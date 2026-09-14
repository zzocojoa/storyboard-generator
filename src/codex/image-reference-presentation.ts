import sharp from 'sharp';
import type { OverlayOptions } from 'sharp';
import { z } from 'zod';
import { contractError } from '../domain/errors.js';
import { inspectImageBytes, MAX_IMAGE_BYTES, MAX_IMAGE_PIXELS } from '../domain/media-inspection.js';
import type { InspectedImage } from '../domain/media-inspection.js';
import { HashSchema } from '../domain/schema.js';

export const MAX_IMAGE_REFERENCE_SOURCES: number = 20;
export const MAX_IMAGE_REFERENCE_ATTACHMENTS: number = 5;
const TILE_SIZE: number = 1024;
const CAPTION_HEIGHT: number = 56;
export type ImageGenerationReference = { label: string; mimeType: InspectedImage['mimeType']; bytes: Buffer };
type ReferenceAttachment = { bytes: Buffer; inspection: InspectedImage };
const AttachmentSchema = z.strictObject({ sha256: HashSchema, mimeType: z.enum(['image/png', 'image/jpeg', 'image/webp']), width: z.number().int().positive(), height: z.number().int().positive() });
const SourcePresentationSchema = z.strictObject({ number: z.number().int().positive(), label: z.string().min(1).max(2000), sha256: HashSchema,
  attachmentIndex: z.number().int().nonnegative(), bounds: z.strictObject({ left: z.number().int().nonnegative(), top: z.number().int().nonnegative(), width: z.number().int().positive(), height: z.number().int().positive() }) });
export const ImageReferencePresentationSchema = z.strictObject({ version: z.literal('1.0.0'), mode: z.enum(['originals', 'contact-sheets']),
  attachments: z.array(AttachmentSchema).max(MAX_IMAGE_REFERENCE_ATTACHMENTS), sources: z.array(SourcePresentationSchema).max(MAX_IMAGE_REFERENCE_SOURCES) });
export type ImageReferencePresentation = z.infer<typeof ImageReferencePresentationSchema>;
export type PreparedImageReferences = { attachments: ReferenceAttachment[]; presentation: ImageReferencePresentation };

/** 원본 자산과 모델 첨부 개수를 구분한다. 복사·디코딩 전에 전체 원본 바이트를 제한한다. */
export function assertImageReferenceBudget(references: readonly { bytes: Buffer }[]): void {
  const bytes: number = references.reduce((sum, reference): number => sum + reference.bytes.length, 0);
  if (references.length > MAX_IMAGE_REFERENCE_SOURCES || bytes > MAX_IMAGE_BYTES) throw contractError('CODEX_IMAGE_REFERENCES_LIMIT',
    `참조 원본은 ${MAX_IMAGE_REFERENCE_SOURCES}개·합계 ${MAX_IMAGE_BYTES}바이트 이하여야 합니다. actualCount=${references.length}, actualBytes=${bytes}. 기준 이미지를 누락하지 말고 제작 기준의 크기와 구성을 확인하세요.`, []);
}

function assertActive(signal: AbortSignal): void {
  if (signal.aborted) throw contractError('AUTOMATION_CANCELLED', '기준 이미지 입력 준비를 중단했습니다. 생성 요청은 전송하지 않았습니다.', []);
}

function caption(number: number): Buffer {
  return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${TILE_SIZE}" height="${CAPTION_HEIGHT}"><rect width="100%" height="100%" fill="#161b22"/><text x="24" y="39" font-family="sans-serif" font-size="32" fill="#ffffff">REF ${number.toString().padStart(2, '0')}</text></svg>`);
}

/** 전체 원본을 자르지 않고 번호가 있는 보드에 배치한다. 이름·명령형 문구는 SVG에 삽입하지 않는다. */
async function contactSheet(references: readonly ImageGenerationReference[], start: number, signal: AbortSignal): Promise<ReferenceAttachment> {
  const columns: number = Math.min(2, references.length);
  const rows: number = Math.ceil(references.length / columns);
  const width: number = columns * TILE_SIZE; const height: number = rows * (TILE_SIZE + CAPTION_HEIGHT);
  const layers: OverlayOptions[] = [];
  for (const [index, reference] of references.entries()) {
    assertActive(signal);
    const left: number = (index % columns) * TILE_SIZE; const top: number = Math.floor(index / columns) * (TILE_SIZE + CAPTION_HEIGHT);
    const bytes: Buffer = await sharp(reference.bytes, { failOn: 'error', limitInputPixels: MAX_IMAGE_PIXELS })
      .autoOrient().resize({ width: TILE_SIZE, height: TILE_SIZE, fit: 'contain', background: '#ffffff' }).flatten({ background: '#ffffff' }).png().toBuffer();
    layers.push({ input: caption(start + index + 1), left, top }, { input: bytes, left, top: top + CAPTION_HEIGHT });
  }
  assertActive(signal);
  const bytes: Buffer = await sharp({ create: { width, height, channels: 3, background: '#ffffff' } }).composite(layers).removeAlpha().png().toBuffer();
  return { bytes, inspection: await inspectImageBytes(bytes, 'image/png') };
}

/** 5개 이하는 원본 바이트 그대로, 초과하면 최대 4칸짜리 보드로 모든 근거를 전달한다. */
export async function prepareImageReferences(input: readonly ImageGenerationReference[], signal: AbortSignal): Promise<PreparedImageReferences> {
  assertImageReferenceBudget(input); assertActive(signal);
  const references: ImageGenerationReference[] = input.map((reference): ImageGenerationReference => ({ ...reference, bytes: Buffer.from(reference.bytes) }));
  const inspections: InspectedImage[] = [];
  for (const reference of references) {
    assertActive(signal);
    if (reference.label.trim().length === 0 || reference.label.length > 2000) throw contractError('CODEX_IMAGE_REFERENCE_LABEL_INVALID', '참조 이미지의 인물·장소·소품 설명을 1~2000자로 지정하세요.', []);
    inspections.push(await inspectImageBytes(reference.bytes, reference.mimeType));
  }
  const attachments: ReferenceAttachment[] = []; const sources: ImageReferencePresentation['sources'] = [];
  const mode: ImageReferencePresentation['mode'] = references.length <= MAX_IMAGE_REFERENCE_ATTACHMENTS ? 'originals' : 'contact-sheets';
  const batchSize: number = Math.max(1, Math.ceil(references.length / MAX_IMAGE_REFERENCE_ATTACHMENTS));
  for (let start: number = 0; start < references.length; start += batchSize) {
    assertActive(signal);
    const batch: ImageGenerationReference[] = references.slice(start, start + batchSize);
    const attachmentIndex: number = attachments.length;
    const attachment: ReferenceAttachment = mode === 'originals' ? { bytes: batch[0]!.bytes, inspection: inspections[start]! } : await contactSheet(batch, start, signal);
    if (attachments.reduce((sum, value): number => sum + value.bytes.length, attachment.bytes.length) > MAX_IMAGE_BYTES) throw contractError('CODEX_IMAGE_REFERENCES_LIMIT', '참조 보드의 합계가 20MB를 초과했습니다. 원본을 보존했습니다. 기준 이미지의 크기를 조정하세요.', []);
    attachments.push(attachment);
    for (const [index, reference] of batch.entries()) {
      const original: InspectedImage = inspections[start + index]!;
      const columns: number = Math.min(2, batch.length);
      sources.push({ number: start + index + 1, label: reference.label, sha256: original.sha256, attachmentIndex,
        bounds: mode === 'originals' ? { left: 0, top: 0, width: original.width, height: original.height } : {
          left: (index % columns) * TILE_SIZE, top: Math.floor(index / columns) * (TILE_SIZE + CAPTION_HEIGHT) + CAPTION_HEIGHT, width: TILE_SIZE, height: TILE_SIZE } });
    }
  }
  assertActive(signal);
  const presentation: ImageReferencePresentation = { version: '1.0.0', mode, attachments: attachments.map((value) => value.inspection), sources };
  validateImageReferencePresentation(presentation, inspections.map((value): string => value.sha256));
  return { attachments, presentation };
}

/** 생성 기록의 참조 목록이 원본 선택과 정확히 같은 순서·개수인지 확인한다. */
export function validateImageReferencePresentation(value: ImageReferencePresentation | undefined, hashes: readonly string[]): ImageReferencePresentation | null {
  if (value === undefined) {
    if (hashes.length > MAX_IMAGE_REFERENCE_ATTACHMENTS) throw contractError('AUTOMATION_REFERENCE_PRESENTATION_REQUIRED', '여러 기준 이미지의 보드 배치 기록이 없습니다. 원본 전체를 전달한 생성 결과가 필요합니다.', []);
    return null;
  }
  const presentation: ImageReferencePresentation = ImageReferencePresentationSchema.parse(value);
  const originals: boolean = hashes.length <= MAX_IMAGE_REFERENCE_ATTACHMENTS;
  const batchSize: number = Math.max(1, Math.ceil(hashes.length / MAX_IMAGE_REFERENCE_ATTACHMENTS));
  const invalid: boolean = presentation.mode !== (originals ? 'originals' : 'contact-sheets')
    || presentation.attachments.length !== Math.ceil(hashes.length / batchSize)
    || presentation.sources.length !== hashes.length || presentation.sources.some((source, index): boolean => {
    const attachment = presentation.attachments[source.attachmentIndex];
    const start: number = Math.floor(index / batchSize) * batchSize;
    const columns: number = Math.min(2, hashes.length - start, batchSize);
    const offset: number = index % batchSize;
    if (source.number !== index + 1 || source.sha256 !== hashes[index] || attachment === undefined || source.attachmentIndex !== Math.floor(index / batchSize)) return true;
    if (originals) return source.bounds.left !== 0 || source.bounds.top !== 0 || source.bounds.width !== attachment.width || source.bounds.height !== attachment.height || attachment.sha256 !== source.sha256;
    return attachment.mimeType !== 'image/png' || attachment.width !== columns * TILE_SIZE
      || attachment.height !== Math.ceil(Math.min(batchSize, hashes.length - start) / columns) * (TILE_SIZE + CAPTION_HEIGHT)
      || source.bounds.left !== (offset % columns) * TILE_SIZE || source.bounds.top !== Math.floor(offset / columns) * (TILE_SIZE + CAPTION_HEIGHT) + CAPTION_HEIGHT
      || source.bounds.width !== TILE_SIZE || source.bounds.height !== TILE_SIZE;
  });
  if (invalid) throw contractError('AUTOMATION_REFERENCE_PRESENTATION_MISMATCH', '참조 보드 기록이 선택한 원본·순서·표시 범위와 다릅니다. 생성 결과를 다시 확인하세요.', []);
  return presentation;
}

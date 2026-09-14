import sharp from 'sharp';
import { expect, it } from 'vitest';
import { MAX_IMAGE_REFERENCE_SOURCES, prepareImageReferences, validateImageReferencePresentation } from '../src/codex/image-reference-presentation.js';
import type { ImageGenerationReference } from '../src/codex/image-reference-presentation.js';
import { MAX_IMAGE_BYTES } from '../src/domain/media-inspection.js';
import { sha256Bytes } from '../src/importers/integrity.js';

async function references(count: number): Promise<ImageGenerationReference[]> {
  return Promise.all(Array.from({ length: count }, async (_value, index): Promise<ImageGenerationReference> => ({ label: `기준 ${index + 1}`,
    mimeType: 'image/png', bytes: await sharp({ create: { width: index % 2 === 0 ? 40 : 20, height: index % 2 === 0 ? 20 : 40,
      channels: 3, background: { r: 25 + index * 10, g: 100, b: 200 } } }).png().toBuffer() })));
}

it('image_reference_boards_preserve_all_sources_order_full_image_and_original_bytes', async (): Promise<void> => {
  const input: ImageGenerationReference[] = await references(8); const original: Buffer[] = input.map((value): Buffer => Buffer.from(value.bytes));
  const prepared = await prepareImageReferences(input, new AbortController().signal);
  expect(prepared.attachments).toHaveLength(4); expect(prepared.presentation.mode).toBe('contact-sheets');
  expect(prepared.presentation.sources.map((source): string => source.sha256)).toEqual(original.map(sha256Bytes));
  for (const [index, source] of prepared.presentation.sources.entries()) {
    expect(source.label).toBe(`기준 ${index + 1}`); expect(source.number).toBe(index + 1);
    const attachment = prepared.attachments[source.attachmentIndex]!;
    const image = sharp(attachment.bytes);
    const middle = await image.clone().extract({ left: source.bounds.left + 512, top: source.bounds.top + 512, width: 1, height: 1 }).raw().toBuffer();
    expect([...middle]).toEqual([25 + index * 10, 100, 200]);
    const edge = await image.clone().extract({ left: source.bounds.left + (index % 2 === 0 ? 2 : 512), top: source.bounds.top + (index % 2 === 0 ? 512 : 2), width: 1, height: 1 }).raw().toBuffer();
    expect([...edge]).toEqual([...middle]);
    const padding = await image.clone().extract({ left: source.bounds.left + 2, top: source.bounds.top + 2, width: 1, height: 1 }).raw().toBuffer();
    expect([...padding]).toEqual([255, 255, 255]);
  }
  expect(input.map((value): Buffer => value.bytes)).toEqual(original);
  const singles = await prepareImageReferences(input.slice(0, 5), new AbortController().signal);
  expect(singles.presentation.mode).toBe('originals'); expect(singles.attachments.map((value): Buffer => value.bytes)).toEqual(original.slice(0, 5));
  expect((await prepareImageReferences([], new AbortController().signal)).attachments).toEqual([]);
  const maximum = await prepareImageReferences(await references(MAX_IMAGE_REFERENCE_SOURCES), new AbortController().signal);
  expect(maximum.attachments).toHaveLength(5); expect(maximum.presentation.sources).toHaveLength(20);
  expect(maximum.attachments.every((value): boolean => value.inspection.width === 2048 && value.inspection.height === 2160)).toBe(true);
});

it('image_reference_boards_reject_missing_forged_oversized_corrupt_and_cancelled_inputs', async (): Promise<void> => {
  const input: ImageGenerationReference[] = await references(8); const hashes: string[] = input.map((value): string => sha256Bytes(value.bytes));
  const prepared = await prepareImageReferences(input, new AbortController().signal);
  expect(() => validateImageReferencePresentation(undefined, hashes)).toThrow(expect.objectContaining({ code: 'AUTOMATION_REFERENCE_PRESENTATION_REQUIRED' }));
  const changed = structuredClone(prepared.presentation); changed.sources[0]!.attachmentIndex = 2;
  expect(() => validateImageReferencePresentation(changed, hashes)).toThrow(expect.objectContaining({ code: 'AUTOMATION_REFERENCE_PRESENTATION_MISMATCH' }));
  const cropped = structuredClone(prepared.presentation); cropped.sources[0]!.bounds.width = 10;
  expect(() => validateImageReferencePresentation(cropped, hashes)).toThrow(expect.objectContaining({ code: 'AUTOMATION_REFERENCE_PRESENTATION_MISMATCH' }));
  expect(() => validateImageReferencePresentation(prepared.presentation, [...hashes].reverse())).toThrow(expect.objectContaining({ code: 'AUTOMATION_REFERENCE_PRESENTATION_MISMATCH' }));
  await expect(prepareImageReferences(Array.from({ length: MAX_IMAGE_REFERENCE_SOURCES + 1 }, () => input[0]!), new AbortController().signal)).rejects.toMatchObject({ code: 'CODEX_IMAGE_REFERENCES_LIMIT' });
  await expect(prepareImageReferences([{ ...input[0]!, bytes: Buffer.alloc(MAX_IMAGE_BYTES + 1) }], new AbortController().signal)).rejects.toMatchObject({ code: 'CODEX_IMAGE_REFERENCES_LIMIT' });
  await expect(prepareImageReferences([...input.slice(0, 7), { ...input[7]!, bytes: Buffer.from('broken') }], new AbortController().signal)).rejects.toMatchObject({ code: 'ASSET_CONTENT_CORRUPT' });
  const controller = new AbortController(); controller.abort();
  await expect(prepareImageReferences(input, controller.signal)).rejects.toMatchObject({ code: 'AUTOMATION_CANCELLED' });
});

import { resolve } from 'node:path';
import { getDocument, OPS } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { describe, expect, it } from 'vitest';
import type { Project } from '../src/domain/schema.js';
import { createPdfTextProjection, exportProjectPdfForPolicy, renderPdfProjection } from '../src/exporters/pdf.js';
import type { PdfFramePageItem, PdfProjection } from '../src/exporters/pdf.js';
import { redactPdfProjection, reviewRedactionPatterns } from '../src/exporters/review-redaction.js';
import { png } from './helpers.js';
import { readinessOutline } from './readiness-fixtures.js';

const fontPath: string = resolve('assets/fonts/NanumGothic-Regular.ttf');
const createdAt: string = '2026-09-11T00:00:00.000Z';
type PdfInspection = { text: string; body: string; pages: number; images: number; imageRatios: number[] };

async function inspectPdf(bytes: Buffer): Promise<PdfInspection> {
  const task = getDocument({ data: new Uint8Array(bytes), useSystemFonts: false, disableFontFace: true });
  try {
    const document = await task.promise;
    const text: string[] = []; const body: string[] = []; const imageRatios: number[] = []; let images: number = 0;
    for (let number: number = 1; number <= document.numPages; number += 1) {
      const page = await document.getPage(number); const content = await page.getTextContent();
      const viewport = page.getViewport({ scale: 1 });
      for (const item of content.items) {
        if (!('str' in item) || item.str.trim().length === 0) continue;
        const x: number = item.transform[4] as number; const y: number = item.transform[5] as number;
        expect(x, item.str).toBeGreaterThanOrEqual(31);
        expect(x + item.width, item.str).toBeLessThanOrEqual(viewport.width - 31);
        expect(y, item.str).toBeGreaterThan(15);
        expect(y + item.height, item.str).toBeLessThan(viewport.height - 15);
        text.push(item.str);
        if (y < viewport.height - 54 && y > 43 && item.height > 9) body.push(item.str);
      }
      const operators = await page.getOperatorList();
      images += operators.fnArray.filter((operation: number): boolean => [OPS.paintImageXObject, OPS.paintInlineImageXObject].includes(operation)).length;
      for (const [index, operation] of operators.fnArray.entries()) {
        if (operation !== OPS.paintImageXObject) continue;
        const previousTransform: number = operators.fnArray.slice(0, index).lastIndexOf(OPS.transform);
        const matrix: number[] = operators.argsArray[previousTransform] as number[];
        imageRatios.push(Math.abs((matrix[0] as number) / (matrix[3] as number)));
      }
    }
    return { text: text.join('\n'), body: body.join('').replace(/\s/gu, ''), pages: document.numPages, images, imageRatios };
  } finally { await task.destroy(); }
}

async function projectionFixture(): Promise<PdfProjection> {
  const projection: PdfProjection = await createPdfTextProjection(await readinessOutline(), { maturity: 'draft', channel: 'pdf-export' }, {});
  return { ...projection, items: [projection.items[0] as PdfFramePageItem] };
}

describe('긴 제작 콘티 PDF', (): void => {
  it('pdf_pagination_preserves_long_korean_and_unbroken_content_inside_page_bounds', async (): Promise<void> => {
    const base: PdfProjection = await projectionFixture();
    const action: string = Array.from({ length: 90 }, (_, index: number): string => `문장${index} 식탁 위 자료를 차례로 확인하고 서로의 시선과 문밖 발소리를 살핀다. 문장끝${index}`).join('\n');
    const source: string = '연결원문'.repeat(240) + '원문최종종결';
    const description: string = '프레임의 모든 인물과 공간이 유지되는지 검토합니다. '.repeat(40) + '설명최종종결';
    const projection: PdfProjection = { ...base, title: '긴 제목 '.repeat(50) + '제목최종종결', items: [{ ...base.items[0]!, action,
      sourceText: source, description, placeholderText: '검토 사유 '.repeat(90) + '검토최종종결',
      textEntries: [{ id: '자막001', label: 'OVERLAY', timeText: '00:00:08:00 - 00:00:11:00 (8000..11000ms)', body: '자막 본문 '.repeat(80) + '자막최종종결', statusText: 'DRAFT · TIMING UNCONFIRMED' }],
      audioEntries: [{ id: '음향001', label: 'SFX', timeText: '00:00:12:00 - 00:00:13:06 (12000..13200ms)', body: '복도에서 다가오는 발소리', statusText: 'MEASURED' }] }] };
    const bytes: Buffer = await renderPdfProjection(projection, fontPath, createdAt);
    const inspected: PdfInspection = await inspectPdf(bytes);
    expect(inspected.pages).toBeGreaterThan(4);
    for (const value of [action, source, description, projection.title]) expect(inspected.body).toContain(value.replace(/\s/gu, ''));
    for (const value of ['검토최종종결', '자막최종종결', '복도에서다가오는발소리', '(8000..11000ms)', '(12000..13200ms)']) expect(inspected.body).toContain(value);
    expect(inspected.images).toBe(0);
    expect(await renderPdfProjection(projection, fontPath, createdAt)).toEqual(bytes);
  });

  it('pdf_pagination_keeps_portrait_and_landscape_images_and_every_frame', async (): Promise<void> => {
    const base: PdfProjection = await projectionFixture();
    for (const [width, height] of [[160, 90], [90, 160]] as const) {
      const item: PdfFramePageItem = { ...base.items[0]!, image: await png(width, height), renderMode: 'bitmap', description: '이미지 비율 검증',
        action: '두 인물의 시선 방향을 확인한다.', sourceText: '확인된 원문', gateText: '', outputText: 'DRAFT', placeholderText: '' };
      const projection: PdfProjection = { ...base, aspectWidth: width, aspectHeight: height,
        items: [item, { ...item, shotId: '마지막컷', frameText: '마지막프레임' }] };
      const inspected: PdfInspection = await inspectPdf(await renderPdfProjection(projection, fontPath, createdAt));
      expect(inspected.images).toBe(2);
      for (const ratio of inspected.imageRatios) expect(ratio).toBeCloseTo(width / height, 5);
      expect(inspected.body).toContain('마지막컷'); expect(inspected.body).toContain('마지막프레임');
    }
  });

  it('pdf_track_details_keep_output_interlocks_and_final_rejection', async (): Promise<void> => {
    const base: Project = await readinessOutline();
    const project: Project = { ...base,
      textCues: base.textCues.map((cue) => ({ ...cue, text: '공개금지자막', authority: 'review-required', mappingDecisionId: null })),
      dataset: { ...base.dataset, units: base.dataset.units.map((unit) => base.audioCues.some((cue): boolean => cue.unitId === unit.id) ? { ...unit, text: '공개금지음성' } : unit) } };
    expect(project.textCues.length).toBeGreaterThan(0); expect(project.audioCues.length).toBeGreaterThan(0);
    const projection: PdfProjection = await createPdfTextProjection(project, { maturity: 'draft', channel: 'pdf-export' }, {});
    const inspected: PdfInspection = await inspectPdf(await renderPdfProjection(projection, fontPath, createdAt));
    expect(inspected.text).not.toContain('공개금지자막'); expect(inspected.text).not.toContain('공개금지음성');
    expect(inspected.text).toContain('OUTPUT BLOCKED'); expect(inspected.text).toContain('STORYBOARD_AUDIO_TIMING_REQUIRED');
    await expect(exportProjectPdfForPolicy(project, fontPath, async (): Promise<Buffer> => { throw new Error('차단된 자산을 읽으면 안 됩니다.'); },
      { maturity: 'final', channel: 'pdf-export' }, {})).rejects.toMatchObject({ code: 'FINAL_OUTPUT_NOT_READY' });
  });

  it('pdf_external_redaction_covers_frame_description_and_new_track_fields', async (): Promise<void> => {
    const base: PdfProjection = await projectionFixture(); const privateText: string = 'private@example.com';
    const track = { id: privateText, label: privateText, timeText: privateText, body: privateText, statusText: privateText };
    const redacted = redactPdfProjection({ ...base, outputLabel: privateText, items: [{ ...base.items[0]!, image: await png(20, 20),
      description: privateText, textEntries: [track], audioEntries: [track] }] }, reviewRedactionPatterns([]));
    expect(JSON.stringify(redacted.projection)).not.toContain(privateText);
    const inspected: PdfInspection = await inspectPdf(await renderPdfProjection(redacted.projection, fontPath, createdAt));
    expect(inspected.text).not.toContain(privateText); expect(inspected.images).toBe(0);
    expect(redacted.entries.some((entry): boolean => entry.fieldPath.endsWith('/textEntries/0/body'))).toBe(true);
    expect(redacted.entries.some((entry): boolean => entry.fieldPath.endsWith('/audioEntries/0/body'))).toBe(true);
  });
});

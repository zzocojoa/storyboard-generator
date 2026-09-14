import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getDocument, OPS } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { expect, it } from 'vitest';
import Fastify from 'fastify';
import { readBuildManifest } from '../src/build.js';
import type { Project } from '../src/domain/schema.js';
import { initialOutputOptions, selectedOutputFrames, selectedOutputShots, StoryboardOutputOptionsSchema } from '../src/exporters/output-options.js';
import type { StoryboardOutputOptions } from '../src/exporters/output-options.js';
import { createSelectedPdfTextProjection, renderPdfProjection } from '../src/exporters/pdf.js';
import { createSelectedCsvProjection, exportSelectedCsv, exportSelectedPdf } from '../src/exporters/selected-output.js';
import { renderCsvProjection } from '../src/exporters/csv.js';
import { readReviewArchive, writeReviewBundle } from '../src/exporters/review-bundle.js';
import { errorBody, httpErrorPolicy } from '../src/server/app.js';
import { registerOutputRoutes } from '../src/server/output-routes.js';
import { ProjectStore } from '../src/server/store.js';
import { sha256Bytes, sha256Text } from '../src/importers/integrity.js';
import { TEST_TEXT_FONT_PATH, png } from './helpers.js';
import { finalFixture, readinessOutline } from './readiness-fixtures.js';

const createdAt: string = '2026-09-11T10:00:00.000Z';
type PdfEvidence = { text: string; body: string; sizes: number[][]; images: number };
async function inspect(bytes: Buffer): Promise<PdfEvidence> {
  const task = getDocument({ data: new Uint8Array(bytes), useSystemFonts: false, disableFontFace: true });
  try {
    const pdf = await task.promise; const sizes: number[][] = []; const text: string[] = []; const body: string[] = []; let images: number = 0;
    for (let index: number = 1; index <= pdf.numPages; index += 1) {
      const page = await pdf.getPage(index); const viewport = page.getViewport({ scale: 1 }); sizes.push([viewport.width, viewport.height]);
      const content = await page.getTextContent();
      for (const item of content.items) if ('str' in item && item.str.trim().length > 0) {
        expect(item.transform[4], item.str).toBeGreaterThanOrEqual(31);
        expect(item.transform[4]! + item.width, item.str).toBeLessThanOrEqual(viewport.width - 31);
        expect(item.transform[5], item.str).toBeGreaterThan(15);
        expect(item.transform[5]! + item.height, item.str).toBeLessThan(viewport.height - 15); text.push(item.str);
        if (item.height > 9 && item.transform[5]! < viewport.height - 54 && item.transform[5]! > 43) body.push(item.str);
      }
      const operators = await page.getOperatorList(); images += operators.fnArray.filter((operation): boolean => operation === OPS.paintImageXObject).length;
    }
    return { text: text.join('').replace(/\s/gu, ''), body: body.join('').replace(/\s/gu, ''), sizes, images };
  } finally { await task.destroy(); }
}

it('output_selection_preserves_original_order_and_chooses_keys_without_hiding_blocked_frames', async (): Promise<void> => {
  const original: Project = await readinessOutline(); const shot = original.shots[0]!;
  const project: Project = { ...original, frames: [...original.frames, { ...original.frames[0]!, id: 'key-test', role: 'key', offsetMs: 1000, visualReview: 'pending' }] };
  const before: string = JSON.stringify(project); const options: StoryboardOutputOptions = { ...initialOutputOptions(), frames: 'representative', scope: { kind: 'segments', segmentIds: [shot.segmentId] } };
  expect(selectedOutputFrames(project, options).find((frame): boolean => frame.shotId === shot.id)?.id).toBe('key-test');
  expect(selectedOutputShots(project, options).map((value): string => value.id)).toEqual(project.shots.filter((value): boolean => value.segmentId === shot.segmentId).map((value): string => value.id));
  expect(() => selectedOutputShots(project, { ...options, scope: { kind: 'segments', segmentIds: ['없는구간'] } })).toThrowError(/없는구간/u);
  expect(StoryboardOutputOptionsSchema.safeParse({ ...options, scope: { kind: 'segments', segmentIds: [] } }).success).toBe(false);
  expect(StoryboardOutputOptionsSchema.safeParse({ ...options, filename: '../../overwrite' }).success).toBe(false);
  expect(JSON.stringify(project)).toBe(before);
});

it('output_detail_pages_keep_all_selected_long_text_with_a4_a3_portrait_landscape', async (): Promise<void> => {
  const project = await readinessOutline(); const options = initialOutputOptions();
  const base = await createSelectedPdfTextProjection(project, { maturity: 'draft', channel: 'pdf-export' }, {}, options);
  const action: string = '긴 제작 지시를 원문 그대로 여러 페이지에 이어 기록합니다.\n'.repeat(70) + '최종연출종결';
  for (const pageSize of ['A4', 'A3'] as const) for (const orientation of ['portrait', 'landscape'] as const) {
    const projection = { ...base, format: { ...options.pdf, pageSize, orientation }, items: [{ ...base.items[0]!, action }] };
    const bytes: Buffer = await renderPdfProjection(projection, TEST_TEXT_FONT_PATH, createdAt); const result = await inspect(bytes);
    expect(result.body).toContain(action.replace(/\s/gu, '')); expect(result.sizes.length).toBeGreaterThan(1);
    expect(result.sizes.every(([width, height]): boolean => orientation === 'portrait' ? width! < height! : width! > height!)).toBe(true);
    expect(Math.min(...result.sizes[0]!)).toBeCloseTo(pageSize === 'A4' ? 595.28 : 841.89, 1);
    expect(await renderPdfProjection(projection, TEST_TEXT_FONT_PATH, createdAt)).toEqual(bytes);
  }
});

it('output_board_two_four_six_keeps_every_selected_image_and_labels_summary_scope', async (): Promise<void> => {
  const project = await readinessOutline(); const options = initialOutputOptions();
  const base = await createSelectedPdfTextProjection(project, { maturity: 'draft', channel: 'pdf-export' }, {}, options);
  const image: Buffer = await png(90, 160);
  for (const count of [2, 4, 6] as const) {
    const projection = { ...base, aspectWidth: 9, aspectHeight: 16, format: { ...options.pdf, orientation: 'portrait' as const, layout: { kind: 'board' as const, framesPerPage: count } },
      items: Array.from({ length: 7 }, (_, index) => ({ ...base.items[0]!, frameId: `FRAME-CHECK-${index}`, image, renderMode: 'bitmap' as const, outputText: 'DRAFT', overlayInputs: [] })) };
    const result = await inspect(await renderPdfProjection(projection, TEST_TEXT_FONT_PATH, createdAt));
    expect(result.images).toBe(7); expect(result.sizes.length).toBe(1 + Math.ceil(7 / count));
    expect(result.text).toContain('그림비교용목록'); expect(result.text).toContain('FRAME-CHECK-6');
    expect(result.text).not.toContain(base.items[0]!.action.replace(/\s/gu, ''));
  }
});

it('output_readable_csv_preserves_track_interlocks_and_escaping_and_respects_selected_sections', async (): Promise<void> => {
  const base = await readinessOutline();
  const project: Project = { ...base, title: '=HYPERLINK(1)', textCues: base.textCues.map((cue) => ({ ...cue, authority: 'review-required', mappingDecisionId: null })) };
  const options: StoryboardOutputOptions = { ...initialOutputOptions(), csv: 'readable', pdf: { ...initialOutputOptions().pdf, sections: ['text', 'audio'] }, scope: { kind: 'segments', segmentIds: [project.shots[0]!.segmentId] } };
  const rows = createSelectedCsvProjection(project, {}, { maturity: 'draft', channel: 'csv-export' }, options);
  expect(rows[0]).toContain('화면 글자'); expect(rows[0]).not.toContain('행동·연출'); expect(rows[0]).not.toContain('원문 연결');
  const csv: string = renderCsvProjection(rows); expect(csv).toContain("'=HYPERLINK(1)"); expect(csv).not.toContain(base.textCues[0]!.text); expect(csv).toContain('[OUTPUT BLOCKED]');
  expect(csv.startsWith('\uFEFF')).toBe(true); expect(csv.endsWith('\r\n')).toBe(true);
  await expect(exportSelectedCsv(project, TEST_TEXT_FONT_PATH, { maturity: 'final', channel: 'csv-export' }, {}, options)).rejects.toMatchObject({ code: 'FINAL_OUTPUT_NOT_READY' });
  await expect(exportSelectedPdf(project, TEST_TEXT_FONT_PATH, async (): Promise<Buffer> => { throw new Error('자산을 읽으면 안 됩니다.'); }, { maturity: 'final', channel: 'pdf-export' }, {}, options, createdAt)).rejects.toMatchObject({ code: 'FINAL_OUTPUT_NOT_READY' });
});

it('output_http_applies_options_and_revision_without_changing_project_or_approval', async (): Promise<void> => {
  const root: string = await mkdtemp(join(tmpdir(), 'cutroom-output-http-')); const store = new ProjectStore(root); const app = Fastify();
  registerOutputRoutes(app, store, TEST_TEXT_FONT_PATH); app.setErrorHandler((error: Error, request, reply): void => { reply.status(httpErrorPolicy(error).status).send(errorBody(error, request)); });
  try {
    const project: Project = await readinessOutline(); await store.create(project);
    const path: string = join(root, sha256Text(project.projectId), 'project.json'); const before = await readFile(path);
    const options = { ...initialOutputOptions(), filename: '검토 콘티', csv: 'readable', scope: { kind: 'segments', segmentIds: [project.shots[0]!.segmentId] } };
    const query: string = new URLSearchParams({ revision: '0', maturity: 'draft', options: JSON.stringify(options) }).toString();
    const base: string = `/api/projects/${encodeURIComponent(project.projectId)}/export`;
    const pdf = await app.inject({ method: 'GET', url: `${base}.pdf?${query}` }); expect(pdf.statusCode).toBe(200); expect(pdf.headers['content-type']).toBe('application/pdf');
    expect(pdf.headers['content-disposition']).toContain(encodeURIComponent('검토 콘티-r0-draft.pdf'));
    const csv = await app.inject({ method: 'GET', url: `${base}.csv?${query}` }); expect(csv.statusCode).toBe(200); expect(csv.body).toContain('화면 글자');
    const record = (await app.inject({ method: 'GET', url: `${base}-options.json?${query}` })).json(); expect(record.options).toEqual(options); expect(record.projectSha256).toHaveLength(64);
    expect((await app.inject({ method: 'GET', url: `${base}.pdf?${query.replace('maturity=draft', 'maturity=final')}` })).statusCode).toBe(409);
    expect((await app.inject({ method: 'GET', url: `${base}.pdf?${query.replace('revision=0', 'revision=9')}` })).statusCode).toBe(409);
    expect((await app.inject({ method: 'GET', url: `${base}.pdf?options=broken` })).statusCode).toBe(400);
    expect(await readFile(path)).toEqual(before);
  } finally { await app.close(); await store.close(); await rm(root, { recursive: true, force: true }); }
});

it('output_selected_final_succeeds_only_when_unselected_segments_also_pass_all_checks', async (): Promise<void> => {
  const h = await finalFixture(); const project: Project = { ...h.project, textCues: h.project.textCues.map((cue) => ({ ...cue, timingStatus: 'confirmed' })) };
  const options: StoryboardOutputOptions = { ...initialOutputOptions(), scope: { kind: 'segments', segmentIds: [project.shots[0]!.segmentId] } };
  const pdf: Buffer = await exportSelectedPdf(project, TEST_TEXT_FONT_PATH, async (id): Promise<Buffer> => h.media.get(id)!, { maturity: 'final', channel: 'pdf-export' }, h.integrity, options, createdAt);
  expect((await inspect(pdf)).text).toContain('FINAL');
  const selected: ReadonlySet<string> = new Set(selectedOutputShots(project, options).map((shot): string => shot.id));
  const hidden = project.frames.find((frame): boolean => !selected.has(frame.shotId))!; expect(hidden).toBeDefined();
  const blocked: Project = { ...project, frames: project.frames.map((frame) => frame.id === hidden.id ? { ...frame, visualReview: 'pending' } : frame) };
  await expect(exportSelectedPdf(blocked, TEST_TEXT_FONT_PATH, async (id): Promise<Buffer> => h.media.get(id)!, { maturity: 'final', channel: 'pdf-export' }, h.integrity, options, createdAt)).rejects.toMatchObject({ code: 'FINAL_OUTPUT_NOT_READY' });
  await expect(exportSelectedCsv(blocked, TEST_TEXT_FONT_PATH, { maturity: 'final', channel: 'csv-export' }, h.integrity, options)).rejects.toMatchObject({ code: 'FINAL_OUTPUT_NOT_READY' });
});

it('output_bundle_records_selected_presentation_preserves_whole_archive_and_external_redaction', async (): Promise<void> => {
  const root: string = await mkdtemp(join(tmpdir(), 'cutroom-output-bundle-')); const dataRoot: string = join(root, 'data'); const store = new ProjectStore(dataRoot);
  try {
    const project: Project = { ...await readinessOutline(), title: 'private@example.com' }; await store.create(project); await store.close();
    const archive = await readReviewArchive(dataRoot, project.projectId); const snapshot = await readFile(join(dataRoot, sha256Text(project.projectId), 'project.json'));
    const options: StoryboardOutputOptions = { ...initialOutputOptions(), csv: 'readable', frames: 'representative', scope: { kind: 'segments', segmentIds: [project.shots[0]!.segmentId] }, pdf: { ...initialOutputOptions().pdf, layout: { kind: 'board', framesPerPage: 4 } } };
    const output: string = join(root, 'external');
    const manifest = await writeReviewBundle(archive, { output, profile: 'external', maturity: 'draft', fontPath: TEST_TEXT_FONT_PATH, createdAt, build: readBuildManifest(), outputOptions: options }, []);
    expect(manifest.presentation?.archiveScope).toBe('whole-project'); expect(manifest.presentation?.selectedArtifacts).toEqual(['shots.csv', 'storyboard.pdf']);
    expect(manifest.presentation?.options).toEqual(options); expect(JSON.stringify(manifest)).not.toContain('private@example.com');
    const saved = JSON.parse(await readFile(join(output, 'project.json'), 'utf8')); expect(saved.project.shots.length).toBe(project.shots.length);
    const pdf = await inspect(await readFile(join(output, 'storyboard.pdf'))); expect(pdf.images).toBe(0); expect(pdf.text).not.toContain('private@example.com');
    for (const file of manifest.files) expect(sha256Bytes(await readFile(join(output, file.path)))).toBe(file.sha256);
    expect(await readFile(join(dataRoot, sha256Text(project.projectId), 'project.json'))).toEqual(snapshot);
  } finally { await store.close(); await rm(root, { recursive: true, force: true }); }
});

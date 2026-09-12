import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, expect, it } from 'vitest';
import { readBuildManifest } from '../src/build.js';
import { CodexRequestStore } from '../src/codex/requests.js';
import type { Project } from '../src/domain/schema.js';
import { initialTextPresentation } from '../src/domain/text-presentation.js';
import { sha256Text } from '../src/importers/integrity.js';
import { TextLayoutResponseSchema } from '../src/rendering/text-response.js';
import { readReviewArchive, writeReviewBundle } from '../src/exporters/review-bundle.js';
import { createApp } from '../src/server/app.js';
import { ProjectStore } from '../src/server/store.js';
import { TEST_AUDIO_NORMALIZATION_OPTIONS } from './helpers.js';
import { finalFixture, readinessOutline } from './readiness-fixtures.js';
import { TEST_LATIN_FONT_PATH } from './typography-helpers.js';

const cleanups: { app: FastifyInstance; root: string }[] = [];
afterEach(async (): Promise<void> => { for (const value of cleanups.splice(0)) { await value.app.close(); await rm(value.root, { recursive: true, force: true }); } });
async function fixture(): Promise<{ app: FastifyInstance; store: ProjectStore; project: Project; path: string; currentPath: string }> {
  const root: string = await mkdtemp(join(tmpdir(), 'cutroom-text-')); const dataRoot: string = join(root, 'data');
  const webRoot: string = join(root, 'web');
  await mkdir(webRoot); await writeFile(join(webRoot, 'index.html'), '<div id="root"></div>');
  const store = new ProjectStore(dataRoot); const ready = await finalFixture();
  await store.create(await readinessOutline());
  const project = await store.update(ready.project.projectId, 0, (): Project => ready.project, ready.project.assets.map((asset) => ({ relativePath: asset.path, content: ready.media.get(asset.id)! })));
  const app = await createApp({ host: '127.0.0.1', port: 0, dataRoot, webRoot, pdfFontPath: resolve('assets/fonts/NanumGothic-Regular.ttf'),
    textFonts: [{ id: 'latin-mono', label: 'Latin Mono', path: resolve(TEST_LATIN_FONT_PATH) }],
    audioNormalization: TEST_AUDIO_NORMALIZATION_OPTIONS, codex: { requestRoot: join(root, 'requests'), speechVoice: 'Yuna' } }, store, new CodexRequestStore(join(root, 'requests'), readBuildManifest()));
  cleanups.push({ app, root });
  return { app, store, project, path: `/api/projects/${encodeURIComponent(project.projectId)}`, currentPath: join(dataRoot, sha256Text(project.projectId), 'project.json') };
}

it('text_presentation_http_previews_then_saves_and_resets_without_source_edits_or_final_bypass', async (): Promise<void> => {
  const value = await fixture(); const cue = value.project.textCues[0]!;
  const path: string = `${value.path}/text/${encodeURIComponent(cue.id)}/presentation`;
  const presentation = { ...initialTextPresentation(value.project.textLayout, cue.kind), y: 0.5, alignment: 'left' as const, background: 'light' as const, layer: 8 };
  const original = await readFile(value.currentPath);
  const preview = await value.app.inject({ method: 'POST', url: `${path}/preview`, payload: { expectedRevision: 1, presentation, atMs: cue.startMs } });
  expect(preview.statusCode).toBe(200); expect(preview.json().svg).toContain('<path'); expect(preview.json().issues).toEqual([]);
  expect(await readFile(value.currentPath)).toEqual(original);
  const response = await value.app.inject({ method: 'PATCH', url: path, payload: { expectedRevision: 1, presentation } });
  expect(response.statusCode).toBe(200); const saved: Project = response.json().project;
  expect(saved.revision).toBe(2); expect(saved.textCues[0]).toEqual({ ...cue, presentation: { ...presentation, mode: 'manual' } });
  expect(saved.textCues.slice(1)).toEqual(value.project.textCues.slice(1));
  for (const key of ['dataset', 'shots', 'frames', 'audioCues', 'assets', 'generationRecords', 'textLayout'] as const) expect(saved[key]).toEqual(value.project[key]);
  const rendered = TextLayoutResponseSchema.parse((await value.app.inject({ url: `${value.path}/text-layout?revision=2&atMs=${cue.startMs}&maturity=draft` })).json());
  expect(rendered.svg).toBe(preview.json().svg); expect(rendered.boxes).toContainEqual(expect.objectContaining({ cueId: cue.id, layer: 8, background: 'light' }));
  expect((await value.app.inject({ url: `${value.path}/export.csv?maturity=final` })).body).toContain('""presentation""');
  const bytes = await readFile(value.currentPath);
  expect((await value.app.inject({ method: 'PATCH', url: path, payload: { expectedRevision: 1, presentation } })).statusCode).toBe(409);
  expect((await value.app.inject({ method: 'POST', url: `${path}/preview`, payload: { expectedRevision: 1, presentation, atMs: 0 } })).statusCode).toBe(409);
  expect((await value.app.inject({ method: 'PATCH', url: path, payload: { expectedRevision: 2, presentation: { ...presentation, layer: -1 } } })).statusCode).toBe(400);
  expect(await readFile(value.currentPath)).toEqual(bytes);
  const overflowing = await value.app.inject({ method: 'PATCH', url: path, payload: { expectedRevision: 2, presentation: { ...presentation, x: 0.99 } } });
  expect(overflowing.statusCode).toBe(200);
  const readiness = (await value.app.inject({ url: `${value.path}/final-readiness` })).json();
  expect(readiness.finalReady).toBe(false); expect(readiness.issues).toContainEqual(expect.objectContaining({ code: 'TEXT_LAYOUT_OVERFLOW', entityId: cue.id }));
  for (const extension of ['pdf', 'csv']) expect((await value.app.inject({ url: `${value.path}/export.${extension}?maturity=final` })).statusCode).toBe(409);
  const reset = await value.app.inject({ method: 'DELETE', url: path, payload: { expectedRevision: 3 } });
  expect(reset.statusCode).toBe(200); expect(reset.json().project.textCues).toEqual(value.project.textCues);
  expect(reset.json().project.revision).toBe(4); expect((await value.app.inject({ url: `${value.path}/final-readiness` })).json().finalReady).toBe(true);
  const unresolved = { ...cue, id: 'unresolved-preview', startMs: cue.endMs, endMs: cue.endMs + 1,
    authority: 'review-required' as const, unitId: null, placementId: null, mappingDecisionId: null };
  await value.store.update(value.project.projectId, 4, (current): Project => ({ ...current, textCues: [...current.textCues, unresolved] }), []);
  const unconfirmed = await value.app.inject({ method: 'POST', url: `${value.path}/text/${unresolved.id}/presentation/preview`, payload: { expectedRevision: 5, presentation, atMs: unresolved.startMs } });
  expect(unconfirmed.statusCode).toBe(200); expect(unconfirmed.json().svg).not.toContain('<path');
  expect(unconfirmed.json().issues).toContainEqual(expect.objectContaining({ entityId: unresolved.id }));
  expect((await value.store.read(value.project.projectId)).revision).toBe(5);
});

it('text_typography_http_previews_without_writes_and_saves_one_revision_with_font_provenance', async (): Promise<void> => {
  const value = await fixture(); const original = await readFile(value.currentPath);
  const catalog = (await value.app.inject({ url: '/api/text-fonts' })).json();
  expect(catalog.fonts).toHaveLength(2); expect(catalog.unavailable).toEqual([]);
  const font = catalog.fonts.find((entry: { id: string }): boolean => entry.id === 'latin-mono');
  const textTypography = { version: '1.0.0', language: 'ko', fontId: font.id, fontSha256: font.sha256 };
  const preview = await value.app.inject({ method: 'POST', url: `${value.path}/text-typography/preview`, payload: { expectedRevision: 1, textTypography, atMs: 0 } });
  expect(preview.statusCode).toBe(200); expect(preview.json().fontSha256).toBe(font.sha256);
  expect(preview.json().issues).toContainEqual(expect.objectContaining({ code: 'TEXT_FONT_GLYPH_MISSING' }));
  expect(await readFile(value.currentPath)).toEqual(original);
  const saved = await value.app.inject({ method: 'PATCH', url: `${value.path}/text-typography`, payload: { expectedRevision: 1, textTypography } });
  expect(saved.statusCode).toBe(200); const project: Project = saved.json().project;
  expect(project.revision).toBe(2); expect(project.textTypography).toEqual(textTypography);
  for (const key of ['dataset', 'textCues', 'audioCues', 'shots', 'frames', 'assets', 'generationRecords', 'sources'] as const) expect(project[key]).toEqual(value.project[key]);
  const rendered = await value.app.inject({ url: `${value.path}/text-layout?revision=2&atMs=0&maturity=draft` });
  expect(rendered.json().fontSha256).toBe(font.sha256); expect(rendered.json().boxes).toEqual([]);
  for (const extension of ['pdf', 'csv']) {
    const result = await value.app.inject({ url: `${value.path}/export.${extension}?maturity=final` });
    expect(result.statusCode).toBe(409); expect(result.json().error.code).toBe('FINAL_OUTPUT_NOT_READY');
  }
  expect((await value.app.inject({ method: 'POST', url: `${value.path}/text-typography/preview`, payload: { expectedRevision: 1, textTypography, atMs: 0 } })).statusCode).toBe(409);
  const before = await readFile(value.currentPath);
  const invalid = await value.app.inject({ method: 'PATCH', url: `${value.path}/text-typography`, payload: { expectedRevision: 2, textTypography: { ...textTypography, fontSha256: '0'.repeat(64) } } });
  expect(invalid.statusCode).toBe(400); expect(invalid.json().error.code).toBe('TEXT_FONT_HASH_MISMATCH'); expect(await readFile(value.currentPath)).toEqual(before);
  await value.store.update(project.projectId, 2, (current): Project => ({ ...current, textTypography: { ...textTypography, version: '1.0.0', fontId: 'not-installed' } }), []);
  const list = await value.app.inject({ url: '/api/projects' }); expect(list.statusCode).toBe(200); expect(list.json().projects[0].finalOutputReady).toBe(false);
  const report = await value.app.inject({ url: `${value.path}/final-readiness` }); expect(report.statusCode).toBe(200);
  expect(report.json().issues).toContainEqual(expect.objectContaining({ code: 'TEXT_FONT_NOT_REGISTERED', field: 'textTypography' }));
  const restored = await value.app.inject({ method: 'PATCH', url: `${value.path}/text-typography`, payload: { expectedRevision: 3, textTypography: { ...textTypography, fontId: 'default', fontSha256: catalog.fonts[0].sha256 } } });
  expect(restored.statusCode).toBe(200); expect((await value.app.inject({ url: `${value.path}/final-readiness` })).json().finalReady).toBe(true);
});

it('text_layout_http_requires_revision_and_preserves_read_only_snapshot_and_cue_boundaries', async (): Promise<void> => {
  const value = await fixture(); const original = await readFile(value.currentPath);
  const first = await value.app.inject({ url: `${value.path}/text-layout?revision=1&atMs=0&maturity=draft` });
  expect(first.statusCode).toBe(200); expect(first.headers['cache-control']).toBe('no-store');
  const result = TextLayoutResponseSchema.parse(first.json()); expect(result.visibleTexts.map((cue): string => cue.text)).toEqual([value.project.textCues[0]!.text]);
  expect(result.svg).toContain('<path'); expect(result.svg).not.toContain(value.project.textCues[1]!.text);
  const end = TextLayoutResponseSchema.parse((await value.app.inject({ url: `${value.path}/text-layout?revision=1&atMs=4000&maturity=draft` })).json());
  expect(end.boxes).toEqual([]); expect(end.visibleTexts).toEqual([]);
  expect((await value.app.inject({ url: `${value.path}/text-layout?atMs=0&maturity=draft` })).statusCode).toBe(400);
  expect((await value.app.inject({ url: `${value.path}/text-layout?revision=0&atMs=0&maturity=draft` })).statusCode).toBe(409);
  expect(await readFile(value.currentPath)).toEqual(original);
});

it('text_reading_http_recomputes_draft_review_and_preserves_source_timing_and_explicit_confirmation', async (): Promise<void> => {
  const value = await fixture(); const cueId: string = value.project.textCues[0]!.id;
  const before = await value.store.update(value.project.projectId, 1, (current): Project => ({ ...current,
    textCues: current.textCues.map((cue) => cue.id === cueId ? { ...cue, timingStatus: 'proposed' } : cue) }), []);
  const textReadability = { ...before.textReadability, graphemesPerSecond: 2, minHoldMs: 5000 };
  const response = await value.app.inject({ method: 'PATCH', url: `${value.path}/text-readability`, payload: { expectedRevision: 2, textReadability } });
  expect(response.statusCode).toBe(200); const saved: Project = response.json().project;
  expect(saved.revision).toBe(3); expect(saved.textReadability).toEqual(textReadability);
  for (const key of ['dataset', 'textCues', 'textLayout', 'shots', 'frames', 'assets', 'generationRecords'] as const) expect(saved[key]).toEqual(before[key]);
  expect((await value.app.inject({ url: `${value.path}/final-readiness` })).json().issues).toContainEqual(expect.objectContaining({ code: 'TEXT_READING_TOO_FAST', entityId: cueId }));
  const bytes = await readFile(value.currentPath);
  expect((await value.app.inject({ method: 'PATCH', url: `${value.path}/text-readability`, payload: { expectedRevision: 2, textReadability } })).statusCode).toBe(409);
  expect((await value.app.inject({ method: 'PATCH', url: `${value.path}/text-readability`, payload: { expectedRevision: 3, textReadability: { ...textReadability, minHoldMs: 10000, maxHoldMs: 1000 } } })).statusCode).toBe(400);
  expect(await readFile(value.currentPath)).toEqual(bytes);
  const confirmed = await value.app.inject({ method: 'POST', url: `${value.path}/text/${encodeURIComponent(cueId)}/confirm`, payload: { expectedRevision: 3 } });
  expect(confirmed.statusCode).toBe(200);
  expect((await value.app.inject({ url: `${value.path}/final-readiness` })).json().finalReady).toBe(true);
  expect(confirmed.json().project.textCues.find((cue: { id: string }) => cue.id === cueId)).toMatchObject({ startMs: before.textCues[0]!.startMs, endMs: before.textCues[0]!.endMs, timingStatus: 'confirmed' });
});

it('text_layout_settings_preserve_assets_approvals_and_text_and_recompute_every_public_final_gate', async (): Promise<void> => {
  const value = await fixture();
  expect((await value.app.inject({ url: `${value.path}/final-readiness` })).json().finalReady).toBe(true);
  const layout = { ...value.project.textLayout, fontSize: 0.12, maxLines: 1 };
  const saved = await value.app.inject({ method: 'PATCH', url: `${value.path}/text-layout`, payload: { expectedRevision: 1, textLayout: layout } });
  expect(saved.statusCode).toBe(200); const project: Project = saved.json().project;
  expect(project.revision).toBe(2); expect(project.textLayout).toEqual(layout);
  expect(project.textLayoutControl).toEqual({ version: '1.0.0', mode: 'manual', plannedInputHash: null });
  for (const key of ['textCues', 'audioCues', 'shots', 'frames', 'assets', 'generationRecords', 'sources'] as const) expect(project[key]).toEqual(value.project[key]);
  const report = (await value.app.inject({ url: `${value.path}/final-readiness` })).json();
  expect(report.finalReady).toBe(false); expect(report.issues).toContainEqual(expect.objectContaining({ code: 'TEXT_LAYOUT_OVERFLOW' }));
  const summaries = (await value.app.inject({ url: '/api/projects' })).json().projects;
  expect(summaries[0].finalOutputReady).toBe(false);
  for (const extension of ['pdf', 'csv']) {
    const output = await value.app.inject({ url: `${value.path}/export.${extension}?maturity=final` });
    expect(output.statusCode).toBe(409); expect(output.json().error.code).toBe('FINAL_OUTPUT_NOT_READY');
  }
  const before = await readFile(value.currentPath);
  expect((await value.app.inject({ method: 'PATCH', url: `${value.path}/text-layout`, payload: { expectedRevision: 1, textLayout: layout } })).statusCode).toBe(409);
  expect((await value.app.inject({ method: 'PATCH', url: `${value.path}/text-layout`, payload: { expectedRevision: 2, textLayout: { ...layout, fontSize: 0 } } })).statusCode).toBe(400);
  expect(await readFile(value.currentPath)).toEqual(before);
  const repaired = await value.app.inject({ method: 'PATCH', url: `${value.path}/text-layout`, payload: { expectedRevision: 2, textLayout: value.project.textLayout, mode: 'automatic' } });
  expect(repaired.statusCode).toBe(200); expect((await value.app.inject({ url: `${value.path}/final-readiness` })).json().finalReady).toBe(true);
  expect(repaired.json().project.textLayoutControl).toEqual({ version: '1.0.0', mode: 'automatic', plannedInputHash: null });
});

it('text_layout_http_does_not_send_unconfirmed_final_or_invalid_authority_text', async (): Promise<void> => {
  const value = await fixture();
  await value.store.update(value.project.projectId, 1, (project): Project => ({ ...project, textCues: project.textCues.map((cue) => ({ ...cue, timingStatus: 'proposed' })) }), []);
  const final = TextLayoutResponseSchema.parse((await value.app.inject({ url: `${value.path}/text-layout?revision=2&atMs=0&maturity=final` })).json());
  expect(final.visibleTexts).toEqual([]); expect(final.boxes).toEqual([]); expect(final.svg).not.toContain('<path');
  const draft = TextLayoutResponseSchema.parse((await value.app.inject({ url: `${value.path}/text-layout?revision=2&atMs=0&maturity=draft` })).json());
  expect(draft.visibleTexts).toHaveLength(1);
});

it('text_layout_final_bundle_checks_actual_font_before_publishing_any_files', async (): Promise<void> => {
  const value = await fixture();
  await value.store.update(value.project.projectId, 1, (project): Project => ({ ...project, textLayout: { ...project.textLayout, fontSize: 0.12, maxLines: 1 } }), []);
  await value.store.close(); const original = await readFile(value.currentPath);
  const archive = await readReviewArchive(dirname(dirname(value.currentPath)), value.project.projectId);
  const output: string = join(dirname(dirname(dirname(value.currentPath))), 'blocked-final');
  await expect(writeReviewBundle(archive, { output, maturity: 'final', fontPath: resolve('assets/fonts/NanumGothic-Regular.ttf'),
    createdAt: '2026-09-11T00:00:00.000Z', build: readBuildManifest() }, [])).rejects.toMatchObject({ code: 'FINAL_OUTPUT_NOT_READY' });
  await expect(access(output)).rejects.toMatchObject({ code: 'ENOENT' }); expect(await readFile(value.currentPath)).toEqual(original);
});

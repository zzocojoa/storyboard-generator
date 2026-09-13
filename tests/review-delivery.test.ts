import { mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { randomBytes, randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';
import { getDocument, OPS } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { afterEach, expect, it } from 'vitest';
import { readBuildManifest } from '../src/build.js';
import type { Project } from '../src/domain/schema.js';
import { initialOutputOptions } from '../src/exporters/output-options.js';
import { createReviewDelivery, previewReviewDelivery } from '../src/exporters/review-delivery.js';
import { ReviewBundleInputSchema } from '../src/exporters/review-delivery-schema.js';
import type { ReviewBundleInput, ReviewBundlePreview, ReviewBundleResult, ReviewDeliveryAttempt } from '../src/exporters/review-delivery-schema.js';
import { verifyReviewDelivery } from '../src/exporters/review-delivery-recovery.js';
import type { ReviewBundleManifest } from '../src/exporters/review-bundle.js';
import { sha256Bytes, sha256Text } from '../src/importers/integrity.js';
import { exportProjectJson } from '../src/exporters/json.js';
import { httpErrorPolicy, errorBody } from '../src/server/app.js';
import { registerReviewBundleRoutes } from '../src/server/review-bundle-routes.js';
import { finalFixture, readyVisualFixture } from './readiness-fixtures.js';
import { TEST_TEXT_FONT_PATH } from './helpers.js';

type Fixture = { root: string; dataRoot: string; directory: string; project: Project; input: ReviewBundleInput; before: Buffer };
const roots: string[] = [];
const secretPrompt: string = 'PRIVATE-GENERATION-PROMPT';
const literalName: string = '제작자[가].*';
afterEach(async (): Promise<void> => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

async function savedFixture(project: Project, media: ReadonlyMap<string, Buffer>): Promise<Fixture> {
  const root: string = await mkdtemp(join(tmpdir(), 'cutroom-review-delivery-')); roots.push(root);
  const dataRoot: string = join(root, 'data'); const directory: string = join(dataRoot, sha256Text(project.projectId));
  await mkdir(join(directory, 'versions'), { recursive: true }); await mkdir(join(directory, 'assets'));
  const before: Buffer = Buffer.from(exportProjectJson(project));
  await writeFile(join(directory, 'project.json'), before); await writeFile(join(directory, 'versions/000000.json'), before);
  for (const asset of project.assets) await writeFile(join(directory, asset.path), media.get(asset.id)!);
  return { root, dataRoot, directory, project, before, input: { version: '1.0.0', expectedRevision: 0, directory: root, maturity: 'draft', profile: 'internal', includeMedia: false,
    delivery: { packageName: '검토', packageVersion: '01', purpose: 'production-review', recipient: literalName, contents: { sourceContent: false, generationPrompts: false } }, redactTerms: [],
    outputOptions: { ...initialOutputOptions(), scope: { kind: 'segments', segmentIds: [project.shots[0]!.segmentId] } } } };
}

async function fixture(): Promise<Fixture> {
  const base = await readyVisualFixture();
  const project: Project = { ...base.project, title: `${literalName} contact@example.com`,
    generationRecords: [{ id: 'private-generation', provider: 'codex-app', model: 'imagegen', modelVersion: null, generatorBuild: null,
      requestId: 'private-request', prompt: secretPrompt, templateVersion: '1', seed: null, referenceHashes: [],
      resultAssetIds: [base.project.assets[0]!.id], shotIds: [base.project.shots[0]!.id], createdAt: '2026-09-07T00:00:00.000Z' }] };
  return savedFixture(project, new Map(project.assets.map((asset): [string, Buffer] => [asset.id, base.bytes])));
}
async function preview(h: Fixture, input: ReviewBundleInput): Promise<ReviewBundlePreview> {
  return previewReviewDelivery(h.dataRoot, h.project.projectId, input, TEST_TEXT_FONT_PATH, readBuildManifest());
}
async function create(h: Fixture, input: ReviewBundleInput, basis: string): Promise<ReviewBundleResult> {
  return createReviewDelivery(h.dataRoot, h.project.projectId, input, basis, TEST_TEXT_FONT_PATH, readBuildManifest(), null);
}
async function pdfContents(path: string): Promise<{ text: string; images: number }> {
  const task = getDocument({ data: new Uint8Array(await readFile(path)), useSystemFonts: false, disableFontFace: true });
  try {
    const pdf = await task.promise; const text: string[] = []; let images: number = 0;
    for (let index: number = 1; index <= pdf.numPages; index += 1) {
      const page = await pdf.getPage(index); const content = await page.getTextContent();
      text.push(content.items.flatMap((item): string[] => 'str' in item ? [item.str] : []).join(''));
      images += (await page.getOperatorList()).fnArray.filter((op: number): boolean => [OPS.paintImageXObject, OPS.paintInlineImageXObject].includes(op)).length;
    }
    return { text: text.join('\n'), images };
  } finally { await task.destroy(); }
}

it('review_delivery_internal_content_choices_media_hashes_and_selection_preserve_original_archive', async (): Promise<void> => {
  const h = await fixture(); const first = await preview(h, h.input);
  expect(first.canCreate).toBe(true); expect(first.fileCount).toBe(11); expect(first.selectedShots).toBe(1); expect(first.archiveShots).toBe(h.project.shots.length);
  await expect(readdir(first.output)).rejects.toMatchObject({ code: 'ENOENT' });
  const result = await create(h, h.input, first.basisSha256);
  const saved = JSON.parse(await readFile(join(result.output, 'project.json'), 'utf8')) as { project: Project };
  expect(saved.project.shots).toEqual(h.project.shots); expect(saved.project.dataset).toEqual(h.project.dataset);
  expect(saved.project.sources[0]!.content).toContain('REDACTED:source-content');
  expect(saved.project.generationRecords[0]!.prompt).toContain('REDACTED:generation-prompt');
  expect(await readFile(join(result.output, 'generation-audit.json'), 'utf8')).not.toContain(secretPrompt);
  const complete: ReviewBundleInput = { ...h.input, includeMedia: true, delivery: { ...h.input.delivery, packageVersion: '02', contents: { sourceContent: true, generationPrompts: true } } };
  const next = await preview(h, complete); expect(next.mediaBytes).toBeGreaterThan(0); expect(next.mediaFiles).toBe(h.project.assets.length);
  const full = await create(h, complete, next.basisSha256);
  expect(full.files.length).toBe(next.fileCount);
  const restored = JSON.parse(await readFile(join(full.output, 'project.json'), 'utf8')) as { project: Project };
  expect(restored.project).toEqual(h.project);
  const manifest = JSON.parse(await readFile(join(full.output, 'bundle-manifest.json'), 'utf8')) as ReviewBundleManifest;
  expect(manifest.delivery).toEqual(complete.delivery); expect(manifest.presentation?.shotIds).toEqual([h.project.shots[0]!.id]);
  for (const file of full.files) { const bytes = await readFile(join(full.output, file.path)); expect(bytes.length).toBe(file.bytes); expect(sha256Bytes(bytes)).toBe(file.sha256); }
  expect(await readFile(join(h.directory, 'project.json'))).toEqual(h.before);
  expect(await readFile(join(h.directory, 'versions/000000.json'))).toEqual(h.before);
});

it('review_delivery_external_literal_terms_redact_json_csv_pdf_and_metadata_without_media', async (): Promise<void> => {
  const h = await fixture(); const input: ReviewBundleInput = { ...h.input, profile: 'external', redactTerms: [literalName] };
  const checked = await preview(h, input); const result = await create(h, input, checked.basisSha256);
  for (const file of result.files.filter((file): boolean => file.path.endsWith('.json') || file.path.endsWith('.csv'))) {
    const content: string = await readFile(join(result.output, file.path), 'utf8'); expect(content).not.toContain(literalName); expect(content).not.toContain('contact@example.com'); expect(content).not.toContain(secretPrompt);
  }
  const pdf = await pdfContents(join(result.output, 'storyboard.pdf')); expect(pdf.images).toBe(0); expect(pdf.text).not.toContain(literalName); expect(pdf.text).not.toContain('contact@example.com'); expect(pdf.text).toContain('EXTERNAL');
  expect(result.files.some((file): boolean => file.path.startsWith('media/'))).toBe(false);
  const manifest = JSON.parse(await readFile(join(result.output, 'bundle-manifest.json'), 'utf8')) as ReviewBundleManifest;
  expect(manifest.delivery?.recipient).toContain('REDACTED:explicit-pii');
  expect(ReviewBundleInputSchema.safeParse({ ...input, includeMedia: true }).success).toBe(false);
  expect(ReviewBundleInputSchema.safeParse({ ...input, delivery: { ...input.delivery, contents: { sourceContent: true, generationPrompts: false } } }).success).toBe(false);
  expect(await readFile(join(h.directory, 'project.json'))).toEqual(h.before);
});

it('review_delivery_rejects_stale_settings_revision_and_changed_asset_before_publication', async (): Promise<void> => {
  const h = await fixture(); const checked = await preview(h, h.input);
  await expect(create(h, { ...h.input, delivery: { ...h.input.delivery, recipient: '다른 수신자' } }, checked.basisSha256)).rejects.toMatchObject({ code: 'REVIEW_DELIVERY_STALE' });
  await expect(create(h, { ...h.input, expectedRevision: 1 }, checked.basisSha256)).rejects.toMatchObject({ code: 'REVISION_CONFLICT' });
  await writeFile(join(h.directory, h.project.assets[0]!.path), 'changed image');
  await expect(create(h, h.input, checked.basisSha256)).rejects.toMatchObject({ code: 'REVIEW_DELIVERY_STALE' });
  await expect(readdir(checked.output)).rejects.toMatchObject({ code: 'ENOENT' });
  const brokenMedia = await preview(h, { ...h.input, includeMedia: true }); expect(brokenMedia.canCreate).toBe(false); expect(brokenMedia.issues.join(' ')).toContain(h.project.assets[0]!.id);
});

it('review_delivery_requires_existing_parent_and_preserves_colliding_folder_and_symlink_target', async (): Promise<void> => {
  const h = await fixture();
  for (const directory of ['relative', join(h.root, 'missing'), h.dataRoot]) await expect(preview(h, { ...h.input, directory })).rejects.toMatchObject({ code: 'INVALID_REVIEW_DIRECTORY' });
  const checked = await preview(h, h.input); await mkdir(checked.output); await writeFile(join(checked.output, 'sentinel'), 'preserved');
  expect((await preview(h, h.input)).canCreate).toBe(false);
  await expect(create(h, h.input, checked.basisSha256)).rejects.toMatchObject({ code: 'REVIEW_DELIVERY_BLOCKED' });
  expect(await readFile(join(checked.output, 'sentinel'), 'utf8')).toBe('preserved');
  const input: ReviewBundleInput = { ...h.input, delivery: { ...h.input.delivery, packageVersion: '02' } }; const second = await preview(h, input);
  await symlink(checked.output, second.output);
  expect((await preview(h, input)).canCreate).toBe(false); expect(await readFile(join(second.output, 'sentinel'), 'utf8')).toBe('preserved');
});

it('review_delivery_final_requires_whole_project_readiness_even_for_one_selected_segment', async (): Promise<void> => {
  const ready = await finalFixture();
  const project: Project = { ...ready.project, textCues: ready.project.textCues.map((cue) => ({ ...cue, timingStatus: 'confirmed' })) };
  const h = await savedFixture(project, ready.media); const input: ReviewBundleInput = { ...h.input, maturity: 'final' }; const checked = await preview(h, input);
  expect(checked.finalReady).toBe(true); const output = await create(h, input, checked.basisSha256); expect(output.maturity).toBe('final');
  const blocked: Project = { ...project, frames: project.frames.map((frame) => frame.shotId !== project.shots[0]!.id ? { ...frame, visualReview: 'pending' } : frame) };
  const other = await savedFixture(blocked, ready.media); const badInput = { ...other.input, maturity: 'final' as const }; const bad = await preview(other, badInput);
  expect(bad.canCreate).toBe(false); await expect(create(other, badInput, bad.basisSha256)).rejects.toMatchObject({ code: 'REVIEW_DELIVERY_BLOCKED' });
  await expect(readdir(bad.output)).rejects.toMatchObject({ code: 'ENOENT' });
});

it('review_delivery_http_checks_origin_serializes_requests_and_releases_busy_after_failure', async (): Promise<void> => {
  const h = await fixture(); const app = Fastify(); registerReviewBundleRoutes(app, h.dataRoot, TEST_TEXT_FONT_PATH, readBuildManifest());
  app.setErrorHandler((error: Error, request, reply): void => { reply.status(httpErrorPolicy(error).status).send(errorBody(error, request)); });
  const url: string = `/api/projects/${encodeURIComponent(h.project.projectId)}/review-bundles`;
  try {
    const denied = await app.inject({ method: 'POST', url: `${url}/preview`, headers: { origin: 'http://untrusted.invalid' }, payload: h.input }); expect(denied.statusCode).toBe(400); expect(denied.body).toContain('FORBIDDEN_REVIEW_DELIVERY_ORIGIN');
    const results = await Promise.all([app.inject({ method: 'POST', url: `${url}/preview`, payload: h.input }), app.inject({ method: 'POST', url: `${url}/preview`, payload: h.input })]);
    expect(results.map((result): number => result.statusCode).sort()).toEqual([200, 409]);
    const checked = results.find((result): boolean => result.statusCode === 200)!.json<ReviewBundlePreview>();
    const stale = await app.inject({ method: 'POST', url, payload: { input: h.input, basisSha256: 'f'.repeat(64) } }); expect(stale.statusCode).toBe(409);
    expect((await app.inject('/api/review-bundles/status')).json().activeProjectId).toBeNull();
    const created = await app.inject({ method: 'POST', url, payload: { input: h.input, basisSha256: checked.basisSha256 } });
    expect(created.statusCode).toBe(201); expect(created.headers['cache-control']).toBe('no-store'); expect(created.json<ReviewBundleResult>().files.length).toBe(11);
    expect(await readFile(join(h.directory, 'project.json'))).toEqual(h.before);
  } finally { await app.close(); }
});

async function recoverable(h: Fixture, input: ReviewBundleInput): Promise<{ attempt: ReviewDeliveryAttempt; result: ReviewBundleResult }> {
  const checked = await preview(h, input);
  const attempt: ReviewDeliveryAttempt = { requestId: randomUUID(), recoveryKey: randomBytes(32).toString('hex'), projectId: h.project.projectId, input, basisSha256: checked.basisSha256,
    output: checked.output, attemptedAt: new Date().toISOString() };
  const result = await createReviewDelivery(h.dataRoot, h.project.projectId, input, checked.basisSha256, TEST_TEXT_FONT_PATH, readBuildManifest(), { requestId: attempt.requestId, recoveryKey: attempt.recoveryKey });
  return { attempt, result };
}

it('review_delivery_recovers_published_internal_external_records_after_source_change_without_recreating', async (): Promise<void> => {
  const h = await fixture();
  const internal = await recoverable(h, { ...h.input, includeMedia: true });
  const external = await recoverable(h, { ...h.input, profile: 'external', redactTerms: [h.project.projectId, literalName], delivery: { ...h.input.delivery, packageVersion: 'external' } });
  const edited: Buffer = Buffer.from(exportProjectJson({ ...h.project, revision: 1, title: '사용자가 생성 뒤 편집한 제목' }));
  await writeFile(join(h.directory, 'project.json'), edited);
  for (const entry of [internal, external]) {
    const before = await Promise.all(entry.result.files.map(async (file): Promise<Buffer> => readFile(join(entry.result.output, file.path))));
    for (const content of before) expect(content.includes(Buffer.from(entry.attempt.recoveryKey))).toBe(false);
    expect(await verifyReviewDelivery(h.project.projectId, entry.attempt)).toEqual(entry.result);
    expect(await Promise.all(entry.result.files.map(async (file): Promise<Buffer> => readFile(join(entry.result.output, file.path))))).toEqual(before);
  }
  const externalManifest: string = await readFile(join(external.result.output, 'bundle-manifest.json'), 'utf8');
  expect(externalManifest).not.toContain(h.project.projectId); expect(externalManifest).not.toContain(h.root); expect(externalManifest).not.toContain(literalName);
  expect(await readFile(join(h.directory, 'project.json'))).toEqual(edited);
  expect(await readFile(join(h.directory, 'versions/000000.json'))).toEqual(h.before);
  expect((await readdir(h.root)).some((name): boolean => name.startsWith('.review-'))).toBe(false);
});

it('review_delivery_recovery_rejects_wrong_request_input_missing_modified_extra_and_symlink_files', async (): Promise<void> => {
  const h = await fixture(); const { attempt, result } = await recoverable(h, h.input);
  for (const other of [{ ...attempt, requestId: randomUUID() }, { ...attempt, recoveryKey: randomBytes(32).toString('hex') }, { ...attempt, basisSha256: 'f'.repeat(64) }, { ...attempt, projectId: 'another' },
    { ...attempt, input: { ...attempt.input, delivery: { ...attempt.input.delivery, recipient: '변경' } } }]) {
    await expect(verifyReviewDelivery(h.project.projectId, other)).rejects.toMatchObject({ code: 'REVIEW_DELIVERY_VERIFICATION_FAILED' });
  }
  const csvPath: string = join(result.output, 'shots.csv'); const csv = await readFile(csvPath);
  const manifestPath: string = join(result.output, 'bundle-manifest.json'); const manifestBytes = await readFile(manifestPath);
  const manifest = JSON.parse(manifestBytes.toString('utf8')) as ReviewBundleManifest;
  const forged: Buffer = Buffer.alloc(csv.length, 120);
  await writeFile(csvPath, forged);
  await writeFile(manifestPath, JSON.stringify({ ...manifest, files: manifest.files.map((file) => file.path === 'shots.csv' ? { ...file, sha256: sha256Bytes(forged) } : file) }));
  await expect(verifyReviewDelivery(h.project.projectId, attempt)).rejects.toMatchObject({ code: 'REVIEW_DELIVERY_VERIFICATION_FAILED' });
  await writeFile(manifestPath, manifestBytes);
  await writeFile(csvPath, Buffer.alloc(csv.length, 120));
  await expect(verifyReviewDelivery(h.project.projectId, attempt)).rejects.toMatchObject({ code: 'REVIEW_DELIVERY_VERIFICATION_FAILED' });
  expect(await readFile(csvPath)).toEqual(Buffer.alloc(csv.length, 120));
  await writeFile(csvPath, csv); await rename(csvPath, join(h.root, 'saved.csv'));
  await expect(verifyReviewDelivery(h.project.projectId, attempt)).rejects.toMatchObject({ code: 'REVIEW_DELIVERY_VERIFICATION_FAILED' });
  await symlink(join(h.root, 'saved.csv'), csvPath);
  await expect(verifyReviewDelivery(h.project.projectId, attempt)).rejects.toMatchObject({ code: 'STORE_PATH_UNSAFE' });
  expect(await readFile(join(h.root, 'saved.csv'))).toEqual(csv);
  await rm(csvPath); await rename(join(h.root, 'saved.csv'), csvPath); await writeFile(join(result.output, 'unknown.txt'), 'preserve');
  await expect(verifyReviewDelivery(h.project.projectId, attempt)).rejects.toMatchObject({ code: 'REVIEW_DELIVERY_VERIFICATION_FAILED' });
  expect(await readFile(join(result.output, 'unknown.txt'), 'utf8')).toBe('preserve');
  expect(await readFile(join(h.directory, 'project.json'))).toEqual(h.before);
});

it('review_delivery_recovery_http_checks_origin_absent_legacy_and_bound_receipt_without_source_writes', async (): Promise<void> => {
  const h = await fixture(); const checked = await preview(h, h.input); const requestId: string = randomUUID();
  const attempt: ReviewDeliveryAttempt = { requestId, recoveryKey: randomBytes(32).toString('hex'), projectId: h.project.projectId, input: h.input, basisSha256: checked.basisSha256,
    output: checked.output, attemptedAt: new Date().toISOString() };
  const app = Fastify(); registerReviewBundleRoutes(app, h.dataRoot, TEST_TEXT_FONT_PATH, readBuildManifest());
  app.setErrorHandler((error: Error, request, reply): void => { reply.status(httpErrorPolicy(error).status).send(errorBody(error, request)); });
  const url: string = `/api/projects/${encodeURIComponent(h.project.projectId)}/review-bundles`;
  try {
    const absent = await app.inject({ method: 'POST', url: `${url}/verify`, payload: attempt });
    expect(absent.statusCode).toBe(404); expect(absent.body).toContain('REVIEW_DELIVERY_NOT_FOUND');
    const denied = await app.inject({ method: 'POST', url: `${url}/verify`, payload: attempt, headers: { origin: 'http://untrusted.invalid' } });
    expect(denied.statusCode).toBe(400);
    const created = await app.inject({ method: 'POST', url, payload: { input: h.input, basisSha256: checked.basisSha256, credential: { requestId, recoveryKey: attempt.recoveryKey } } });
    expect(created.statusCode).toBe(201);
    const verified = await app.inject({ method: 'POST', url: `${url}/verify`, payload: attempt });
    expect(verified.statusCode).toBe(200); expect(verified.json()).toEqual(created.json()); expect(verified.headers['cache-control']).toBe('no-store');
    const legacyInput: ReviewBundleInput = { ...h.input, delivery: { ...h.input.delivery, packageVersion: 'legacy' } };
    const legacyChecked = await preview(h, legacyInput); const legacy = await create(h, legacyInput, legacyChecked.basisSha256);
    await expect(verifyReviewDelivery(h.project.projectId, { ...attempt, input: legacyInput, basisSha256: legacyChecked.basisSha256, output: legacy.output })).rejects.toMatchObject({ code: 'REVIEW_DELIVERY_VERIFICATION_FAILED' });
    expect((await app.inject('/api/review-bundles/status')).json().activeProjectId).toBeNull();
    expect(await readFile(join(h.directory, 'project.json'))).toEqual(h.before);
  } finally { await app.close(); }
});

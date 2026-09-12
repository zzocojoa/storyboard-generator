import { randomUUID } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { readBuildManifest } from '../src/build.js';
import { CodexRequestStore } from '../src/codex/requests.js';
import { readDocumentSources } from '../src/documents/io.js';
import type { DocumentReviewEngine, ReviewEngineResult } from '../src/documents/review-engine.js';
import { ReviewStateSchema } from '../src/documents/review-model.js';
import { DocumentReviewService } from '../src/documents/review-service.js';
import { createApp } from '../src/server/app.js';
import { ProjectStore } from '../src/server/store.js';
import { reviewTestInput, syntheticReviewResult } from './document-review-helpers.js';
import { TEST_AUDIO_NORMALIZATION_OPTIONS, TEST_TEXT_FONT_PATH } from './helpers.js';

it('document_review_identified_start_reuses_running_and_terminal_requests_and_rejects_conflicting_or_partial_records', async (): Promise<void> => {
  const root: string = await mkdtemp(join(tmpdir(), 'document-review-identified-'));
  const input: string = join(root, 'input'); await cp('tests/fixtures/documents', input, { recursive: true });
  const sources = await readDocumentSources(input); const body = reviewTestInput(sources, input);
  await mkdir(join(root, 'web')); await writeFile(join(root, 'web', 'index.html'), '<!doctype html>');
  const pending: Array<{ resolve: (result: ReviewEngineResult) => void; reject: (reason: Error) => void }> = [];
  const engine: DocumentReviewEngine = { run: async (_prompt: string, signal: AbortSignal): Promise<ReviewEngineResult> => {
    const completion = Promise.withResolvers<ReviewEngineResult>(); pending.push(completion);
    const abort = (): void => completion.reject(new Error('검토 취소'));
    signal.addEventListener('abort', abort, { once: true });
    try { return await completion.promise; } finally { signal.removeEventListener('abort', abort); }
  } };
  const service = new DocumentReviewService(join(root, 'reviews'), engine);
  const store = new ProjectStore(join(root, 'data'));
  const app = await createApp({ host: '127.0.0.1', port: 0, dataRoot: join(root, 'data'), webRoot: join(root, 'web'),
    pdfFontPath: TEST_TEXT_FONT_PATH, audioNormalization: TEST_AUDIO_NORMALIZATION_OPTIONS,
    codex: { requestRoot: join(root, 'requests'), speechVoice: 'Yuna' } }, store,
  new CodexRequestStore(join(root, 'requests'), readBuildManifest()), undefined, service);
  try {
    const id: string = randomUUID(); const url: string = `/api/document-reviews/${id}/start`;
    const foreign = await app.inject({ method: 'POST', url, payload: body, headers: { origin: 'https://unrelated.test' } });
    expect(foreign.json().error.code).toBe('FORBIDDEN_DOCUMENT_REVIEW_ORIGIN'); expect(pending).toHaveLength(0);
    const invalid = await app.inject({ method: 'POST', url: '/api/document-reviews/not-a-uuid/start', payload: body });
    expect(invalid.statusCode).toBe(400);
    const started = await app.inject({ method: 'POST', url, payload: body });
    expect(started.statusCode).toBe(202); expect(ReviewStateSchema.parse(started.json().review).id).toBe(id);
    const duplicate = await app.inject({ method: 'POST', url, payload: body });
    expect(duplicate.json()).toEqual(started.json()); expect(pending).toHaveLength(1);
    const conflict = await app.inject({ method: 'POST', url, payload: { ...body, production: { ...body.production, width: '4' } } });
    expect(conflict.statusCode).toBe(409); expect(conflict.json().error).toMatchObject({ code: 'DOCUMENT_REVIEW_ID_CONFLICT', scope: 'request', retryable: false });
    const second: string = randomUUID(); const secondUrl: string = `/api/document-reviews/${second}/start`;
    const busy = await app.inject({ method: 'POST', url: secondUrl, payload: body });
    expect(busy.statusCode).toBe(409); expect(busy.json().error.code).toBe('DOCUMENT_REVIEW_BUSY');
    expect((await app.inject(`/api/document-reviews/${second}`)).statusCode).toBe(404);
    pending[0]!.resolve({ model: 'test-model', result: syntheticReviewResult(sources) });
    await expect.poll(async (): Promise<string> => (await service.read(id)).status).toBe('completed');
    const files: string[] = await readdir(join(root, 'reviews', 'requests'));
    const bytes: Buffer[] = await Promise.all(files.map((file: string): Promise<Buffer> => readFile(join(root, 'reviews', 'requests', file))));
    const completed = await app.inject({ method: 'POST', url, payload: body });
    expect(completed.json().review.status).toBe('completed'); expect(completed.json().review.id).toBe(id); expect(pending).toHaveLength(1);
    expect(await Promise.all(files.map((file: string): Promise<Buffer> => readFile(join(root, 'reviews', 'requests', file))))).toEqual(bytes);
    expect((await app.inject({ method: 'POST', url: secondUrl, payload: body })).statusCode).toBe(202);
    await app.inject({ method: 'POST', url: `/api/document-reviews/${second}/cancel` });
    expect((await app.inject({ method: 'POST', url: secondUrl, payload: body })).json().review.status).toBe('cancelled');
    expect(pending).toHaveLength(2);
    const failed: string = randomUUID(); const failedUrl: string = `/api/document-reviews/${failed}/start`;
    await app.inject({ method: 'POST', url: failedUrl, payload: body }); pending[2]!.reject(new Error('검증용 엔진 실패'));
    await expect.poll(async (): Promise<string> => (await service.read(failed)).status).toBe('failed');
    expect((await app.inject({ method: 'POST', url: failedUrl, payload: body })).json().review.status).toBe('failed'); expect(pending).toHaveLength(3);
    const partial: string = randomUUID(); const partialPath: string = join(root, 'reviews', 'requests', `${partial}.input.json`);
    await writeFile(partialPath, JSON.stringify({ input: body, preset: null })); const partialBytes: Buffer = await readFile(partialPath);
    const incomplete = await app.inject({ method: 'POST', url: `/api/document-reviews/${partial}/start`, payload: body });
    expect(incomplete.statusCode).toBe(423); expect(incomplete.json().error).toMatchObject({ code: 'DOCUMENT_REVIEW_START_INCOMPLETE', scope: 'request', operatorActionRequired: true, mutationBlocked: false });
    expect(await readFile(partialPath)).toEqual(partialBytes); expect(pending).toHaveLength(3);
    expect(await store.list()).toHaveLength(0);
    await app.close();
    const reopened = new DocumentReviewService(join(root, 'reviews'), engine); await reopened.initialize();
    try { expect((await reopened.startIdentified(id, body)).status).toBe('completed'); expect(pending).toHaveLength(3); }
    finally { await reopened.close(); }
  } finally { await app.close(); await rm(root, { recursive: true, force: true }); }
});

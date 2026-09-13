import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, it } from 'vitest';
import { readBuildManifest } from '../src/build.js';
import { CodexRequestStore } from '../src/codex/requests.js';
import { readDocumentSources } from '../src/documents/io.js';
import { ReviewStateSchema } from '../src/documents/review-model.js';
import { createApp } from '../src/server/app.js';
import { ProjectStore } from '../src/server/store.js';
import { REVIEW_PRODUCTION, reviewTestInput, syntheticReviewResult, writeReviewEngineFixture } from './document-review-helpers.js';
import { TEST_AUDIO_NORMALIZATION_OPTIONS } from './helpers.js';

it('document_review_api_rejects_invalid_origin_body_and_busy_then_cancels_without_project_changes', async (): Promise<void> => {
  const root: string = await mkdtemp(join(tmpdir(), 'document-review-api-'));
  const input: string = join(root, 'input'); await cp('tests/fixtures/documents', input, { recursive: true });
  const sources = await readDocumentSources(input);
  const executable = await writeReviewEngineFixture(root, syntheticReviewResult(sources), 'timeout', 0);
  const webRoot = join(root, 'web'); await mkdir(webRoot); await writeFile(join(webRoot, 'index.html'), '<!doctype html>');
  const store = new ProjectStore(join(root, 'data'));
  const app = await createApp({ host: '127.0.0.1', port: 4317, dataRoot: join(root, 'data'), webRoot,
    pdfFontPath: resolve('assets/fonts/NanumGothic-Regular.ttf'), audioNormalization: TEST_AUDIO_NORMALIZATION_OPTIONS,
    codex: { requestRoot: join(root, 'requests'), speechVoice: 'Yuna' }, documentReview: { executable, requestRoot: join(root, 'reviews'), timeoutMs: 3000 } },
  store, new CodexRequestStore(join(root, 'requests'), readBuildManifest()));
  try {
    const body = reviewTestInput(sources, input);
    expect((await app.inject({ method: 'GET', url: '/api/document-reviews/status' })).json()).toEqual({ configured: true, activeRequestId: null });
    const foreign = await app.inject({ method: 'POST', url: '/api/document-reviews', headers: { origin: 'https://unrelated.test' }, payload: body });
    expect(foreign.json().error.code).toBe('FORBIDDEN_DOCUMENT_REVIEW_ORIGIN');
    const invalid = await app.inject({ method: 'POST', url: '/api/document-reviews', payload: { ...body, sourceFingerprint: 'missing' } });
    expect(invalid.statusCode).toBe(400);
    const started = await app.inject({ method: 'POST', url: '/api/document-reviews', payload: body });
    expect(started.statusCode).toBe(202); const review = ReviewStateSchema.parse(started.json().review);
    const duplicate = await app.inject({ method: 'POST', url: '/api/document-reviews', payload: body });
    expect(duplicate.json().review.id).toBe(review.id);
    const busy = await app.inject({ method: 'POST', url: '/api/document-reviews', payload: { ...body, production: REVIEW_PRODUCTION } });
    expect(busy.statusCode).toBe(409); expect(busy.json().error.scope).toBe('request');
    const early = await app.inject({ method: 'POST', url: `/api/document-reviews/${review.id}/validate`, payload: body });
    expect(early.statusCode).toBe(409);
    const cancelled = await app.inject({ method: 'POST', url: `/api/document-reviews/${review.id}/cancel` });
    expect(cancelled.json().review.status).toBe('cancelled');
    const preset = await app.inject({ method: 'POST', url: '/api/document-presets', payload: { name: '공통 설정', fields: REVIEW_PRODUCTION } });
    expect(preset.statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/api/document-presets' })).json().presets).toHaveLength(1);
    expect(await store.list()).toHaveLength(0);
    const missing = await app.inject({ method: 'GET', url: '/api/document-reviews/7b98f43d-d2ca-45b1-83d4-304098eed0dd' });
    expect(missing.statusCode).toBe(404);
  } finally { await app.close(); await rm(root, { recursive: true, force: true }); }
});

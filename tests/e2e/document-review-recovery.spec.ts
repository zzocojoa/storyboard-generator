import { appendFile, cp, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, test } from '@playwright/test';
import { readBuildManifest } from '../../src/build.js';
import { CodexRequestStore } from '../../src/codex/requests.js';
import { readDocumentSources } from '../../src/documents/io.js';
import type { DocumentReviewEngine, ReviewEngineResult } from '../../src/documents/review-engine.js';
import { DocumentReviewService } from '../../src/documents/review-service.js';
import { createApp } from '../../src/server/app.js';
import { ProjectStore } from '../../src/server/store.js';
import { syntheticReviewResult } from '../document-review-helpers.js';
import { TEST_AUDIO_NORMALIZATION_OPTIONS, TEST_TEXT_FONT_PATH } from '../helpers.js';

test('e2e_document_review_reconnects_same_request_after_reload_and_preserves_edits_and_applied_results', async ({ page }): Promise<void> => {
  const root: string = await mkdtemp(join(tmpdir(), 'document-review-recovery-')); const input: string = join(root, 'input');
  await cp('tests/fixtures/documents', input, { recursive: true });
  const result = syntheticReviewResult(await readDocumentSources(input));
  const pending: Array<{ resolve: (value: ReviewEngineResult) => void }> = [];
  const engine: DocumentReviewEngine = { run: async (_prompt: string, signal: AbortSignal): Promise<ReviewEngineResult> => {
    const completion = Promise.withResolvers<ReviewEngineResult>();
    const aborted = (): void => { completion.reject(new Error('검토 검증이 취소됐습니다.')); };
    signal.addEventListener('abort', aborted, { once: true }); pending.push({ resolve: completion.resolve });
    try { return await completion.promise; } finally { signal.removeEventListener('abort', aborted); }
  } };
  const reviews = new DocumentReviewService(join(root, 'reviews'), engine); const store = new ProjectStore(join(root, 'data'));
  const app = await createApp({ host: '127.0.0.1', port: 0, dataRoot: join(root, 'data'), webRoot: resolve(process.env.CUTROOM_E2E_WEB_ROOT ?? 'dist/web'),
    pdfFontPath: TEST_TEXT_FONT_PATH, audioNormalization: TEST_AUDIO_NORMALIZATION_OPTIONS,
    codex: { requestRoot: join(root, 'requests'), speechVoice: 'Yuna' } }, store, new CodexRequestStore(join(root, 'requests'), readBuildManifest()), undefined, reviews);
  const starts: string[] = []; const cancels: string[] = []; const validates: string[] = [];
  page.on('request', (request): void => {
    if (request.method() !== 'POST') return;
    if ((/\/api\/document-reviews\/[^/]+\/start$/u.test(request.url()))) starts.push(request.url());
    if (/\/api\/document-reviews\/[^/]+\/cancel$/u.test(request.url())) cancels.push(request.url());
    if (/\/api\/document-reviews\/[^/]+\/validate$/u.test(request.url())) validates.push(request.url());
  });
  try {
    await page.goto(await app.listen({ host: '127.0.0.1', port: 0 }));
    const open = page.locator('.welcome').getByRole('button', { name: /제작 문서 8개/ });
    await open.click(); const panel = page.getByRole('dialog');
    await panel.getByLabel('제작 문서 폴더', { exact: true }).fill(input);
    await panel.getByRole('button', { name: '문서 검토', exact: true }).click();
    await panel.getByRole('button', { name: 'Codex로 검토하고 채우기', exact: true }).click();
    await expect(panel.getByText('이전 검토 요청을 보관했습니다.', { exact: false })).toBeVisible();
    await expect(panel.getByRole('button', { name: '검토 취소', exact: true })).toBeEnabled();
    const firstId: string = reviews.activeRequestId()!; expect(firstId).not.toBeNull();
    await panel.getByLabel('화면비 가로', { exact: true }).fill('4');
    await panel.getByLabel('화면비 가로', { exact: true }).fill('');
    await page.reload(); await open.click();
    await expect(panel.getByRole('button', { name: '이전 검토에 다시 연결', exact: true })).toBeDisabled();
    expect(starts).toHaveLength(1); expect(cancels).toHaveLength(0); expect(validates).toHaveLength(0);
    expect(reviews.activeRequestId()).toBe(firstId);
    await panel.getByRole('button', { name: '원본 다시 확인', exact: true }).click();
    await panel.getByRole('button', { name: '이전 검토에 다시 연결', exact: true }).click();
    await expect(panel.locator('.document-review-note')).toContainText('같은 검토 요청에 다시 연결했습니다.');
    expect(pending).toHaveLength(1); expect(starts).toHaveLength(1);
    pending[0]!.resolve({ model: 'test-codex-model', result });
    await expect(panel.locator('.document-review-note')).toContainText('입력값을 채웠습니다.');
    await expect(panel.getByLabel('프레임레이트', { exact: true })).toHaveValue('30/1');
    await expect(panel.getByLabel('화면비 가로', { exact: true })).toHaveValue('');
    await panel.getByLabel('화면비 가로', { exact: true }).fill('4');
    await panel.getByRole('button', { name: '입력된 제안 모두 확인', exact: true }).click();
    const validated: number = validates.length;
    await page.reload(); await open.click();
    expect(starts).toHaveLength(1); expect(validates).toHaveLength(validated);
    await panel.getByRole('button', { name: '원본 다시 확인', exact: true }).click();
    await panel.getByRole('button', { name: '이전 검토에 다시 연결', exact: true }).click();
    await expect(panel.locator('.document-review-note')).toContainText('이미 반영한 검토 결과');
    await expect(panel.locator('.document-review-results')).toContainText(result.summary);
    await expect(panel.getByLabel('화면비 가로', { exact: true })).toHaveValue('4');
    await expect(panel.getByRole('button', { name: '입력된 제안 모두 확인', exact: true })).toHaveCount(0);
    expect(starts).toHaveLength(1);
    await panel.getByRole('button', { name: '현재 값으로 다시 검토', exact: true }).click();
    await expect(panel.getByRole('button', { name: '검토 취소', exact: true })).toBeEnabled();
    await panel.getByLabel('인물 ID: 민아', { exact: true }).selectOption('helper');
    await page.reload(); await open.click();
    await panel.getByRole('button', { name: '원본 다시 확인', exact: true }).click();
    await panel.getByRole('button', { name: '이전 검토에 다시 연결', exact: true }).click();
    await expect(panel.locator('.document-review-note')).toContainText('같은 검토 요청');
    pending[1]!.resolve({ model: 'test-codex-model', result: { summary: '현재 연결과 제작 설정을 유지합니다.', suggestions: [] } });
    await expect(panel.locator('.document-review-error')).toContainText('검토 중 원본 또는 연결을 수정');
    await expect(panel.getByLabel('인물 ID: 민아', { exact: true })).toHaveValue('helper');
    await expect(panel.getByLabel('화면비 가로', { exact: true })).toHaveValue('4');
    await appendFile(join(input, 'broadcast_readable_script.md'), '\n검증용 원문 변경\n');
    await page.reload(); await open.click();
    await panel.getByRole('button', { name: '원본 다시 확인', exact: true }).click();
    await expect(panel).toContainText('manifest 해시 불일치');
    await expect(panel.getByRole('button', { name: '이전 검토에 다시 연결', exact: true })).toBeDisabled();
    await expect(panel.getByLabel('화면비 가로', { exact: true })).toHaveValue('4');
    expect(starts).toHaveLength(2); expect(cancels).toHaveLength(0);
    expect((await app.inject('/api/projects')).json().projects).toHaveLength(0);
  } finally { await page.context().close(); await app.close(); await rm(root, { recursive: true, force: true }); }
});

test('e2e_document_review_recovers_lost_start_response_and_unsent_request_with_the_previously_saved_id', async ({ page }): Promise<void> => {
  const root: string = await mkdtemp(join(tmpdir(), 'document-review-lost-response-')); const input: string = join(root, 'input');
  await cp('tests/fixtures/documents', input, { recursive: true });
  const result = syntheticReviewResult(await readDocumentSources(input));
  const pending: Array<{ resolve: (value: ReviewEngineResult) => void }> = [];
  const engine: DocumentReviewEngine = { run: async (_prompt: string, signal: AbortSignal): Promise<ReviewEngineResult> => {
    const completion = Promise.withResolvers<ReviewEngineResult>(); pending.push(completion);
    const abort = (): void => completion.reject(new Error('검토 검증 취소'));
    signal.addEventListener('abort', abort, { once: true });
    try { return await completion.promise; } finally { signal.removeEventListener('abort', abort); }
  } };
  const reviews = new DocumentReviewService(join(root, 'reviews'), engine); const store = new ProjectStore(join(root, 'data'));
  const app = await createApp({ host: '127.0.0.1', port: 0, dataRoot: join(root, 'data'), webRoot: resolve(process.env.CUTROOM_E2E_WEB_ROOT ?? 'dist/web'),
    pdfFontPath: TEST_TEXT_FONT_PATH, audioNormalization: TEST_AUDIO_NORMALIZATION_OPTIONS,
    codex: { requestRoot: join(root, 'requests'), speechVoice: 'Yuna' } }, store, new CodexRequestStore(join(root, 'requests'), readBuildManifest()), undefined, reviews);
  try {
    await page.goto(await app.listen({ host: '127.0.0.1', port: 0 }));
    const open = page.locator('.welcome').getByRole('button', { name: /제작 문서 8개/ }); await open.click(); const panel = page.getByRole('dialog');
    await panel.getByLabel('제작 문서 폴더', { exact: true }).fill(input);
    await panel.getByRole('button', { name: '문서 검토', exact: true }).click();
    const requestIds: string[] = [];
    page.on('request', (request): void => {
      const matched: RegExpMatchArray | null = request.url().match(/\/api\/document-reviews\/([^/]+)\/start$/u);
      if (matched !== null && request.method() === 'POST') requestIds.push(matched[1]!);
    });
    const startRoute: RegExp = /\/api\/document-reviews\/[^/]+\/start$/u;
    await page.route(startRoute, async (route): Promise<void> => {
      const id: string = route.request().url().split('/').at(-2)!;
      const savedBeforePost: boolean = await page.evaluate((requestId: string): boolean => Object.values(localStorage).some((value: string): boolean => value.includes(requestId)), id);
      expect(savedBeforePost).toBe(true);
      const response = await route.fetch(); expect(response.status()).toBe(202);
      await route.abort('failed');
    }, { times: 1 });
    await panel.getByRole('button', { name: 'Codex로 검토하고 채우기', exact: true }).click();
    await expect(panel.locator('.document-review-error')).toContainText('서버에 연결하지 못했습니다.');
    const firstId: string = requestIds[0]!; expect(reviews.activeRequestId()).toBe(firstId); expect(pending).toHaveLength(1);
    await panel.getByLabel('화면비 가로', { exact: true }).fill('4');
    await page.reload(); await open.click();
    await expect(panel.getByRole('button', { name: '이전 검토에 다시 연결', exact: true })).toBeDisabled();
    await panel.getByRole('button', { name: '원본 다시 확인', exact: true }).click();
    await panel.getByRole('button', { name: '이전 검토에 다시 연결', exact: true }).click();
    await expect(panel.locator('.document-review-note')).toContainText('같은 검토 요청');
    pending[0]!.resolve({ model: 'test-model', result });
    await expect(panel.locator('.document-review-note')).toContainText('입력값을 채웠습니다.');
    await expect(panel.getByLabel('화면비 가로', { exact: true })).toHaveValue('4');
    expect(requestIds).toEqual([firstId]); expect(pending).toHaveLength(1);
    await page.route(startRoute, async (route): Promise<void> => { await route.abort('failed'); }, { times: 1 });
    await panel.getByRole('button', { name: '현재 값으로 다시 검토', exact: true }).click();
    await expect(panel.locator('.document-review-error')).toContainText('서버에 연결하지 못했습니다.');
    const secondId: string = requestIds[1]!; expect(secondId).not.toBe(firstId); expect(pending).toHaveLength(1);
    await page.reload(); await open.click();
    await panel.getByRole('button', { name: '원본 다시 확인', exact: true }).click();
    await panel.getByRole('button', { name: '이전 검토에 다시 연결', exact: true }).click();
    await expect(panel.locator('.document-review-error')).toContainText('문서 검토 요청이 없습니다.');
    await panel.getByRole('button', { name: '같은 요청 재전송', exact: true }).click();
    await expect(panel.locator('.document-review-note')).toContainText('같은 검토 요청');
    expect(requestIds).toEqual([firstId, secondId, secondId]); expect(pending).toHaveLength(2); expect(reviews.activeRequestId()).toBe(secondId);
    pending[1]!.resolve({ model: 'test-model', result: { summary: '현재 설정을 유지합니다.', suggestions: [] } });
    await expect(panel.locator('.document-review-results')).toContainText('현재 설정을 유지합니다.');
    await expect(panel.getByLabel('화면비 가로', { exact: true })).toHaveValue('4');
    expect((await app.inject('/api/projects')).json().projects).toHaveLength(0);
  } finally { await page.context().close(); await app.close(); await rm(root, { recursive: true, force: true }); }
});

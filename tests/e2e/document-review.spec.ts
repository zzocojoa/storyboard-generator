import { nodeFixtureSource } from '../node-process-fixture.js';
import { cp, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, test } from '@playwright/test';
import { readBuildManifest } from '../../src/build.js';
import { CodexRequestStore } from '../../src/codex/requests.js';
import { readDocumentSources } from '../../src/documents/io.js';
import { createApp } from '../../src/server/app.js';
import { ProjectStore } from '../../src/server/store.js';
import { syntheticReviewResult, writeReviewEngineFixture } from '../document-review-helpers.js';
import { TEST_AUDIO_NORMALIZATION_OPTIONS } from '../helpers.js';

test('e2e_codex_document_review_autofills_confirms_presets_and_creates_audited_package', async ({ page }, testInfo): Promise<void> => {
  const root: string = await mkdtemp(join(tmpdir(), 'document-review-ui-'));
  const input: string = join(root, 'input'); await cp('tests/fixtures/documents', input, { recursive: true });
  const result = syntheticReviewResult(await readDocumentSources(input));
  const executable: string = await writeReviewEngineFixture(root, result, 'success', 300);
  const store = new ProjectStore(join(root, 'data'));
  const app = await createApp({ host: '127.0.0.1', port: 4317, dataRoot: join(root, 'data'), webRoot: resolve(process.env.CUTROOM_E2E_WEB_ROOT ?? 'dist/web'),
    pdfFontPath: resolve('assets/fonts/NanumGothic-Regular.ttf'), audioNormalization: TEST_AUDIO_NORMALIZATION_OPTIONS,
    codex: { requestRoot: join(root, 'requests'), speechVoice: 'Yuna' }, documentReview: { executable, requestRoot: join(root, 'reviews'), timeoutMs: 3000 } },
  store, new CodexRequestStore(join(root, 'requests'), readBuildManifest()));
  try {
    await page.goto(await app.listen({ host: '127.0.0.1', port: 0 }));
    await page.locator('.welcome').getByRole('button', { name: /제작 문서 8개/ }).click();
    const panel = page.getByRole('dialog');
    await panel.getByLabel('제작 문서 폴더').fill(input);
    await panel.getByRole('button', { name: '문서 검토', exact: true }).click();
    await panel.getByRole('button', { name: 'Codex로 검토하고 채우기', exact: true }).click();
    await expect(panel.getByRole('button', { name: '검토 취소', exact: true })).toBeVisible();
    await expect(panel.getByRole('navigation', { name: '패키지 제작 단계' }).getByRole('button', { name: '1 문서 확인', exact: true })).toBeDisabled();
    await panel.getByLabel('프레임레이트', { exact: true }).selectOption('25/1');
    await expect(panel.locator('.document-review-note')).toContainText('입력값을 채웠습니다');
    await expect(panel.getByLabel('인물 ID: 민아', { exact: true })).toHaveValue('host');
    await expect(panel.getByLabel('인물 ID: 준', { exact: true })).toHaveValue('helper');
    await expect(panel.getByLabel('프레임레이트', { exact: true })).toHaveValue('25/1');
    await expect(panel.getByLabel('화면비 가로', { exact: true })).toHaveValue('16');
    const invalidEngine: string = await writeReviewEngineFixture(root, result, 'invalid-json', 0);
    await cp(nodeFixtureSource(invalidEngine), nodeFixtureSource(executable));
    await panel.getByRole('button', { name: '현재 값으로 다시 검토', exact: true }).click();
    await expect(panel.locator('.document-review-error')).toContainText('JSON이 아닙니다');
    await expect(panel.getByLabel('인물 ID: 민아', { exact: true })).toHaveValue('host');
    await expect(panel.locator('.document-review-results')).toContainText('이전 검토 · test-codex-model');
    await panel.getByRole('button', { name: '생성 내용 확인', exact: true }).click();
    await expect(panel.locator('.document-error-summary')).toContainText('근거를 확인한 뒤 진행');
    await panel.getByRole('button', { name: '입력된 제안 모두 확인', exact: true }).click();
    await panel.getByText('내 제작 프리셋', { exact: true }).click();
    await panel.getByLabel('새 프리셋 이름', { exact: true }).fill('나의 공통 제작 설정');
    await panel.getByRole('button', { name: '현재 제작 설정 저장', exact: true }).click();
    await expect(panel.locator('.document-review-note')).toContainText('프리셋을 저장');
    await page.screenshot({ path: testInfo.outputPath('document-codex-filled.png') });
    await panel.getByRole('button', { name: '생성 내용 확인', exact: true }).click();
    await panel.getByLabel('새 패키지 폴더', { exact: true }).fill(join(root, 'package'));
    await panel.getByLabel('패키지 버전', { exact: true }).fill('codex-reviewed');
    await panel.getByRole('button', { name: '패키지 생성', exact: true }).click();
    await expect(panel.getByRole('status')).toContainText('패키지 생성 완료');
    const steps = panel.getByRole('navigation', { name: '패키지 제작 단계' });
    await steps.getByRole('button', { name: '1 문서 확인', exact: true }).click();
    await steps.getByRole('button', { name: '3 생성·불러오기', exact: true }).click();
    await expect(panel.locator('.document-success')).toContainText('storyboard_handoff.json');
    await steps.getByRole('button', { name: '2 연결·설정', exact: true }).click();
    await panel.getByLabel('인물 ID: 민아', { exact: true }).selectOption('helper');
    await steps.getByRole('button', { name: '3 생성·불러오기', exact: true }).click();
    await expect(panel.getByRole('alert')).toContainText('근거를 확인한 뒤 진행');
    await panel.getByLabel('인물 ID: 민아', { exact: true }).selectOption('host');
    await panel.getByRole('button', { name: '입력된 제안 모두 확인', exact: true }).click();
    await steps.getByRole('button', { name: '3 생성·불러오기', exact: true }).click();
    await expect(panel.locator('.document-package-changed')).toContainText('새 패키지를 저장');
    const settings = JSON.parse(await readFile(join(root, 'package', 'document-settings.json'), 'utf8'));
    expect(settings.formatVersion).toBe('1.1.0');
    expect(settings.reviewAudit.entries.some((entry: { origin: string; confirmed: boolean }): boolean => entry.origin === 'inference' && entry.confirmed)).toBe(true);
    expect(settings.reviewAudit.preset.name).toBe('나의 공통 제작 설정');
    expect(settings.timebase.fpsNumerator).toBe(25);
    expect(await store.list()).toHaveLength(0);
    await panel.getByRole('button', { name: '다른 패키지 만들기', exact: true }).click();
    const other: string = join(root, 'other'); await cp('tests/fixtures/production/09_PRODUCTION', other, { recursive: true });
    await panel.getByLabel('제작 문서 폴더').fill(other);
    await panel.getByRole('button', { name: '문서 검토', exact: true }).click();
    await panel.getByText('내 제작 프리셋', { exact: true }).click();
    await panel.getByLabel('제작 프리셋', { exact: true }).selectOption({ label: '나의 공통 제작 설정 · 16:9 · 25/1 fps' });
    await expect(panel.getByLabel('프레임레이트', { exact: true })).toHaveValue('25/1');
    await expect(panel.getByLabel('인물 ID: 백기철', { exact: true })).toHaveValue('');
    await page.setViewportSize({ width: 375, height: 812 });
    expect(await panel.locator('.document-scroll').evaluate((element: HTMLDivElement): boolean => element.scrollWidth <= element.clientWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath('document-codex-mobile.png') });
  } finally { await page.context().close(); await app.close(); await rm(root, { recursive: true, force: true }); }
});

test('e2e_codex_document_review_cancels_and_preserves_connection_edits_during_review', async ({ page }): Promise<void> => {
  const root: string = await mkdtemp(join(tmpdir(), 'document-review-cancel-ui-'));
  const input: string = join(root, 'input'); await cp('tests/fixtures/documents', input, { recursive: true });
  const result = syntheticReviewResult(await readDocumentSources(input));
  const executable: string = await writeReviewEngineFixture(root, result, 'success', 500);
  const app = await createApp({ host: '127.0.0.1', port: 4317, dataRoot: join(root, 'data'), webRoot: resolve(process.env.CUTROOM_E2E_WEB_ROOT ?? 'dist/web'),
    pdfFontPath: resolve('assets/fonts/NanumGothic-Regular.ttf'), audioNormalization: TEST_AUDIO_NORMALIZATION_OPTIONS,
    codex: { requestRoot: join(root, 'requests'), speechVoice: 'Yuna' }, documentReview: { executable, requestRoot: join(root, 'reviews'), timeoutMs: 3000 } },
  new ProjectStore(join(root, 'data')), new CodexRequestStore(join(root, 'requests'), readBuildManifest()));
  try {
    await page.goto(await app.listen({ host: '127.0.0.1', port: 0 }));
    await page.locator('.welcome').getByRole('button', { name: /제작 문서 8개/ }).click();
    const panel = page.getByRole('dialog');
    await panel.getByLabel('제작 문서 폴더').fill(input);
    await panel.getByRole('button', { name: '문서 검토', exact: true }).click();
    await panel.getByRole('button', { name: 'Codex로 검토하고 채우기', exact: true }).click();
    await panel.getByRole('button', { name: '검토 취소', exact: true }).click();
    await expect(panel.locator('.document-review-note')).toContainText('취소했습니다');
    await expect(panel.getByLabel('화면비 가로', { exact: true })).toHaveValue('');
    await panel.getByRole('button', { name: '현재 값으로 다시 검토', exact: true }).click();
    await panel.getByLabel('인물 ID: 민아', { exact: true }).selectOption('helper');
    await expect(panel.locator('.document-review-error')).toContainText('검토 중 원본 또는 연결을 수정');
    await expect(panel.getByLabel('인물 ID: 민아', { exact: true })).toHaveValue('helper');
    await expect(panel.getByLabel('음성 샘플레이트', { exact: true })).toHaveValue('');
  } finally { await page.context().close(); await app.close(); await rm(root, { recursive: true, force: true }); }
});

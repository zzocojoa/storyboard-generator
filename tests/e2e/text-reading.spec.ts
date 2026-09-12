import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, test } from '@playwright/test';
import { readBuildManifest } from '../../src/build.js';
import { CodexRequestStore } from '../../src/codex/requests.js';
import { createApp } from '../../src/server/app.js';
import { ProjectStore } from '../../src/server/store.js';
import { TEST_AUDIO_NORMALIZATION_OPTIONS } from '../helpers.js';
import { readingProject } from '../text-reading-helpers.js';

test('e2e_text_reading_review_opens_persistent_policy_and_keeps_current_timings_unconfirmed', async ({ page }): Promise<void> => {
  const root: string = await mkdtemp(join(tmpdir(), 'cutroom-reading-ui-')); const dataRoot: string = join(root, 'data');
  const store = new ProjectStore(dataRoot); const original = await readingProject(); await store.create(original);
  const app = await createApp({ host: '127.0.0.1', port: 0, dataRoot, webRoot: resolve(process.env.CUTROOM_E2E_WEB_ROOT ?? 'dist/web'), pdfFontPath: resolve('assets/fonts/NanumGothic-Regular.ttf'),
    audioNormalization: TEST_AUDIO_NORMALIZATION_OPTIONS, codex: { requestRoot: join(root, 'requests'), speechVoice: 'Yuna' } }, store, new CodexRequestStore(join(root, 'requests'), readBuildManifest()));
  try {
    const origin: string = await app.listen({ host: '127.0.0.1', port: 0 }); await page.goto(origin);
    const navigation = page.getByRole('navigation', { name: '콘티 작업 공간' });
    await navigation.getByRole('button', { name: '검토·출력', exact: true }).click();
    const review = page.getByRole('region', { name: '검토 및 내보내기' });
    await review.getByLabel('검토 항목 검색').fill('TEXT_READING_TOO_FAST');
    const group = review.locator('.review-group').first(); await group.locator('summary').first().click();
    await group.getByRole('button', { name: '편집하기 ↗', exact: true }).first().click();
    const form = page.getByRole('form', { name: '글자 읽기 기준' }); await expect(form).toBeVisible();
    await form.getByLabel('읽기 속도 · 초당 표시 문자').fill('8'); await form.getByLabel('최소 표시 시간 ms').fill('1500');
    await form.getByRole('button', { name: '읽기 기준 저장' }).click(); await expect(form).toContainText('저장된 읽기 기준');
    await page.reload(); await navigation.getByRole('button', { name: '제작 설정', exact: true }).click();
    await expect(form.getByLabel('읽기 속도 · 초당 표시 문자')).toHaveValue('8'); await expect(form.getByLabel('최소 표시 시간 ms')).toHaveValue('1500');
    const saved = await store.read(original.projectId);
    expect(saved.revision).toBe(1); expect(saved.textCues).toEqual(original.textCues); expect(saved.dataset).toEqual(original.dataset); expect(saved.generationRecords).toEqual(original.generationRecords);
    await form.scrollIntoViewIfNeeded(); await page.screenshot({ path: '.local/validation/automation-runtime/text-reading-browser.png' });
    await navigation.getByRole('button', { name: '검토·출력', exact: true }).click();
    await review.getByLabel('검토 항목 검색').fill('TEXT_READING_TOO_FAST');
    await review.locator('.review-group').first().locator('summary').first().click();
    await expect(review.locator('.review-issue').first()).toContainText('1500ms');
    const response = await page.request.get(`${origin}/api/projects/${encodeURIComponent(original.projectId)}/export.pdf?maturity=final`); expect(response.status()).toBe(409);
  } finally { await page.context().close(); await app.close(); await rm(root, { recursive: true, force: true }); }
});

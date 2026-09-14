import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import { expect, test } from '@playwright/test';
import { readBuildManifest } from '../../src/build.js';
import { CodexRequestStore } from '../../src/codex/requests.js';
import { createApp } from '../../src/server/app.js';
import { ProjectStore } from '../../src/server/store.js';
import { createIndependentStoryboard } from '../../src/proposal/independent-storyboard.js';
import { importPackage } from '../../src/importers/import-package.js';
import { nativePackage, TEST_AUDIO_NORMALIZATION_OPTIONS, TEST_TEXT_FONT_PATH } from '../helpers.js';
import { readinessOutline } from '../readiness-fixtures.js';

test('e2e_output_settings_persist_per_project_and_download_selected_formats_with_final_blocked', async ({ page }): Promise<void> => {
  const root: string = await mkdtemp(join(tmpdir(), 'cutroom-output-ui-')); const dataRoot: string = join(root, 'data'); const store = new ProjectStore(dataRoot);
  const source = await readinessOutline(); await store.create(source); await store.create(createIndependentStoryboard(importPackage(await nativePackage()),
    { handoffPath: 'fixture', storyboardId: randomUUID(), name: '별도 출력 프로젝트', proposedTextHoldMs: 2000 }));
  const app = await createApp({ host: '127.0.0.1', port: 0, dataRoot, webRoot: resolve('dist/web'), pdfFontPath: TEST_TEXT_FONT_PATH,
    audioNormalization: TEST_AUDIO_NORMALIZATION_OPTIONS, codex: { requestRoot: join(root, 'requests'), speechVoice: 'Yuna' } }, store, new CodexRequestStore(join(root, 'requests'), readBuildManifest()));
  try {
    await page.goto(await app.listen({ host: '127.0.0.1', port: 0 }));
    await page.locator('.project-rail').getByRole('button').filter({ hasText: source.title }).click();
    await page.getByRole('navigation', { name: '콘티 작업 공간' }).getByRole('button', { name: '검토·출력', exact: true }).click();
    const settings = page.getByRole('region', { name: '출력 설정', exact: true });
    await settings.getByLabel('PDF 용지', { exact: true }).selectOption('A3');
    await settings.getByLabel('PDF 방향', { exact: true }).selectOption('portrait');
    await settings.getByLabel('PDF 구성', { exact: true }).selectOption('board');
    await settings.getByLabel('페이지당 그림 수').selectOption('6');
    await settings.getByLabel('출력 프레임', { exact: true }).selectOption('representative');
    await settings.getByLabel('CSV 구성', { exact: true }).selectOption('readable');
    await settings.getByLabel('출력 파일 이름', { exact: true }).fill('그림 검토');
    await settings.getByLabel('출력 범위', { exact: true }).selectOption('segments');
    const segments = settings.getByRole('group', { name: '포함할 구간' }).getByRole('checkbox');
    for (let index: number = 1; index < source.dataset.segments.length; index += 1) await segments.nth(index).uncheck();
    await settings.getByRole('button', { name: '출력 설정 저장', exact: true }).click();
    await expect(settings).toContainText('이 프로젝트의 출력 설정을 이 브라우저에 저장했습니다.');
    await settings.getByLabel('PDF 구성', { exact: true }).scrollIntoViewIfNeeded();
    await page.screenshot({ path: '.local/validation/automation-runtime/output-options-browser.png' });
    await expect(settings.getByRole('button', { name: 'FINAL PDF', exact: true })).toBeDisabled();
    const pdfEvent = page.waitForEvent('download'); await settings.getByRole('link', { name: 'DRAFT PDF', exact: true }).click(); const pdf = await pdfEvent;
    expect(pdf.suggestedFilename()).toBe('그림 검토-r0-draft.pdf'); const pdfPath = await pdf.path(); expect(pdfPath).not.toBeNull(); expect((await readFile(pdfPath!)).subarray(0, 5).toString()).toBe('%PDF-');
    const csvEvent = page.waitForEvent('download'); await settings.getByRole('link', { name: 'DRAFT CSV', exact: true }).click(); const csv = await csvEvent;
    const content: string = await readFile((await csv.path())!, 'utf8'); expect(content).toContain('음성·음향'); expect(content).not.toContain('camera_angle');
    await page.reload(); await page.getByRole('navigation', { name: '콘티 작업 공간' }).getByRole('button', { name: '검토·출력', exact: true }).click();
    await expect(settings.getByLabel('PDF 용지', { exact: true })).toHaveValue('A3'); await expect(settings.getByLabel('페이지당 그림 수')).toHaveValue('6');
    await expect(settings.getByLabel('출력 파일 이름', { exact: true })).toHaveValue('그림 검토');
    await page.route('**/export.pdf?**', async (route): Promise<void> => {
      const url: URL = new URL(route.request().url()); url.searchParams.set('revision', '99'); await route.continue({ url: url.href });
    });
    await settings.getByRole('link', { name: 'DRAFT PDF', exact: true }).click();
    await expect(settings.getByRole('alert')).toContainText('출력 기준 revision 99');
    await expect(settings.getByLabel('출력 파일 이름', { exact: true })).toHaveValue('그림 검토');
    await page.unroute('**/export.pdf?**');
    await segments.first().uncheck(); await expect(settings.getByRole('button', { name: 'DRAFT PDF', exact: true })).toBeDisabled();
    await page.locator('.project-rail').getByRole('button').filter({ hasText: '별도 출력 프로젝트' }).click();
    await page.getByRole('navigation', { name: '콘티 작업 공간' }).getByRole('button', { name: '검토·출력', exact: true }).click();
    await expect(settings.getByLabel('PDF 용지', { exact: true })).toHaveValue('A4'); await expect(settings.getByLabel('출력 파일 이름', { exact: true })).toHaveValue('storyboard');
    await page.evaluate((): void => { window.localStorage.setItem('cutroom:selected-project:1', 'missing-project'); });
    await page.reload(); await expect(page.locator('.notice')).toContainText('이전에 선택한 콘티를 현재 목록에서 찾을 수 없습니다.');
    await page.locator('.project-rail').getByRole('button').filter({ hasText: source.title }).click();
    await page.getByRole('navigation', { name: '콘티 작업 공간' }).getByRole('button', { name: '검토·출력', exact: true }).click();
    await expect(settings.getByLabel('PDF 용지', { exact: true })).toHaveValue('A3');
    expect(await store.read(source.projectId)).toEqual(source);
  } finally { await page.context().close(); await app.close(); await store.close(); await rm(root, { recursive: true, force: true }); }
});

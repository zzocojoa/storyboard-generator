import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, test } from '@playwright/test';
import type { Locator } from '@playwright/test';
import { readBuildManifest } from '../../src/build.js';
import { CodexRequestStore } from '../../src/codex/requests.js';
import { readPackage } from '../../src/io/package.js';
import { createApp } from '../../src/server/app.js';
import { ProjectStore } from '../../src/server/store.js';
import { SYNTHETIC_DOCUMENT_BINDINGS } from '../document-helpers.js';
import { TEST_AUDIO_NORMALIZATION_OPTIONS } from '../helpers.js';

type NavigationFixture = { root: string; input: string; store: ProjectStore; app: Awaited<ReturnType<typeof createApp>> };

async function navigationFixture(): Promise<NavigationFixture> {
  const root: string = await mkdtemp(join(tmpdir(), 'document-navigation-'));
  const input: string = join(root, 'input'); await cp('tests/fixtures/documents', input, { recursive: true });
  const store = new ProjectStore(join(root, 'data'));
  const app = await createApp({ host: '127.0.0.1', port: 4317, dataRoot: join(root, 'data'), webRoot: resolve('dist/web'),
    pdfFontPath: resolve('assets/fonts/NanumGothic-Regular.ttf'), audioNormalization: TEST_AUDIO_NORMALIZATION_OPTIONS,
    codex: { requestRoot: join(root, 'requests'), speechVoice: 'Yuna' } }, store, new CodexRequestStore(join(root, 'requests'), readBuildManifest()));
  return { root, input, store, app };
}

async function fillConnections(panel: Locator): Promise<void> {
  for (const binding of SYNTHETIC_DOCUMENT_BINDINGS.people) await panel.getByLabel('인물 ID: ' + binding.key, { exact: true }).selectOption(binding.targetId);
  for (const binding of SYNTHETIC_DOCUMENT_BINDINGS.scenes) await panel.getByLabel('장면 ID: ' + binding.key, { exact: true }).selectOption(binding.targetId);
}

async function fillProduction(panel: Locator): Promise<void> {
  await panel.getByLabel('프레임레이트', { exact: true }).selectOption('30/1');
  await panel.getByLabel('음성 샘플레이트', { exact: true }).selectOption('48000');
  await panel.getByLabel('화면비 가로', { exact: true }).fill('16');
  await panel.getByLabel('화면비 세로', { exact: true }).fill('9');
}

test('e2e_document_completed_steps_preserve_inputs_and_saved_packages_when_revisiting', async ({ page }, testInfo): Promise<void> => {
  const { root, input, store, app } = await navigationFixture();
  try {
    await page.goto(await app.listen({ host: '127.0.0.1', port: 0 }));
    await page.locator('.welcome').getByRole('button', { name: /제작 문서 8개/ }).click();
    const panel: Locator = page.getByRole('dialog');
    const steps: Locator = panel.getByRole('navigation', { name: '패키지 제작 단계' });
    const first: Locator = steps.getByRole('button', { name: '1 문서 확인', exact: true });
    const second: Locator = steps.getByRole('button', { name: '2 연결·설정', exact: true });
    const third: Locator = steps.getByRole('button', { name: '3 생성·불러오기', exact: true });
    await expect(second).toBeDisabled(); await expect(third).toBeDisabled();
    await panel.getByLabel('제작 문서 폴더').fill(input);
    await panel.getByRole('button', { name: '문서 검토', exact: true }).click();
    await fillConnections(panel); await fillProduction(panel);
    await panel.getByRole('button', { name: '생성 내용 확인', exact: true }).click();
    await panel.getByLabel('패키지 버전', { exact: true }).fill('first');
    await panel.getByLabel('새 패키지 폴더', { exact: true }).fill(join(root, 'first'));
    await first.click(); await expect(panel.getByLabel('제작 문서 폴더')).toHaveValue(input);
    await second.click(); await expect(panel.getByLabel('인물 ID: 민아', { exact: true })).toHaveValue('host');
    await expect(panel.getByLabel('프레임레이트', { exact: true })).toHaveValue('30/1');
    await third.click(); await expect(panel.getByLabel('패키지 버전', { exact: true })).toHaveValue('first');
    await expect(panel.getByLabel('새 패키지 폴더', { exact: true })).toHaveValue(join(root, 'first'));
    await panel.getByRole('button', { name: '패키지 생성', exact: true }).click();
    await expect(panel.getByRole('status')).toContainText('패키지 생성 완료');
    const original = await readPackage(join(root, 'first', 'storyboard_handoff.json'));
    await panel.getByLabel('초안 글자 유지 시간 (ms)', { exact: true }).fill('1800');
    await first.click(); await third.click();
    await expect(panel.locator('.document-success')).toContainText(join(root, 'first', 'storyboard_handoff.json'));
    await expect(panel.getByLabel('초안 글자 유지 시간 (ms)', { exact: true })).toHaveValue('1800');
    await expect(panel.getByRole('button', { name: '패키지 생성', exact: true })).toHaveCount(0);
    await panel.getByRole('button', { name: '이전 단계', exact: true }).click();
    await expect(second).toHaveAttribute('aria-current', 'step');
    await panel.getByLabel('프레임레이트', { exact: true }).selectOption('25/1');
    await panel.getByLabel('화면비 세로', { exact: true }).fill('');
    await third.click(); await expect(panel.getByRole('alert')).toContainText('화면비 세로');
    await expect(second).toHaveAttribute('aria-current', 'step');
    await panel.getByLabel('화면비 세로', { exact: true }).fill('9');
    await third.click();
    await expect(panel.locator('.document-package-changed')).toContainText('기존 버전 first은 보존');
    await expect(panel.getByRole('button', { name: '생성 패키지 불러오기', exact: true })).toHaveCount(0);
    await panel.getByRole('button', { name: '패키지 생성', exact: true }).click();
    await expect(panel.getByRole('alert')).toContainText('새 버전');
    await expect(panel.getByRole('alert')).toContainText('다른 새 폴더');
    await panel.getByLabel('패키지 버전', { exact: true }).fill('second');
    await panel.getByLabel('새 패키지 폴더', { exact: true }).fill(join(root, 'second'));
    await page.setViewportSize({ width: 375, height: 812 });
    await first.click(); await third.click();
    await expect(panel.getByLabel('패키지 버전', { exact: true })).toHaveValue('second');
    expect(await panel.locator('.document-scroll').evaluate((element: HTMLDivElement): boolean => element.scrollWidth <= element.clientWidth)).toBe(true);
    await first.focus(); await page.keyboard.press('Enter'); await expect(first).toHaveAttribute('aria-current', 'step');
    await third.click();
    await page.screenshot({ path: testInfo.outputPath('document-navigation-mobile.png') });
    await panel.getByRole('button', { name: '패키지 생성', exact: true }).click();
    await expect(panel.getByRole('status')).toContainText('패키지 생성 완료');
    expect(await readPackage(join(root, 'first', 'storyboard_handoff.json'))).toEqual(original);
    expect((await readPackage(join(root, 'second', 'storyboard_handoff.json'))).handoff.timebase.fpsNumerator).toBe(25);
    await second.click(); await third.click();
    await expect(panel.locator('.document-success')).toContainText(join(root, 'second', 'storyboard_handoff.json'));
    await panel.getByRole('button', { name: '생성 패키지 불러오기', exact: true }).click();
    await expect(panel).not.toBeVisible();
    expect((await store.read('plant-doc-demo')).handoff.packageVersion).toBe('second');
    expect((await store.read('plant-doc-demo')).handoff.timebase.fpsNumerator).toBe(25);
  } finally { await page.context().close(); await app.close(); await rm(root, { recursive: true, force: true }); }
});

test('e2e_document_step_navigation_revalidates_changed_sources_and_resets_other_story', async ({ page }): Promise<void> => {
  const { root, input, app } = await navigationFixture();
  try {
    await page.goto(await app.listen({ host: '127.0.0.1', port: 0 }));
    await page.locator('.welcome').getByRole('button', { name: /제작 문서 8개/ }).click();
    const panel: Locator = page.getByRole('dialog');
    const steps: Locator = panel.getByRole('navigation', { name: '패키지 제작 단계' });
    const first: Locator = steps.getByRole('button', { name: '1 문서 확인', exact: true });
    const third: Locator = steps.getByRole('button', { name: '3 생성·불러오기', exact: true });
    await panel.getByLabel('제작 문서 폴더').fill(input);
    await panel.getByRole('button', { name: '문서 검토', exact: true }).click();
    await fillConnections(panel); await fillProduction(panel);
    await panel.getByRole('button', { name: '생성 내용 확인', exact: true }).click();
    await panel.getByLabel('패키지 버전', { exact: true }).fill('before-source-edit');
    await panel.getByLabel('새 패키지 폴더', { exact: true }).fill(join(root, 'first'));
    await panel.getByRole('button', { name: '패키지 생성', exact: true }).click();
    await expect(panel.getByRole('status')).toContainText('패키지 생성 완료');
    const original = await readPackage(join(root, 'first', 'storyboard_handoff.json'));
    await writeFile(join(input, 'narration.md'), await readFile(join(input, 'narration.md'), 'utf8') + '\n');
    await first.click(); await third.click();
    await expect(panel.getByRole('alert')).toContainText('검토 이후 원본 문서가 변경');
    await first.click(); await panel.getByRole('button', { name: '문서 검토', exact: true }).click();
    await expect(third).toBeDisabled();
    await expect(panel.getByLabel('인물 ID: 민아', { exact: true })).toHaveValue('');
    await fillConnections(panel);
    await panel.getByRole('button', { name: '생성 내용 확인', exact: true }).click();
    await expect(panel.locator('.document-package-changed')).toContainText('새 패키지를 저장');
    await expect(panel.getByRole('button', { name: '생성 패키지 불러오기', exact: true })).toHaveCount(0);
    expect(await readPackage(join(root, 'first', 'storyboard_handoff.json'))).toEqual(original);
    const other: string = join(root, 'other'); await cp('tests/fixtures/production/09_PRODUCTION', other, { recursive: true });
    await first.click(); await panel.getByLabel('제작 문서 폴더').fill(other);
    await expect(third).toBeDisabled();
    await expect(steps.getByRole('button', { name: '2 연결·설정', exact: true })).toBeDisabled();
    await panel.getByRole('button', { name: '문서 검토', exact: true }).click();
    await expect(panel).toContainText('12장면 · 32구간 · 원문 95개');
    await expect(panel.getByLabel('프레임레이트', { exact: true })).toHaveValue('');
    await expect(panel.getByLabel('인물 ID: 백기철', { exact: true })).toHaveValue('');
    await expect(third).toBeDisabled();
  } finally { await page.context().close(); await app.close(); await rm(root, { recursive: true, force: true }); }
});

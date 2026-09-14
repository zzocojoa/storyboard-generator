import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, test } from '@playwright/test';
import { readBuildManifest } from '../../src/build.js';
import { CodexRequestStore } from '../../src/codex/requests.js';
import { createApp } from '../../src/server/app.js';
import { ProjectStore } from '../../src/server/store.js';
import { TEST_AUDIO_NORMALIZATION_OPTIONS } from '../helpers.js';

test('e2e_section_documents_connect_all_people_create_package_and_import_planned_subtitles', async ({ page }, testInfo): Promise<void> => {
  const root = await mkdtemp(join(tmpdir(), 'section-document-ui-'));
  const store = new ProjectStore(join(root, 'data'));
  const app = await createApp({ host: '127.0.0.1', port: 4317, dataRoot: join(root, 'data'), webRoot: resolve('dist/web'),
    pdfFontPath: resolve('assets/fonts/NanumGothic-Regular.ttf'), audioNormalization: TEST_AUDIO_NORMALIZATION_OPTIONS,
    codex: { requestRoot: join(root, 'requests'), speechVoice: 'Yuna' } }, store, new CodexRequestStore(join(root, 'requests'), readBuildManifest()));
  try {
    await page.goto(await app.listen({ host: '127.0.0.1', port: 0 }));
    await page.locator('.welcome').getByRole('button', { name: /제작 문서 8개/ }).click();
    const panel = page.getByRole('dialog');
    await panel.getByLabel('제작 문서 폴더').fill(resolve('tests/fixtures/section-documents'));
    await panel.getByRole('button', { name: '문서 검토', exact: true }).click();
    await expect(panel).toContainText('12장면 · 24구간 · 원문 208개');
    await expect(panel).toContainText('문서로 연결된 인물 ID 8개 확인');
    await expect(panel.getByRole('alert')).toHaveCount(0);
    await expect(panel.getByLabel('프레임레이트', { exact: true })).toHaveValue('');
    await panel.getByLabel('프레임레이트', { exact: true }).selectOption('30/1');
    await panel.getByLabel('음성 샘플레이트', { exact: true }).selectOption('48000');
    await panel.getByLabel('화면비 가로', { exact: true }).fill('16');
    await panel.getByLabel('화면비 세로', { exact: true }).fill('9');
    await panel.getByRole('button', { name: '생성 내용 확인', exact: true }).click();
    await panel.getByLabel('패키지 버전', { exact: true }).fill('section-e2e');
    await panel.getByLabel('새 패키지 폴더', { exact: true }).fill(join(root, 'package'));
    await panel.getByRole('button', { name: '패키지 생성', exact: true }).click();
    await expect(panel.getByRole('status')).toContainText('패키지 생성 완료');
    await panel.getByLabel('초안 글자 유지 시간 (ms)', { exact: true }).fill('2000');
    await panel.getByRole('button', { name: '생성 패키지 불러오기', exact: true }).click();
    await expect(panel).not.toBeVisible();
    await expect(page.locator('.project-tile')).toHaveCount(1);
    const project = await store.read('garden-steps-demo');
    expect(project.dataset.units).toHaveLength(208);
    expect(project.textCues).toHaveLength(155);
    expect(project.textCues.every((cue): boolean => cue.timingStatus === 'proposed')).toBe(true);
    await page.screenshot({ path: testInfo.outputPath('section-imported.png') });
    await page.reload();
    await expect(page.locator('.project-tile')).toContainText('작은 텃밭의 열두 단계');
    expect((await store.read('garden-steps-demo')).dataset.units).toEqual(project.dataset.units);
  } finally { await page.context().close(); await app.close(); await rm(root, { recursive: true, force: true }); }
});

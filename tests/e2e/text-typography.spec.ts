import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, test } from '@playwright/test';
import { readBuildManifest } from '../../src/build.js';
import { CodexRequestStore } from '../../src/codex/requests.js';
import type { Project } from '../../src/domain/schema.js';
import { createApp } from '../../src/server/app.js';
import { ProjectStore } from '../../src/server/store.js';
import { sha256Text } from '../../src/importers/integrity.js';
import { TEST_AUDIO_NORMALIZATION_OPTIONS, TEST_TEXT_FONT_PATH } from '../helpers.js';
import { finalFixture, readinessOutline } from '../readiness-fixtures.js';
import { TEST_LATIN_FONT_PATH } from '../typography-helpers.js';

test('e2e_text_typography_restores_draft_previews_and_repairs_changed_font_without_source_edits', async ({ page }, testInfo): Promise<void> => {
  await page.setViewportSize({ width: 1440, height: 1400 });
  const root: string = await mkdtemp(join(tmpdir(), 'cutroom-typography-ui-')); const dataRoot: string = join(root, 'data');
  const selectedPath: string = join(root, 'selected.ttf'); await writeFile(selectedPath, await readFile(TEST_TEXT_FONT_PATH));
  const store = new ProjectStore(dataRoot); const ready = await finalFixture(); await store.create(await readinessOutline());
  const project = await store.update(ready.project.projectId, 0, (): Project => ready.project, ready.project.assets.map((asset) => ({ relativePath: asset.path, content: ready.media.get(asset.id)! })));
  const currentPath: string = join(dataRoot, sha256Text(project.projectId), 'project.json'); const original = await readFile(currentPath);
  const app = await createApp({ host: '127.0.0.1', port: 0, dataRoot, webRoot: resolve(process.env.CUTROOM_E2E_WEB_ROOT ?? 'dist/web'), pdfFontPath: resolve(TEST_TEXT_FONT_PATH),
    textFonts: [{ id: 'selected', label: '검토용 글꼴', path: selectedPath }], audioNormalization: TEST_AUDIO_NORMALIZATION_OPTIONS,
    codex: { requestRoot: join(root, 'requests'), speechVoice: 'Yuna' } }, store, new CodexRequestStore(join(root, 'requests'), readBuildManifest()));
  try {
    const base: string = await app.listen({ host: '127.0.0.1', port: 0 }); await page.goto(base);
    await page.getByRole('navigation', { name: '콘티 작업 공간' }).getByRole('button', { name: '제작 설정', exact: true }).click();
    const form = page.getByRole('form', { name: '글꼴과 언어' });
    await form.getByLabel('화면 글꼴', { exact: true }).selectOption('selected'); await form.getByLabel('문구 언어', { exact: true }).fill('ko');
    await page.reload();
    await expect(form.getByLabel('화면 글꼴', { exact: true })).toHaveValue('selected'); await expect(form.getByLabel('문구 언어', { exact: true })).toHaveValue('ko');
    await form.getByRole('button', { name: '선택한 글꼴 미리보기', exact: true }).click();
    await expect(form.getByRole('img', { name: '선택한 글꼴로 조판한 화면 글자' })).toBeVisible(); expect(await readFile(currentPath)).toEqual(original);
    await expect.poll(async (): Promise<boolean> => form.getByRole('img', { name: '선택한 글꼴로 조판한 화면 글자' }).evaluate((element: HTMLImageElement): boolean => element.complete && element.naturalWidth > 0)).toBe(true);
    await form.screenshot({ path: testInfo.outputPath('typography-preview.png') });
    await form.getByRole('button', { name: '글꼴·언어 저장', exact: true }).click();
    await expect.poll(async (): Promise<number> => (await store.read(project.projectId)).revision).toBe(2);
    await writeFile(selectedPath, await readFile(TEST_LATIN_FONT_PATH)); await page.reload();
    await expect(form.getByRole('button', { name: '현재 글꼴 파일 선택', exact: true })).toBeVisible();
    await expect(form.getByRole('button', { name: '글꼴·언어 저장', exact: true })).toBeDisabled();
    await form.getByRole('button', { name: '현재 글꼴 파일 선택', exact: true }).click();
    await form.getByRole('button', { name: '선택한 글꼴 미리보기', exact: true }).click();
    await expect(form.getByRole('region', { name: '글꼴 미리보기' })).toContainText('선택 글꼴에 없는 글자');
    await form.getByLabel('화면 글꼴', { exact: true }).selectOption('default');
    await expect(form.getByRole('region', { name: '글꼴 미리보기' })).toHaveCount(0);
    await form.getByRole('button', { name: '글꼴·언어 저장', exact: true }).click();
    await expect.poll(async (): Promise<number> => (await store.read(project.projectId)).revision).toBe(3);
    const saved = await store.read(project.projectId); expect(saved.textTypography).toMatchObject({ fontId: 'default', language: 'ko' });
    for (const key of ['dataset', 'textCues', 'audioCues', 'shots', 'frames', 'assets', 'generationRecords'] as const) expect(saved[key]).toEqual(project[key]);
    expect((await (await page.request.get(`${base}/api/projects/${encodeURIComponent(project.projectId)}/final-readiness`)).json()).finalReady).toBe(true);
    await page.reload(); await expect(form.getByLabel('화면 글꼴', { exact: true })).toHaveValue('default');
  } finally { await app.close(); await rm(root, { recursive: true, force: true }); }
});

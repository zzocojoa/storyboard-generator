import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, test } from '@playwright/test';
import { readBuildManifest } from '../../src/build.js';
import { CodexRequestStore } from '../../src/codex/requests.js';
import type { Project } from '../../src/domain/schema.js';
import { sha256Bytes, sha256Text } from '../../src/importers/integrity.js';
import { createApp } from '../../src/server/app.js';
import { ProjectStore } from '../../src/server/store.js';
import { TEST_AUDIO_NORMALIZATION_OPTIONS, TEST_TEXT_FONT_PATH, png } from '../helpers.js';
import { finalFixture, readinessOutline } from '../readiness-fixtures.js';

test('e2e_text_presentation_restores_draft_previews_saves_and_resets_only_selected_cue', async ({ page }, testInfo): Promise<void> => {
  await page.setViewportSize({ width: 1440, height: 1100 });
  const root: string = await mkdtemp(join(tmpdir(), 'cutroom-presentation-ui-')); const dataRoot: string = join(root, 'data');
  const store = new ProjectStore(dataRoot); const ready = await finalFixture(); await store.create(await readinessOutline());
  const keyBytes: Buffer = await png(90, 50); const firstFrame = ready.project.frames[0]!;
  const keyAsset = { ...ready.project.assets.find((asset): boolean => asset.id === firstFrame.imageAssetId)!, id: 'composition-key-image', subjectId: 'composition-key', path: 'assets/composition-key.png', sha256: sha256Bytes(keyBytes) };
  const candidate: Project = { ...ready.project, assets: [...ready.project.assets, keyAsset], frames: [
    ...ready.project.frames.map((frame) => frame.id === firstFrame.id ? { ...frame, visualReview: 'pending' as const } : frame),
    { ...firstFrame, id: 'composition-key', offsetMs: 2000, role: 'key', imageAssetId: keyAsset.id, visualReview: 'pending' },
  ] };
  const media = new Map([...ready.media, [keyAsset.id, keyBytes] as const]);
  const project = await store.update(ready.project.projectId, 0, (): Project => candidate, candidate.assets.map((asset) => ({ relativePath: asset.path, content: media.get(asset.id)! })));
  const cue = project.textCues[0]!; const currentPath: string = join(dataRoot, sha256Text(project.projectId), 'project.json');
  const original = await readFile(currentPath);
  const app = await createApp({ host: '127.0.0.1', port: 0, dataRoot, webRoot: resolve(process.env.CUTROOM_E2E_WEB_ROOT ?? 'dist/web'), pdfFontPath: resolve(TEST_TEXT_FONT_PATH),
    audioNormalization: TEST_AUDIO_NORMALIZATION_OPTIONS, codex: { requestRoot: join(root, 'requests'), speechVoice: 'Yuna' } }, store, new CodexRequestStore(join(root, 'requests'), readBuildManifest()));
  try {
    await page.goto(await app.listen({ host: '127.0.0.1', port: 0 }));
    const inspector = page.getByRole('complementary', { name: '콘티 편집 패널' });
    await inspector.getByRole('button', { name: '글자', exact: true }).click();
    const form = page.getByRole('form', { name: `개별 글자 배치 ${cue.id}`, exact: true, includeHidden: true });
    const details = inspector.locator('.text-presentation-editor').filter({ has: form });
    await details.locator('summary').click();
    await form.getByLabel('세로 위치 %', { exact: true }).fill('40');
    await form.getByRole('combobox', { name: '글자 정렬', exact: true }).selectOption('left');
    await form.getByRole('combobox', { name: '글자 배경', exact: true }).selectOption('light');
    await form.getByLabel('레이어', { exact: true }).fill('3');
    await page.reload(); await details.locator('summary').click();
    await expect(form.getByLabel('세로 위치 %', { exact: true })).toHaveValue('40');
    await expect(form.getByRole('combobox', { name: '글자 배경', exact: true })).toHaveValue('light');
    await form.getByRole('button', { name: '개별 배치 미리보기', exact: true }).click();
    const preview = form.getByRole('img', { name: '개별 글자 배치를 적용한 화면' });
    await expect(preview).toBeVisible();
    await expect.poll(async (): Promise<boolean> => preview.evaluate((element: HTMLImageElement): boolean => element.complete && element.naturalWidth > 0)).toBe(true);
    expect(await readFile(currentPath)).toEqual(original);
    await preview.scrollIntoViewIfNeeded();
    await preview.screenshot({ path: testInfo.outputPath('text-presentation-preview.png') });
    await page.screenshot({ path: testInfo.outputPath('text-presentation-workspace.png') });
    const largeButton = form.getByRole('button', { name: '그림과 크게 보기', exact: true });
    await largeButton.click();
    const composition = page.getByRole('dialog', { name: '그림과 글자 배치 검토', exact: true });
    await expect(composition).toBeVisible();
    const bitmap = composition.getByRole('img', { name: '글자 배치 검토의 현재 그림', exact: true });
    const draftText = composition.getByRole('img', { name: '현재 시점의 미저장 글자 배치', exact: true });
    await expect(bitmap).toHaveJSProperty('naturalWidth', 2); await expect(draftText).toBeVisible();
    await expect(composition).toContainText('미승인 그림 포함');
    const seek = async (value: number): Promise<void> => {
      await composition.getByRole('slider').evaluate((input: HTMLInputElement, atMs: number): void => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, String(atMs)); input.dispatchEvent(new Event('input', { bubbles: true }));
      }, value);
    };
    let releaseSlow: (() => void) | null = null;
    const slow = new Promise<void>((resolveSlow): void => { releaseSlow = resolveSlow; });
    let slowStarted: boolean = false; let slowFinished: boolean = false;
    await page.route('**/presentation/preview', async (route): Promise<void> => {
      const input = route.request().postDataJSON() as { atMs: number };
      const response = await route.fetch();
      if (input.atMs === 1000) { slowStarted = true; await slow; }
      if (input.atMs === 3999) {
        const data = await response.json() as Record<string, unknown>;
        await route.fulfill({ response, json: { ...data, revision: 999 } }); return;
      }
      await route.fulfill({ response });
      if (input.atMs === 1000) slowFinished = true;
    });
    await seek(1000); await expect.poll((): boolean => slowStarted).toBe(true);
    await expect(draftText).toHaveCount(0);
    await seek(3000); await expect(bitmap).toHaveJSProperty('naturalWidth', 90); await expect(draftText).toBeVisible();
    releaseSlow!(); await expect.poll((): boolean => slowFinished).toBe(true); await expect(draftText).toBeVisible();
    await expect(composition.getByLabel('글자 배치 검토 시각')).toHaveText('00:03:00');
    const frame = composition.locator('.monitor-frame'); const box = await frame.boundingBox();
    expect(Math.min(box!.width, box!.height)).toBeGreaterThan(400); expect(box!.width / box!.height).toBeCloseTo(project.profile.aspectWidth / project.profile.aspectHeight, 1);
    await composition.screenshot({ path: testInfo.outputPath('text-composition-desktop.png') });
    await page.setViewportSize({ width: 390, height: 844 });
    const mobile = await composition.boundingBox(); expect(mobile!.x).toBeGreaterThanOrEqual(0); expect(mobile!.x + mobile!.width).toBeLessThanOrEqual(390);
    await expect(composition.getByRole('button', { name: '닫기', exact: true })).toBeInViewport();
    await expect(composition.getByRole('slider')).toBeInViewport();
    await composition.screenshot({ path: testInfo.outputPath('text-composition-mobile.png') });
    await seek(3999); await expect(composition.getByRole('alert')).toContainText('저장 버전·표시 시점이 다릅니다'); await expect(draftText).toHaveCount(0);
    expect(await readFile(currentPath)).toEqual(original);
    await page.keyboard.press('Escape'); await expect(composition).toHaveCount(0); await expect(largeButton).toBeFocused();
    await page.unroute('**/presentation/preview'); await page.setViewportSize({ width: 1440, height: 1100 });
    await form.getByLabel('레이어', { exact: true }).fill('4'); await expect(preview).toHaveCount(0);
    await form.getByRole('button', { name: '개별 배치 저장', exact: true }).click();
    await expect.poll(async (): Promise<number> => (await store.read(project.projectId)).revision).toBe(2);
    const saved = await store.read(project.projectId);
    expect(saved.textCues[0]?.presentation).toMatchObject({ y: 0.4, alignment: 'left', background: 'light', layer: 4, mode: 'manual' });
    expect(saved.textCues[0]).toEqual({ ...cue, presentation: saved.textCues[0]!.presentation });
    for (const key of ['dataset', 'shots', 'frames', 'audioCues', 'assets', 'generationRecords'] as const) expect(saved[key]).toEqual(project[key]);
    await page.reload(); await details.locator('summary').click();
    await expect(form.getByLabel('레이어', { exact: true })).toHaveValue('4');
    await expect(details.locator('summary')).toContainText('직접 지정');
    await form.getByRole('button', { name: '공통 배치 사용', exact: true }).click();
    await expect.poll(async (): Promise<number> => (await store.read(project.projectId)).revision).toBe(3);
    expect((await store.read(project.projectId)).textCues).toEqual(project.textCues);
    await expect(details.locator('summary')).toContainText('공통 프리셋');
  } finally { await app.close(); await rm(root, { recursive: true, force: true }); }
});

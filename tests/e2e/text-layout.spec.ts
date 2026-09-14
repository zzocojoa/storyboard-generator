import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, test } from '@playwright/test';
import sharp from 'sharp';
import { createSegmentPlanBasis } from '../../src/automation/plan-basis.js';
import { compileAutomaticSegmentPlan } from '../../src/automation/plan-compiler.js';
import { inspectAutomaticText, recordAutomaticTextReview } from '../../src/automation/text-review.js';
import { readBuildManifest } from '../../src/build.js';
import { CodexRequestStore } from '../../src/codex/requests.js';
import type { Project } from '../../src/domain/schema.js';
import { sha256Text } from '../../src/importers/integrity.js';
import { readTextFont } from '../../src/rendering/text-font.js';
import { createApp } from '../../src/server/app.js';
import { ProjectStore } from '../../src/server/store.js';
import { TEST_AUDIO_NORMALIZATION_OPTIONS } from '../helpers.js';
import { automaticPlanProvenance } from '../automatic-plan-helpers.js';
import { crowdedTextPlan, crowdedTextProject } from '../automatic-text-helpers.js';
import { finalFixture, readinessOutline } from '../readiness-fixtures.js';

test('e2e_text_layout_settings_persist_and_same_glyph_overlay_follows_cue_boundaries', async ({ page }): Promise<void> => {
  const root: string = await mkdtemp(join(tmpdir(), 'cutroom-text-ui-')); const dataRoot: string = join(root, 'data');
  const store = new ProjectStore(dataRoot); const ready = await finalFixture();
  await store.create(await readinessOutline());
  const project = await store.update(ready.project.projectId, 0, (): Project => ready.project, ready.project.assets.map((asset) => ({ relativePath: asset.path, content: ready.media.get(asset.id)! })));
  const webRoot: string = resolve(process.env.CUTROOM_E2E_WEB_ROOT ?? 'dist/web');
  const app = await createApp({ host: '127.0.0.1', port: 0, dataRoot, webRoot, pdfFontPath: resolve('assets/fonts/NanumGothic-Regular.ttf'),
    audioNormalization: TEST_AUDIO_NORMALIZATION_OPTIONS, codex: { requestRoot: join(root, 'requests'), speechVoice: 'Yuna' } }, store, new CodexRequestStore(join(root, 'requests'), readBuildManifest()));
  try {
    const base: string = await app.listen({ host: '127.0.0.1', port: 0 }); await page.goto(base);
    await page.getByRole('navigation', { name: '콘티 작업 공간' }).getByRole('button', { name: '제작 설정', exact: true }).click();
    const settings = page.getByRole('form', { name: '글자 배치 설정' });
    await settings.getByLabel('글자 크기 · 짧은 변의 %').fill('5');
    await settings.getByLabel('화면 고지 위치').selectOption('bottom');
    await settings.getByRole('button', { name: '글자 배치 저장' }).click();
    await expect(settings).toContainText('저장된 글자 설정');
    await page.reload();
    await page.getByRole('navigation', { name: '콘티 작업 공간' }).getByRole('button', { name: '제작 설정', exact: true }).click();
    await expect(settings.getByLabel('글자 크기 · 짧은 변의 %')).toHaveValue('5');
    await expect(settings.getByLabel('화면 고지 위치')).toHaveValue('bottom');
    const current: Project = JSON.parse(await readFile(join(dataRoot, sha256Text(project.projectId), 'project.json'), 'utf8')) as Project;
    expect(current.revision).toBe(2); expect(current.textCues).toEqual(project.textCues); expect(current.frames).toEqual(project.frames); expect(current.assets).toEqual(project.assets);
    await page.getByRole('button', { name: '초안 미리보기', exact: true }).click();
    const monitor = page.getByRole('dialog', { name: '콘티 시간순 재생' });
    const overlay = monitor.getByRole('img', { name: '화면 글자 배치', exact: true });
    await expect(overlay).toHaveJSProperty('naturalHeight', 1000);
    await expect(monitor.getByRole('img', { name: '현재 재생 프레임', exact: true })).toHaveJSProperty('naturalWidth', 2);
    const composited: Buffer = await monitor.locator('.monitor-frame').screenshot();
    const dimensions = await sharp(composited).metadata();
    const uncovered: Buffer = await sharp(composited).extract({ left: Math.floor(dimensions.width! / 2), top: Math.floor(dimensions.height! / 4), width: 1, height: 1 }).removeAlpha().raw().toBuffer();
    expect([...uncovered]).toEqual([32, 64, 96]);
    const first: string = (await overlay.getAttribute('src'))!;
    await expect(monitor).toContainText(project.textCues[0]!.text);
    const seek = async (atMs: number): Promise<void> => {
      await monitor.getByRole('slider', { name: '검토 재생 위치' }).evaluate((input: HTMLInputElement, value: number): void => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, String(value)); input.dispatchEvent(new Event('input', { bubbles: true }));
      }, atMs);
    };
    await seek(2000); await expect(overlay).toHaveAttribute('src', first);
    await page.screenshot({ path: '.local/validation/automation-runtime/text-layout-browser.png' });
    await seek(4000); await expect(overlay).toHaveCount(0);
    await seek(13500); await expect(overlay).toHaveCount(1); await expect(overlay).not.toHaveAttribute('src', first);
    await expect(monitor).toContainText(project.textCues[1]!.text);
    await expect(monitor).not.toContainText(project.textCues[0]!.text);
  } finally { await page.context().close(); await app.close(); await rm(root, { recursive: true, force: true }); }
});

test('e2e_automatic_text_review_opens_settings_and_resolves_layout_without_confirming_text', async ({ page }): Promise<void> => {
  const root: string = await mkdtemp(join(tmpdir(), 'cutroom-text-review-ui-')); const dataRoot: string = join(root, 'data');
  const store = new ProjectStore(dataRoot); const original = await crowdedTextProject();
  const fontPath: string = resolve('assets/fonts/NanumGothic-Regular.ttf'); const font = await readTextFont(fontPath);
  const candidate = compileAutomaticSegmentPlan(original, createSegmentPlanBasis(original, 'SEG-001', ['shot-1']), crowdedTextPlan(), [], [], automaticPlanProvenance(), 64);
  const review = inspectAutomaticText(original, candidate.project, 'SEG-001', font);
  const reviewed = recordAutomaticTextReview(original, candidate.project, automaticPlanProvenance().generationId, review);
  await store.create(original);
  const project = await store.update(original.projectId, 0, (): Project => reviewed, []);
  const app = await createApp({ host: '127.0.0.1', port: 0, dataRoot, webRoot: resolve(process.env.CUTROOM_E2E_WEB_ROOT ?? 'dist/web'), pdfFontPath: fontPath,
    audioNormalization: TEST_AUDIO_NORMALIZATION_OPTIONS, codex: { requestRoot: join(root, 'requests'), speechVoice: 'Yuna' } }, store, new CodexRequestStore(join(root, 'requests'), readBuildManifest()));
  try {
    const base: string = await app.listen({ host: '127.0.0.1', port: 0 }); await page.goto(base);
    const navigation = page.getByRole('navigation', { name: '콘티 작업 공간' });
    await navigation.getByRole('button', { name: '검토·출력', exact: true }).click();
    const panel = page.getByRole('region', { name: '검토 및 내보내기' });
    await panel.getByLabel('검토 항목 검색').fill('TEXT_LAYOUT_OVERFLOW');
    const group = panel.locator('.review-group').first(); await group.locator('summary').first().click();
    const problem = group.locator('.review-issue').first();
    await expect(problem).toContainText('TEXT_LAYOUT_OVERFLOW');
    await problem.getByRole('button', { name: '편집하기 ↗', exact: true }).click();
    const settings = page.getByRole('form', { name: '글자 배치 설정' });
    await expect(settings).toBeVisible(); await expect(settings.getByLabel('글자 크기 · 짧은 변의 %')).toHaveValue('12');
    await settings.getByLabel('글자 크기 · 짧은 변의 %').fill('4.2');
    await settings.getByRole('button', { name: '글자 배치 저장' }).click();
    await expect(settings).toContainText('저장된 글자 설정');
    await navigation.getByRole('button', { name: '검토·출력', exact: true }).click();
    await panel.getByLabel('검토 항목 검색').fill('TEXT_LAYOUT_OVERFLOW');
    await expect(panel.locator('.review-group')).toHaveCount(0);
    const current: Project = JSON.parse(await readFile(join(dataRoot, sha256Text(project.projectId), 'project.json'), 'utf8')) as Project;
    expect(current.revision).toBe(2); expect(current.textCues).toEqual(project.textCues); expect(current.dataset).toEqual(project.dataset);
    expect(current.generationRecords).toEqual(project.generationRecords);
    const reviewedCues = current.textCues.filter((cue) => cue.segmentId === 'SEG-001');
    expect(reviewedCues).toHaveLength(2); expect(reviewedCues.every((cue) => cue.timingStatus === 'proposed')).toBe(true);
    const response = await page.request.get(`${base}/api/projects/${encodeURIComponent(project.projectId)}/export.pdf?maturity=final`);
    expect(response.status()).toBe(409);
    await panel.getByLabel('검토 항목 검색').fill('TEXT_TIMING_CONFIRMATION_REQUIRED');
    await expect(panel.locator('.review-group').first()).toBeVisible();
    await page.screenshot({ path: '.local/validation/automation-runtime/automatic-text-review-browser.png' });
  } finally { await page.context().close(); await app.close(); await rm(root, { recursive: true, force: true }); }
});

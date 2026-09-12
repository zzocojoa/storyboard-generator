import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, test } from '@playwright/test';
import type { FastifyInstance } from 'fastify';
import type { Locator, Page } from '@playwright/test';
import { readBuildManifest } from '../../src/build.js';
import { CodexRequestStore } from '../../src/codex/requests.js';
import type { Project } from '../../src/domain/schema.js';
import { importPackage } from '../../src/importers/import-package.js';
import { sha256Text } from '../../src/importers/integrity.js';
import { createSourceOutline } from '../../src/proposal/outline.js';
import { createApp } from '../../src/server/app.js';
import { ProjectStore } from '../../src/server/store.js';
import { reviewPlaybackKey } from '../../web/src/review-playback.js';
import { nativeData, nativePackage, TEST_AUDIO_NORMALIZATION_OPTIONS, TEST_TEXT_FONT_PATH, withNativeData } from '../helpers.js';
import { producerPlaybackFixture } from '../producer-playback-helpers.js';

type ReviewApp = { root: string; app: FastifyInstance; project: Project; file: string; original: Buffer; url: string };
async function fixture(): Promise<ReviewApp> {
  const root: string = await mkdtemp(join(tmpdir(), 'cutroom-review-speed-')); const dataRoot: string = join(root, 'data');
  const store = new ProjectStore(dataRoot); const input = await producerPlaybackFixture(); await store.create(input.source);
  const project: Project = await store.update(input.source.projectId, 0, (): Project => input.project, input.writes);
  const payload = await nativePackage();
  const other = createSourceOutline(importPackage(withNativeData(payload, { ...nativeData(payload), projectId: 'other-story' })), { proposedTextHoldMs: 2000 });
  await store.create({ ...other, title: '속도 분리 검증' });
  const app = await createApp({ host: '127.0.0.1', port: 0, dataRoot, webRoot: resolve(process.env.CUTROOM_E2E_WEB_ROOT ?? 'dist/web'), pdfFontPath: TEST_TEXT_FONT_PATH,
    audioNormalization: TEST_AUDIO_NORMALIZATION_OPTIONS, codex: { requestRoot: join(root, 'requests'), speechVoice: 'Yuna' } }, store, new CodexRequestStore(join(root, 'requests'), readBuildManifest()));
  const file: string = join(dataRoot, sha256Text(project.projectId), 'project.json');
  return { root, app, project, file, original: await readFile(file), url: await app.listen({ host: '127.0.0.1', port: 0 }) };
}

async function seek(monitor: Locator, value: number): Promise<void> {
  await monitor.getByRole('slider', { name: '검토 재생 위치' }).evaluate((input: HTMLInputElement, atMs: number): void => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, String(atMs)); input.dispatchEvent(new Event('input', { bubbles: true }));
  }, value);
}
type PlaybackSample = { wall: number; atMs: number; audioMs: number; rate: number; pitch: boolean };
async function sample(page: Page): Promise<PlaybackSample> {
  return page.evaluate((): PlaybackSample => {
    const audio = document.querySelector<HTMLAudioElement>('audio[data-storyboard-audio]');
    const slider = document.querySelector<HTMLInputElement>('[aria-label="검토 재생 위치"]');
    if (audio === null || slider === null) throw new Error('실제 재생 요소가 없습니다.');
    return { wall: performance.now(), atMs: Number(slider.value), audioMs: audio.currentTime * 1000, rate: audio.playbackRate, pitch: audio.preservesPitch };
  });
}

test('e2e_review_speed_synchronizes_real_delayed_audio_frames_text_and_cue_end_without_project_mutation', async ({ page }): Promise<void> => {
  const running = await fixture(); const mutations: string[] = []; const errors: string[] = [];
  page.on('request', (request): void => { if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method())) mutations.push(request.url()); });
  page.on('pageerror', (error): void => { errors.push(error.message); });
  const { promise: loading, resolve: release } = Promise.withResolvers<void>();
  await page.route('**/output/audio/**', async (route): Promise<void> => { await loading; await route.continue(); });
  try {
    await page.goto(running.url); await page.getByRole('complementary', { name: '프로젝트 목록' }).getByRole('button', { name: new RegExp(running.project.title, 'u') }).click(); await page.getByRole('button', { name: '초안 미리보기', exact: true }).click();
    const monitor = page.getByRole('dialog', { name: '콘티 시간순 재생' }); const speed = monitor.getByLabel('검토 속도', { exact: true });
    await speed.selectOption('0.5'); await seek(monitor, 5000);
    const image = monitor.getByRole('img', { name: '현재 재생 프레임', exact: true }); await expect(image).toHaveJSProperty('naturalWidth', 90);
    const first: string = (await image.getAttribute('src'))!;
    await monitor.getByRole('button', { name: '검토 재생', exact: true }).click();
    await expect.poll(async (): Promise<number> => Number(await monitor.getByRole('slider').inputValue())).toBeGreaterThan(5400);
    release();
    const audio = page.locator('audio[data-storyboard-audio]'); await expect(audio).toHaveJSProperty('readyState', 4);
    await expect.poll(async (): Promise<number> => { const value = await sample(page); return Math.abs(value.audioMs - (value.atMs - 5000)); }).toBeLessThan(200);
    const slow = await sample(page); expect(slow.rate).toBe(0.5); expect(slow.pitch).toBe(true);
    await expect.poll(async (): Promise<number> => (await sample(page)).wall - slow.wall).toBeGreaterThan(250);
    const slowNext = await sample(page); expect((slowNext.atMs - slow.atMs) / (slowNext.wall - slow.wall)).toBeCloseTo(0.5, 1);
    await speed.selectOption('2'); await expect(audio).toHaveJSProperty('playbackRate', 2);
    const fast = await sample(page); expect(fast.atMs).toBeGreaterThanOrEqual(slowNext.atMs); expect(fast.atMs - slowNext.atMs).toBeLessThan(500);
    await expect.poll(async (): Promise<number> => (await sample(page)).wall - fast.wall).toBeGreaterThan(150);
    const fastNext = await sample(page); expect((fastNext.atMs - fast.atMs) / (fastNext.wall - fast.wall)).toBeCloseTo(2, 0);
    expect(Math.abs(fastNext.audioMs - (fastNext.atMs - 5000))).toBeLessThan(200);
    await expect(audio).toHaveCount(0); await expect(image).not.toHaveAttribute('src', first);
    await monitor.getByRole('button', { name: '검토 일시 정지', exact: true }).click();
    await seek(monitor, 13500); await expect(monitor.locator('.storyboard-text-overlay')).toContainText('흙이 마르면 물을 주세요.');
    await page.screenshot({ path: '.local/validation/automation-runtime/review-speed-desktop.png' });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: '.local/validation/automation-runtime/review-speed-mobile.png' });
    expect(await monitor.evaluate((element): number => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1);
    await monitor.getByRole('button', { name: 'CLOSE', exact: true }).click();
    expect(await readFile(running.file)).toEqual(running.original); expect(mutations).toEqual([]); expect(errors).toEqual([]);
  } finally { release(); await page.context().close(); await running.app.close(); await rm(running.root, { recursive: true, force: true }); }
});

test('e2e_review_speed_restores_per_project_without_autoplay_and_controls_individual_audio_with_explicit_storage_errors', async ({ page }): Promise<void> => {
  const running = await fixture(); const key: string = reviewPlaybackKey(running.project.projectId);
  const mutations: string[] = []; page.on('request', (request): void => { if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method())) mutations.push(request.url()); });
  try {
    await page.goto(running.url); await page.getByRole('complementary', { name: '프로젝트 목록' }).getByRole('button', { name: new RegExp(running.project.title, 'u') }).click(); const timeline = page.locator('.timeline');
    await timeline.getByLabel('검토 속도', { exact: true }).selectOption('1.5'); await page.reload();
    await expect(timeline.getByLabel('검토 속도', { exact: true })).toHaveValue('1.5'); await expect(page.locator('audio[data-storyboard-audio]')).toHaveCount(0);
    await page.getByRole('button', { name: /속도 분리 검증/u }).click(); await expect(timeline.getByLabel('검토 속도', { exact: true })).toHaveValue('1');
    await page.getByRole('button', { name: new RegExp(running.project.title, 'u') }).click(); await expect(timeline.getByLabel('검토 속도', { exact: true })).toHaveValue('1.5');
    await page.evaluate((storageKey: string): void => { localStorage.setItem(storageKey, '{'); }, key); await page.reload();
    await expect(timeline).toContainText('검토 속도를 복원하지 못했습니다'); await expect(timeline.getByRole('button', { name: '시간순 재생' })).toBeDisabled();
    await timeline.getByLabel('검토 속도', { exact: true }).selectOption('0.75');
    await page.getByRole('button', { name: '초안 미리보기', exact: true }).click(); const monitor = page.getByRole('dialog', { name: '콘티 시간순 재생' });
    await seek(monitor, 5000); await monitor.getByRole('button', { name: '이 그림 편집', exact: true }).click();
    const inspector = page.getByRole('complementary', { name: '콘티 편집 패널' }); await inspector.getByRole('button', { name: '음성', exact: true }).click();
    const preview = inspector.locator('.audio-review-preview'); const audio = preview.locator('audio');
    await expect(audio).toHaveJSProperty('playbackRate', 0.75); await audio.evaluate(async (element: HTMLAudioElement): Promise<void> => { await element.play(); });
    await preview.getByLabel('검토 속도', { exact: true }).selectOption('1.25'); await expect(audio).toHaveJSProperty('playbackRate', 1.25); await expect(audio).toHaveJSProperty('paused', false);
    await expect(timeline.getByLabel('검토 속도', { exact: true })).toHaveValue('1.25');
    await page.evaluate((storageKey: string): void => { const original = Storage.prototype.setItem; Storage.prototype.setItem = function(key: string, value: string): void {
      if (key === storageKey) throw new DOMException('검토 저장 한도', 'QuotaExceededError'); original.call(this, key, value);
    }; }, key);
    await preview.getByLabel('검토 속도', { exact: true }).selectOption('2'); await expect(preview).toContainText('현재 화면에만 적용'); await expect(audio).toHaveJSProperty('playbackRate', 2);
    await inspector.getByRole('button', { name: '연출', exact: true }).click(); await expect(audio).toHaveCount(0);
    expect(await readFile(running.file)).toEqual(running.original); expect(mutations).toEqual([]);
  } finally { await page.context().close(); await running.app.close(); await rm(running.root, { recursive: true, force: true }); }
});

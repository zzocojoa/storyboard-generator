import { readBuildManifest } from '../../src/build.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, test } from '@playwright/test';
import type { Page, Request, Response } from '@playwright/test';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { CodexRequestStore } from '../../src/codex/requests.js';
import type { Asset, AudioCue, Project } from '../../src/domain/schema.js';
import { importPackage } from '../../src/importers/import-package.js';
import { createSourceOutline } from '../../src/proposal/outline.js';
import { sha256Bytes } from '../../src/importers/integrity.js';
import { createApp } from '../../src/server/app.js';
import { ProjectStore } from '../../src/server/store.js';
import { nativeData, nativePackage, withNativeData, pcmWav, TEST_AUDIO_NORMALIZATION_OPTIONS } from '../helpers.js';
import { readinessOutline } from '../readiness-fixtures.js';

type AudioObservation = { element: HTMLAudioElement; metadataCount: number; mediaErrors: number };
type MediaEventProbe = { event: string; readyState: number; networkState: number; errorCode: number | null; errorMessage: string | null };
type AudioServerProbe = { event: string; elapsedMs: number; status: number; bytes: number | null };
type AudioLoadProbe = { metadataSeen: boolean; playhead: string | null; activeAudioElements: number; notice: string | null;
  mediaEvents: MediaEventProbe[]; httpStatuses: number[]; requestFailures: string[]; serverEvents: AudioServerProbe[] };
declare global { interface Window { audioObservation: AudioObservation | null; audioMediaEvents: MediaEventProbe[] } }
type RunningAudioApp = { root: string; app: FastifyInstance; url: string; cue: AudioCue; serverEvents: AudioServerProbe[] };

async function startAudioApp(): Promise<RunningAudioApp> {
  const root: string = await mkdtemp(join(tmpdir(), 'storyboard-real-audio-'));
  const dataRoot: string = join(root, 'data'); const requestRoot: string = join(root, 'requests');
  const store: ProjectStore = new ProjectStore(dataRoot);
  try {
  const base: Project = await readinessOutline();
  const original: Project = await store.create({ ...base, title: 'Real Audio A' });
  const cue: AudioCue = { ...(original.audioCues[0] as AudioCue), startMs: 5000, endMs: 8000, timingStatus: 'measured', assetId: 'real-wav' };
  const bytes: Buffer = pcmWav(3000, 48000, 1, 16);
  const asset: Asset = { id: 'real-wav', kind: 'audio', subjectId: cue.id, path: 'assets/real.wav', mimeType: 'audio/wav', sha256: sha256Bytes(bytes),
    description: '실제 Chromium PCM 디코드 검증', durationMs: 3000, audioMetadata: { sampleRate: 48000, channels: 1, codec: 'pcm_s16le' }, version: 1 };
  await store.update(original.projectId, 0, (project: Project): Project => ({ ...project, assets: [asset],
    audioCues: project.audioCues.map((candidate: AudioCue): AudioCue => candidate.id === cue.id ? cue : candidate) }), [{ relativePath: asset.path, content: bytes }]);
  const payload = await nativePackage();
  const other = createSourceOutline(importPackage(withNativeData(payload, { ...nativeData(payload), projectId: 'real-audio-b' })), { proposedTextHoldMs: 2000 });
  await store.create({ ...other, title: 'Real Audio B' });
  const app: FastifyInstance = await createApp({ host: '127.0.0.1', port: 0, dataRoot, webRoot: resolve('dist/web'),
    pdfFontPath: resolve('assets/fonts/NanumGothic-Regular.ttf'), audioNormalization: TEST_AUDIO_NORMALIZATION_OPTIONS,
    codex: { requestRoot, speechVoice: 'Yuna' } }, store, new CodexRequestStore(requestRoot, readBuildManifest()));
  const serverEvents: AudioServerProbe[] = [];
  const requests: Map<string, number> = new Map<string, number>();
  app.addHook('onRequest', async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    if (!request.url.includes('/output/audio/')) return;
    requests.set(request.id, performance.now());
    serverEvents.push({ event: 'request', elapsedMs: 0, status: reply.statusCode, bytes: null });
    reply.raw.once('close', (): void => { serverEvents.push({ event: 'close', elapsedMs: performance.now() - (requests.get(request.id) as number),
      status: reply.statusCode, bytes: null }); });
  });
  app.addHook('onSend', async (request: FastifyRequest, reply: FastifyReply, payload: unknown): Promise<unknown> => {
    if (requests.has(request.id)) serverEvents.push({ event: 'send', elapsedMs: performance.now() - (requests.get(request.id) as number),
      status: reply.statusCode, bytes: Buffer.isBuffer(payload) ? payload.length : null });
    return payload;
  });
  const url: string = await app.listen({ host: '127.0.0.1', port: 0 });
  return { root, app, url, cue, serverEvents };
  } catch (error: unknown) { await store.close(); await rm(root, { recursive: true, force: true }); throw error; }
}

async function prepare(page: Page, running: RunningAudioApp, atMs: number): Promise<void> {
  const httpStatuses: number[] = [];
  const requestFailures: string[] = [];
  page.on('response', (response: Response): void => { if (response.url().includes('/output/audio/')) httpStatuses.push(response.status()); });
  page.on('requestfailed', (request: Request): void => { if (request.url().includes('/output/audio/')) requestFailures.push(request.failure()?.errorText ?? 'unknown'); });
  await page.addInitScript((): void => {
    const mediaWindow = window; mediaWindow.audioObservation = null; mediaWindow.audioMediaEvents = [];
    for (const name of ['loadstart', 'loadedmetadata', 'canplay', 'playing', 'pause', 'stalled', 'suspend', 'abort', 'emptied', 'error']) {
      document.addEventListener(name, (event: Event): void => {
        if (!(event.target instanceof HTMLAudioElement)) return;
        mediaWindow.audioMediaEvents.push({ event: event.type, readyState: event.target.readyState, networkState: event.target.networkState,
          errorCode: event.target.error?.code ?? null, errorMessage: event.target.error?.message ?? null });
      }, true);
    }
    document.addEventListener('loadedmetadata', (event: Event): void => {
      if (!(event.target instanceof HTMLAudioElement)) return;
      const previous: AudioObservation | null = mediaWindow.audioObservation;
      mediaWindow.audioObservation = { element: event.target, metadataCount: (previous?.metadataCount ?? 0) + 1, mediaErrors: previous?.mediaErrors ?? 0 };
    }, true);
    document.addEventListener('error', (event: Event): void => {
      if (event.target instanceof HTMLAudioElement && mediaWindow.audioObservation !== null) mediaWindow.audioObservation.mediaErrors += 1;
    }, true);
  });
  await page.goto(running.url);
  await page.locator('.project-tile').filter({ hasText: 'Real Audio A' }).click();
  await expect(page.getByRole('heading', { name: 'Real Audio A' })).toBeVisible();
  await page.getByRole('slider', { name: '재생 위치' }).fill(String(atMs));
  await page.getByRole('button', { name: '시간순 재생', exact: true }).click();
  await expect.poll(async (): Promise<AudioLoadProbe> => ({
    ...await page.evaluate((): Omit<AudioLoadProbe, 'httpStatuses' | 'requestFailures' | 'serverEvents'> => ({ metadataSeen: window.audioObservation !== null,
      playhead: document.querySelector<HTMLInputElement>('input[type="range"]')?.value ?? null,
      notice: document.querySelector('.notice.error')?.textContent ?? null, mediaEvents: window.audioMediaEvents,
      activeAudioElements: document.querySelectorAll('audio[data-storyboard-audio]').length })),
    httpStatuses: [...httpStatuses], requestFailures: [...requestFailures], serverEvents: [...running.serverEvents],
  })).toEqual(expect.objectContaining({ metadataSeen: true }));
}

async function audioState(page: Page): Promise<{ native: boolean; duration: number; currentTime: number; paused: boolean; readyState: number; errors: number; metadataCount: number; connected: boolean; src: string }> {
  return page.evaluate(() => {
    const observation: AudioObservation | null = window.audioObservation;
    if (observation === null) throw new Error('실제 Audio loadedmetadata 이벤트가 없습니다.');
    const element: HTMLAudioElement = observation.element;
    return { native: element instanceof HTMLAudioElement, duration: element.duration, currentTime: element.currentTime,
      paused: element.paused, readyState: element.readyState, errors: observation.mediaErrors + (element.error === null ? 0 : 1),
      metadataCount: observation.metadataCount, connected: element.isConnected, src: element.getAttribute('src') ?? '' };
  });
}

async function checkRealAudio(page: Page, chromium: string, name: string): Promise<{ chromium: string; initial: Awaited<ReturnType<typeof audioState>>; final: Awaited<ReturnType<typeof audioState>> }> {
  const running: RunningAudioApp = await startAudioApp();
  try {
    const atMs: number = name === 'e2e_real_audio_seek_uses_html_media_element' ? 6500 : 5000;
    await prepare(page, running, atMs);
    const state = await audioState(page);
    expect(state.native).toBe(true); expect(state.errors).toBe(0); expect(state.metadataCount).toBeGreaterThan(0);
    expect(state.duration).toBeCloseTo(3, 2);
    await expect.poll(async (): Promise<boolean> => { const current = await audioState(page); return !current.paused && current.readyState >= 2; }).toBe(true);
    if (name === 'e2e_real_audio_seek_uses_html_media_element') {
      await expect.poll(async (): Promise<number> => (await audioState(page)).currentTime).toBeGreaterThanOrEqual(1.5);
    }
    if (name === 'e2e_real_audio_stops_at_cue_end') {
      await expect.poll(async (): Promise<boolean> => (await audioState(page)).paused, { timeout: 5000 }).toBe(true);
      await expect(page.locator('audio[data-storyboard-audio]')).toHaveCount(0);
    }
    if (name === 'e2e_real_audio_is_disposed_on_monitor_close') {
      await page.getByRole('button', { name: 'CLOSE', exact: true }).click();
      await expect(page.getByRole('dialog', { name: '콘티 시간순 재생' })).toHaveCount(0);
    }
    if (name === 'e2e_real_audio_is_disposed_on_project_switch') {
      await page.locator('.project-tile').filter({ hasText: 'Real Audio B' }).click();
      await expect(page.getByRole('heading', { name: 'Real Audio B' })).toBeVisible();
    }
    if (name.includes('disposed')) {
      await expect.poll(async (): Promise<boolean> => { const current = await audioState(page); return current.paused && !current.connected && current.src === ''; }).toBe(true);
      await expect(page.locator('audio[data-storyboard-audio]')).toHaveCount(0);
    }
    expect((await audioState(page)).errors).toBe(0);
    return { chromium, initial: state, final: await audioState(page) };
  } finally {
    // 실제 미디어 검증 뒤 브라우저 Context의 연결 풀까지 닫고 서버와 임시 자원을 정리한다.
    try { await page.context().close(); }
    finally { await running.app.close(); await rm(running.root, { recursive: true, force: true }); }
  }
}

test('e2e_real_wav_decodes_in_chromium', async ({ page, browser }, testInfo): Promise<void> => {
  const evidence = await checkRealAudio(page, browser.version(), 'e2e_real_wav_decodes_in_chromium');
  await testInfo.attach('real-media-evidence', { body: JSON.stringify(evidence), contentType: 'application/json' });
});

test('e2e_real_audio_loadedmetadata_reports_duration', async ({ page, browser }, testInfo): Promise<void> => {
  const evidence = await checkRealAudio(page, browser.version(), 'e2e_real_audio_loadedmetadata_reports_duration');
  await testInfo.attach('real-media-evidence', { body: JSON.stringify(evidence), contentType: 'application/json' });
});

test('e2e_real_audio_seek_uses_html_media_element', async ({ page, browser }, testInfo): Promise<void> => {
  const evidence = await checkRealAudio(page, browser.version(), 'e2e_real_audio_seek_uses_html_media_element');
  await testInfo.attach('real-media-evidence', { body: JSON.stringify(evidence), contentType: 'application/json' });
});

test('e2e_real_audio_stops_at_cue_end', async ({ page, browser }, testInfo): Promise<void> => {
  const evidence = await checkRealAudio(page, browser.version(), 'e2e_real_audio_stops_at_cue_end');
  await testInfo.attach('real-media-evidence', { body: JSON.stringify(evidence), contentType: 'application/json' });
});

test('e2e_real_audio_is_disposed_on_monitor_close', async ({ page, browser }, testInfo): Promise<void> => {
  const evidence = await checkRealAudio(page, browser.version(), 'e2e_real_audio_is_disposed_on_monitor_close');
  await testInfo.attach('real-media-evidence', { body: JSON.stringify(evidence), contentType: 'application/json' });
});

test('e2e_real_audio_is_disposed_on_project_switch', async ({ page, browser }, testInfo): Promise<void> => {
  const evidence = await checkRealAudio(page, browser.version(), 'e2e_real_audio_is_disposed_on_project_switch');
  await testInfo.attach('real-media-evidence', { body: JSON.stringify(evidence), contentType: 'application/json' });
});

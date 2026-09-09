import { readBuildManifest } from '../../src/build.js';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, test } from '@playwright/test';
import type { ConsoleMessage, Page, Request, Response, TestInfo } from '@playwright/test';
import type { FastifyInstance } from 'fastify';
import { CodexRequestStore } from '../../src/codex/requests.js';
import type { Asset, AudioCue, Project } from '../../src/domain/schema.js';
import { importPackage } from '../../src/importers/import-package.js';
import { createSourceOutline } from '../../src/proposal/outline.js';
import { sha256Bytes } from '../../src/importers/integrity.js';
import { createApp } from '../../src/server/app.js';
import { AudioServerDiagnostics, BROWSER_AUDIO_EVENTS } from '../audio-diagnostics.js';
import type { AudioLifecycleEvent, AudioServerProbe, MediaEventProbe } from '../audio-diagnostics.js';
import { ObservedAudioNormalizer, ObservedAudioStore } from './audio-observers.js';
import type { AudioLifecycleRecorder } from './audio-observers.js';
import { nativeData, nativePackage, withNativeData, pcmWav, TEST_AUDIO_NORMALIZATION_OPTIONS } from '../helpers.js';
import { readinessOutline } from '../readiness-fixtures.js';

type AudioObservation = { element: HTMLAudioElement; metadataCount: number; mediaErrors: number };
type AudioHttpProbe = { timestamp: string; status: number; contentRange: string | null; url: string };
type BrowserConsoleEntry = { timestamp: string; level: string; text: string };
type AudioLoadProbe = { metadataSeen: boolean; playhead: string | null; activeAudioElements: number; notice: string | null;
  mediaEvents: MediaEventProbe[]; httpResponses: AudioHttpProbe[]; requestFailures: string[]; serverEvents: AudioServerProbe[] };
declare global { interface Window { audioObservation: AudioObservation | null; audioMediaEvents: MediaEventProbe[]; recordEarlyAudioFrame: () => Promise<void> } }
type RunningAudioApp = { root: string; app: FastifyInstance; url: string; cue: AudioCue; projectId: string; transport: AudioServerDiagnostics; store: ObservedAudioStore; normalizer: ObservedAudioNormalizer };

async function startAudioApp(record: AudioLifecycleRecorder): Promise<RunningAudioApp> {
  const root: string = await realpath(await mkdtemp(join(tmpdir(), 'storyboard-real-audio-')));
  const dataRoot: string = join(root, 'data'); const requestRoot: string = join(root, 'requests');
  const store: ObservedAudioStore = new ObservedAudioStore(dataRoot, record);
  const normalizer: ObservedAudioNormalizer = new ObservedAudioNormalizer(TEST_AUDIO_NORMALIZATION_OPTIONS, record);
  let app: FastifyInstance | null = null;
  let transport: AudioServerDiagnostics | null = null;
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
  app = await createApp({ host: '127.0.0.1', port: 0, dataRoot, webRoot: resolve('dist/web'),
    pdfFontPath: resolve('assets/fonts/NanumGothic-Regular.ttf'), audioNormalization: TEST_AUDIO_NORMALIZATION_OPTIONS,
    codex: { requestRoot, speechVoice: 'Yuna' } }, store, new CodexRequestStore(requestRoot, readBuildManifest()), normalizer);
  app.log.level = 'silent';
  transport = new AudioServerDiagnostics(app);
  const url: string = await app.listen({ host: '127.0.0.1', port: 0 });
  return { root, app, url, cue, projectId: original.projectId, transport, store, normalizer };
  } catch (error: unknown) {
    const cleanupErrors: unknown[] = [];
    if (app !== null) { try { await app.close(); } catch (closeError: unknown) { cleanupErrors.push(closeError); } }
    const closed: PromiseSettledResult<void>[] = await Promise.allSettled([normalizer.close(), store.close()]);
    for (const result of closed) if (result.status === 'rejected') cleanupErrors.push(result.reason);
    if (transport !== null) { await transport.waitForClosedConnections(); transport.dispose(); }
    if (cleanupErrors.length > 0) throw new AggregateError([error, ...cleanupErrors], '실제 Audio App 준비 실패 뒤 자원 정리에 실패했습니다.');
    await rm(root, { recursive: true, force: true }); throw error;
  }
}

async function prepare(page: Page, running: RunningAudioApp, atMs: number, httpResponses: readonly AudioHttpProbe[], requestFailures: readonly string[]): Promise<void> {
  await page.addInitScript((eventNames: readonly string[]): void => {
    const mediaWindow = window; mediaWindow.audioObservation = null; mediaWindow.audioMediaEvents = [];
    for (const name of eventNames) {
      document.addEventListener(name, (event: Event): void => {
        if (!(event.target instanceof HTMLAudioElement)) return;
        mediaWindow.audioMediaEvents.push({ event: event.type, timestamp: new Date().toISOString(), currentTime: event.target.currentTime, duration: Number.isFinite(event.target.duration) ? event.target.duration : null, src: event.target.getAttribute('src') ?? '', audioElements: document.querySelectorAll('audio[data-storyboard-audio]').length, readyState: event.target.readyState, networkState: event.target.networkState,
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
  }, BROWSER_AUDIO_EVENTS);
  await page.goto(running.url);
  await page.locator('.project-tile').filter({ hasText: 'Real Audio A' }).click();
  await expect(page.getByRole('heading', { name: 'Real Audio A' })).toBeVisible();
  await page.getByRole('slider', { name: '재생 위치' }).fill(String(atMs));
  await page.getByRole('button', { name: '시간순 재생', exact: true }).click();
  await expect.poll(async (): Promise<AudioLoadProbe> => ({
    ...await page.evaluate((): Omit<AudioLoadProbe, 'httpResponses' | 'requestFailures' | 'serverEvents'> => ({ metadataSeen: window.audioObservation !== null,
      playhead: document.querySelector<HTMLInputElement>('input[type="range"]')?.value ?? null,
      notice: document.querySelector('.notice.error')?.textContent ?? null, mediaEvents: window.audioMediaEvents,
      activeAudioElements: document.querySelectorAll('audio[data-storyboard-audio]').length })),
    httpResponses: [...httpResponses], requestFailures: [...requestFailures], serverEvents: running.transport.events(),
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

async function checkRealAudio(page: Page, chromium: string, name: string, testInfo: TestInfo): Promise<{ chromium: string; initial: Awaited<ReturnType<typeof audioState>>; final: Awaited<ReturnType<typeof audioState>> }> {
  const lifecycle: AudioLifecycleEvent[] = []; const httpResponses: AudioHttpProbe[] = []; const requestFailures: string[] = []; const consoleLog: BrowserConsoleEntry[] = [];
  const record: AudioLifecycleRecorder = (event: AudioLifecycleEvent): void => { lifecycle.push(event); };
  const observePhase = (event: string, error: string | null): void => { record({ event, timestamp: new Date().toISOString(), heartbeatTimers: null, activeWorkers: null, queuedJobs: null, workerTimers: null, error }); };
  const onResponse = (response: Response): void => { if (response.url().includes('/output/audio/')) httpResponses.push({ timestamp: new Date().toISOString(), status: response.status(), contentRange: response.headers()['content-range'] ?? null, url: response.url() }); };
  const onRequestFailed = (request: Request): void => { if (request.url().includes('/output/audio/')) requestFailures.push(request.failure()?.errorText ?? 'unknown'); };
  const onConsole = (entry: ConsoleMessage): void => { consoleLog.push({ timestamp: new Date().toISOString(), level: entry.type(), text: entry.text().slice(0, 2000) }); };
  page.on('response', onResponse); page.on('requestfailed', onRequestFailed); page.on('console', onConsole);
  let ownedBrowserListeners: number = 3;
  let contextClosed: boolean = false; page.context().once('close', (): void => { contextClosed = true; observePhase('browser-context-close-end', null); });
  let running: RunningAudioApp | null = null; let bodyPassed: boolean = false; let bodyError: unknown = null;
  try {
    running = await startAudioApp(record);
    const atMs: number = name === 'e2e_real_audio_seek_uses_html_media_element' ? 6500 : 5000;
    await prepare(page, running, atMs, httpResponses, requestFailures);
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
    // 최초 Native 로딩 검사 뒤에 별도 200·206 요청을 보내 Cache 예열로 간헐 실패를 가리지 않는다.
    const endpoint: string = `/api/projects/${encodeURIComponent(running.projectId)}/output/audio/${encodeURIComponent(running.cue.id)}`;
    const transportChecks = await page.evaluate(async (url: string): Promise<{ fullStatus: number; rangeStatus: number; fullBytes: number; rangeBytes: number; contentRange: string | null }> => {
      const full: globalThis.Response = await fetch(url); const fullBytes: number = (await full.arrayBuffer()).byteLength;
      const range: globalThis.Response = await fetch(url, { headers: { Range: 'bytes=0-1023' } }); const rangeBytes: number = (await range.arrayBuffer()).byteLength;
      return { fullStatus: full.status, rangeStatus: range.status, fullBytes, rangeBytes, contentRange: range.headers.get('content-range') };
    }, endpoint);
    expect(transportChecks).toMatchObject({ fullStatus: 200, rangeStatus: 206, rangeBytes: 1024 });
    expect(transportChecks.fullBytes).toBeGreaterThan(1024); expect(transportChecks.contentRange).toBe(`bytes 0-1023/${transportChecks.fullBytes}`);
    const final = await audioState(page); bodyPassed = true;
    return { chromium, initial: state, final };
  } catch (error: unknown) { bodyError = error; throw error;
  } finally {
    const cleanupErrors: unknown[] = [];
    let browserSnapshot: { mediaEvents: MediaEventProbe[]; audioElements: number; uiError: string | null; playhead: string | null } | null = null;
    if (!page.isClosed()) {
      try { browserSnapshot = await page.evaluate(() => ({ mediaEvents: window.audioMediaEvents ?? [], audioElements: document.querySelectorAll('audio[data-storyboard-audio]').length,
        uiError: document.querySelector('.notice.error')?.textContent ?? null, playhead: document.querySelector<HTMLInputElement>('input[type="range"]')?.value ?? null })); }
      catch (error: unknown) { cleanupErrors.push(error); observePhase('browser-snapshot-failed', error instanceof Error ? error.name : 'UNKNOWN'); }
    }
    observePhase('browser-context-close-start', null);
    try { await page.context().close(); } catch (error: unknown) { cleanupErrors.push(error); }
    page.off('response', onResponse); page.off('requestfailed', onRequestFailed); page.off('console', onConsole);
    ownedBrowserListeners = 0;
    if (running !== null) {
      observePhase('app-close-start', null);
      try { await running.app.close(); observePhase('app-close-end', null); }
      catch (error: unknown) {
        cleanupErrors.push(error); observePhase('app-close-end', error instanceof Error ? error.name : 'UNKNOWN');
        const closed: PromiseSettledResult<void>[] = await Promise.allSettled([running.normalizer.close(), running.store.close()]);
        for (const result of closed) if (result.status === 'rejected') cleanupErrors.push(result.reason);
      }
      await running.transport.waitForClosedConnections();
      running.transport.dispose();
    }
    const workers = running?.normalizer.diagnostics() ?? null;
    const transport = running?.transport.resources() ?? null;
    const remaining = { browserContexts: page.context().browser()?.contexts().filter((context): boolean => context === page.context()).length ?? (contextClosed ? 0 : 1),
      heartbeatTimers: running?.store.heartbeatTimers() ?? 0, workerTimers: workers === null ? 0 : workers.queueTimers + workers.executionTimers,
      activeWorkers: workers?.activeWorkers ?? 0, queuedJobs: workers?.queuedJobs ?? 0,
      listeners: (transport?.listeners ?? 0) + ownedBrowserListeners,
      sockets: transport?.sockets ?? 0, requests: transport?.requests ?? 0, serverListening: running?.app.server.listening ?? false };
    let rootRemoved: boolean = false;
    if (running !== null && !remaining.serverListening && remaining.activeWorkers === 0 && remaining.heartbeatTimers === 0 && remaining.sockets === 0) {
      try { await rm(running.root, { recursive: true, force: true }); rootRemoved = true; }
      catch (error: unknown) { cleanupErrors.push(error); }
    }
    const artifact = { name, repetition: testInfo.repeatEachIndex + 1, chromium, bodyPassed, contextClosed, rootRemoved,
      scope: 'owned application and diagnostics resources', remaining, workerState: workers, browserSnapshot, httpResponses, requestFailures,
      lifecycle, serverEvents: running?.transport.events() ?? [], consoleLog,
      errors: [bodyError, ...cleanupErrors].filter((error: unknown): boolean => error !== null).map((error: unknown): string => error instanceof Error ? error.message : String(error)) };
    for (const [file, value] of [['audio-diagnostics.json', artifact], ['server-lifecycle.json', { lifecycle, events: artifact.serverEvents, remaining }], ['browser-console.json', consoleLog]] as const) {
      const path: string = testInfo.outputPath(file); await writeFile(path, JSON.stringify(value, null, 2));
      await testInfo.attach(file, { path, contentType: 'application/json' });
    }
    if (cleanupErrors.length > 0) throw new AggregateError(bodyError === null ? cleanupErrors : [bodyError, ...cleanupErrors], '실제 Audio 검증의 자원 정리에 실패했습니다.');
    expect(contextClosed).toBe(true); expect(remaining).toEqual({ browserContexts: 0, heartbeatTimers: 0, workerTimers: 0, activeWorkers: 0, queuedJobs: 0, listeners: 0, sockets: 0, requests: 0, serverListening: false });
    if (running !== null) expect(rootRemoved).toBe(true);
  }
}

test('e2e_real_wav_decodes_in_chromium', async ({ page, browser }, testInfo): Promise<void> => {
  const evidence = await checkRealAudio(page, browser.version(), 'e2e_real_wav_decodes_in_chromium', testInfo);
  await testInfo.attach('real-media-evidence', { body: JSON.stringify(evidence), contentType: 'application/json' });
});

test('e2e_real_audio_loadedmetadata_reports_duration', async ({ page, browser }, testInfo): Promise<void> => {
  const evidence = await checkRealAudio(page, browser.version(), 'e2e_real_audio_loadedmetadata_reports_duration', testInfo);
  await testInfo.attach('real-media-evidence', { body: JSON.stringify(evidence), contentType: 'application/json' });
});

test('e2e_real_audio_seek_uses_html_media_element', async ({ page, browser }, testInfo): Promise<void> => {
  const evidence = await checkRealAudio(page, browser.version(), 'e2e_real_audio_seek_uses_html_media_element', testInfo);
  await testInfo.attach('real-media-evidence', { body: JSON.stringify(evidence), contentType: 'application/json' });
});

test('e2e_real_audio_stops_at_cue_end', async ({ page, browser }, testInfo): Promise<void> => {
  const evidence = await checkRealAudio(page, browser.version(), 'e2e_real_audio_stops_at_cue_end', testInfo);
  await testInfo.attach('real-media-evidence', { body: JSON.stringify(evidence), contentType: 'application/json' });
});

test('e2e_real_audio_is_disposed_on_monitor_close', async ({ page, browser }, testInfo): Promise<void> => {
  const evidence = await checkRealAudio(page, browser.version(), 'e2e_real_audio_is_disposed_on_monitor_close', testInfo);
  await testInfo.attach('real-media-evidence', { body: JSON.stringify(evidence), contentType: 'application/json' });
});

test('e2e_real_audio_is_disposed_on_project_switch', async ({ page, browser }, testInfo): Promise<void> => {
  const evidence = await checkRealAudio(page, browser.version(), 'e2e_real_audio_is_disposed_on_project_switch', testInfo);
  await testInfo.attach('real-media-evidence', { body: JSON.stringify(evidence), contentType: 'application/json' });
});

test('e2e_audio_start_survives_early_animation_frame_timestamp', async ({ page, browser }, testInfo): Promise<void> => {
  let injected: number = 0;
  await page.exposeFunction('recordEarlyAudioFrame', (): void => { injected += 1; });
  await page.addInitScript((): void => {
    const nativeFrame: typeof window.requestAnimationFrame = window.requestAnimationFrame.bind(window);
    let delivered: boolean = false;
    window.requestAnimationFrame = (callback: FrameRequestCallback): number => {
      const requestedAt: number = performance.now();
      return nativeFrame((timestamp: number): void => {
        if (!delivered && document.querySelector('audio[data-storyboard-audio]') !== null) {
          delivered = true;
          void window.recordEarlyAudioFrame();
          callback(requestedAt - 20);
        } else callback(timestamp);
      });
    };
  });
  await checkRealAudio(page, browser.version(), 'e2e_audio_start_survives_early_animation_frame_timestamp', testInfo);
  expect(injected).toBe(1);
});

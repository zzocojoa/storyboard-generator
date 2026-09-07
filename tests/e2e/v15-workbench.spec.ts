import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, test } from '@playwright/test';
import type { FastifyInstance } from 'fastify';
import { CodexRequestStore } from '../../src/codex/requests.js';
import type { Asset, AudioCue, NativeDataset, PackagePayload, Project, Shot, StoryboardFrame, TextCue } from '../../src/domain/schema.js';
import { importPackage } from '../../src/importers/import-package.js';
import { sha256Bytes, sha256Text } from '../../src/importers/integrity.js';
import { createSourceOutline } from '../../src/proposal/outline.js';
import { applySegmentProposal, SegmentProposalSchema } from '../../src/proposal/model.js';
import { createApp } from '../../src/server/app.js';
import type { AppConfig } from '../../src/server/config.js';
import { ProjectStore } from '../../src/server/store.js';
import type { StorageFaultInjector, StorageFaultPoint } from '../../src/server/store.js';
import { nativeData, nativePackage, pcmWav, png, TEST_AUDIO_NORMALIZATION_OPTIONS, withNativeData } from '../helpers.js';

type RunningApp = { app: FastifyInstance; dataRoot: string; root: string; store: ProjectStore; url: string };
type MutableFault = { enabled: boolean; injector: StorageFaultInjector };
type NativeTextPlacement = NativeDataset['textPlacements'][number];

async function outline(projectId: string, title: string): Promise<Project> {
  const payload = await nativePackage();
  const project: Project = createSourceOutline(importPackage(withNativeData(payload, { ...nativeData(payload), projectId })), { proposedTextHoldMs: 2000 });
  return { ...project, title };
}

async function root(prefix: string): Promise<string> { return mkdtemp(join(tmpdir(), prefix)); }
function projectDirectory(dataRoot: string, projectId: string): string { return join(dataRoot, sha256Text(projectId)); }

async function startApp(rootPath: string, store: ProjectStore): Promise<RunningApp> {
  const dataRoot: string = join(rootPath, 'data'); const requestRoot: string = join(rootPath, 'requests');
  await mkdir(requestRoot, { recursive: true });
  const config: AppConfig = { host: '127.0.0.1', port: 0, dataRoot, webRoot: resolve('dist/web'),
    pdfFontPath: resolve('assets/fonts/NanumGothic-Regular.ttf'), audioNormalization: TEST_AUDIO_NORMALIZATION_OPTIONS,
    codex: { requestRoot, speechVoice: 'Yuna' } };
  const app: FastifyInstance = await createApp(config, store, new CodexRequestStore(requestRoot));
  const url: string = await app.listen({ host: '127.0.0.1', port: 0 });
  return { app, dataRoot, root: rootPath, store, url };
}

async function stopApp(running: RunningApp): Promise<void> {
  await running.app.close(); await rm(running.root, { recursive: true, force: true });
}

function mutableFault(): MutableFault {
  const state: MutableFault = { enabled: false, injector: { ownerPid: process.pid, trigger(point: StorageFaultPoint): void {
    if (state.enabled && point === 'before-lock-write') throw new Error('의도한 Lock 획득 장애');
  } } };
  return state;
}

function nonSourcedShot(shot: Shot, visualMode: 'black' | 'hold-previous'): Shot {
  return { ...shot, visualMode, sourceLinks: shot.sourceLinks.map((link) => ({ ...link,
    usage: link.usage === 'primary-visual' || link.usage === 'continued-visual' ? 'context-only' as const : link.usage })) };
}

test('e2e_open_text_placement_end_is_edited_and_confirmed', async ({ page }): Promise<void> => {
  const rootPath: string = await root('storyboard-e2e-text-confirm-'); const dataRoot: string = join(rootPath, 'data'); const store = new ProjectStore(dataRoot);
  const payload: PackagePayload = await nativePackage(); const data: NativeDataset = nativeData(payload);
  const firstSegmentId: string | undefined = data.segments[0]?.id;
  const placement: NativeTextPlacement | undefined = data.textPlacements.find((candidate: NativeTextPlacement): boolean => candidate.segmentId === firstSegmentId);
  if (placement === undefined) throw new Error('첫 구간의 Text Placement가 없습니다.');
  const openData: NativeDataset = { ...data, projectId: 'e2e-text-confirm',
    textPlacements: data.textPlacements.map((candidate: NativeTextPlacement): NativeTextPlacement => candidate.id === placement.id ? { ...candidate, endMs: null } : candidate) };
  const base: Project = createSourceOutline(importPackage(withNativeData(payload, openData)), { proposedTextHoldMs: 2000 });
  const cue: TextCue | undefined = base.textCues.find((candidate: TextCue): boolean => candidate.placementId === placement.id);
  if (cue === undefined) throw new Error('열린 Placement 글자 큐가 없습니다.');
  const open: Project = { ...base, title: 'Text Timing Confirmation' };
  await store.create(open); const running: RunningApp = await startApp(rootPath, store);
  try {
    await page.goto(running.url); await expect(page.getByRole('heading', { name: 'Text Timing Confirmation' })).toBeVisible();
    const editor = page.locator('.inspector-section.text-block .track-editor').filter({ hasText: cue.text }).first();
    const type = editor.locator('label.field').filter({ hasText: /^TYPE/ }).locator('select');
    const start = editor.locator('label.field').filter({ hasText: /^START MS/ }).locator('input');
    const end = editor.locator('label.field').filter({ hasText: /^END MS/ }).locator('input');
    await expect(editor).toBeVisible(); await expect(editor.locator('header span')).toHaveText('PROPOSED');
    await expect(type).toBeDisabled(); await expect(start).toBeDisabled(); await expect(end).toBeEnabled();
    const changedEndMs: number = cue.endMs + 500;
    await end.fill(String(changedEndMs)); await expect(editor.getByRole('button', { name: '변경 저장 후 확정' })).toBeDisabled();
    await editor.getByRole('button', { name: '종료 시각 저장' }).click();
    await expect(editor.locator('header span')).toHaveText('PROPOSED'); await expect(end).toHaveValue(String(changedEndMs));
    await expect(editor.getByRole('button', { name: '시각 확정', exact: true })).toBeEnabled();
    await editor.getByRole('button', { name: '시각 확정', exact: true }).click();
    await expect(editor.locator('header span')).toHaveText('CONFIRMED'); await expect(editor.getByRole('button', { name: '시각 확정됨' })).toBeDisabled();
  } finally { await stopApp(running); }
});

test('e2e_late_anchor_key_frame_is_visible', async ({ page }): Promise<void> => {
  const rootPath: string = await root('storyboard-e2e-anchor-'); const dataRoot: string = join(rootPath, 'data'); const store = new ProjectStore(dataRoot);
  const base: Project = await outline(`e2e-anchor-${randomUUID()}`, 'Late Anchor');
  const proposal = SegmentProposalSchema.parse({ shots: [{
    sourceLinks: [
      { unitId: '안내-1', usage: 'primary-visual', anchor: { startPermille: 0, endPermille: 700 } },
      { unitId: '동작', usage: 'primary-visual', anchor: { startPermille: 700, endPermille: 1000 } },
      { unitId: '효과음', usage: 'audio-only' },
    ], durationWeight: 1, action: 'Late Anchor 화면', visualLocationId: null,
    camera: { size: 'CU', angle: 'eye', move: 'static' }, presence: [], propIds: [], cameraAxis: null,
    screenDirection: null, informationIds: [], transitionOut: { kind: 'cut', durationMs: 0, note: '' }, frameDescription: '시작 화면',
  }] });
  await store.create(applySegmentProposal(base, 'demonstration', proposal, 'e2e-late-anchor'));
  const running: RunningApp = await startApp(rootPath, store);
  try {
    await page.goto(running.url); await expect(page.getByRole('heading', { name: 'Late Anchor' })).toBeVisible();
    await page.locator('.segment-row').nth(1).click();
    await expect(page.locator('.frame-editor header b', { hasText: 'KEY' })).toBeVisible();
    await expect(page.locator('.frame-editor').filter({ hasText: '+5950ms' })).toBeVisible();
    await expect(page.locator('.mapping-editor').filter({ hasText: '동작' })).toContainText('ABSOLUTE REVEAL · 10950ms');
  } finally { await stopApp(running); }
});

test('e2e_project_recovery_disables_only_selected_project', async ({ page }): Promise<void> => {
  const rootPath: string = await root('storyboard-e2e-recovery-'); const dataRoot: string = join(rootPath, 'data'); const creator = new ProjectStore(dataRoot);
  const open: Project = await creator.create(await outline('e2e-open', 'Project A'));
  const blocked: Project = await creator.create(await outline('e2e-blocked', 'Project B')); await creator.close();
  const directoryName: string = sha256Text(blocked.projectId); await writeFile(join(dataRoot, '.recovery-blocks', `${directoryName}.json`), JSON.stringify({
    version: 1, projectId: blocked.projectId, directoryName, transactionId: 'operator-review', code: 'STORE_RECOVERY_REQUIRED',
    message: 'Project B만 복구 검토가 필요합니다.', detectedAt: '2026-09-07T00:00:00.000Z',
  }));
  const running: RunningApp = await startApp(rootPath, new ProjectStore(dataRoot));
  try {
    await page.goto(running.url); await page.locator('.project-tile').filter({ hasText: 'Project B' }).click();
    await expect(page.locator('.storage-recovery-banner')).toBeVisible(); await expect(page.locator('button.propose')).toBeDisabled();
    await page.locator('.project-tile').filter({ hasText: 'Project A' }).click();
    await expect(page.getByRole('heading', { name: open.title })).toBeVisible(); await expect(page.locator('.storage-recovery-banner')).toHaveCount(0);
    await expect(page.locator('button.propose')).toBeEnabled();
  } finally { await stopApp(running); }
});

test('e2e_asset_integrity_notice_clears_after_reconcile', async ({ page }): Promise<void> => {
  const rootPath: string = await root('storyboard-e2e-integrity-'); const dataRoot: string = join(rootPath, 'data'); const store = new ProjectStore(dataRoot);
  const initial: Project = await store.create(await outline('e2e-integrity', 'Asset Integrity')); const frame: StoryboardFrame = initial.frames[0] as StoryboardFrame;
  const content: Buffer = await png(2, 2); const asset: Asset = { id: 'e2e-image', kind: 'image', subjectId: frame.id,
    path: 'assets/e2e-image.png', mimeType: 'image/png', sha256: sha256Bytes(content), description: 'E2E', durationMs: null, version: 1 };
  await store.update(initial.projectId, 0, (project: Project): Project => ({ ...project, assets: [asset],
    frames: project.frames.map((candidate: StoryboardFrame): StoryboardFrame => candidate.id === frame.id
      ? { ...candidate, imageAssetId: asset.id, visualReview: 'accepted' } : candidate) }), [{ relativePath: asset.path, content }]);
  const assetPath: string = join(projectDirectory(dataRoot, initial.projectId), asset.path); await writeFile(assetPath, Buffer.from('broken'));
  const running: RunningApp = await startApp(rootPath, store);
  try {
    await page.goto(running.url); await expect(page.locator('.asset-integrity-banner')).toContainText('STORED_ASSET_HASH_MISMATCH');
    await writeFile(assetPath, content); await page.getByRole('button', { name: 'REFRESH' }).click();
    await expect(page.locator('.asset-integrity-banner')).toHaveCount(0);
  } finally { await stopApp(running); }
});

test('e2e_24fps_and_duration_timecode_are_distinct', async ({ page }): Promise<void> => {
  const rootPath: string = await root('storyboard-e2e-timecode-'); const dataRoot: string = join(rootPath, 'data'); const store = new ProjectStore(dataRoot);
  const base: Project = await outline('e2e-timecode', 'Timecode'); await store.create({ ...base, handoff: { ...base.handoff,
    timebase: { ...base.handoff.timebase, fpsNumerator: 24, fpsDenominator: 1, dropFrame: false, startTimecode: '01:00:00:00' } } });
  const running: RunningApp = await startApp(rootPath, store);
  try {
    await page.goto(running.url); await expect(page.locator('.project-index')).toHaveText('00:17:12');
    await expect(page.locator('.segment-row').first()).toContainText('01:00:00:00');
    await expect(page.locator('.timeline header time')).toHaveText('01:00:00:00');
    await expect(page.locator('.timeline header span').last()).toHaveText('00:17:12');
  } finally { await stopApp(running); }
});

test('e2e_audio_seek_and_end_cleanup', async ({ page }): Promise<void> => {
  const rootPath: string = await root('storyboard-e2e-audio-'); const dataRoot: string = join(rootPath, 'data'); const store = new ProjectStore(dataRoot);
  await store.create(await outline('e2e-audio-other', 'Other Project'));
  const initial: Project = await store.create(await outline('e2e-audio', 'Audio Project')); const cue: AudioCue = initial.audioCues[0] as AudioCue;
  const content: Buffer = pcmWav(2000, 48000, 1, 16); const asset: Asset = { id: 'e2e-audio-asset', kind: 'audio', subjectId: cue.id,
    path: 'assets/e2e-audio.wav', mimeType: 'audio/wav', sha256: sha256Bytes(content), description: 'E2E 음성', durationMs: 2000, version: 1,
    audioMetadata: { sampleRate: 48000, channels: 1, codec: 'pcm_s16le' } };
  await store.update(initial.projectId, 0, (project: Project): Project => ({ ...project, assets: [asset], audioCues: project.audioCues.map((candidate: AudioCue): AudioCue => candidate.id === cue.id
    ? { ...candidate, startMs: 5000, endMs: 7000, timingStatus: 'measured', timingRelation: 'within-segment', assetId: asset.id } : candidate) }), [{ relativePath: asset.path, content }]);
  await page.addInitScript((): void => {
    type AudioState = { currentTime: number };
    type Tracked = { element: AudioState; pauses: number; plays: number };
    const tracked: Tracked[] = [];
    class TrackedAudio implements AudioState {
      currentTime: number = 0;
      readonly tracked: Tracked;
      constructor(_src?: string) { this.tracked = { element: this, pauses: 0, plays: 0 }; tracked.push(this.tracked); }
      pause(): void { this.tracked.pauses += 1; }
      play(): Promise<void> { this.tracked.plays += 1; return Promise.resolve(); }
    }
    Object.defineProperty(window, 'Audio', { value: TrackedAudio as unknown as typeof Audio });
    Object.assign(window, { __trackedAudio: tracked });
  });
  const running: RunningApp = await startApp(rootPath, store);
  try {
    await page.goto(running.url); await page.locator('.project-tile').filter({ hasText: 'Audio Project' }).click();
    await expect(page.getByRole('heading', { name: 'Audio Project' })).toBeVisible();
    const safeAudio = await page.request.get(`${running.url}/api/projects/${encodeURIComponent(initial.projectId)}/output/audio/${encodeURIComponent(cue.id)}`);
    expect(safeAudio.status()).toBe(200);
    const scrubber = page.locator('.scrubber');
    await scrubber.evaluate((input: HTMLInputElement): void => {
      const setter: ((this: HTMLInputElement, value: string) => void) | undefined = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      if (setter === undefined) throw new Error('Range input value setter를 찾을 수 없습니다.');
      setter.call(input, '5000'); input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await expect(page.locator('.timeline header time')).toHaveText('00:05:00');
    await page.getByRole('button', { name: '시간순 재생' }).click();
    await expect.poll(() => page.evaluate((): number => (window as unknown as { __trackedAudio: unknown[] }).__trackedAudio.length)).toBeGreaterThan(0);
    const firstAudioCount: number = await page.evaluate((): number => (window as unknown as { __trackedAudio: unknown[] }).__trackedAudio.length);
    await page.evaluate((): void => {
      const button: HTMLButtonElement | null = document.querySelector<HTMLButtonElement>('.monitor-bar button');
      if (button === null) throw new Error('Program Monitor 닫기 버튼을 찾을 수 없습니다.');
      button.click();
    });
    await expect.poll(() => page.evaluate((count: number): number => (window as unknown as { __trackedAudio: Array<{ pauses: number }> }).__trackedAudio
      .slice(0, count).reduce((total: number, tracked: { pauses: number }): number => total + tracked.pauses, 0), firstAudioCount)).toBeGreaterThan(0);
    await scrubber.evaluate((input: HTMLInputElement): void => {
      const setter: ((this: HTMLInputElement, value: string) => void) | undefined = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      if (setter === undefined) throw new Error('Range input value setter를 찾을 수 없습니다.');
      setter.call(input, '6000'); input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await expect(page.locator('.timeline header time')).toHaveText('00:06:00');
    await page.getByRole('button', { name: '시간순 재생' }).click();
    await expect.poll(() => page.evaluate((): number => (window as unknown as { __trackedAudio: unknown[] }).__trackedAudio.length)).toBeGreaterThan(firstAudioCount);
    const secondAudioIndex: number = await page.evaluate((): number => (window as unknown as { __trackedAudio: unknown[] }).__trackedAudio.length - 1);
    await expect.poll(() => page.evaluate((index: number): number => (window as unknown as { __trackedAudio: Array<{ element: HTMLAudioElement }> }).__trackedAudio[index]?.element.currentTime ?? -1, secondAudioIndex)).toBeGreaterThan(0.9);
    await expect.poll(() => page.evaluate((index: number): number => (window as unknown as { __trackedAudio: Array<{ pauses: number }> }).__trackedAudio[index]?.pauses ?? 0, secondAudioIndex)).toBeGreaterThan(0);
  } finally { await stopApp(running); }
});

test('e2e_409_and_503_do_not_create_persistent_project_block', async ({ page }): Promise<void> => {
  const rootPath: string = await root('storyboard-e2e-errors-'); const dataRoot: string = join(rootPath, 'data'); const creator = new ProjectStore(dataRoot);
  const initial: Project = await creator.create(await outline('e2e-errors', 'Transient Errors')); const fault: MutableFault = mutableFault();
  const running: RunningApp = await startApp(rootPath, new ProjectStore(dataRoot, fault.injector));
  try {
    await page.goto(running.url); const external = new ProjectStore(dataRoot);
    await external.update(initial.projectId, 0, (project: Project): Project => ({ ...project, title: 'Transient Errors' }), []); await external.close();
    await page.getByRole('button', { name: '프레임 저장' }).click(); await expect(page.locator('.notice.error')).toContainText('Revision');
    await expect(page.locator('.storage-recovery-banner')).toHaveCount(0); await page.getByRole('button', { name: 'REFRESH' }).click();
    fault.enabled = true; await page.getByRole('button', { name: '프레임 저장' }).click(); await expect(page.locator('.notice.error')).toContainText('STORAGE TEMPORARILY UNAVAILABLE');
    await expect(page.locator('.storage-recovery-banner')).toHaveCount(0);
  } finally { await stopApp(running); }
});

test('e2e_black_and_hold_previous_visual_modes', async ({ page }): Promise<void> => {
  const rootPath: string = await root('storyboard-e2e-visual-modes-'); const dataRoot: string = join(rootPath, 'data'); const store = new ProjectStore(dataRoot);
  const base: Project = await outline('e2e-visual-modes', 'Visual Modes'); const shots: Shot[] = base.shots.map((shot: Shot, index: number): Shot =>
    index === 0 ? nonSourcedShot(shot, 'hold-previous') : index === 1 ? nonSourcedShot(shot, 'black') : index === 2 ? nonSourcedShot(shot, 'hold-previous') : shot);
  await store.create({ ...base, shots }); const running: RunningApp = await startApp(rootPath, store);
  try {
    await page.goto(running.url); await expect(page.locator('.shot-frame[data-visual-mode="hold-previous"] .frame-placeholder')).toContainText('HOLD_PREVIOUS_SOURCE_UNAVAILABLE');
    await expect(page.locator('.frame-generate')).toBeDisabled();
    await page.locator('.segment-row').nth(1).click(); await expect(page.locator('.shot-frame[data-visual-mode="black"] img')).toBeVisible();
    await expect(page.locator('.frame-output-state')).toContainText('BLACK · OUTPUT SAFE');
    await page.locator('.segment-row').nth(2).click(); await expect(page.locator('.shot-frame[data-visual-mode="hold-previous"] img')).toBeVisible();
    await expect(page.locator('.frame-output-state')).toContainText('HOLD');
  } finally { await stopApp(running); }
});

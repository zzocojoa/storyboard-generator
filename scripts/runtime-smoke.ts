import { readBuildManifest, generatorBuildProvenance } from '../src/build.js';
import { readReviewArchive, writeReviewBundle } from '../src/exporters/review-bundle.js';
import { finalFixture, readinessOutline, withFirstGap } from '../tests/readiness-fixtures.js';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { FastifyInstance } from 'fastify';
import sharp from 'sharp';
import { CodexRequestStore } from '../src/codex/requests.js';
import type { Asset, AudioCue, GenerationRecord, Project, Shot, StoryboardFrame } from '../src/domain/schema.js';
import { sha256Bytes, sha256Text } from '../src/importers/integrity.js';
import { applySegmentProposal, SegmentProposalSchema } from '../src/proposal/model.js';
import { createApp } from '../src/server/app.js';
import type { AppConfig } from '../src/server/config.js';
import { ProjectStore } from '../src/server/store.js';
import type { StorageFaultInjector, StorageFaultPoint } from '../src/server/store.js';

type RunningApp = { app: FastifyInstance; store: ProjectStore; url: string };
type HttpResult = { body: unknown; bytes: Buffer; status: number };
type Barrier = { injector: StorageFaultInjector; reached: Promise<void>; release(): void };

const HANDOFF_PATH: string = resolve('tests/fixtures/native/storyboard_handoff.json');
const AUDIO_OPTIONS: AppConfig['audioNormalization'] = {
  maxWorkers: 1, maxQueuedJobs: 2, maxQueuedInputBytes: 16 * 1024 * 1024,
  queueTimeoutMs: 10_000, executionTimeoutMs: 10_000,
  maxOldGenerationSizeMb: 96, maxYoungGenerationSizeMb: 16, stackSizeMb: 4,
};

function appConfig(root: string, dataRoot: string): AppConfig {
  return { host: '127.0.0.1', port: 0, dataRoot, webRoot: resolve('dist/web'),
    pdfFontPath: resolve('assets/fonts/NanumGothic-Regular.ttf'), audioNormalization: AUDIO_OPTIONS,
    codex: { requestRoot: join(root, 'requests'), speechVoice: 'Yuna' } };
}

async function startApp(root: string, dataRoot: string, store: ProjectStore): Promise<RunningApp> {
  const config: AppConfig = appConfig(root, dataRoot);
  await mkdir(config.codex.requestRoot, { recursive: true });
  const app: FastifyInstance = await createApp(config, store, new CodexRequestStore(config.codex.requestRoot, readBuildManifest()));
  const url: string = await app.listen({ host: config.host, port: 0 });
  return { app, store, url };
}

async function request(url: string, path: string, init: RequestInit): Promise<HttpResult> {
  const response: Response = await fetch(`${url}${path}`, init);
  const bytes: Buffer = Buffer.from(await response.arrayBuffer());
  let body: unknown = null;
  if ((response.headers.get('content-type') ?? '').includes('json')) body = JSON.parse(bytes.toString('utf8')) as unknown;
  return { body, bytes, status: response.status };
}

async function expectStatus(url: string, path: string, init: RequestInit, status: number): Promise<HttpResult> {
  const result: HttpResult = await request(url, path, init);
  assert.equal(result.status, status, `${init.method ?? 'GET'} ${path}: ${result.status} ${result.bytes.toString('utf8')}`);
  return result;
}

function json(method: string, value: object): RequestInit {
  return { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(value) };
}

function projectFrom(result: HttpResult): Project {
  return (result.body as { project: Project }).project;
}

function pcmWav(durationMs: number, sampleRate: number): Buffer {
  const sampleFrames: number = Math.round(sampleRate * durationMs / 1000);
  const dataLength: number = sampleFrames * 2;
  const bytes: Buffer = Buffer.alloc(44 + dataLength);
  bytes.write('RIFF', 0); bytes.writeUInt32LE(36 + dataLength, 4); bytes.write('WAVE', 8); bytes.write('fmt ', 12);
  bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22); bytes.writeUInt32LE(sampleRate, 24);
  bytes.writeUInt32LE(sampleRate * 2, 28); bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34);
  bytes.write('data', 36); bytes.writeUInt32LE(dataLength, 40);
  return bytes;
}

function nonSourced(shot: Shot, visualMode: 'black' | 'hold-previous'): Shot {
  return { ...shot, visualMode, sourceLinks: shot.sourceLinks.map((link) => ({ ...link,
    usage: link.usage === 'primary-visual' || link.usage === 'continued-visual' ? 'context-only' as const : link.usage })) };
}

function barrier(point: StorageFaultPoint): Barrier {
  let reached: (() => void) | null = null;
  let release: (() => void) | null = null;
  const reachedPromise: Promise<void> = new Promise<void>((resolveReached): void => { reached = resolveReached; });
  const held: Promise<void> = new Promise<void>((resolveHeld): void => { release = resolveHeld; });
  let used: boolean = false;
  return { reached: reachedPromise, release(): void { release?.(); }, injector: { ownerPid: process.pid,
    async trigger(candidate: StorageFaultPoint): Promise<void> {
      if (used || candidate !== point) return;
      used = true; reached?.(); await held;
    } } };
}

async function runPrimarySmoke(root: string): Promise<{ ports: number[]; checks: string[] }> {
  const dataRoot: string = join(root, 'primary-data');
  let running: RunningApp | null = await startApp(join(root, 'primary-app'), dataRoot, new ProjectStore(dataRoot));
  const ports: number[] = [Number(new URL(running.url).port)];
  const checks: string[] = [];
  try {
    await expectStatus(running.url, '/', {}, 200); checks.push('root:200');
    const initialStatus: HttpResult = await expectStatus(running.url, '/api/status', {}, 200);
    assert.equal((initialStatus.body as { processHeartbeat: { healthy: boolean } }).processHeartbeat.healthy, true);
    checks.push('status:200', 'heartbeat:healthy');
    const imported: Project = projectFrom(await expectStatus(running.url, '/api/projects/import', json('POST', {
      handoffPath: HANDOFF_PATH, proposedTextHoldMs: 2000,
    }), 201));
    await expectStatus(running.url, `/api/projects/${encodeURIComponent(imported.projectId)}`, {}, 200); checks.push('import:201', 'project:200');

    const proposal = SegmentProposalSchema.parse({ shots: [{
      sourceLinks: [
        { unitId: '안내-1', usage: 'primary-visual', anchor: { startPermille: 0, endPermille: 700 } },
        { unitId: '동작', usage: 'primary-visual', anchor: { startPermille: 700, endPermille: 1000 } },
        { unitId: '효과음', usage: 'audio-only' },
      ], visualMode: 'sourced', durationWeight: 1, action: '화분 관리 동작', visualLocationId: null,
      camera: { size: 'CU', angle: 'eye', move: 'static' }, presence: [], propIds: [], cameraAxis: null,
      screenDirection: null, informationIds: [], transitionOut: { kind: 'cut', durationMs: 0, note: '' }, frameDescription: '화분 관리 시작',
    }] });
    let project: Project = await running.store.update(imported.projectId, imported.revision,
      (current: Project): Project => applySegmentProposal(current, 'demonstration', proposal, 'runtime-late-anchor'), []);
    const keyFrame: StoryboardFrame = project.frames.find((frame: StoryboardFrame): boolean => frame.shotId === 'runtime-late-anchor:shot:1' && frame.role === 'key') as StoryboardFrame;
    assert.ok(keyFrame);
    await expectStatus(running.url, `/api/projects/${encodeURIComponent(project.projectId)}/frames/${encodeURIComponent(keyFrame.id)}/generate`, json('POST', { expectedRevision: project.revision }), 202);
    checks.push('late-anchor:applied', 'key-frame:created', 'frame-context:202');

    const sourceFrame: StoryboardFrame = project.frames.find((frame: StoryboardFrame): boolean => frame.shotId === 'runtime-late-anchor:shot:1' && frame.role === 'start') as StoryboardFrame;
    const audioCue: AudioCue = project.audioCues.find((cue: AudioCue): boolean => cue.unitId === '안내-1') as AudioCue;
    const imageBytes: Buffer = await sharp({ create: { width: 2, height: 2, channels: 4, background: '#204060' } }).png().toBuffer();
    const audioDurationMs: number = audioCue.endMs - audioCue.startMs;
    const audioBytes: Buffer = pcmWav(audioDurationMs, project.handoff.timebase.sampleRate);
    const imageAsset: Asset = { id: 'runtime-image', kind: 'image', subjectId: sourceFrame.id, path: 'assets/runtime-image.png',
      mimeType: 'image/png', sha256: sha256Bytes(imageBytes), description: 'Runtime Frame', durationMs: null, version: 1 };
    const keyAsset: Asset = { ...imageAsset, id: 'runtime-key-image', subjectId: keyFrame.id, path: 'assets/runtime-key-image.png' };
    const audioAsset: Asset = { id: 'runtime-audio', kind: 'audio', subjectId: audioCue.id, path: 'assets/runtime-audio.wav',
      mimeType: 'audio/wav', sha256: sha256Bytes(audioBytes), description: 'Runtime Audio', durationMs: audioDurationMs, version: 1,
      audioMetadata: { sampleRate: project.handoff.timebase.sampleRate, channels: 1, codec: 'pcm_s16le' } };
    const record: GenerationRecord = { id: 'runtime-generation', provider: 'codex-app', model: 'current', generatorBuild: generatorBuildProvenance(readBuildManifest()), modelVersion: null,
      requestId: randomUUID(), prompt: 'Runtime smoke frame', templateVersion: '1.0.0', seed: null, referenceHashes: [],
      resultAssetIds: [imageAsset.id], shotIds: [sourceFrame.shotId], createdAt: new Date().toISOString() };
    project = await running.store.update(project.projectId, project.revision, (current: Project): Project => ({ ...current,
      assets: [...current.assets, imageAsset, keyAsset, audioAsset], generationRecords: [...current.generationRecords, record],
      frames: current.frames.map((frame: StoryboardFrame): StoryboardFrame => frame.id === sourceFrame.id
        ? { ...frame, imageAssetId: imageAsset.id, visualReview: 'accepted' } : frame.id === keyFrame.id ? { ...frame, imageAssetId: keyAsset.id, visualReview: 'accepted' } : frame),
      audioCues: current.audioCues.map((cue: AudioCue): AudioCue => cue.id === audioCue.id
        ? { ...cue, assetId: audioAsset.id, timingStatus: 'measured' } : cue),
      shots: current.shots.map((shot: Shot, index: number): Shot => index === 0 ? nonSourced(shot, 'black')
        : index === 2 ? nonSourced(shot, 'hold-previous') : shot),
    }), [{ relativePath: imageAsset.path, content: imageBytes }, { relativePath: keyAsset.path, content: imageBytes }, { relativePath: audioAsset.path, content: audioBytes }]);

    const blackFrame: StoryboardFrame = project.frames.find((frame: StoryboardFrame): boolean => frame.shotId === project.shots[0]?.id) as StoryboardFrame;
    const holdFrame: StoryboardFrame = project.frames.find((frame: StoryboardFrame): boolean => frame.shotId === project.shots[2]?.id) as StoryboardFrame;
    const safeFrame: HttpResult = await expectStatus(running.url, `/api/projects/${encodeURIComponent(project.projectId)}/output/frame/${encodeURIComponent(sourceFrame.id)}`, {}, 200);
    assert.equal(safeFrame.bytes.subarray(1, 4).toString('ascii'), 'PNG');
    await expectStatus(running.url, `/api/projects/${encodeURIComponent(project.projectId)}/output/frame/${encodeURIComponent(blackFrame.id)}`, {}, 200);
    await expectStatus(running.url, `/api/projects/${encodeURIComponent(project.projectId)}/output/frame/${encodeURIComponent(holdFrame.id)}`, {}, 200);
    const safeAudio: HttpResult = await expectStatus(running.url, `/api/projects/${encodeURIComponent(project.projectId)}/output/audio/${encodeURIComponent(audioCue.id)}`, {}, 200);
    assert.equal(safeAudio.bytes.subarray(0, 4).toString('ascii'), 'RIFF');
    const audit: HttpResult = await expectStatus(running.url, `/api/projects/${encodeURIComponent(project.projectId)}/generation-audit`, {}, 200);
    assert.equal((audit.body as { records: unknown[] }).records.length, 1);
    const integrity: HttpResult = await expectStatus(running.url, `/api/projects/${encodeURIComponent(project.projectId)}/asset-integrity`, {}, 200);
    assert.deepEqual((integrity.body as { issues: unknown[] }).issues, []);
    checks.push('black:200', 'hold:200', 'safe-frame:200', 'safe-audio:200', 'audit:200', 'asset-integrity:200');

    const updated: Project = projectFrom(await expectStatus(running.url, `/api/projects/${encodeURIComponent(project.projectId)}/source-update`, json('POST', {
      handoffPath: HANDOFF_PATH, proposedTextHoldMs: 2000, expectedRevision: project.revision,
    }), 200));
    project = updated; checks.push('source-update:200');
    const exportedJson: HttpResult = await expectStatus(running.url, `/api/projects/${encodeURIComponent(project.projectId)}/export.json`, {}, 200);
    assert.equal((JSON.parse(exportedJson.bytes.toString('utf8')) as Project).schemaVersion, '1.7.0');
    await expectStatus(running.url, `/api/projects/${encodeURIComponent(project.projectId)}/export.csv`, {}, 200);
    const exportedPdf: HttpResult = await expectStatus(running.url, `/api/projects/${encodeURIComponent(project.projectId)}/export.pdf`, {}, 200);
    assert.equal(exportedPdf.bytes.subarray(0, 5).toString('ascii'), '%PDF-'); checks.push('json:200', 'csv:200', 'pdf:200');
    await expectStatus(running.url, `/api/projects/${encodeURIComponent(project.projectId)}/profile`, json('PATCH', {
      expectedRevision: 0, profile: project.profile,
    }), 409); checks.push('conflict:409');

    const imagePath: string = join(dataRoot, sha256Text(project.projectId), imageAsset.path);
    await writeFile(imagePath, Buffer.from('corrupt'));
    await expectStatus(running.url, `/api/projects/${encodeURIComponent(project.projectId)}/output/frame/${encodeURIComponent(sourceFrame.id)}`, {}, 423);
    await writeFile(imagePath, imageBytes); checks.push('asset:423');

    const projectId: string = project.projectId;
    await running.app.close(); running = null;
    const directoryName: string = sha256Text(projectId);
    const blockRoot: string = join(dataRoot, '.recovery-blocks');
    await writeFile(join(blockRoot, 'malformed-marker.json'), '{');
    await writeFile(join(blockRoot, `${directoryName}.json`), JSON.stringify({ version: 1, projectId, directoryName,
      transactionId: 'operator-review', code: 'STORE_RECOVERY_REQUIRED', message: 'Runtime recovery block', detectedAt: new Date().toISOString() }));
    running = await startApp(join(root, 'blocked-app'), dataRoot, new ProjectStore(dataRoot)); ports.push(Number(new URL(running.url).port));
    const blockedStatus: HttpResult = await expectStatus(running.url, '/api/status', {}, 200);
    assert.equal((blockedStatus.body as { invalidRecoveryMarkers: unknown[] }).invalidRecoveryMarkers.length, 1);
    await expectStatus(running.url, `/api/projects/${encodeURIComponent(projectId)}`, {}, 200);
    await expectStatus(running.url, `/api/projects/${encodeURIComponent(projectId)}/profile`, json('PATCH', {
      expectedRevision: project.revision, profile: project.profile,
    }), 423); checks.push('marker-quarantine:reported', 'project:423');
    return { ports, checks };
  } finally {
    if (running !== null) await running.app.close();
  }
}

async function runServiceFailure(root: string): Promise<{ port: number; check: string }> {
  const dataRoot: string = join(root, 'service-data');
  const creator: ProjectStore = new ProjectStore(dataRoot);
  const setup: RunningApp = await startApp(join(root, 'service-setup'), dataRoot, creator);
  const imported: Project = projectFrom(await expectStatus(setup.url, '/api/projects/import', json('POST', {
    handoffPath: HANDOFF_PATH, proposedTextHoldMs: 2000,
  }), 201));
  await setup.app.close();
  const injector: StorageFaultInjector = { ownerPid: process.pid, trigger(point: StorageFaultPoint): void {
    if (point === 'before-lock-write') throw new Error('Runtime lock acquisition failure');
  } };
  const running: RunningApp = await startApp(join(root, 'service-app'), dataRoot, new ProjectStore(dataRoot, injector));
  try {
    await expectStatus(running.url, `/api/projects/${encodeURIComponent(imported.projectId)}/profile`, json('PATCH', {
      expectedRevision: imported.revision, profile: imported.profile,
    }), 503);
    return { port: Number(new URL(running.url).port), check: 'service:503' };
  } finally { await running.app.close(); }
}

async function runActiveRefresh(root: string): Promise<{ port: number; checks: string[] }> {
  const dataRoot: string = join(root, 'active-data');
  const setup: RunningApp = await startApp(join(root, 'active-setup'), dataRoot, new ProjectStore(dataRoot));
  const imported: Project = projectFrom(await expectStatus(setup.url, '/api/projects/import', json('POST', {
    handoffPath: HANDOFF_PATH, proposedTextHoldMs: 2000,
  }), 201));
  await setup.app.close();
  const gate: Barrier = barrier('after-update-current-read');
  const writer: ProjectStore = new ProjectStore(dataRoot, gate.injector);
  const pending: Promise<Project> = writer.update(imported.projectId, imported.revision,
    (current: Project): Project => ({ ...current, title: `${current.title} Runtime` }), []);
  await gate.reached;
  const observer: RunningApp = await startApp(join(root, 'active-observer'), dataRoot, new ProjectStore(dataRoot));
  try {
    const active: HttpResult = await expectStatus(observer.url, '/api/status', {}, 200);
    assert.equal((active.body as { activeUpdates: unknown[] }).activeUpdates.length, 1);
    gate.release(); await pending;
    const refreshed: HttpResult = await expectStatus(observer.url, '/api/status', {}, 200);
    assert.equal((refreshed.body as { activeUpdates: unknown[] }).activeUpdates.length, 0);
    return { port: Number(new URL(observer.url).port), checks: ['active-update:reported', 'active-update:refreshed'] };
  } finally { gate.release(); await writer.close(); await observer.app.close(); }
}


async function runFinalSmoke(root: string): Promise<{ port: number; checks: string[] }> {
  const dataRoot: string = join(root, 'final-data');
  const running: RunningApp = await startApp(join(root, 'final-app'), dataRoot, new ProjectStore(dataRoot));
  const checks: string[] = [];
  try {
    const base: Project = await running.store.create(await readinessOutline()); const ready = await finalFixture();
    let project: Project = await running.store.update(base.projectId, base.revision, (): Project => ({ ...ready.project,
      textCues: ready.project.textCues.map((cue) => ({ ...cue, timingStatus: 'proposed' })) }),
      ready.project.assets.map((asset) => ({ relativePath: asset.path, content: ready.media.get(asset.id) as Buffer })));
    const path: string = `/api/projects/${encodeURIComponent(project.projectId)}`;
    const status = await expectStatus(running.url, '/api/status', {}, 200);
    assert.deepEqual((status.body as { build: unknown }).build, readBuildManifest()); checks.push('build:verified');
    const initial = await expectStatus(running.url, `${path}/final-readiness`, {}, 200);
    assert.equal((initial.body as { finalReady: boolean }).finalReady, false);
    for (const extension of ['csv', 'pdf']) {
      await expectStatus(running.url, `${path}/export.${extension}?maturity=draft`, {}, 200);
      const blocked = await expectStatus(running.url, `${path}/export.${extension}?maturity=final`, {}, 409);
      assert.equal((blocked.body as { error: { code: string } }).error.code, 'FINAL_OUTPUT_NOT_READY');
    }
    checks.push('draft-text:200', 'final-unconfirmed:409');
    for (const cue of project.textCues) project = projectFrom(await expectStatus(running.url, `${path}/text/${cue.id}/confirm`, json('POST', { expectedRevision: project.revision }), 200));
    assert.equal(((await expectStatus(running.url, `${path}/final-readiness`, {}, 200)).body as { finalReady: boolean }).finalReady, true);
    for (const extension of ['csv', 'pdf']) await expectStatus(running.url, `${path}/export.${extension}?maturity=final`, {}, 200);
    const archive = await readReviewArchive(dataRoot, project.projectId);
    const bundle = await writeReviewBundle(archive, { output: join(root, 'final-review'), maturity: 'final', fontPath: appConfig(root, dataRoot).pdfFontPath,
      build: readBuildManifest(), createdAt: new Date().toISOString() }, []);
    assert.equal(bundle.files.length, 8); await archive.assertUnchanged(); checks.push('text-confirm:200', 'final-pdf:200', 'final-csv:200', 'review-bundle:created');
    await expectStatus(running.url, `${path}/output/visual?atMs=0`, {}, 200);
    project = await running.store.update(project.projectId, project.revision, (current: Project): Project => withFirstGap(current, 1000), []);
    await expectStatus(running.url, `${path}/output/visual?atMs=1000`, {}, 409); checks.push('actual-playhead-gap:409');
    project = await running.store.update(project.projectId, project.revision, (current: Project): Project => ({ ...current,
      shots: current.shots.map((shot: Shot, index: number): Shot => index === 1 ? nonSourced(shot, 'hold-previous') : shot) }), []);
    await expectStatus(running.url, `${path}/output/visual?atMs=5000`, {}, 409); checks.push('hold-unsafe-origin:409');
    project = await running.store.update(project.projectId, project.revision, (current: Project): Project => ({ ...current,
      shots: current.shots.map((shot: Shot, index: number): Shot => index === 0 ? nonSourced(shot, 'black') : shot) }), []);
    await expectStatus(running.url, `${path}/output/visual?atMs=0`, {}, 200);
    await expectStatus(running.url, `${path}/output/visual?atMs=5000`, {}, 200); checks.push('safe-visual-black:200', 'safe-visual-hold:200');
    await writeFile(join(dataRoot, sha256Text(project.projectId), 'project.json'), JSON.stringify({ ...project, title: 'Audit mismatch fixture' }));
    const mismatch = await expectStatus(running.url, `${path}/generation-audit`, {}, 423);
    assert.equal((mismatch.body as { error: { code: string } }).error.code, 'AUDIT_CURRENT_VERSION_MISMATCH'); checks.push('audit-mismatch:423');
    return { port: Number(new URL(running.url).port), checks };
  } finally { await running.app.close(); }
}

const root: string = await mkdtemp(join(tmpdir(), 'storyboard-runtime-smoke-'));
try {
  const primary = await runPrimarySmoke(root);
  const service = await runServiceFailure(root);
  const active = await runActiveRefresh(root);
  const final = await runFinalSmoke(root);
  const registryFiles: string[][] = await Promise.all([
    join(root, 'primary-data', '.process-instances'), join(root, 'final-data', '.process-instances'), join(root, 'service-data', '.process-instances'), join(root, 'active-data', '.process-instances'),
  ].map((path: string): Promise<string[]> => readdir(path)));
  assert.ok(registryFiles.every((entries: string[]): boolean => entries.length === 0));
  process.stdout.write(`${JSON.stringify({ ports: [...primary.ports, service.port, active.port, final.port], checks: [...primary.checks, service.check, ...active.checks, ...final.checks], cleaned: true })}\n`);
} finally { await rm(root, { recursive: true, force: true }); }

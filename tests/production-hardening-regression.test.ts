import { mkdir, mkdtemp, readFile, readdir, rm, stat, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { CodexRequestStore } from '../src/codex/requests.js';
import { inspectAudioBytes, inspectAudioFileBytes } from '../src/domain/media-inspection.js';
import type { Asset, AudioCue, Project } from '../src/domain/schema.js';
import { ProjectSchema } from '../src/domain/schema.js';
import { exportProjectJson } from '../src/exporters/json.js';
import { importPackage } from '../src/importers/import-package.js';
import { sha256Bytes, sha256Text } from '../src/importers/integrity.js';
import { parseProject } from '../src/io/project.js';
import { createSourceOutline } from '../src/proposal/outline.js';
import { createApp } from '../src/server/app.js';
import type { AppConfig } from '../src/server/config.js';
import { ProjectStore } from '../src/server/store.js';
import { BrowserAudioController } from '../web/src/audio-lifecycle.js';
import type { AudioElementPort, AudioLifecycleCue, AudioScheduler } from '../web/src/audio-lifecycle.js';
import { nativePackage, pcmWav } from './helpers.js';

const roots: string[] = [];

type LegacyFixture = {
  root: string;
  dataRoot: string;
  store: ProjectStore;
  project: Project;
  cue: AudioCue;
  asset: Asset;
  bytes: Buffer;
  assetPath: string;
};

type TransactionJournal = {
  version: 1;
  transactionId: string;
  projectId: string;
  expectedRevision: number;
  nextRevision: number;
  assetRelativePaths: string[];
};

async function outline(): Promise<Project> {
  return createSourceOutline(importPackage(await nativePackage()), { proposedTextHoldMs: 2000 });
}

function sfxCue(project: Project): AudioCue {
  const cue: AudioCue | undefined = project.audioCues.find((candidate: AudioCue): boolean => candidate.kind === 'sfx');
  if (cue === undefined) throw new Error('SFX 검증 Cue가 없습니다.');
  return cue;
}

async function temporaryRoot(prefix: string): Promise<string> {
  const root: string = await mkdtemp(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

async function createLegacyFixture(sampleRate: number, channels: 1 | 2, bitsPerSample: 16 | 24,
  actualDurationMs: number, metadataDurationMs: number, cueDurationMs: number,
  metadataSampleRate: number, metadataChannels: number, metadataCodec: string, bytesOverride: Buffer | null): Promise<LegacyFixture> {
  const base: Project = await outline();
  const cue: AudioCue = sfxCue(base);
  const bytes: Buffer = bytesOverride ?? pcmWav(actualDurationMs, sampleRate, channels, bitsPerSample);
  const asset: Asset = {
    id: 'legacy-audio', kind: 'audio', subjectId: cue.id, path: 'assets/legacy-audio.wav', mimeType: 'audio/wav',
    sha256: sha256Bytes(bytes), description: '이전 버전 WAV', durationMs: metadataDurationMs, version: 1,
    audioMetadata: { sampleRate: metadataSampleRate, channels: metadataChannels, codec: metadataCodec },
  };
  const measuredCue: AudioCue = { ...cue, endMs: cue.startMs + cueDurationMs, timingStatus: 'measured', assetId: asset.id };
  const project: Project = parseProject({ ...base, assets: [...base.assets, asset],
    audioCues: base.audioCues.map((candidate: AudioCue): AudioCue => candidate.id === cue.id ? measuredCue : candidate) });
  const root: string = await temporaryRoot('storyboard-hardening-');
  const dataRoot: string = join(root, 'data');
  const store: ProjectStore = new ProjectStore(dataRoot);
  await store.create(project);
  const assetPath: string = await store.assetPath(project.projectId, asset.id);
  await mkdir(dirname(assetPath), { recursive: true });
  await writeFile(assetPath, bytes);
  return { root, dataRoot, store, project, cue: measuredCue, asset, bytes, assetPath };
}

async function appForFixture(fixture: LegacyFixture): Promise<FastifyInstance> {
  const webRoot: string = join(fixture.root, 'web');
  await mkdir(webRoot);
  await writeFile(join(webRoot, 'index.html'), '<!doctype html><div id="root"></div>', 'utf8');
  const config: AppConfig = { host: '127.0.0.1', port: 4317, dataRoot: fixture.dataRoot, webRoot,
    pdfFontPath: resolve('assets/fonts/NanumGothic-Regular.ttf'), codex: { requestRoot: join(fixture.root, 'requests'), speechVoice: 'Yuna' } };
  return createApp(config, fixture.store, new CodexRequestStore(config.codex.requestRoot));
}

function projectDirectory(dataRoot: string, projectId: string): string {
  return join(dataRoot, sha256Text(projectId));
}

async function exists(path: string): Promise<boolean> {
  try { await stat(path); return true; }
  catch (error: unknown) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return false;
    throw error;
  }
}

function transactionJournal(project: Project, transactionId: string, assetRelativePaths: string[]): TransactionJournal {
  return { version: 1, transactionId, projectId: project.projectId, expectedRevision: project.revision,
    nextRevision: project.revision + 1, assetRelativePaths };
}

async function stageTransaction(dataRoot: string, previous: Project, next: Project, transactionId: string,
  assetRelativePaths: string[]): Promise<string> {
  const directory: string = projectDirectory(dataRoot, previous.projectId);
  const transactionPath: string = join(directory, '.transactions', transactionId);
  await mkdir(transactionPath, { recursive: true });
  await writeFile(join(transactionPath, 'project.previous.json'), exportProjectJson(previous));
  await writeFile(join(transactionPath, 'project.next.json'), exportProjectJson(next));
  await writeFile(join(transactionPath, 'version.next.json'), exportProjectJson(next));
  await writeFile(join(transactionPath, 'journal.json'), JSON.stringify(transactionJournal(previous, transactionId, assetRelativePaths)));
  return transactionPath;
}

function wavWithExcessiveChunks(): Buffer {
  const base: Buffer = pcmWav(1, 48000, 1, 16);
  const junk: Buffer = Buffer.alloc(8 * 4_096);
  for (let offset: number = 0; offset < junk.length; offset += 8) junk.write('JUNK', offset);
  const bytes: Buffer = Buffer.concat([base.subarray(0, 36), junk, base.subarray(36)]);
  bytes.writeUInt32LE(bytes.length - 8, 4);
  return bytes;
}

type FakeAudio = AudioElementPort & { pauseCount: number; playCount: number };

function fakeAudio(playResult: Promise<void>): FakeAudio {
  const audio: FakeAudio = {
    currentTime: 0, pauseCount: 0, playCount: 0,
    pause(): void { audio.pauseCount += 1; },
    play(): Promise<void> { audio.playCount += 1; return playResult; },
  };
  return audio;
}

function manualScheduler(): AudioScheduler & { callbacks: Map<number, () => void> } {
  const callbacks: Map<number, () => void> = new Map<number, () => void>();
  let nextId: number = 1;
  return {
    callbacks,
    schedule(callback: () => void, _delayMs: number): number { const id: number = nextId; nextId += 1; callbacks.set(id, callback); return id; },
    cancel(timerId: number): void { callbacks.delete(timerId); },
  };
}

afterEach(async (): Promise<void> => {
  const pending: string[] = roots.splice(0, roots.length);
  await Promise.all(pending.map((root: string): Promise<void> => rm(root, { recursive: true, force: true })));
});

describe('오디오 자원 한계', (): void => {
  it('비정상적으로 낮은 sample rate를 정규화 전에 거부한다', async (): Promise<void> => {
    const project: Project = await outline();
    expect((): void => { inspectAudioBytes(project, pcmWav(1000, 1, 1, 16), 'audio/wav'); }).toThrowError(expect.objectContaining({ code: 'AUDIO_SAMPLE_RATE_UNSUPPORTED' }));
  });

  it('정규화 예상 출력이 한도를 넘으면 Buffer 할당 전에 거부한다', async (): Promise<void> => {
    const base: Project = await outline();
    const project: Project = parseProject({ ...base, handoff: { ...base.handoff,
      timebase: { ...base.handoff.timebase, sampleRate: 96000 } } });
    expect((): void => { inspectAudioBytes(project, pcmWav(140000, 8000, 2, 16), 'audio/wav'); }).toThrowError(expect.objectContaining({ code: 'AUDIO_NORMALIZED_SIZE_LIMIT' }));
  });

  it('빈 data 청크를 오디오로 허용하지 않는다', async (): Promise<void> => {
    const project: Project = await outline();
    expect((): void => { inspectAudioBytes(project, pcmWav(0, 48000, 1, 16), 'audio/wav'); }).toThrowError(expect.objectContaining({ code: 'ASSET_CONTENT_CORRUPT' }));
  });

  it('과도한 WAV 청크 순회를 제한한다', async (): Promise<void> => {
    const project: Project = await outline();
    expect((): void => { inspectAudioBytes(project, wavWithExcessiveChunks(), 'audio/wav'); }).toThrowError(expect.objectContaining({ code: 'AUDIO_WAV_CHUNK_LIMIT' }));
  });
});

describe('실제 WAV metadata와 타임라인 결속', (): void => {
  it('실제 sample rate와 Asset metadata 불일치를 차단한다', async (): Promise<void> => {
    const fixture: LegacyFixture = await createLegacyFixture(24000, 1, 16, 500, 500, 500, 48000, 1, 'pcm_s16le', null);
    await expect(fixture.store.asset(fixture.project.projectId, fixture.asset.id)).rejects.toMatchObject({ code: 'AUDIO_ASSET_METADATA_MISMATCH' });
  });

  it('실제 duration과 Asset metadata 불일치를 차단한다', async (): Promise<void> => {
    const fixture: LegacyFixture = await createLegacyFixture(48000, 1, 16, 500, 600, 600, 48000, 1, 'pcm_s16le', null);
    await expect(fixture.store.asset(fixture.project.projectId, fixture.asset.id)).rejects.toMatchObject({ code: 'AUDIO_ASSET_METADATA_MISMATCH' });
  });

  it('실제 channel 수와 Asset metadata 불일치를 차단한다', async (): Promise<void> => {
    const fixture: LegacyFixture = await createLegacyFixture(48000, 1, 16, 500, 500, 500, 48000, 2, 'pcm_s16le', null);
    await expect(fixture.store.asset(fixture.project.projectId, fixture.asset.id)).rejects.toMatchObject({ code: 'AUDIO_ASSET_METADATA_MISMATCH' });
  });

  it('실제 codec과 Asset metadata 불일치를 차단한다', async (): Promise<void> => {
    const fixture: LegacyFixture = await createLegacyFixture(48000, 1, 16, 500, 500, 500, 48000, 1, 'pcm_s24le', null);
    await expect(fixture.store.asset(fixture.project.projectId, fixture.asset.id)).rejects.toMatchObject({ code: 'AUDIO_ASSET_METADATA_MISMATCH' });
  });

  it('Asset 길이와 Cue 타임라인이 다른 Project를 저장 계약에서 거부한다', async (): Promise<void> => {
    const base: Project = await outline(); const cue: AudioCue = sfxCue(base); const bytes: Buffer = pcmWav(500, 48000, 1, 16);
    const asset: Asset = { id: 'timeline-audio', kind: 'audio', subjectId: cue.id, path: 'assets/timeline.wav', mimeType: 'audio/wav',
      sha256: sha256Bytes(bytes), description: '타임라인 검증', durationMs: 500, version: 1,
      audioMetadata: { sampleRate: 48000, channels: 1, codec: 'pcm_s16le' } };
    expect((): void => { parseProject({ ...base, assets: [...base.assets, asset], audioCues: base.audioCues.map((candidate: AudioCue): AudioCue =>
      candidate.id === cue.id ? { ...candidate, endMs: candidate.startMs + 600, timingStatus: 'measured', assetId: asset.id } : candidate) }); })
      .toThrowError(expect.objectContaining({ code: 'INVALID_PROJECT' }));
  });
});

describe('이전 WAV의 명시적 정규화 복구', (): void => {
  it('24kHz PCM WAV를 손상이 아닌 정규화 필요 상태로 식별한다', async (): Promise<void> => {
    const fixture: LegacyFixture = await createLegacyFixture(24000, 1, 16, 500, 500, 500, 24000, 1, 'pcm_s16le', null);
    await expect(fixture.store.asset(fixture.project.projectId, fixture.asset.id)).rejects.toMatchObject({ code: 'AUDIO_ASSET_NORMALIZATION_REQUIRED' });
    expect((await fixture.store.list())[0]?.audioRepairRequired).toBe(1);
  });

  it('복구 API가 새 Asset 버전을 생성하고 Cue를 교체한다', async (): Promise<void> => {
    const fixture: LegacyFixture = await createLegacyFixture(24000, 1, 16, 500, 500, 500, 24000, 1, 'pcm_s16le', null);
    const app: FastifyInstance = await appForFixture(fixture);
    const response = await app.inject({ method: 'POST', url: `/api/projects/${fixture.project.projectId}/audio/${fixture.cue.id}/normalize`, payload: { expectedRevision: 0 } });
    expect(response.statusCode).toBe(201);
    const project: Project = ProjectSchema.parse(response.json().project);
    const cue: AudioCue | undefined = project.audioCues.find((candidate: AudioCue): boolean => candidate.id === fixture.cue.id);
    const asset: Asset | undefined = project.assets.find((candidate: Asset): boolean => candidate.id === cue?.assetId);
    expect(cue?.assetId).not.toBe(fixture.asset.id);
    expect(asset).toEqual(expect.objectContaining({ version: 2, audioMetadata: { sampleRate: 48000, channels: 1, codec: 'pcm_s16le' } }));
    await app.close();
  });

  it('복구 후 이전 Asset과 원본 파일을 보존한다', async (): Promise<void> => {
    const fixture: LegacyFixture = await createLegacyFixture(24000, 1, 16, 500, 500, 500, 24000, 1, 'pcm_s16le', null);
    const app: FastifyInstance = await appForFixture(fixture);
    const response = await app.inject({ method: 'POST', url: `/api/projects/${fixture.project.projectId}/audio/${fixture.cue.id}/normalize`, payload: { expectedRevision: 0 } });
    const project: Project = ProjectSchema.parse(response.json().project);
    expect(project.assets.some((asset: Asset): boolean => asset.id === fixture.asset.id)).toBe(true);
    expect((await readFile(fixture.assetPath)).equals(fixture.bytes)).toBe(true);
    await app.close();
  });

  it('복구된 파일은 프로젝트 sample rate의 PCM16이고 안전 재생할 수 있다', async (): Promise<void> => {
    const fixture: LegacyFixture = await createLegacyFixture(24000, 1, 16, 500, 500, 500, 24000, 1, 'pcm_s16le', null);
    const app: FastifyInstance = await appForFixture(fixture);
    const response = await app.inject({ method: 'POST', url: `/api/projects/${fixture.project.projectId}/audio/${fixture.cue.id}/normalize`, payload: { expectedRevision: 0 } });
    const project: Project = ProjectSchema.parse(response.json().project);
    const stored = await fixture.store.safeAudio(project.projectId, fixture.cue.id);
    expect(inspectAudioFileBytes(stored.content, stored.mimeType)).toEqual(expect.objectContaining({ durationMs: 500, sampleRate: 48000, channels: 1, codec: 'pcm_s16le' }));
    await app.close();
  });

  it('복구 입력이 손상되면 revision과 파일을 바꾸지 않는다', async (): Promise<void> => {
    const corrupt: Buffer = Buffer.from('RIFF-corrupt');
    const fixture: LegacyFixture = await createLegacyFixture(24000, 1, 16, 500, 500, 500, 24000, 1, 'pcm_s16le', corrupt);
    const app: FastifyInstance = await appForFixture(fixture);
    const response = await app.inject({ method: 'POST', url: `/api/projects/${fixture.project.projectId}/audio/${fixture.cue.id}/normalize`, payload: { expectedRevision: 0 } });
    expect(response.statusCode).toBe(400);
    expect((await fixture.store.read(fixture.project.projectId)).revision).toBe(0);
    expect((await readFile(fixture.assetPath)).equals(corrupt)).toBe(true);
    await app.close();
  });
});

describe('저장 Transaction journal 복구', (): void => {
  it('현재 revision 게시 전 중단된 Transaction의 Asset과 version을 제거한다', async (): Promise<void> => {
    const root: string = await temporaryRoot('storyboard-transaction-'); const dataRoot: string = join(root, 'data');
    const store: ProjectStore = new ProjectStore(dataRoot); const previous: Project = await store.create(await outline());
    const next: Project = parseProject({ ...previous, revision: 1 }); const transactionId: string = '00000000-0000-4000-8000-000000000001';
    const transactionPath: string = await stageTransaction(dataRoot, previous, next, transactionId, ['assets/orphan.wav']);
    const directory: string = projectDirectory(dataRoot, previous.projectId); const assetPath: string = join(directory, 'assets', 'orphan.wav');
    const versionPath: string = join(directory, 'versions', '000001.json');
    await writeFile(assetPath, pcmWav(10, 48000, 1, 16)); await writeFile(versionPath, exportProjectJson(next));
    const recovered: ProjectStore = new ProjectStore(dataRoot);
    expect((await recovered.read(previous.projectId)).revision).toBe(0);
    expect(await exists(assetPath)).toBe(false); expect(await exists(versionPath)).toBe(false); expect(await exists(transactionPath)).toBe(false);
    expect(recovered.recoveryEvents()).toContainEqual({ projectId: previous.projectId, transactionId, outcome: 'rolled-back' });
  });

  it('완전히 게시된 유효 Transaction은 commit으로 확정한다', async (): Promise<void> => {
    const root: string = await temporaryRoot('storyboard-transaction-'); const dataRoot: string = join(root, 'data');
    const store: ProjectStore = new ProjectStore(dataRoot); const previous: Project = await store.create(await outline());
    const next: Project = parseProject({ ...previous, revision: 1 }); const transactionId: string = '00000000-0000-4000-8000-000000000002';
    const transactionPath: string = await stageTransaction(dataRoot, previous, next, transactionId, []);
    const directory: string = projectDirectory(dataRoot, previous.projectId); const versionPath: string = join(directory, 'versions', '000001.json');
    await writeFile(versionPath, exportProjectJson(next)); await writeFile(join(directory, 'project.json'), exportProjectJson(next));
    const recovered: ProjectStore = new ProjectStore(dataRoot);
    expect((await recovered.read(previous.projectId)).revision).toBe(1);
    expect(await exists(versionPath)).toBe(true); expect(await exists(transactionPath)).toBe(false);
    expect(recovered.recoveryEvents()).toContainEqual({ projectId: previous.projectId, transactionId, outcome: 'committed' });
  });

  it('게시된 현재 Project의 journal Asset이 없으면 이전 revision으로 복구한다', async (): Promise<void> => {
    const root: string = await temporaryRoot('storyboard-transaction-'); const dataRoot: string = join(root, 'data');
    const store: ProjectStore = new ProjectStore(dataRoot); const previous: Project = await store.create(await outline());
    const missing: Asset = { id: 'missing-image', kind: 'image', subjectId: null, path: 'assets/missing.png', mimeType: 'image/png',
      sha256: sha256Bytes(Buffer.from('missing')), description: '게시 실패 검증', durationMs: null, version: 1 };
    const next: Project = parseProject({ ...previous, revision: 1, assets: [...previous.assets, missing] });
    const transactionId: string = '00000000-0000-4000-8000-000000000003';
    const transactionPath: string = await stageTransaction(dataRoot, previous, next, transactionId, [missing.path]);
    const directory: string = projectDirectory(dataRoot, previous.projectId); const versionPath: string = join(directory, 'versions', '000001.json');
    await writeFile(versionPath, exportProjectJson(next)); await writeFile(join(directory, 'project.json'), exportProjectJson(next));
    const recovered: ProjectStore = new ProjectStore(dataRoot);
    const project: Project = await recovered.read(previous.projectId);
    expect(project.revision).toBe(0); expect(project.assets.some((asset: Asset): boolean => asset.id === missing.id)).toBe(false);
    expect(await exists(versionPath)).toBe(false); expect(await exists(transactionPath)).toBe(false);
    expect(recovered.recoveryEvents()).toContainEqual({ projectId: previous.projectId, transactionId, outcome: 'restored-previous' });
  });

  it('이전 복구에서 남은 내구성 임시 파일을 사용해 복구를 계속한다', async (): Promise<void> => {
    const root: string = await temporaryRoot('storyboard-transaction-'); const dataRoot: string = join(root, 'data');
    const store: ProjectStore = new ProjectStore(dataRoot); const previous: Project = await store.create(await outline());
    const missing: Asset = { id: 'missing-retry-image', kind: 'image', subjectId: null, path: 'assets/missing-retry.png', mimeType: 'image/png',
      sha256: sha256Bytes(Buffer.from('missing-retry')), description: '복구 재시도 검증', durationMs: null, version: 1 };
    const next: Project = parseProject({ ...previous, revision: 1, assets: [...previous.assets, missing] });
    const transactionId: string = '00000000-0000-4000-8000-000000000007';
    await stageTransaction(dataRoot, previous, next, transactionId, [missing.path]);
    const directory: string = projectDirectory(dataRoot, previous.projectId);
    await writeFile(join(directory, 'versions', '000001.json'), exportProjectJson(next));
    await writeFile(join(directory, 'project.json'), exportProjectJson(next));
    await writeFile(join(directory, `project.json.${transactionId}.recovery`), exportProjectJson(previous));
    const recovered: ProjectStore = new ProjectStore(dataRoot);
    expect((await recovered.read(previous.projectId)).revision).toBe(0);
    expect(await exists(join(directory, `project.json.${transactionId}.recovery`))).toBe(false);
  });

  it('journal이 없는 staging 디렉터리를 제거한다', async (): Promise<void> => {
    const root: string = await temporaryRoot('storyboard-transaction-'); const dataRoot: string = join(root, 'data');
    const store: ProjectStore = new ProjectStore(dataRoot); const project: Project = await store.create(await outline());
    const transactionId: string = '00000000-0000-4000-8000-000000000004';
    const transactionPath: string = join(projectDirectory(dataRoot, project.projectId), '.transactions', transactionId);
    await mkdir(transactionPath); await writeFile(join(transactionPath, 'asset-0.bin'), 'partial');
    const recovered: ProjectStore = new ProjectStore(dataRoot); await recovered.initialize();
    expect(await exists(transactionPath)).toBe(false);
    expect(recovered.recoveryEvents()).toContainEqual({ projectId: project.projectId, transactionId, outcome: 'staging-removed' });
  });

  it('손상된 journal을 조용히 무시하지 않는다', async (): Promise<void> => {
    const root: string = await temporaryRoot('storyboard-transaction-'); const dataRoot: string = join(root, 'data');
    const store: ProjectStore = new ProjectStore(dataRoot); const project: Project = await store.create(await outline());
    const transactionPath: string = join(projectDirectory(dataRoot, project.projectId), '.transactions', '00000000-0000-4000-8000-000000000005');
    await mkdir(transactionPath); await writeFile(join(transactionPath, 'journal.json'), '{broken');
    await expect(new ProjectStore(dataRoot).initialize()).rejects.toMatchObject({ code: 'TRANSACTION_JOURNAL_CORRUPT' });
  });

  it('journal의 assets 상위 경로 탈출을 거부하고 현재 Project를 보존한다', async (): Promise<void> => {
    const root: string = await temporaryRoot('storyboard-transaction-'); const dataRoot: string = join(root, 'data');
    const store: ProjectStore = new ProjectStore(dataRoot); const project: Project = await store.create(await outline());
    const next: Project = parseProject({ ...project, revision: 1 }); const transactionId: string = '00000000-0000-4000-8000-000000000006';
    await stageTransaction(dataRoot, project, next, transactionId, ['assets/../project.json']);
    await expect(new ProjectStore(dataRoot).initialize()).rejects.toMatchObject({ code: 'TRANSACTION_JOURNAL_PATH_UNSAFE' });
    expect((await store.read(project.projectId)).revision).toBe(0);
  });

  it('종료된 process의 write lock을 제거하고 복구 사실을 남긴다', async (): Promise<void> => {
    const root: string = await temporaryRoot('storyboard-transaction-'); const dataRoot: string = join(root, 'data');
    const store: ProjectStore = new ProjectStore(dataRoot); const project: Project = await store.create(await outline());
    const lockPath: string = join(projectDirectory(dataRoot, project.projectId), 'write.lock');
    await writeFile(lockPath, JSON.stringify({ version: 1, pid: 2147483647, createdAt: '2026-09-06T00:00:00.000Z' }));
    const recovered: ProjectStore = new ProjectStore(dataRoot); await recovered.initialize();
    expect(await exists(lockPath)).toBe(false);
    expect(recovered.recoveryEvents()).toContainEqual({ projectId: project.projectId, transactionId: 'lock', outcome: 'stale-lock-removed' });
  });

  it('살아 있는 process의 write lock을 임의로 제거하지 않는다', async (): Promise<void> => {
    const root: string = await temporaryRoot('storyboard-transaction-'); const dataRoot: string = join(root, 'data');
    const store: ProjectStore = new ProjectStore(dataRoot); const project: Project = await store.create(await outline());
    const lockPath: string = join(projectDirectory(dataRoot, project.projectId), 'write.lock');
    await writeFile(lockPath, JSON.stringify({ version: 1, pid: process.pid, createdAt: '2026-09-06T00:00:00.000Z' }));
    await expect(new ProjectStore(dataRoot).initialize()).rejects.toMatchObject({ code: 'PROJECT_BUSY' });
    expect(await exists(lockPath)).toBe(true); await unlink(lockPath);
  });

  it('정상 update는 journal과 lock을 남기지 않는다', async (): Promise<void> => {
    const root: string = await temporaryRoot('storyboard-transaction-'); const dataRoot: string = join(root, 'data');
    const store: ProjectStore = new ProjectStore(dataRoot); const project: Project = await store.create(await outline());
    const updated: Project = await store.update(project.projectId, 0, (current: Project): Project => ({ ...current, title: '저장 완료' }), []);
    const directory: string = projectDirectory(dataRoot, project.projectId);
    expect(updated.revision).toBe(1); expect(await exists(join(directory, 'write.lock'))).toBe(false);
    expect(await readdir(join(directory, '.transactions'))).toEqual([]);
  });
});

describe('브라우저 Audio 수명주기', (): void => {
  const cue: AudioLifecycleCue = { id: 'audio-cue', startMs: 1000, endMs: 3000 };

  it('Cue 종료 timer가 Audio를 정지한다', (): void => {
    const scheduler = manualScheduler(); const audio: FakeAudio = fakeAudio(Promise.resolve());
    const controller = new BrowserAudioController((_url: string): FakeAudio => audio, scheduler);
    controller.start('project-a', cue, 1500, '/audio.wav', (): void => {});
    const callback: (() => void) | undefined = [...scheduler.callbacks.values()][0];
    if (callback === undefined) throw new Error('Cue 종료 timer가 등록되지 않았습니다.');
    callback(); expect(audio.pauseCount).toBe(1); expect(controller.activeCount()).toBe(0);
  });

  it('playhead가 Cue 끝을 지나면 Audio를 정지한다', (): void => {
    const scheduler = manualScheduler(); const audio: FakeAudio = fakeAudio(Promise.resolve());
    const controller = new BrowserAudioController((_url: string): FakeAudio => audio, scheduler);
    controller.start('project-a', cue, 1500, '/audio.wav', (): void => {}); controller.reconcile('project-a', 3000, true);
    expect(audio.pauseCount).toBe(1); expect(controller.activeCount()).toBe(0);
  });

  it('일시정지는 Audio와 재생 이력을 초기화한다', (): void => {
    const scheduler = manualScheduler(); const audios: FakeAudio[] = [];
    const controller = new BrowserAudioController((_url: string): FakeAudio => { const audio: FakeAudio = fakeAudio(Promise.resolve()); audios.push(audio); return audio; }, scheduler);
    controller.start('project-a', cue, 1500, '/audio.wav', (): void => {}); controller.reconcile('project-a', 1500, false);
    controller.start('project-a', cue, 1500, '/audio.wav', (): void => {});
    expect(audios).toHaveLength(2); expect(audios[0]?.pauseCount).toBe(1);
  });

  it('Project가 바뀌면 이전 Audio를 정지하고 같은 Cue ID도 새로 재생한다', (): void => {
    const scheduler = manualScheduler(); const audios: FakeAudio[] = [];
    const controller = new BrowserAudioController((_url: string): FakeAudio => { const audio: FakeAudio = fakeAudio(Promise.resolve()); audios.push(audio); return audio; }, scheduler);
    controller.start('project-a', cue, 1500, '/a.wav', (): void => {}); controller.reconcile('project-b', 1500, true);
    controller.start('project-b', cue, 1500, '/b.wav', (): void => {});
    expect(audios).toHaveLength(2); expect(audios[0]?.pauseCount).toBe(1);
  });

  it('reset 뒤 늦게 끝난 play Promise가 이전 Audio를 다시 남기지 않는다', async (): Promise<void> => {
    const resolver: { current: (() => void) | null } = { current: null };
    const pending: Promise<void> = new Promise<void>((resolvePlayPromise): void => { resolver.current = resolvePlayPromise; });
    const scheduler = manualScheduler(); const audio: FakeAudio = fakeAudio(pending);
    const controller = new BrowserAudioController((_url: string): FakeAudio => audio, scheduler);
    controller.start('project-a', cue, 1500, '/audio.wav', (): void => {}); controller.reset();
    const resolvePlay: (() => void) | null = resolver.current;
    if (resolvePlay === null) throw new Error('Audio play Promise resolver가 없습니다.');
    resolvePlay(); await pending; await Promise.resolve();
    expect(audio.pauseCount).toBeGreaterThanOrEqual(2); expect(controller.activeCount()).toBe(0);
  });

  it('이전 play 실패가 reset 뒤 시작한 같은 Cue의 새 Audio를 멈추지 않는다', async (): Promise<void> => {
    const rejecter: { current: ((error: Error) => void) | null } = { current: null };
    const pending: Promise<void> = new Promise<void>((_resolve, reject): void => { rejecter.current = reject; });
    const scheduler = manualScheduler(); const first: FakeAudio = fakeAudio(pending); const second: FakeAudio = fakeAudio(Promise.resolve());
    const audios: FakeAudio[] = [first, second];
    const controller = new BrowserAudioController((_url: string): FakeAudio => {
      const audio: FakeAudio | undefined = audios.shift(); if (audio === undefined) throw new Error('검증 Audio가 부족합니다.'); return audio;
    }, scheduler);
    controller.start('project-a', cue, 1500, '/first.wav', (): void => {}); controller.reset();
    controller.start('project-a', cue, 1500, '/second.wav', (): void => {});
    const rejectPlay: ((error: Error) => void) | null = rejecter.current;
    if (rejectPlay === null) throw new Error('Audio play Promise rejecter가 없습니다.');
    rejectPlay(new Error('이전 Audio 실패')); await pending.catch((): void => {}); await Promise.resolve();
    expect(second.pauseCount).toBe(0); expect(controller.activeCount()).toBe(1);
  });

  it('Cue 중간에서 재생하면 Audio offset을 정확히 설정한다', (): void => {
    const scheduler = manualScheduler(); const audio: FakeAudio = fakeAudio(Promise.resolve());
    const controller = new BrowserAudioController((_url: string): FakeAudio => audio, scheduler);
    controller.start('project-a', cue, 2250, '/audio.wav', (): void => {});
    expect(audio.currentTime).toBe(1.25);
  });
});

import { randomUUID } from 'node:crypto';
import { hostname, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { mkdir, mkdtemp, readFile, readdir, rename, rm, stat, unlink, writeFile } from 'node:fs/promises';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { CodexRequestStore } from '../src/codex/requests.js';
import { assetReferenceIssues, collectProjectAssetReferences, PROJECT_ASSET_REFERENCE_FIELDS } from '../src/domain/asset-references.js';
import { AudioNormalizationWorkerOptionsSchema } from '../src/domain/audio-normalizer.js';
import type { Asset, AudioCue, GenerationRecord, Issue, Project, Shot, StoryboardFrame } from '../src/domain/schema.js';
import { validateProject } from '../src/domain/validation.js';
import { importPackage } from '../src/importers/import-package.js';
import { sha256Bytes, sha256Text } from '../src/importers/integrity.js';
import { parseProject } from '../src/io/project.js';
import { createSourceOutline } from '../src/proposal/outline.js';
import { createApp } from '../src/server/app.js';
import type { AppConfig } from '../src/server/config.js';
import { ProjectStore, SimulatedStorageCrash, STORAGE_TRANSACTION_JOURNAL_VERSION } from '../src/server/store.js';
import type { StorageFaultInjector, StorageFaultPoint } from '../src/server/store.js';
import { nativeData, nativePackage, pcmWav, png, TEST_AUDIO_NORMALIZATION_OPTIONS, withNativeData } from './helpers.js';

const roots: string[] = [];
const DEAD_PROCESS_ID: number = 2_147_483_647;

type StoreFixture = { root: string; dataRoot: string; store: ProjectStore; project: Project };
type Barrier = { injector: StorageFaultInjector; reached: Promise<void>; release(): void };
type ActiveCreate = StoreFixture & { pending: Promise<Project>; gate: Barrier; second: ProjectStore };
type CapturedError = { code: string; issues: readonly Issue[] };

afterEach(async (): Promise<void> => {
  await Promise.all(roots.splice(0).map((root: string): Promise<void> => rm(root, { recursive: true, force: true })));
});

async function temporaryRoot(prefix: string): Promise<string> {
  const root: string = await mkdtemp(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

async function outline(projectId: string): Promise<Project> {
  const payload = await nativePackage();
  const data = nativeData(payload);
  return createSourceOutline(importPackage(withNativeData(payload, { ...data, projectId })), { proposedTextHoldMs: 2000 });
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

async function captureError(action: Promise<unknown>): Promise<CapturedError> {
  try { await action; }
  catch (error: unknown) {
    if (error instanceof Error && 'code' in error && typeof error.code === 'string' && 'issues' in error && Array.isArray(error.issues)) {
      return { code: error.code, issues: error.issues as readonly Issue[] };
    }
    throw error;
  }
  throw new Error('실패해야 하는 작업이 성공했습니다.');
}

async function createFixture(projectId: string): Promise<StoreFixture> {
  const root: string = await temporaryRoot('storyboard-storage-boundary-');
  const dataRoot: string = join(root, 'data');
  const store: ProjectStore = new ProjectStore(dataRoot);
  const project: Project = await store.create(await outline(projectId));
  return { root, dataRoot, store, project };
}

function imageAsset(id: string, subjectId: string | null, bytes: Buffer): Asset {
  return { id, kind: 'image', subjectId, path: `assets/${id}.png`, mimeType: 'image/png', sha256: sha256Bytes(bytes),
    description: '저장 경계 이미지', durationMs: null, version: 1 };
}

function propAsset(id: string, bytes: Buffer): Asset {
  return { id, kind: 'prop', subjectId: null, path: `assets/${id}.png`, mimeType: 'image/png', sha256: sha256Bytes(bytes),
    description: '저장 경계 소품', durationMs: null, version: 1 };
}

function audioAsset(id: string, subjectId: string, bytes: Buffer): Asset {
  return { id, kind: 'audio', subjectId, path: `assets/${id}.wav`, mimeType: 'audio/wav', sha256: sha256Bytes(bytes),
    description: '저장 경계 음성', durationMs: 500, version: 1,
    audioMetadata: { sampleRate: 48000, channels: 1, codec: 'pcm_s16le' } };
}

function generationRecord(id: string, resultAssetIds: readonly string[]): GenerationRecord {
  return { id, provider: 'codex-app', model: 'imagegen', modelVersion: null, requestId: null, prompt: '저장 경계 검증',
    templateVersion: '1', seed: null, referenceHashes: [], resultAssetIds: [...resultAssetIds], shotIds: [],
    createdAt: '2026-09-06T00:00:00.000Z' };
}

function replaceShot(project: Project, shot: Shot): Project {
  return { ...project, shots: project.shots.map((candidate: Shot): Shot => candidate.id === shot.id ? shot : candidate) };
}

function replaceFrame(project: Project, frame: StoryboardFrame): Project {
  return { ...project, frames: project.frames.map((candidate: StoryboardFrame): StoryboardFrame => candidate.id === frame.id ? frame : candidate) };
}

function replaceCue(project: Project, cue: AudioCue): Project {
  return { ...project, audioCues: project.audioCues.map((candidate: AudioCue): AudioCue => candidate.id === cue.id ? cue : candidate) };
}

function barrier(point: StorageFaultPoint, ownerPid: number): Barrier {
  let markReached: (() => void) | null = null;
  let continueOperation: (() => void) | null = null;
  let triggered: boolean = false;
  const reached: Promise<void> = new Promise<void>((resolveReached): void => { markReached = resolveReached; });
  const hold: Promise<void> = new Promise<void>((resolveHold): void => { continueOperation = resolveHold; });
  return {
    reached,
    release(): void { continueOperation?.(); },
    injector: { ownerPid, async trigger(candidate: StorageFaultPoint): Promise<void> {
      if (candidate !== point || triggered) return;
      triggered = true;
      markReached?.();
      await hold;
    } },
  };
}

async function recoveryBlockCount(dataRoot: string): Promise<number> {
  const path: string = join(dataRoot, '.recovery-blocks');
  return await exists(path) ? (await readdir(path)).length : 0;
}

async function transactionNames(dataRoot: string, projectId: string): Promise<string[]> {
  return readdir(join(projectDirectory(dataRoot, projectId), '.transactions'));
}

async function createTransactionNames(dataRoot: string): Promise<string[]> {
  return readdir(join(dataRoot, '.create-transactions'));
}

async function faultStore(fixture: StoreFixture, injector: StorageFaultInjector): Promise<ProjectStore> {
  const store: ProjectStore = new ProjectStore(fixture.dataRoot, injector);
  await store.initialize();
  return store;
}

async function appForStore(root: string, dataRoot: string, store: ProjectStore): Promise<FastifyInstance> {
  const webRoot: string = join(root, `web-${randomUUID()}`);
  await mkdir(webRoot);
  await writeFile(join(webRoot, 'index.html'), '<main></main>', 'utf8');
  const config: AppConfig = { host: '127.0.0.1', port: 4317, dataRoot, webRoot,
    pdfFontPath: resolve('assets/fonts/NanumGothic-Regular.ttf'), audioNormalization: TEST_AUDIO_NORMALIZATION_OPTIONS,
    codex: { requestRoot: join(root, `requests-${randomUUID()}`), speechVoice: 'Yuna' } };
  return createApp(config, store, new CodexRequestStore(config.codex.requestRoot));
}

async function activeCreate(point: StorageFaultPoint, initializeSecond: boolean): Promise<ActiveCreate> {
  const root: string = await temporaryRoot('storyboard-active-create-');
  const dataRoot: string = join(root, 'data');
  const project: Project = await outline(`active-create-${roots.length}-${randomUUID()}`);
  const second: ProjectStore = new ProjectStore(dataRoot);
  if (initializeSecond) await second.initialize();
  const gate: Barrier = barrier(point, process.pid);
  const store: ProjectStore = new ProjectStore(dataRoot, gate.injector);
  const pending: Promise<Project> = store.create(project);
  await gate.reached;
  return { root, dataRoot, store, project, pending, gate, second };
}

async function crashedCreate(point: StorageFaultPoint): Promise<StoreFixture> {
  const root: string = await temporaryRoot('storyboard-crashed-create-');
  const dataRoot: string = join(root, 'data');
  const project: Project = await outline(`crashed-create-${roots.length}-${randomUUID()}`);
  const injector: StorageFaultInjector = { ownerPid: DEAD_PROCESS_ID, trigger(candidate: StorageFaultPoint): void {
    if (candidate === point) throw new SimulatedStorageCrash(candidate);
  } };
  const store: ProjectStore = new ProjectStore(dataRoot, injector);
  await expect(store.create(project)).rejects.toMatchObject({ code: 'SIMULATED_STORAGE_CRASH' });
  return { root, dataRoot, store, project };
}

async function addAsset(fixture: StoreFixture, asset: Asset, bytes: Buffer): Promise<Project> {
  return fixture.store.update(fixture.project.projectId, fixture.project.revision,
    (current: Project): Project => ({ ...current, assets: [...current.assets, asset] }), [{ relativePath: asset.path, content: bytes }]);
}

async function rejectDanglingPropUpdate(fixture: StoreFixture): Promise<CapturedError> {
  const shot: Shot = fixture.project.shots[0] as Shot;
  return captureError(fixture.store.update(fixture.project.projectId, fixture.project.revision,
    (current: Project): Project => replaceShot(current, { ...shot, propIds: ['missing-prop'] }), []));
}

describe('A. Asset reference collection', (): void => {
  async function referenceProject(): Promise<Project> {
    const project: Project = await outline('reference-collector');
    const frame: StoryboardFrame = project.frames[0] as StoryboardFrame;
    const cue: AudioCue = project.audioCues[0] as AudioCue;
    const shot: Shot = project.shots[0] as Shot;
    return { ...replaceCue(replaceFrame(replaceShot(project, { ...shot, propIds: ['prop'],
      continuityBefore: [{ assetId: 'before', state: '이전' }], continuityAfter: [{ assetId: 'after', state: '이후' }] }),
    { ...frame, imageAssetId: 'image' }), { ...cue, assetId: 'audio' }), generationRecords: [generationRecord('generation', ['result'])] };
  }

  it('asset_reference_collector_includes_frame_image', async (): Promise<void> => {
    expect(collectProjectAssetReferences(await referenceProject())).toContainEqual(expect.objectContaining({ relation: 'frame-image', assetId: 'image' }));
  });
  it('asset_reference_collector_includes_audio_cue', async (): Promise<void> => {
    expect(collectProjectAssetReferences(await referenceProject())).toContainEqual(expect.objectContaining({ relation: 'audio-cue', assetId: 'audio' }));
  });
  it('asset_reference_collector_includes_generation_result', async (): Promise<void> => {
    expect(collectProjectAssetReferences(await referenceProject())).toContainEqual(expect.objectContaining({ relation: 'generation-result', assetId: 'result' }));
  });
  it('asset_reference_collector_includes_shot_prop_ids', async (): Promise<void> => {
    expect(collectProjectAssetReferences(await referenceProject())).toContainEqual(expect.objectContaining({ relation: 'shot-prop', assetId: 'prop' }));
  });
  it('asset_reference_collector_includes_continuity_before', async (): Promise<void> => {
    expect(collectProjectAssetReferences(await referenceProject())).toContainEqual(expect.objectContaining({ relation: 'continuity-before', assetId: 'before' }));
  });
  it('asset_reference_collector_includes_continuity_after', async (): Promise<void> => {
    expect(collectProjectAssetReferences(await referenceProject())).toContainEqual(expect.objectContaining({ relation: 'continuity-after', assetId: 'after' }));
  });
  it('asset_reference_collector_reports_field_paths', async (): Promise<void> => {
    const references = collectProjectAssetReferences(await referenceProject());
    expect(references.map((value): string => value.field)).toEqual(expect.arrayContaining([
      expect.stringMatching(/^frames\..+\.imageAssetId$/), expect.stringMatching(/^audioCues\..+\.assetId$/),
      expect.stringMatching(/^generationRecords\..+\.resultAssetIds\.0$/), expect.stringMatching(/^shots\..+\.propIds\.0$/),
      expect.stringMatching(/^shots\..+\.continuityBefore\.0\.assetId$/), expect.stringMatching(/^shots\..+\.continuityAfter\.0\.assetId$/),
    ]));
  });
  it('asset_reference_policy_covers_all_current_foreign_keys', async (): Promise<void> => {
    expect(PROJECT_ASSET_REFERENCE_FIELDS).toEqual(['frames.imageAssetId', 'audioCues.assetId', 'generationRecords.resultAssetIds',
      'shots.propIds', 'shots.continuityBefore.assetId', 'shots.continuityAfter.assetId']);
  });
});

describe('B. Initial create asset references', (): void => {
  async function rejected(project: Project): Promise<{ error: CapturedError; dataRoot: string; store: ProjectStore }> {
    const root: string = await temporaryRoot('storyboard-rejected-create-');
    const dataRoot: string = join(root, 'data');
    const store: ProjectStore = new ProjectStore(dataRoot);
    return { error: await captureError(store.create(project)), dataRoot, store };
  }

  it('initial_create_rejects_prop_asset_reference', async (): Promise<void> => {
    const project: Project = await outline('initial-prop'); const shot: Shot = project.shots[0] as Shot; const bytes: Buffer = await png(1, 1); const asset: Asset = propAsset('prop', bytes);
    expect((await rejected({ ...replaceShot(project, { ...shot, propIds: [asset.id] }), assets: [asset] })).error.code).toBe('UNSUPPORTED_INITIAL_PROJECT_ASSETS');
  });
  it('initial_create_rejects_dangling_prop_asset_reference', async (): Promise<void> => {
    const project: Project = await outline('initial-dangling-prop'); const shot: Shot = project.shots[0] as Shot;
    expect((await rejected(replaceShot(project, { ...shot, propIds: ['missing'] }))).error.code).toBe('UNSUPPORTED_INITIAL_PROJECT_ASSETS');
  });
  it('initial_create_rejects_generation_result_reference', async (): Promise<void> => {
    const project: Project = await outline('initial-generation');
    expect((await rejected({ ...project, generationRecords: [generationRecord('generation', ['missing'])] })).error.code).toBe('UNSUPPORTED_INITIAL_PROJECT_ASSETS');
  });
  it('initial_create_rejects_continuity_before_reference', async (): Promise<void> => {
    const project: Project = await outline('initial-before'); const shot: Shot = project.shots[0] as Shot;
    expect((await rejected(replaceShot(project, { ...shot, continuityBefore: [{ assetId: 'missing', state: '이전' }] }))).error.code).toBe('UNSUPPORTED_INITIAL_PROJECT_ASSETS');
  });
  it('initial_create_rejects_continuity_after_reference', async (): Promise<void> => {
    const project: Project = await outline('initial-after'); const shot: Shot = project.shots[0] as Shot;
    expect((await rejected(replaceShot(project, { ...shot, continuityAfter: [{ assetId: 'missing', state: '이후' }] }))).error.code).toBe('UNSUPPORTED_INITIAL_PROJECT_ASSETS');
  });
  it('rejected_reference_create_has_no_disk_side_effect', async (): Promise<void> => {
    const project: Project = await outline('initial-no-disk'); const shot: Shot = project.shots[0] as Shot; const result = await rejected(replaceShot(project, { ...shot, propIds: ['missing'] }));
    expect(await exists(result.dataRoot)).toBe(false);
  });
  it('rejected_reference_create_has_no_recovery_block', async (): Promise<void> => {
    const project: Project = await outline('initial-no-block'); const shot: Shot = project.shots[0] as Shot; const result = await rejected(replaceShot(project, { ...shot, propIds: ['missing'] }));
    expect(result.store.recoveryBlocks()).toEqual([]); expect(await exists(join(result.dataRoot, '.recovery-blocks'))).toBe(false);
  });
});

describe('C. Update asset reference closure', (): void => {
  it('update_rejects_unknown_prop_asset_reference', async (): Promise<void> => {
    expect((await rejectDanglingPropUpdate(await createFixture('unknown-prop'))).code).toBe('ASSET_REFERENCE_NOT_FOUND');
  });
  it('update_rejects_wrong_kind_prop_asset_reference', async (): Promise<void> => {
    const fixture = await createFixture('wrong-prop-kind'); const bytes = await png(1, 1); const image = imageAsset('image', null, bytes); const current = await addAsset(fixture, image, bytes); const shot = current.shots[0] as Shot;
    await expect(fixture.store.update(current.projectId, current.revision, (project: Project): Project => replaceShot(project, { ...shot, propIds: [image.id] }), [])).rejects.toMatchObject({ code: 'ASSET_REFERENCE_KIND_MISMATCH' });
  });
  it('update_accepts_existing_prop_asset_reference', async (): Promise<void> => {
    const fixture = await createFixture('existing-prop'); const bytes = await png(1, 1); const prop = propAsset('prop', bytes); const current = await addAsset(fixture, prop, bytes); const shot = current.shots[0] as Shot;
    const updated = await fixture.store.update(current.projectId, current.revision, (project: Project): Project => replaceShot(project, { ...shot, propIds: [prop.id] }), []);
    expect(updated.shots[0]?.propIds).toEqual([prop.id]);
  });
  it('update_accepts_new_prop_asset_and_reference_in_same_revision', async (): Promise<void> => {
    const fixture = await createFixture('new-prop'); const bytes = await png(1, 1); const prop = propAsset('prop', bytes); const shot = fixture.project.shots[0] as Shot;
    const updated = await fixture.store.update(fixture.project.projectId, 0, (project: Project): Project => ({ ...replaceShot(project, { ...shot, propIds: [prop.id] }), assets: [prop] }), [{ relativePath: prop.path, content: bytes }]);
    expect(updated.assets).toContainEqual(prop);
  });
  it('update_rejects_frame_reference_to_audio_asset', async (): Promise<void> => {
    const fixture = await createFixture('frame-audio'); const frame = fixture.project.frames[0] as StoryboardFrame; const cue = fixture.project.audioCues[0] as AudioCue; const bytes = pcmWav(500, 48000, 1, 16); const audio = audioAsset('audio', cue.id, bytes);
    await expect(fixture.store.update(fixture.project.projectId, 0, (project: Project): Project => ({ ...replaceFrame(project, { ...frame, imageAssetId: audio.id }), assets: [audio] }), [{ relativePath: audio.path, content: bytes }])).rejects.toMatchObject({ code: 'ASSET_REFERENCE_KIND_MISMATCH' });
  });
  it('update_rejects_frame_asset_subject_mismatch', async (): Promise<void> => {
    const fixture = await createFixture('frame-subject'); const frame = fixture.project.frames[0] as StoryboardFrame; const other = fixture.project.frames[1] as StoryboardFrame; const bytes = await png(1, 1); const image = imageAsset('image', other.id, bytes);
    await expect(fixture.store.update(fixture.project.projectId, 0, (project: Project): Project => ({ ...replaceFrame(project, { ...frame, imageAssetId: image.id }), assets: [image] }), [{ relativePath: image.path, content: bytes }])).rejects.toMatchObject({ code: 'ASSET_REFERENCE_SUBJECT_MISMATCH' });
  });
  it('update_rejects_audio_reference_to_image_asset', async (): Promise<void> => {
    const fixture = await createFixture('audio-image'); const cue = fixture.project.audioCues[0] as AudioCue; const bytes = await png(1, 1); const image = imageAsset('image', null, bytes);
    await expect(fixture.store.update(fixture.project.projectId, 0, (project: Project): Project => ({ ...replaceCue(project, { ...cue, assetId: image.id }), assets: [image] }), [{ relativePath: image.path, content: bytes }])).rejects.toMatchObject({ code: 'ASSET_REFERENCE_KIND_MISMATCH' });
  });
  it('update_rejects_audio_asset_subject_mismatch', async (): Promise<void> => {
    const fixture = await createFixture('audio-subject'); const cue = fixture.project.audioCues[0] as AudioCue; const other = fixture.project.audioCues[1] as AudioCue; const bytes = pcmWav(500, 48000, 1, 16); const audio = audioAsset('audio', other.id, bytes);
    await expect(fixture.store.update(fixture.project.projectId, 0, (project: Project): Project => ({ ...replaceCue(project, { ...cue, assetId: audio.id }), assets: [audio] }), [{ relativePath: audio.path, content: bytes }])).rejects.toMatchObject({ code: 'ASSET_REFERENCE_SUBJECT_MISMATCH' });
  });
  it('update_rejects_continuity_reference_to_audio_asset', async (): Promise<void> => {
    const fixture = await createFixture('continuity-audio'); const shot = fixture.project.shots[0] as Shot; const cue = fixture.project.audioCues[0] as AudioCue; const bytes = pcmWav(500, 48000, 1, 16); const audio = audioAsset('audio', cue.id, bytes);
    await expect(fixture.store.update(fixture.project.projectId, 0, (project: Project): Project => ({ ...replaceShot(project, { ...shot, continuityBefore: [{ assetId: audio.id, state: '이전' }] }), assets: [audio] }), [{ relativePath: audio.path, content: bytes }])).rejects.toMatchObject({ code: 'ASSET_REFERENCE_KIND_MISMATCH' });
  });
  it('update_rejects_missing_generation_result_asset', async (): Promise<void> => {
    const fixture = await createFixture('generation-missing');
    await expect(fixture.store.update(fixture.project.projectId, 0, (project: Project): Project => ({ ...project, generationRecords: [generationRecord('generation', ['missing'])] }), [])).rejects.toMatchObject({ code: 'ASSET_REFERENCE_NOT_FOUND' });
  });
  it('valid_generation_result_asset_reference_succeeds', async (): Promise<void> => {
    const fixture = await createFixture('generation-valid'); const bytes = await png(1, 1); const prop = propAsset('result', bytes);
    const updated = await fixture.store.update(fixture.project.projectId, 0, (project: Project): Project => ({ ...project, assets: [prop], generationRecords: [generationRecord('generation', [prop.id])] }), [{ relativePath: prop.path, content: bytes }]);
    expect(updated.generationRecords[0]?.resultAssetIds).toEqual([prop.id]);
  });
  it('arbitrary_store_transform_cannot_bypass_asset_reference_closure', async (): Promise<void> => {
    const fixture = await createFixture('arbitrary-transform'); const shot = fixture.project.shots[0] as Shot;
    await expect(fixture.store.update(fixture.project.projectId, 0, (): Project => replaceShot(fixture.project, { ...shot, propIds: ['missing'] }), [])).rejects.toMatchObject({ code: 'ASSET_REFERENCE_NOT_FOUND' });
  });
  it('asset_reference_failure_creates_no_journal', async (): Promise<void> => {
    const fixture = await createFixture('closure-no-journal'); await rejectDanglingPropUpdate(fixture);
    expect(await transactionNames(fixture.dataRoot, fixture.project.projectId)).toEqual([]);
  });
  it('asset_reference_failure_releases_lock', async (): Promise<void> => {
    const fixture = await createFixture('closure-no-lock'); await rejectDanglingPropUpdate(fixture);
    expect(await exists(join(projectDirectory(fixture.dataRoot, fixture.project.projectId), 'write.lock'))).toBe(false);
  });
  it('asset_reference_failure_creates_no_recovery_block', async (): Promise<void> => {
    const fixture = await createFixture('closure-no-block'); await rejectDanglingPropUpdate(fixture);
    expect(await recoveryBlockCount(fixture.dataRoot)).toBe(0);
  });
});

describe('D. Shared validation policy', (): void => {
  async function missingPropProject(id: string): Promise<Project> {
    const project = await outline(id); const shot = project.shots[0] as Shot;
    return replaceShot(project, { ...shot, propIds: ['missing'] });
  }

  it('validate_project_uses_shared_asset_reference_policy', async (): Promise<void> => {
    const project = await missingPropProject('validator-policy');
    expect(validateProject(project, project.dataset)).toContainEqual(expect.objectContaining({ code: 'ASSET_REFERENCE_NOT_FOUND', field: expect.stringContaining('propIds') }));
  });
  it('store_and_validator_report_same_missing_asset', async (): Promise<void> => {
    const fixture = await createFixture('same-missing'); const shot = fixture.project.shots[0] as Shot; const changed = replaceShot(fixture.project, { ...shot, propIds: ['missing'] });
    const validationCode = validateProject(changed, changed.dataset).find((value: Issue): boolean => value.field.includes('propIds'))?.code;
    expect((await captureError(fixture.store.update(changed.projectId, 0, (): Project => changed, []))).code).toBe(validationCode);
  });
  it('store_and_validator_report_same_kind_mismatch', async (): Promise<void> => {
    const fixture = await createFixture('same-kind'); const bytes = await png(1, 1); const image = imageAsset('image', null, bytes); const current = await addAsset(fixture, image, bytes); const shot = current.shots[0] as Shot; const changed = replaceShot(current, { ...shot, propIds: [image.id] });
    const validationCode = validateProject(changed, changed.dataset).find((value: Issue): boolean => value.field.includes('propIds'))?.code;
    expect((await captureError(fixture.store.update(current.projectId, current.revision, (): Project => changed, []))).code).toBe(validationCode);
  });
  it('shared_policy_does_not_duplicate_reference_issues', async (): Promise<void> => {
    const project = await missingPropProject('validator-no-duplicate');
    expect(assetReferenceIssues(project)).toHaveLength(1); expect(validateProject(project, project.dataset).filter((value: Issue): boolean => value.code === 'ASSET_REFERENCE_NOT_FOUND')).toHaveLength(1);
  });
});

describe('E. Lock acquisition failure', (): void => {
  function competingLock(projectId: string): string {
    return JSON.stringify({ version: 2, projectId, host: hostname(), pid: process.pid, transactionId: randomUUID(), createdAt: new Date().toISOString() });
  }

  async function collisionFixture(removeBeforeCatch: boolean): Promise<{ fixture: StoreFixture; store: ProjectStore; lockPath: string }> {
    const fixture = await createFixture(`lock-collision-${removeBeforeCatch}`); const lockPath = join(projectDirectory(fixture.dataRoot, fixture.project.projectId), 'write.lock'); let installed = false;
    const injector: StorageFaultInjector = { ownerPid: process.pid, async trigger(point: StorageFaultPoint): Promise<void> {
      if (point === 'before-lock-write' && !installed) { installed = true; await writeFile(lockPath, competingLock(fixture.project.projectId)); }
      if (point === 'after-lock-write-eexist' && removeBeforeCatch && await exists(lockPath)) await unlink(lockPath);
    } };
    return { fixture, store: await faultStore(fixture, injector), lockPath };
  }

  async function syncFailureFixture(id: string): Promise<{ fixture: StoreFixture; store: ProjectStore; lockPath: string }> {
    const fixture = await createFixture(id); let failed = false;
    const injector: StorageFaultInjector = { ownerPid: process.pid, trigger(point: StorageFaultPoint): void {
      if (point === 'before-lock-directory-sync' && !failed) { failed = true; throw new Error('directory sync failure'); }
    } };
    return { fixture, store: await faultStore(fixture, injector), lockPath: join(projectDirectory(fixture.dataRoot, fixture.project.projectId), 'write.lock') };
  }

  it('lock_eexist_returns_project_busy', async (): Promise<void> => {
    const fixture = await collisionFixture(false); await expect(fixture.store.update(fixture.fixture.project.projectId, 0, (project: Project): Project => project, [])).rejects.toMatchObject({ code: 'PROJECT_BUSY' });
  });
  it('lock_eexist_is_busy_even_if_lock_disappears_before_catch', async (): Promise<void> => {
    const fixture = await collisionFixture(true); const error = await captureError(fixture.store.update(fixture.fixture.project.projectId, 0, (project: Project): Project => project, []));
    expect(error.code).toBe('PROJECT_BUSY'); expect(await exists(fixture.lockPath)).toBe(false);
  });
  it('lock_eexist_returns_http_409', async (): Promise<void> => {
    const fixture = await createFixture('lock-http'); const app = await appForStore(fixture.root, fixture.dataRoot, fixture.store); const path = join(projectDirectory(fixture.dataRoot, fixture.project.projectId), 'write.lock'); await writeFile(path, competingLock(fixture.project.projectId));
    const response = await app.inject({ method: 'PATCH', url: `/api/projects/${fixture.project.projectId}/profile`, payload: { expectedRevision: 0, profile: fixture.project.profile } });
    expect(response.statusCode).toBe(409); expect(response.json()).toMatchObject({ error: { code: 'PROJECT_BUSY' } }); await app.close();
  });
  it('lock_sync_failure_cleans_owned_lock', async (): Promise<void> => {
    const scenario = await syncFailureFixture('lock-sync-clean'); await captureError(scenario.store.update(scenario.fixture.project.projectId, 0, (project: Project): Project => project, [])); expect(await exists(scenario.lockPath)).toBe(false);
  });
  it('lock_sync_failure_does_not_report_project_busy', async (): Promise<void> => {
    const scenario = await syncFailureFixture('lock-sync-code'); expect((await captureError(scenario.store.update(scenario.fixture.project.projectId, 0, (project: Project): Project => project, []))).code).toBe('STORE_LOCK_ACQUISITION_FAILED');
  });
  it('lock_sync_failure_leaves_no_transaction', async (): Promise<void> => {
    const scenario = await syncFailureFixture('lock-sync-transaction'); await captureError(scenario.store.update(scenario.fixture.project.projectId, 0, (project: Project): Project => project, [])); expect(await transactionNames(scenario.fixture.dataRoot, scenario.fixture.project.projectId)).toEqual([]);
  });
  it('lock_sync_failure_leaves_revision_unchanged', async (): Promise<void> => {
    const scenario = await syncFailureFixture('lock-sync-revision'); await captureError(scenario.store.update(scenario.fixture.project.projectId, 0, (project: Project): Project => ({ ...project, title: '변경' }), [])); expect((await scenario.fixture.store.read(scenario.fixture.project.projectId)).revision).toBe(0);
  });
  it('lock_cleanup_verifies_transaction_id', async (): Promise<void> => {
    const fixture = await createFixture('lock-metadata'); const lockPath = join(projectDirectory(fixture.dataRoot, fixture.project.projectId), 'write.lock'); let changed = false;
    const store = await faultStore(fixture, { ownerPid: process.pid, async trigger(point: StorageFaultPoint): Promise<void> { if (point === 'after-lock-file-created' && !changed) { changed = true; const value = JSON.parse(await readFile(lockPath, 'utf8')) as Record<string, unknown>; await writeFile(lockPath, JSON.stringify({ ...value, transactionId: randomUUID() })); } } });
    expect((await captureError(store.update(fixture.project.projectId, 0, (project: Project): Project => project, []))).code).toBe('STORE_LOCK_CLEANUP_REQUIRED');
  });
  it('lock_cleanup_verifies_file_identity', async (): Promise<void> => {
    const fixture = await createFixture('lock-identity'); const lockPath = join(projectDirectory(fixture.dataRoot, fixture.project.projectId), 'write.lock'); let changed = false;
    const store = await faultStore(fixture, { ownerPid: process.pid, async trigger(point: StorageFaultPoint): Promise<void> { if (point === 'after-lock-file-created' && !changed) { changed = true; const content = await readFile(lockPath); const replacement = `${lockPath}.replacement`; await writeFile(replacement, content); await rename(replacement, lockPath); } } });
    expect((await captureError(store.update(fixture.project.projectId, 0, (project: Project): Project => project, []))).code).toBe('STORE_LOCK_CLEANUP_REQUIRED');
  });
  it('changed_lock_is_not_deleted_by_failed_acquirer', async (): Promise<void> => {
    const scenario = await collisionFixture(false); await captureError(scenario.store.update(scenario.fixture.project.projectId, 0, (project: Project): Project => project, [])); expect(await exists(scenario.lockPath)).toBe(true);
  });
  it('unprovable_lock_cleanup_creates_recovery_block', async (): Promise<void> => {
    const fixture = await createFixture('lock-unprovable'); const lockPath = join(projectDirectory(fixture.dataRoot, fixture.project.projectId), 'write.lock'); let changed = false;
    const store = await faultStore(fixture, { ownerPid: process.pid, async trigger(point: StorageFaultPoint): Promise<void> { if (point === 'after-lock-file-created' && !changed) { changed = true; const value = JSON.parse(await readFile(lockPath, 'utf8')) as Record<string, unknown>; await writeFile(lockPath, JSON.stringify({ ...value, transactionId: randomUUID() })); } } });
    await captureError(store.update(fixture.project.projectId, 0, (project: Project): Project => project, [])); expect(await recoveryBlockCount(fixture.dataRoot)).toBe(1);
  });
  it('acquire_lock_failure_does_not_poison_unrelated_project', async (): Promise<void> => {
    const root = await temporaryRoot('storyboard-lock-scope-'); const dataRoot = join(root, 'data'); const normal = new ProjectStore(dataRoot); const first = await normal.create(await outline('lock-blocked')); const second = await normal.create(await outline('lock-healthy')); const firstLock = join(projectDirectory(dataRoot, first.projectId), 'write.lock'); let changed = false;
    const failing = new ProjectStore(dataRoot, { ownerPid: process.pid, async trigger(point: StorageFaultPoint): Promise<void> { if (point === 'after-lock-file-created' && !changed) { changed = true; const value = JSON.parse(await readFile(firstLock, 'utf8')) as Record<string, unknown>; await writeFile(firstLock, JSON.stringify({ ...value, transactionId: randomUUID() })); } } }); await failing.initialize();
    await captureError(failing.update(first.projectId, 0, (project: Project): Project => project, [])); const updated = await failing.update(second.projectId, 0, (project: Project): Project => ({ ...project, title: '정상' }), []); expect(updated.revision).toBe(1);
  });
  it('successful_lock_path_remains_compatible', async (): Promise<void> => {
    const fixture = await createFixture('lock-compatible'); const updated = await fixture.store.update(fixture.project.projectId, 0, (project: Project): Project => ({ ...project, title: '정상' }), []); expect(updated.revision).toBe(1); expect(await exists(join(projectDirectory(fixture.dataRoot, fixture.project.projectId), 'write.lock'))).toBe(false);
  });
});

describe('F. Create owned lock', (): void => {
  it('create_staging_contains_owned_write_lock', async (): Promise<void> => {
    const scenario = await activeCreate('after-create-lock-written', false); const names = await createTransactionNames(scenario.dataRoot); const lock = JSON.parse(await readFile(join(scenario.dataRoot, '.create-transactions', names[0] as string, 'project', 'write.lock'), 'utf8')) as Record<string, unknown>;
    expect(lock).toMatchObject({ projectId: scenario.project.projectId, transactionId: names[0], pid: process.pid }); scenario.gate.release(); await scenario.pending;
  });
  it('create_publishes_lock_with_final_directory', async (): Promise<void> => {
    const scenario = await activeCreate('after-create-directory-publish', false); expect(await exists(join(projectDirectory(scenario.dataRoot, scenario.project.projectId), 'write.lock'))).toBe(true); scenario.gate.release(); await scenario.pending;
  });
  it('create_verification_accepts_only_owned_create_lock', async (): Promise<void> => {
    const scenario = await activeCreate('after-create-directory-publish', false); const lockPath = join(projectDirectory(scenario.dataRoot, scenario.project.projectId), 'write.lock'); const lock = JSON.parse(await readFile(lockPath, 'utf8')) as Record<string, unknown>; await writeFile(lockPath, JSON.stringify({ ...lock, transactionId: randomUUID() })); scenario.gate.release(); await expect(scenario.pending).rejects.toMatchObject({ code: 'STORE_RECOVERY_REQUIRED' }); expect(await recoveryBlockCount(scenario.dataRoot)).toBe(1);
  });
  it('create_removes_lock_after_journal_cleanup', async (): Promise<void> => {
    const scenario = await activeCreate('before-create-lock-removal', false); expect(await createTransactionNames(scenario.dataRoot)).toEqual([]); expect(await exists(join(projectDirectory(scenario.dataRoot, scenario.project.projectId), 'write.lock'))).toBe(true); scenario.gate.release(); await scenario.pending;
  });
  it('create_returns_only_after_lock_removal', async (): Promise<void> => {
    const fixture = await createFixture('create-return'); expect(await exists(join(projectDirectory(fixture.dataRoot, fixture.project.projectId), 'write.lock'))).toBe(false); expect(await createTransactionNames(fixture.dataRoot)).toEqual([]);
  });
  it('create_cleanup_failure_preserves_lock_and_journal', async (): Promise<void> => {
    const root = await temporaryRoot('storyboard-create-cleanup-'); const dataRoot = join(root, 'data'); const project = await outline('create-cleanup'); const store = new ProjectStore(dataRoot, { ownerPid: process.pid, trigger(point: StorageFaultPoint): void { if (point === 'before-create-journal-cleanup') throw new Error('cleanup failure'); } });
    await expect(store.create(project)).rejects.toThrow('cleanup failure'); expect(await createTransactionNames(dataRoot)).toHaveLength(1); expect(await exists(join(projectDirectory(dataRoot, project.projectId), 'write.lock'))).toBe(true);
  });
  it('create_crash_after_publish_preserves_owned_lock', async (): Promise<void> => {
    const fixture = await crashedCreate('after-create-directory-publish'); expect(await exists(join(projectDirectory(fixture.dataRoot, fixture.project.projectId), 'write.lock'))).toBe(true); expect(await createTransactionNames(fixture.dataRoot)).toHaveLength(1);
  });
  it('startup_recovers_dead_create_lock', async (): Promise<void> => {
    const fixture = await crashedCreate('after-create-directory-publish'); const recovered = new ProjectStore(fixture.dataRoot); await recovered.initialize(); expect((await recovered.read(fixture.project.projectId)).revision).toBe(0); expect(await exists(join(projectDirectory(fixture.dataRoot, fixture.project.projectId), 'write.lock'))).toBe(false);
  });
  it('startup_does_not_remove_live_create_lock', async (): Promise<void> => {
    const scenario = await activeCreate('after-create-directory-publish', false); const observer = new ProjectStore(scenario.dataRoot); await expect(observer.initialize()).rejects.toMatchObject({ code: 'PROJECT_BUSY' }); expect(await exists(join(projectDirectory(scenario.dataRoot, scenario.project.projectId), 'write.lock'))).toBe(true); scenario.gate.release(); await scenario.pending;
  });
  it('mismatched_create_lock_requires_recovery', async (): Promise<void> => {
    const fixture = await crashedCreate('after-create-directory-publish'); const path = join(projectDirectory(fixture.dataRoot, fixture.project.projectId), 'write.lock'); const lock = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>; await writeFile(path, JSON.stringify({ ...lock, transactionId: randomUUID() })); const recovered = new ProjectStore(fixture.dataRoot); await recovered.initialize(); expect(recovered.recoveryBlocks()[0]?.code).toBe('STORE_CREATE_RECOVERY_REQUIRED'); expect(await exists(path)).toBe(true);
  });
});

describe('G. Create-update serialization', (): void => {
  async function busyUpdateScenario(id: string): Promise<{ scenario: ActiveCreate; error: CapturedError; transformCalls: number }> {
    const scenario = await activeCreate('before-create-journal-cleanup', true); let transformCalls = 0;
    const error = await captureError(scenario.second.update(scenario.project.projectId, 0, (project: Project): Project => { transformCalls += 1; return { ...project, title: id }; }, []));
    return { scenario, error, transformCalls };
  }

  it('update_is_busy_after_create_publish_before_cleanup', async (): Promise<void> => {
    const result = await busyUpdateScenario('busy'); expect(result.error.code).toBe('PROJECT_BUSY'); result.scenario.gate.release(); await result.scenario.pending;
  });
  it('update_transform_is_not_called_during_active_create', async (): Promise<void> => {
    const result = await busyUpdateScenario('transform'); expect(result.transformCalls).toBe(0); result.scenario.gate.release(); await result.scenario.pending;
  });
  it('update_creates_no_version_during_active_create', async (): Promise<void> => {
    const result = await busyUpdateScenario('version'); expect(await readdir(join(projectDirectory(result.scenario.dataRoot, result.scenario.project.projectId), 'versions'))).toEqual(['000000.json']); result.scenario.gate.release(); await result.scenario.pending;
  });
  it('update_creates_no_transaction_during_active_create', async (): Promise<void> => {
    const result = await busyUpdateScenario('transaction'); expect(await transactionNames(result.scenario.dataRoot, result.scenario.project.projectId)).toEqual([]); result.scenario.gate.release(); await result.scenario.pending;
  });
  it('active_create_update_conflict_creates_no_recovery_block', async (): Promise<void> => {
    const result = await busyUpdateScenario('block'); expect(await recoveryBlockCount(result.scenario.dataRoot)).toBe(0); result.scenario.gate.release(); await result.scenario.pending;
  });
  it('update_succeeds_after_create_completion', async (): Promise<void> => {
    const scenario = await activeCreate('before-create-journal-cleanup', true); scenario.gate.release(); await scenario.pending; const updated = await scenario.second.update(scenario.project.projectId, 0, (project: Project): Project => ({ ...project, title: '완료 후 변경' }), []); expect(updated.revision).toBe(1);
  });
  it('create_return_revision_matches_persisted_revision', async (): Promise<void> => {
    const fixture = await createFixture('create-revision'); expect(fixture.project.revision).toBe((await fixture.store.read(fixture.project.projectId)).revision);
  });
  it('create_and_update_do_not_commit_concurrently', async (): Promise<void> => {
    const result = await busyUpdateScenario('serial'); expect((await result.scenario.second.read(result.scenario.project.projectId)).revision).toBe(0); result.scenario.gate.release(); await result.scenario.pending; const updated = await result.scenario.second.update(result.scenario.project.projectId, 0, (project: Project): Project => ({ ...project, title: '직렬' }), []); expect(updated.revision).toBe(1);
  });
  it('create_and_update_preserve_version_zero', async (): Promise<void> => {
    const fixture = await createFixture('version-zero'); await fixture.store.update(fixture.project.projectId, 0, (project: Project): Project => ({ ...project, title: 'revision one' }), []); const zero = parseProject(JSON.parse(await readFile(join(projectDirectory(fixture.dataRoot, fixture.project.projectId), 'versions', '000000.json'), 'utf8')) as unknown); expect(zero.revision).toBe(0);
  });
  it('create_and_update_preserve_asset_free_initial_contract', async (): Promise<void> => {
    const fixture = await createFixture('asset-free-contract'); const updated = await fixture.store.update(fixture.project.projectId, 0, (project: Project): Project => ({ ...project, title: '텍스트 변경' }), []); expect(updated.assets).toEqual([]); expect(collectProjectAssetReferences(updated)).toEqual([]);
  });
});

describe('H. Transient initialization', (): void => {
  async function transientScenario(): Promise<ActiveCreate> { return activeCreate('before-create-journal-cleanup', false); }

  it('initialization_busy_during_live_create_is_transient', async (): Promise<void> => {
    const scenario = await transientScenario(); await expect(scenario.second.initialize()).rejects.toMatchObject({ code: 'PROJECT_BUSY' }); scenario.gate.release(); await scenario.pending; await expect(scenario.second.initialize()).resolves.toBeUndefined();
  });
  it('same_store_instance_can_retry_after_create_finishes', async (): Promise<void> => {
    const scenario = await transientScenario(); await captureError(scenario.second.initialize()); scenario.gate.release(); await scenario.pending; const updated = await scenario.second.update(scenario.project.projectId, 0, (project: Project): Project => ({ ...project, title: '재시도' }), []); expect(updated.revision).toBe(1);
  });
  it('transient_busy_does_not_create_recovery_block', async (): Promise<void> => {
    const scenario = await transientScenario(); await captureError(scenario.second.initialize()); expect(await recoveryBlockCount(scenario.dataRoot)).toBe(0); scenario.gate.release(); await scenario.pending;
  });
  it('transient_busy_does_not_leave_rejected_initialization_cached', async (): Promise<void> => {
    const scenario = await transientScenario(); expect((await captureError(scenario.second.initialize())).code).toBe('PROJECT_BUSY'); scenario.gate.release(); await scenario.pending; expect((await scenario.second.read(scenario.project.projectId)).revision).toBe(0);
  });
});

describe('I. Existing storage regression', (): void => {
  it('concurrent_updates_still_commit_exactly_once', async (): Promise<void> => {
    const fixture = await createFixture('concurrent-once'); const gate = barrier('after-update-current-read', process.pid); const firstStore = await faultStore(fixture, gate.injector); const second = new ProjectStore(fixture.dataRoot); await second.initialize(); const first = firstStore.update(fixture.project.projectId, 0, (project: Project): Project => ({ ...project, title: 'first' }), []); await gate.reached; await expect(second.update(fixture.project.projectId, 0, (project: Project): Project => ({ ...project, title: 'second' }), [])).rejects.toMatchObject({ code: 'PROJECT_BUSY' }); gate.release(); await first; expect(await readdir(join(projectDirectory(fixture.dataRoot, fixture.project.projectId), 'versions'))).toHaveLength(2);
  });
  it('revision_conflict_still_returns_409', async (): Promise<void> => {
    const fixture = await createFixture('revision-http'); const app = await appForStore(fixture.root, fixture.dataRoot, fixture.store); const response = await app.inject({ method: 'PATCH', url: `/api/projects/${fixture.project.projectId}/profile`, payload: { expectedRevision: 9, profile: fixture.project.profile } }); expect(response.statusCode).toBe(409); expect(response.json()).toMatchObject({ error: { code: 'REVISION_CONFLICT' } }); await app.close();
  });
  it('asset_metadata_immutability_still_holds', async (): Promise<void> => {
    const fixture = await createFixture('asset-immutable'); const bytes = await png(1, 1); const asset = imageAsset('image', null, bytes); const current = await addAsset(fixture, asset, bytes); await expect(fixture.store.update(current.projectId, current.revision, (project: Project): Project => ({ ...project, assets: [{ ...asset, description: '변경' }] }), [])).rejects.toMatchObject({ code: 'ASSET_METADATA_IMMUTABLE' });
  });
  it('existing_asset_removal_is_still_rejected', async (): Promise<void> => {
    const fixture = await createFixture('asset-removal'); const bytes = await png(1, 1); const asset = imageAsset('image', null, bytes); const current = await addAsset(fixture, asset, bytes); await expect(fixture.store.update(current.projectId, current.revision, (project: Project): Project => ({ ...project, assets: [] }), [])).rejects.toMatchObject({ code: 'ASSET_REMOVAL_FORBIDDEN' });
  });
  it('journal_v3_recovery_still_passes', async (): Promise<void> => {
    const fixture = await createFixture('journal-v3'); const injector: StorageFaultInjector = { ownerPid: DEAD_PROCESS_ID, trigger(point: StorageFaultPoint): void { if (point === 'after-update-journal-prepared') throw new SimulatedStorageCrash(point); } }; const crashing = await faultStore(fixture, injector); await expect(crashing.update(fixture.project.projectId, 0, (project: Project): Project => ({ ...project, title: 'crash' }), [])).rejects.toMatchObject({ code: 'SIMULATED_STORAGE_CRASH' }); const recovered = new ProjectStore(fixture.dataRoot); await recovered.initialize(); expect((await recovered.read(fixture.project.projectId)).revision).toBe(0); expect(recovered.recoveryBlocks()).toEqual([]);
  });
  it('legacy_journal_v2_remains_conservative', async (): Promise<void> => {
    const fixture = await createFixture('journal-v2'); const injector: StorageFaultInjector = { ownerPid: DEAD_PROCESS_ID, trigger(point: StorageFaultPoint): void { if (point === 'after-update-journal-prepared') throw new SimulatedStorageCrash(point); } }; const crashing = await faultStore(fixture, injector); await expect(crashing.update(fixture.project.projectId, 0, (project: Project): Project => ({ ...project, title: 'legacy' }), [])).rejects.toMatchObject({ code: 'SIMULATED_STORAGE_CRASH' }); const names = await transactionNames(fixture.dataRoot, fixture.project.projectId); const journalPath = join(projectDirectory(fixture.dataRoot, fixture.project.projectId), '.transactions', names[0] as string, 'journal.json'); const v3 = JSON.parse(await readFile(journalPath, 'utf8')) as Record<string, unknown>; const previousProject = v3.previousProject as { sha256: string }; const nextProject = v3.nextProject as { sha256: string }; const versionFile = v3.versionFile as { finalRelativePath: string; sha256: string }; await writeFile(journalPath, JSON.stringify({ version: 2, operation: 'update', transactionId: v3.transactionId, projectId: v3.projectId, owner: v3.owner, expectedRevision: v3.expectedRevision, nextRevision: v3.nextRevision, previousProjectSha256: previousProject.sha256, nextProjectSha256: nextProject.sha256, versionFile: { relativePath: versionFile.finalRelativePath, sha256: versionFile.sha256 }, assets: [] })); const recovered = new ProjectStore(fixture.dataRoot); await recovered.initialize(); expect((await recovered.read(fixture.project.projectId)).revision).toBe(0);
  });
  it('worker_queue_limits_remain_valid', (): void => {
    expect(AudioNormalizationWorkerOptionsSchema.parse(TEST_AUDIO_NORMALIZATION_OPTIONS)).toEqual(TEST_AUDIO_NORMALIZATION_OPTIONS); expect(STORAGE_TRANSACTION_JOURNAL_VERSION).toBe(3);
  });
});

import { tmpdir } from 'node:os';
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { CodexRequestStore } from '../src/codex/requests.js';
import { contractError } from '../src/domain/errors.js';
import type { Asset, AudioCue, GenerationRecord, Project, Shot, StoryboardFrame } from '../src/domain/schema.js';
import { applySourceUpdate } from '../src/domain/source-update.js';
import { exportProjectJson } from '../src/exporters/json.js';
import { importPackage } from '../src/importers/import-package.js';
import { sha256Bytes, sha256Text } from '../src/importers/integrity.js';
import { parseProject } from '../src/io/project.js';
import { createSourceOutline } from '../src/proposal/outline.js';
import { createApp } from '../src/server/app.js';
import type { AppConfig } from '../src/server/config.js';
import { assertAssetCatalogTransition, collectProjectAssetReferences, ProjectStore, SimulatedStorageCrash } from '../src/server/store.js';
import type { AssetWrite, StorageFaultInjector, StorageFaultPoint } from '../src/server/store.js';
import { nativeData, nativePackage, pcmWav, png, productionPackage, TEST_AUDIO_NORMALIZATION_OPTIONS, withNativeData } from './helpers.js';

const roots: string[] = [];
const DEAD_PROCESS_ID: number = 2_147_483_647;

type StoreFixture = { root: string; dataRoot: string; store: ProjectStore; project: Project };
type Barrier = { injector: StorageFaultInjector; reached: Promise<void>; release(): void };

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

async function storeFixture(injector: StorageFaultInjector | null): Promise<StoreFixture> {
  const root: string = await temporaryRoot('storyboard-concurrency-');
  const dataRoot: string = join(root, 'data');
  const store: ProjectStore = injector === null ? new ProjectStore(dataRoot) : new ProjectStore(dataRoot, injector);
  const project: Project = await store.create(await outline(`contract-${roots.length}`));
  return { root, dataRoot, store, project };
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

function codeOf(error: unknown): string {
  return error instanceof Error && 'code' in error ? String(error.code) : error instanceof Error ? error.name : '';
}

function imageAsset(id: string, bytes: Buffer, path: string): Asset {
  return { id, kind: 'image', subjectId: null, path, mimeType: 'image/png', sha256: sha256Bytes(bytes),
    description: '스토리지 계약 검증', durationMs: null, version: 1 };
}

function audioAsset(id: string, cueId: string, bytes: Buffer, path: string): Asset {
  return { id, kind: 'audio', subjectId: cueId, path, mimeType: 'audio/wav', sha256: sha256Bytes(bytes),
    description: '가이드 음성', durationMs: 500, version: 1,
    audioMetadata: { sampleRate: 48000, channels: 1, codec: 'pcm_s16le' } };
}

function barrier(point: StorageFaultPoint): Barrier {
  let markReached: (() => void) | null = null;
  let continueUpdate: (() => void) | null = null;
  let triggered: boolean = false;
  const reached: Promise<void> = new Promise<void>((resolveReached): void => { markReached = resolveReached; });
  const hold: Promise<void> = new Promise<void>((resolveHold): void => { continueUpdate = resolveHold; });
  return {
    reached,
    release(): void { continueUpdate?.(); },
    injector: {
      ownerPid: process.pid,
      async trigger(candidate: StorageFaultPoint): Promise<void> {
        if (candidate !== point || triggered) return;
        triggered = true;
        markReached?.();
        await hold;
      },
    },
  };
}

async function transactions(dataRoot: string, projectId: string): Promise<string[]> {
  return readdir(join(projectDirectory(dataRoot, projectId), '.transactions'));
}

async function recoveryBlockCount(dataRoot: string): Promise<number> {
  const path: string = join(dataRoot, '.recovery-blocks');
  return await exists(path) ? (await readdir(path)).length : 0;
}

async function addImageAsset(fixture: StoreFixture, id: string): Promise<{ project: Project; asset: Asset; bytes: Buffer }> {
  const bytes: Buffer = await png(2, 2);
  const asset: Asset = imageAsset(id, bytes, `assets/${id}.png`);
  const project: Project = await fixture.store.update(fixture.project.projectId, fixture.project.revision,
    (current: Project): Project => ({ ...current, assets: [...current.assets, asset] }), [{ relativePath: asset.path, content: bytes }]);
  return { project, asset, bytes };
}

async function appForStore(root: string, dataRoot: string, store: ProjectStore): Promise<FastifyInstance> {
  const webRoot: string = join(root, 'web');
  await mkdir(webRoot);
  await writeFile(join(webRoot, 'index.html'), '<main></main>', 'utf8');
  const config: AppConfig = { host: '127.0.0.1', port: 4317, dataRoot, webRoot,
    pdfFontPath: resolve('assets/fonts/NanumGothic-Regular.ttf'), audioNormalization: TEST_AUDIO_NORMALIZATION_OPTIONS,
    codex: { requestRoot: join(root, 'requests'), speechVoice: 'Yuna' } };
  return createApp(config, store, new CodexRequestStore(config.codex.requestRoot));
}

async function errorCode(action: Promise<unknown>): Promise<string> {
  try { await action; return ''; }
  catch (error: unknown) { return codeOf(error); }
}

describe('A. lock-before-read 저장 순서', (): void => {
  it('update_acquires_lock_before_reading_current', async (): Promise<void> => {
    const gate: Barrier = barrier('after-update-lock-acquired'); const fixture: StoreFixture = await storeFixture(gate.injector);
    const pending: Promise<Project> = fixture.store.update(fixture.project.projectId, 0, (current: Project): Project => ({ ...current, title: '첫 저장' }), []);
    await gate.reached;
    expect(await exists(join(projectDirectory(fixture.dataRoot, fixture.project.projectId), 'write.lock'))).toBe(true);
    expect((await fixture.store.read(fixture.project.projectId)).revision).toBe(0);
    gate.release(); expect((await pending).revision).toBe(1);
  });

  it('expected_revision_is_checked_under_owned_lock', async (): Promise<void> => {
    const gate: Barrier = barrier('after-update-lock-acquired'); const fixture: StoreFixture = await storeFixture(gate.injector);
    const pending: Promise<Project> = fixture.store.update(fixture.project.projectId, 9, (current: Project): Project => current, []);
    await gate.reached; expect(await exists(join(projectDirectory(fixture.dataRoot, fixture.project.projectId), 'write.lock'))).toBe(true);
    gate.release(); await expect(pending).rejects.toMatchObject({ code: 'REVISION_CONFLICT' });
  });

  it('version_collision_is_checked_under_owned_lock', async (): Promise<void> => {
    const gate: Barrier = barrier('after-update-lock-acquired'); const fixture: StoreFixture = await storeFixture(gate.injector);
    await writeFile(join(projectDirectory(fixture.dataRoot, fixture.project.projectId), 'versions', '000001.json'), '{}');
    const pending: Promise<Project> = fixture.store.update(fixture.project.projectId, 0, (current: Project): Project => current, []);
    await gate.reached; expect(await exists(join(projectDirectory(fixture.dataRoot, fixture.project.projectId), 'write.lock'))).toBe(true);
    gate.release(); await expect(pending).rejects.toMatchObject({ code: 'PROJECT_VERSION_EXISTS' });
  });

  it('asset_preflight_runs_under_owned_lock', async (): Promise<void> => {
    const points: StorageFaultPoint[] = [];
    const fixture: StoreFixture = await storeFixture({ ownerPid: process.pid, trigger(point: StorageFaultPoint): void { points.push(point); } });
    const bytes: Buffer = await png(2, 2); const asset: Asset = imageAsset('ordered', bytes, 'assets/ordered.png');
    await fixture.store.update(fixture.project.projectId, 0, (current: Project): Project => ({ ...current, assets: [asset] }), [{ relativePath: asset.path, content: bytes }]);
    expect(points.indexOf('after-update-lock-acquired')).toBeLessThan(points.indexOf('after-update-under-lock-preflight'));
  });

  it('under_lock_snapshot_allows_only_owned_lock', async (): Promise<void> => {
    const gate: Barrier = barrier('after-update-current-read'); const fixture: StoreFixture = await storeFixture(gate.injector);
    const pending: Promise<Project> = fixture.store.update(fixture.project.projectId, 0, (current: Project): Project => ({ ...current, title: '허용' }), []);
    await gate.reached;
    expect((await readdir(projectDirectory(fixture.dataRoot, fixture.project.projectId))).sort()).toEqual(['.transactions', 'assets', 'project.json', 'versions', 'write.lock'].sort());
    gate.release(); await pending;
  });

  it('external_current_change_after_lock_is_detected', async (): Promise<void> => {
    const gate: Barrier = barrier('before-update-journal-create'); const fixture: StoreFixture = await storeFixture(gate.injector);
    const pending: Promise<Project> = fixture.store.update(fixture.project.projectId, 0, (current: Project): Project => ({ ...current, title: '내 변경' }), []);
    await gate.reached;
    await writeFile(join(projectDirectory(fixture.dataRoot, fixture.project.projectId), 'project.json'), exportProjectJson({ ...fixture.project, title: '외부 변경' }));
    gate.release(); await expect(pending).rejects.toMatchObject({ code: 'STORE_CONCURRENT_MODIFICATION' });
  });

  it('current_hash_is_rechecked_before_journal_creation', async (): Promise<void> => {
    const gate: Barrier = barrier('before-update-journal-create'); const fixture: StoreFixture = await storeFixture(gate.injector);
    const pending: Promise<Project> = fixture.store.update(fixture.project.projectId, 0, (current: Project): Project => ({ ...current, title: '새 제목' }), []);
    await gate.reached;
    const path: string = join(projectDirectory(fixture.dataRoot, fixture.project.projectId), 'project.json');
    const changed: Project = parseProject({ ...fixture.project, title: '같은 revision의 다른 해시' }); await writeFile(path, exportProjectJson(changed));
    gate.release(); expect(await errorCode(pending)).toBe('STORE_CONCURRENT_MODIFICATION'); expect(await transactions(fixture.dataRoot, fixture.project.projectId)).toEqual([]);
  });
});

describe('B. 두 Store 동시 갱신', (): void => {
  it('concurrent_update_is_busy_while_first_holds_lock', async (): Promise<void> => {
    const gate: Barrier = barrier('after-update-current-read'); const fixture: StoreFixture = await storeFixture(gate.injector);
    const second: ProjectStore = new ProjectStore(fixture.dataRoot); await second.initialize();
    const first: Promise<Project> = fixture.store.update(fixture.project.projectId, 0, (current: Project): Project => ({ ...current, title: 'A' }), []);
    await gate.reached; await expect(second.update(fixture.project.projectId, 0, (current: Project): Project => ({ ...current, title: 'B' }), [])).rejects.toMatchObject({ code: 'PROJECT_BUSY' });
    gate.release(); await first;
  });

  it('second_update_rechecks_revision_after_first_commit', async (): Promise<void> => {
    const fixture: StoreFixture = await storeFixture(null); const second: ProjectStore = new ProjectStore(fixture.dataRoot); await second.initialize();
    await fixture.store.update(fixture.project.projectId, 0, (current: Project): Project => ({ ...current, title: 'A' }), []);
    await expect(second.update(fixture.project.projectId, 0, (current: Project): Project => ({ ...current, title: 'B' }), [])).rejects.toMatchObject({ code: 'REVISION_CONFLICT' });
  });

  it('stale_expected_revision_returns_revision_conflict', async (): Promise<void> => {
    const fixture: StoreFixture = await storeFixture(null);
    await fixture.store.update(fixture.project.projectId, 0, (current: Project): Project => ({ ...current, title: '최신' }), []);
    await expect(fixture.store.update(fixture.project.projectId, 0, (current: Project): Project => current, [])).rejects.toMatchObject({ code: 'REVISION_CONFLICT' });
  });

  it('concurrent_updates_commit_exactly_once', async (): Promise<void> => {
    const gate: Barrier = barrier('after-update-current-read'); const fixture: StoreFixture = await storeFixture(gate.injector);
    const second: ProjectStore = new ProjectStore(fixture.dataRoot); await second.initialize();
    const first: Promise<Project> = fixture.store.update(fixture.project.projectId, 0, (current: Project): Project => ({ ...current, title: 'A' }), []);
    await gate.reached; expect(await errorCode(second.update(fixture.project.projectId, 0, (current: Project): Project => ({ ...current, title: 'B' }), []))).toBe('PROJECT_BUSY');
    gate.release(); await first;
    expect((await second.read(fixture.project.projectId)).revision).toBe(1);
    expect((await readdir(join(projectDirectory(fixture.dataRoot, fixture.project.projectId), 'versions'))).sort()).toEqual(['000000.json', '000001.json']);
  });

  it('concurrent_same_change_does_not_restore_previous_revision', async (): Promise<void> => {
    const gate: Barrier = barrier('after-update-current-read'); const fixture: StoreFixture = await storeFixture(gate.injector);
    const second: ProjectStore = new ProjectStore(fixture.dataRoot); await second.initialize();
    const first: Promise<Project> = fixture.store.update(fixture.project.projectId, 0, (current: Project): Project => ({ ...current, title: '동일' }), []);
    await gate.reached; await expect(second.update(fixture.project.projectId, 0, (current: Project): Project => ({ ...current, title: '동일' }), [])).rejects.toMatchObject({ code: 'PROJECT_BUSY' });
    gate.release(); await first; expect((await second.read(fixture.project.projectId)).title).toBe('동일');
  });

  it('concurrent_same_change_does_not_create_recovery_block', async (): Promise<void> => {
    const gate: Barrier = barrier('after-update-current-read'); const fixture: StoreFixture = await storeFixture(gate.injector); const second: ProjectStore = new ProjectStore(fixture.dataRoot); await second.initialize();
    const first: Promise<Project> = fixture.store.update(fixture.project.projectId, 0, (current: Project): Project => ({ ...current, title: '동일' }), []);
    await gate.reached; await errorCode(second.update(fixture.project.projectId, 0, (current: Project): Project => ({ ...current, title: '동일' }), [])); gate.release(); await first;
    expect(await recoveryBlockCount(fixture.dataRoot)).toBe(0);
  });

  it('concurrent_same_asset_does_not_delete_committed_asset', async (): Promise<void> => {
    const gate: Barrier = barrier('after-update-asset-linked'); const fixture: StoreFixture = await storeFixture(gate.injector); const second: ProjectStore = new ProjectStore(fixture.dataRoot); await second.initialize();
    const bytes: Buffer = await png(2, 2); const asset: Asset = imageAsset('shared', bytes, 'assets/shared.png'); const writes: AssetWrite[] = [{ relativePath: asset.path, content: bytes }];
    const first: Promise<Project> = fixture.store.update(fixture.project.projectId, 0, (current: Project): Project => ({ ...current, assets: [asset] }), writes);
    await gate.reached; await expect(second.update(fixture.project.projectId, 0, (current: Project): Project => ({ ...current, assets: [asset] }), writes)).rejects.toMatchObject({ code: 'PROJECT_BUSY' });
    gate.release(); await first; expect((await readFile(join(projectDirectory(fixture.dataRoot, fixture.project.projectId), asset.path))).equals(bytes)).toBe(true);
  });

  it('concurrent_asset_update_publishes_only_one_version', async (): Promise<void> => {
    const gate: Barrier = barrier('after-update-asset-linked'); const fixture: StoreFixture = await storeFixture(gate.injector); const second: ProjectStore = new ProjectStore(fixture.dataRoot); await second.initialize();
    const bytes: Buffer = await png(2, 2); const asset: Asset = imageAsset('one', bytes, 'assets/one.png'); const writes: AssetWrite[] = [{ relativePath: asset.path, content: bytes }];
    const first: Promise<Project> = fixture.store.update(fixture.project.projectId, 0, (current: Project): Project => ({ ...current, assets: [asset] }), writes);
    await gate.reached; await errorCode(second.update(fixture.project.projectId, 0, (current: Project): Project => ({ ...current, assets: [asset] }), writes)); gate.release(); await first;
    expect(await readdir(join(projectDirectory(fixture.dataRoot, fixture.project.projectId), 'versions'))).toHaveLength(2);
  });

  it('slow_asset_preflight_blocks_other_update_before_read', async (): Promise<void> => {
    const gate: Barrier = barrier('after-update-under-lock-preflight'); const fixture: StoreFixture = await storeFixture(gate.injector); const second: ProjectStore = new ProjectStore(fixture.dataRoot); await second.initialize();
    let secondTransformCalls: number = 0; const bytes: Buffer = await png(2, 2); const asset: Asset = imageAsset('slow', bytes, 'assets/slow.png');
    const first: Promise<Project> = fixture.store.update(fixture.project.projectId, 0, (current: Project): Project => ({ ...current, assets: [asset] }), [{ relativePath: asset.path, content: bytes }]);
    await gate.reached; await errorCode(second.update(fixture.project.projectId, 0, (current: Project): Project => { secondTransformCalls += 1; return current; }, []));
    expect(secondTransformCalls).toBe(0); gate.release(); await first;
  });

  it('busy_update_creates_no_transaction', async (): Promise<void> => {
    const gate: Barrier = barrier('after-update-lock-acquired'); const fixture: StoreFixture = await storeFixture(gate.injector); const second: ProjectStore = new ProjectStore(fixture.dataRoot); await second.initialize();
    const first: Promise<Project> = fixture.store.update(fixture.project.projectId, 0, (current: Project): Project => current, []); await gate.reached;
    await errorCode(second.update(fixture.project.projectId, 0, (current: Project): Project => current, [])); expect(await transactions(fixture.dataRoot, fixture.project.projectId)).toEqual([]);
    gate.release(); await first;
  });

  it('busy_update_leaves_no_lock_of_its_own', async (): Promise<void> => {
    const gate: Barrier = barrier('after-update-lock-acquired'); const fixture: StoreFixture = await storeFixture(gate.injector); const second: ProjectStore = new ProjectStore(fixture.dataRoot); await second.initialize();
    const first: Promise<Project> = fixture.store.update(fixture.project.projectId, 0, (current: Project): Project => current, []); await gate.reached;
    await errorCode(second.update(fixture.project.projectId, 0, (current: Project): Project => current, [])); gate.release(); await first;
    expect(await exists(join(projectDirectory(fixture.dataRoot, fixture.project.projectId), 'write.lock'))).toBe(false);
  });

  it('revision_conflict_creates_no_transaction', async (): Promise<void> => {
    const fixture: StoreFixture = await storeFixture(null); await errorCode(fixture.store.update(fixture.project.projectId, 5, (current: Project): Project => current, []));
    expect(await transactions(fixture.dataRoot, fixture.project.projectId)).toEqual([]);
  });

  it('revision_conflict_creates_no_recovery_block', async (): Promise<void> => {
    const fixture: StoreFixture = await storeFixture(null); await errorCode(fixture.store.update(fixture.project.projectId, 5, (current: Project): Project => current, []));
    expect(await recoveryBlockCount(fixture.dataRoot)).toBe(0);
  });
});

describe('C. 실패 시 잠금 정리', (): void => {
  async function expectReleased(action: (fixture: StoreFixture) => Promise<unknown>): Promise<void> {
    const fixture: StoreFixture = await storeFixture(null); await expect(action(fixture)).rejects.toBeDefined();
    expect(await exists(join(projectDirectory(fixture.dataRoot, fixture.project.projectId), 'write.lock'))).toBe(false);
  }

  it('transform_failure_releases_lock', async (): Promise<void> => {
    const fixture: StoreFixture = await storeFixture(null); const second: ProjectStore = new ProjectStore(fixture.dataRoot); await second.initialize();
    await expect(fixture.store.update(fixture.project.projectId, 0, (): Project => { throw new Error('transform 실패'); }, [])).rejects.toThrow('transform 실패');
    const committed: Project = await second.update(fixture.project.projectId, 0, (current: Project): Project => ({ ...current, title: 'B 정상 저장' }), []);
    expect(committed.revision).toBe(1); expect(await recoveryBlockCount(fixture.dataRoot)).toBe(0);
  });
  it('invalid_next_project_releases_lock', async (): Promise<void> => expectReleased((fixture: StoreFixture): Promise<Project> => fixture.store.update(fixture.project.projectId, 0, (current: Project): Project => ({ ...current, title: '' }), [])));
  it('asset_preflight_failure_releases_lock', async (): Promise<void> => {
    const fixture: StoreFixture = await storeFixture(null); const second: ProjectStore = new ProjectStore(fixture.dataRoot); await second.initialize();
    const bytes: Buffer = Buffer.from('invalid image'); const asset: Asset = imageAsset('invalid', bytes, 'assets/invalid.png');
    await expect(fixture.store.update(fixture.project.projectId, 0, (current: Project): Project => ({ ...current, assets: [asset] }), [{ relativePath: asset.path, content: bytes }])).rejects.toMatchObject({ code: 'ASSET_CONTENT_CORRUPT' });
    const committed: Project = await second.update(fixture.project.projectId, 0, (current: Project): Project => ({ ...current, title: 'B 정상 저장' }), []);
    expect(committed.revision).toBe(1); expect(await recoveryBlockCount(fixture.dataRoot)).toBe(0);
  });
  it('version_collision_releases_lock', async (): Promise<void> => expectReleased(async (fixture: StoreFixture): Promise<Project> => {
    await writeFile(join(projectDirectory(fixture.dataRoot, fixture.project.projectId), 'versions', '000001.json'), '{}');
    return fixture.store.update(fixture.project.projectId, 0, (current: Project): Project => current, []);
  }));
  it('asset_collision_releases_lock', async (): Promise<void> => expectReleased(async (fixture: StoreFixture): Promise<Project> => {
    const bytes: Buffer = await png(2, 2); const asset: Asset = imageAsset('collision-release', bytes, 'assets/collision-release.png');
    await writeFile(join(projectDirectory(fixture.dataRoot, fixture.project.projectId), asset.path), bytes);
    return fixture.store.update(fixture.project.projectId, 0, (current: Project): Project => ({ ...current, assets: [asset] }), [{ relativePath: asset.path, content: bytes }]);
  }));
  it('normal_domain_error_releases_lock', async (): Promise<void> => expectReleased((fixture: StoreFixture): Promise<Project> => fixture.store.update(fixture.project.projectId, 0, (): Project => { throw contractError('EDIT_REJECTED', '도메인 검증 실패', []); }, [])));

  it('storage_integrity_error_preserves_recovery_protection', async (): Promise<void> => {
    const gate: Barrier = barrier('before-update-journal-create'); const fixture: StoreFixture = await storeFixture(gate.injector);
    const pending: Promise<Project> = fixture.store.update(fixture.project.projectId, 0, (current: Project): Project => ({ ...current, title: '변경' }), []);
    await gate.reached; await writeFile(join(projectDirectory(fixture.dataRoot, fixture.project.projectId), 'project.json'), exportProjectJson({ ...fixture.project, title: '외부' }));
    gate.release(); await expect(pending).rejects.toMatchObject({ code: 'STORE_CONCURRENT_MODIFICATION' });
    expect(await exists(join(projectDirectory(fixture.dataRoot, fixture.project.projectId), 'write.lock'))).toBe(true); expect(await recoveryBlockCount(fixture.dataRoot)).toBe(1);
  });
});

describe('D. Asset-free Initial Create', (): void => {
  async function rejectedCreate(project: Project): Promise<{ root: string; dataRoot: string; store: ProjectStore; code: string }> {
    const root: string = await temporaryRoot('storyboard-create-contract-'); const dataRoot: string = join(root, 'data'); const store: ProjectStore = new ProjectStore(dataRoot);
    return { root, dataRoot, store, code: await errorCode(store.create(project)) };
  }

  it('initial_create_rejects_asset_metadata', async (): Promise<void> => {
    const base: Project = await outline('initial-metadata'); const bytes: Buffer = await png(1, 1); const result = await rejectedCreate({ ...base, assets: [imageAsset('initial', bytes, 'assets/initial.png')] });
    expect(result.code).toBe('UNSUPPORTED_INITIAL_PROJECT_ASSETS');
  });
  it('initial_create_rejects_frame_asset_reference', async (): Promise<void> => {
    const base: Project = await outline('initial-frame'); const frame: StoryboardFrame = base.frames[0] as StoryboardFrame;
    expect((await rejectedCreate({ ...base, frames: base.frames.map((value: StoryboardFrame): StoryboardFrame => value.id === frame.id ? { ...value, imageAssetId: 'image-ref' } : value) })).code).toBe('UNSUPPORTED_INITIAL_PROJECT_ASSETS');
  });
  it('initial_create_rejects_audio_asset_reference', async (): Promise<void> => {
    const base: Project = await outline('initial-audio'); const cue: AudioCue = base.audioCues[0] as AudioCue;
    expect((await rejectedCreate({ ...base, audioCues: base.audioCues.map((value: AudioCue): AudioCue => value.id === cue.id ? { ...value, assetId: 'audio-ref' } : value) })).code).toBe('UNSUPPORTED_INITIAL_PROJECT_ASSETS');
  });
  it('initial_create_rejects_generation_record_asset_reference', async (): Promise<void> => {
    const base: Project = await outline('initial-generation'); const record: GenerationRecord = { id: 'generation', provider: 'codex-app', model: 'imagegen', modelVersion: null,
      requestId: null, prompt: '검증', templateVersion: '1', seed: null, referenceHashes: [], resultAssetIds: ['generated-ref'], shotIds: [], createdAt: '2026-09-06T00:00:00.000Z' };
    expect((await rejectedCreate({ ...base, generationRecords: [record] })).code).toBe('UNSUPPORTED_INITIAL_PROJECT_ASSETS');
  });
  it('initial_create_rejects_all_other_asset_reference_fields', async (): Promise<void> => {
    const base: Project = await outline('initial-continuity'); const shot: Shot = base.shots[0] as Shot;
    const changed: Project = { ...base, shots: base.shots.map((value: Shot): Shot => value.id === shot.id ? { ...value,
      continuityBefore: [{ assetId: 'before-ref', state: '이전' }], continuityAfter: [{ assetId: 'after-ref', state: '이후' }] } : value) };
    expect(collectProjectAssetReferences(changed).map((reference): string => reference.field)).toEqual(expect.arrayContaining([
      `shots.${shot.id}.continuityBefore.0.assetId`, `shots.${shot.id}.continuityAfter.0.assetId`]));
    expect((await rejectedCreate(changed)).code).toBe('UNSUPPORTED_INITIAL_PROJECT_ASSETS');
  });
  it('rejected_asset_create_creates_no_project_directory', async (): Promise<void> => {
    const base: Project = await outline('initial-no-directory'); const bytes: Buffer = await png(1, 1); const result = await rejectedCreate({ ...base, assets: [imageAsset('asset', bytes, 'assets/asset.png')] });
    expect(await exists(projectDirectory(result.dataRoot, base.projectId))).toBe(false);
  });
  it('rejected_asset_create_creates_no_create_journal', async (): Promise<void> => {
    const base: Project = await outline('initial-no-journal'); const bytes: Buffer = await png(1, 1); const result = await rejectedCreate({ ...base, assets: [imageAsset('asset', bytes, 'assets/asset.png')] });
    expect(await exists(join(result.dataRoot, '.create-transactions'))).toBe(false);
  });
  it('rejected_asset_create_creates_no_recovery_block', async (): Promise<void> => {
    const base: Project = await outline('initial-no-block'); const bytes: Buffer = await png(1, 1); const result = await rejectedCreate({ ...base, assets: [imageAsset('asset', bytes, 'assets/asset.png')] });
    expect(await recoveryBlockCount(result.dataRoot)).toBe(0); expect(result.store.recoveryBlocks()).toEqual([]);
  });
  it('asset_free_initial_create_still_succeeds', async (): Promise<void> => {
    const fixture: StoreFixture = await storeFixture(null); expect(fixture.project.revision).toBe(0); expect(fixture.project.assets).toEqual([]);
  });
  it('existing_asset_bearing_project_remains_readable', async (): Promise<void> => {
    const fixture: StoreFixture = await storeFixture(null); const saved = await addImageAsset(fixture, 'readable');
    expect((await fixture.store.read(fixture.project.projectId)).assets).toEqual([saved.asset]);
  });
  it('existing_asset_bearing_project_remains_recoverable', async (): Promise<void> => {
    const fixture: StoreFixture = await storeFixture(null); const saved = await addImageAsset(fixture, 'recoverable');
    const recovered: ProjectStore = new ProjectStore(fixture.dataRoot); await recovered.initialize();
    expect((await recovered.asset(saved.project.projectId, saved.asset.id)).content.equals(saved.bytes)).toBe(true);
  });
  it('recovery_complete_asset_bearing_final_is_still_verified', async (): Promise<void> => {
    const crash: StorageFaultInjector = { ownerPid: DEAD_PROCESS_ID, trigger(point: StorageFaultPoint): void { if (point === 'before-update-cleanup') throw new SimulatedStorageCrash(point); } };
    const fixture: StoreFixture = await storeFixture(crash); const bytes: Buffer = await png(2, 2); const asset: Asset = imageAsset('complete', bytes, 'assets/complete.png');
    await expect(fixture.store.update(fixture.project.projectId, 0, (current: Project): Project => ({ ...current, assets: [asset] }), [{ relativePath: asset.path, content: bytes }])).rejects.toMatchObject({ code: 'SIMULATED_STORAGE_CRASH' });
    const recovered: ProjectStore = new ProjectStore(fixture.dataRoot); await recovered.initialize(); expect((await recovered.read(fixture.project.projectId)).assets).toContainEqual(asset); expect(recovered.recoveryBlocks()).toEqual([]);
  });
});

describe('E. append-only Asset catalog', (): void => {
  type AssetMutationCase = { name: string; change(asset: Asset): Asset };
  const metadataCases: readonly AssetMutationCase[] = [
    { name: 'existing_asset_kind_change_is_rejected', change: (asset: Asset): Asset => ({ ...asset, kind: 'prop' }) },
    { name: 'existing_asset_subject_change_is_rejected', change: (asset: Asset): Asset => ({ ...asset, subjectId: 'different' }) },
    { name: 'existing_asset_path_change_is_rejected', change: (asset: Asset): Asset => ({ ...asset, path: 'assets/different.png' }) },
    { name: 'existing_asset_mime_change_is_rejected', change: (asset: Asset): Asset => ({ ...asset, mimeType: 'image/webp' }) },
    { name: 'existing_asset_hash_change_is_rejected', change: (asset: Asset): Asset => ({ ...asset, sha256: 'f'.repeat(64) }) },
    { name: 'existing_asset_description_change_is_rejected', change: (asset: Asset): Asset => ({ ...asset, description: '변경' }) },
    { name: 'existing_asset_duration_change_is_rejected', change: (asset: Asset): Asset => ({ ...asset, durationMs: 100 }) },
    { name: 'existing_asset_version_change_is_rejected', change: (asset: Asset): Asset => ({ ...asset, version: 2 }) },
  ];

  async function catalogFixture(): Promise<{ current: Project; asset: Asset; bytes: Buffer }> {
    const current: Project = await outline(`catalog-${roots.length}`); const bytes: Buffer = await png(2, 2); const asset: Asset = imageAsset('catalog-asset', bytes, 'assets/catalog.png');
    return { current: parseProject({ ...current, assets: [asset] }), asset, bytes };
  }

  it('existing_asset_metadata_is_immutable', async (): Promise<void> => {
    const fixture = await catalogFixture(); const next: Project = { ...fixture.current, assets: [{ ...fixture.asset, description: '다름' }] };
    expect(() => assertAssetCatalogTransition(fixture.current, next, [])).toThrowError(expect.objectContaining({ code: 'ASSET_METADATA_IMMUTABLE' }));
  });

  for (const item of metadataCases) {
    it(item.name, async (): Promise<void> => {
      const fixture = await catalogFixture(); const next: Project = { ...fixture.current, assets: [item.change(fixture.asset)] };
      expect(() => assertAssetCatalogTransition(fixture.current, next, [])).toThrowError(expect.objectContaining({ code: 'ASSET_METADATA_IMMUTABLE' }));
    });
  }

  it('existing_audio_metadata_change_is_rejected', async (): Promise<void> => {
    const base: Project = await outline('audio-metadata'); const cue: AudioCue = base.audioCues[0] as AudioCue; const bytes: Buffer = pcmWav(500, 48000, 1, 16);
    const asset: Asset = audioAsset('audio-existing', cue.id, bytes, 'assets/audio-existing.wav'); const current: Project = { ...base, assets: [asset] };
    const next: Project = { ...current, assets: [{ ...asset, audioMetadata: { sampleRate: 44100, channels: 1, codec: 'pcm_s16le' } }] };
    expect(() => assertAssetCatalogTransition(current, next, [])).toThrowError(expect.objectContaining({ code: 'ASSET_METADATA_IMMUTABLE' }));
  });
  it('existing_asset_removal_is_rejected', async (): Promise<void> => {
    const fixture = await catalogFixture(); expect(() => assertAssetCatalogTransition(fixture.current, { ...fixture.current, assets: [] }, [])).toThrowError(expect.objectContaining({ code: 'ASSET_REMOVAL_FORBIDDEN' }));
  });
  it('existing_asset_write_is_rejected', async (): Promise<void> => {
    const fixture = await catalogFixture(); expect(() => assertAssetCatalogTransition(fixture.current, fixture.current, [{ relativePath: fixture.asset.path, content: fixture.bytes }])).toThrowError(expect.objectContaining({ code: 'ASSET_WRITE_FOR_EXISTING_ASSET' }));
  });
  it('existing_asset_path_cannot_be_reused', async (): Promise<void> => {
    const fixture = await catalogFixture(); const replacement: Asset = imageAsset('replacement', fixture.bytes, fixture.asset.path);
    expect(() => assertAssetCatalogTransition(fixture.current, { ...fixture.current, assets: [...fixture.current.assets, replacement] }, [{ relativePath: replacement.path, content: fixture.bytes }])).toThrowError(expect.objectContaining({ code: 'ASSET_PATH_REUSE_FORBIDDEN' }));
  });
  it('new_asset_requires_exactly_one_write', async (): Promise<void> => {
    const base: Project = await outline('new-write-required'); const bytes: Buffer = await png(1, 1); const asset: Asset = imageAsset('new', bytes, 'assets/new.png');
    expect(() => assertAssetCatalogTransition(base, { ...base, assets: [asset] }, [])).toThrowError(expect.objectContaining({ code: 'ASSET_WRITE_COUNT_MISMATCH' }));
  });
  it('undeclared_asset_write_is_rejected', async (): Promise<void> => {
    const base: Project = await outline('undeclared-write'); const bytes: Buffer = await png(1, 1);
    expect(() => assertAssetCatalogTransition(base, base, [{ relativePath: 'assets/undeclared.png', content: bytes }])).toThrowError(expect.objectContaining({ code: 'ASSET_WRITE_UNDECLARED' }));
  });
  it('new_asset_with_new_id_and_path_succeeds', async (): Promise<void> => {
    const fixture: StoreFixture = await storeFixture(null); const saved = await addImageAsset(fixture, 'new-success');
    expect((await fixture.store.asset(saved.project.projectId, saved.asset.id)).asset).toEqual(saved.asset);
  });
  it('audio_asset_replacement_uses_new_asset_id', async (): Promise<void> => {
    const base: Project = await outline('audio-replacement'); const cue: AudioCue = base.audioCues[0] as AudioCue; const firstBytes: Buffer = pcmWav(500, 48000, 1, 16); const secondBytes: Buffer = pcmWav(500, 48000, 1, 16);
    const first: Asset = audioAsset('audio-v1', cue.id, firstBytes, 'assets/audio-v1.wav'); const second: Asset = audioAsset('audio-v2', cue.id, secondBytes, 'assets/audio-v2.wav');
    const current: Project = { ...base, assets: [first], audioCues: base.audioCues.map((value: AudioCue): AudioCue => value.id === cue.id ? { ...value, assetId: first.id } : value) };
    const next: Project = { ...current, assets: [first, second], audioCues: current.audioCues.map((value: AudioCue): AudioCue => value.id === cue.id ? { ...value, assetId: second.id } : value) };
    expect(assertAssetCatalogTransition(current, next, [{ relativePath: second.path, content: secondBytes }]).newAssets.map((asset: Asset): string => asset.id)).toEqual(['audio-v2']);
  });
  it('image_asset_replacement_preserves_old_asset', async (): Promise<void> => {
    const base: Project = await outline('image-replacement'); const bytes: Buffer = await png(1, 1); const oldAsset: Asset = imageAsset('image-v1', bytes, 'assets/image-v1.png'); const newAsset: Asset = imageAsset('image-v2', bytes, 'assets/image-v2.png');
    const frame: StoryboardFrame = base.frames[0] as StoryboardFrame; const current: Project = { ...base, assets: [oldAsset], frames: base.frames.map((value: StoryboardFrame): StoryboardFrame => value.id === frame.id ? { ...value, imageAssetId: oldAsset.id } : value) };
    const next: Project = { ...current, assets: [oldAsset, newAsset], frames: current.frames.map((value: StoryboardFrame): StoryboardFrame => value.id === frame.id ? { ...value, imageAssetId: newAsset.id } : value) };
    assertAssetCatalogTransition(current, next, [{ relativePath: newAsset.path, content: bytes }]); expect(next.assets).toContainEqual(oldAsset);
  });
  it('source_update_preserves_existing_asset_catalog', async (): Promise<void> => {
    const base: Project = await outline('source-assets'); const bytes: Buffer = await png(1, 1); const asset: Asset = imageAsset('source-kept', bytes, 'assets/source-kept.png'); const current: Project = { ...base, assets: [asset] };
    const incoming: Project = await outline('source-assets'); const next: Project = applySourceUpdate(current, incoming, 'source-contract');
    expect(next.assets).toEqual([asset]); expect(() => assertAssetCatalogTransition(current, next, [])).not.toThrow();
  });
});

describe('F. transform 입력 격리', (): void => {
  it('transform_receives_isolated_project_copy', async (): Promise<void> => {
    const fixture: StoreFixture = await storeFixture(null); const received: Project[] = [];
    await fixture.store.update(fixture.project.projectId, 0, (current: Project): Project => { received.push(current); return current; }, []);
    expect(received[0]).not.toBe(fixture.project); expect(received[0]?.dataset).not.toBe(fixture.project.dataset);
  });
  it('mutating_transform_input_does_not_change_stored_current', async (): Promise<void> => {
    const fixture: StoreFixture = await storeFixture(null);
    await expect(fixture.store.update(fixture.project.projectId, 0, (current: Project): Project => { current.title = '변조'; throw new Error('중단'); }, [])).rejects.toThrow('중단');
    expect(await fixture.store.read(fixture.project.projectId)).toEqual(fixture.project);
  });
  it('mutating_transform_input_does_not_change_previous_journal', async (): Promise<void> => {
    const gate: Barrier = barrier('after-update-journal-prepared'); const fixture: StoreFixture = await storeFixture(gate.injector);
    const pending: Promise<Project> = fixture.store.update(fixture.project.projectId, 0, (current: Project): Project => { current.title = '다음'; return current; }, []);
    await gate.reached; const names: string[] = await transactions(fixture.dataRoot, fixture.project.projectId);
    const previous: Project = parseProject(JSON.parse(await readFile(join(projectDirectory(fixture.dataRoot, fixture.project.projectId), '.transactions', names[0] as string, 'project.previous.json'), 'utf8')) as unknown);
    expect(previous.title).toBe(fixture.project.title); gate.release(); await pending;
  });
  it('mutating_transform_input_does_not_hide_asset_change', async (): Promise<void> => {
    const fixture: StoreFixture = await storeFixture(null); const saved = await addImageAsset(fixture, 'isolated-asset');
    await expect(fixture.store.update(saved.project.projectId, saved.project.revision, (current: Project): Project => { (current.assets[0] as Asset).description = '숨긴 변경'; return current; }, [])).rejects.toMatchObject({ code: 'ASSET_METADATA_IMMUTABLE' });
    expect((await fixture.store.read(saved.project.projectId)).assets[0]).toEqual(saved.asset);
  });
  it('previous_project_hash_uses_pre_transform_current', async (): Promise<void> => {
    const gate: Barrier = barrier('after-update-journal-prepared'); const fixture: StoreFixture = await storeFixture(gate.injector);
    const pending: Promise<Project> = fixture.store.update(fixture.project.projectId, 0, (current: Project): Project => { current.title = '해시 이후'; return current; }, []);
    await gate.reached; const names: string[] = await transactions(fixture.dataRoot, fixture.project.projectId);
    const journal = JSON.parse(await readFile(join(projectDirectory(fixture.dataRoot, fixture.project.projectId), '.transactions', names[0] as string, 'journal.json'), 'utf8')) as { previousProject: { sha256: string } };
    expect(journal.previousProject.sha256).toBe(sha256Text(exportProjectJson(fixture.project))); gate.release(); await pending;
  });
  it('failed_transform_does_not_change_current_revision', async (): Promise<void> => {
    const fixture: StoreFixture = await storeFixture(null); await errorCode(fixture.store.update(fixture.project.projectId, 0, (): Project => { throw new Error('실패'); }, []));
    expect((await fixture.store.read(fixture.project.projectId)).revision).toBe(0);
  });
});

describe('G. HTTP 경쟁 응답', (): void => {
  async function concurrentHttpFixture(): Promise<{ fixture: StoreFixture; gate: Barrier; app: FastifyInstance }> {
    const gate: Barrier = barrier('after-update-current-read'); const fixture: StoreFixture = await storeFixture(gate.injector); return { fixture, gate, app: await appForStore(fixture.root, fixture.dataRoot, fixture.store) };
  }

  it('concurrent_patch_requests_return_one_success_and_one_conflict_or_busy', async (): Promise<void> => {
    const { fixture, gate, app } = await concurrentHttpFixture(); const url: string = `/api/projects/${fixture.project.projectId}/profile`;
    const first = app.inject({ method: 'PATCH', url, payload: { expectedRevision: 0, profile: fixture.project.profile } }); await gate.reached;
    const second = await app.inject({ method: 'PATCH', url, payload: { expectedRevision: 0, profile: fixture.project.profile } }); gate.release(); const completed = await first;
    expect([completed.statusCode, second.statusCode].sort()).toEqual([200, 409]); await app.close();
  });
  it('concurrent_requests_leave_single_version_snapshot', async (): Promise<void> => {
    const { fixture, gate, app } = await concurrentHttpFixture(); const url: string = `/api/projects/${fixture.project.projectId}/profile`;
    const first = app.inject({ method: 'PATCH', url, payload: { expectedRevision: 0, profile: fixture.project.profile } }); await gate.reached;
    await app.inject({ method: 'PATCH', url, payload: { expectedRevision: 0, profile: fixture.project.profile } }); gate.release(); await first;
    expect(await readdir(join(projectDirectory(fixture.dataRoot, fixture.project.projectId), 'versions'))).toHaveLength(2); await app.close();
  });
  it('concurrent_requests_leave_no_recovery_block', async (): Promise<void> => {
    const { fixture, gate, app } = await concurrentHttpFixture(); const url: string = `/api/projects/${fixture.project.projectId}/profile`;
    const first = app.inject({ method: 'PATCH', url, payload: { expectedRevision: 0, profile: fixture.project.profile } }); await gate.reached;
    await app.inject({ method: 'PATCH', url, payload: { expectedRevision: 0, profile: fixture.project.profile } }); gate.release(); await first;
    expect(await recoveryBlockCount(fixture.dataRoot)).toBe(0); await app.close();
  });
  it('project_busy_returns_http_409', async (): Promise<void> => {
    const { fixture, gate, app } = await concurrentHttpFixture(); const url: string = `/api/projects/${fixture.project.projectId}/profile`;
    const first = app.inject({ method: 'PATCH', url, payload: { expectedRevision: 0, profile: fixture.project.profile } }); await gate.reached;
    const busy = await app.inject({ method: 'PATCH', url, payload: { expectedRevision: 0, profile: fixture.project.profile } }); expect(busy.statusCode).toBe(409); gate.release(); await first; await app.close();
  });
  it('revision_conflict_returns_http_409', async (): Promise<void> => {
    const fixture: StoreFixture = await storeFixture(null); const app: FastifyInstance = await appForStore(fixture.root, fixture.dataRoot, fixture.store);
    const response = await app.inject({ method: 'PATCH', url: `/api/projects/${fixture.project.projectId}/profile`, payload: { expectedRevision: 99, profile: fixture.project.profile } });
    expect(response.statusCode).toBe(409); expect(response.json()).toMatchObject({ error: { code: 'REVISION_CONFLICT' } }); await app.close();
  });
  it('unsupported_initial_project_assets_returns_http_400', async (): Promise<void> => {
    class RejectingInitialStore extends ProjectStore {
      override async create(_project: Project): Promise<Project> { throw contractError('UNSUPPORTED_INITIAL_PROJECT_ASSETS', 'Initial Create Asset 금지', []); }
    }
    const root: string = await temporaryRoot('storyboard-http-create-'); const dataRoot: string = join(root, 'data'); const store: ProjectStore = new RejectingInitialStore(dataRoot); const app: FastifyInstance = await appForStore(root, dataRoot, store);
    const response = await app.inject({ method: 'POST', url: '/api/projects/import', payload: { handoffPath: 'tests/fixtures/native/storyboard_handoff.json', proposedTextHoldMs: 2000 } });
    expect(response.statusCode).toBe(400); expect(response.json()).toMatchObject({ error: { code: 'UNSUPPORTED_INITIAL_PROJECT_ASSETS' } }); await app.close();
  });
});

describe('H. PRJ-007 회귀', (): void => {
  async function productionOutline(): Promise<Project> { return createSourceOutline(importPackage(await productionPackage()), { proposedTextHoldMs: 3000 }); }

  async function unit045AssetProject(): Promise<{ base: Project; project: Project; cue: AudioCue; asset: Asset; bytes: Buffer }> {
    const base: Project = await productionOutline(); const cue: AudioCue = base.audioCues.find((value: AudioCue): boolean => value.unitId === 'UNIT-045') as AudioCue;
    const bytes: Buffer = await readFile('tests/fixtures/media/unit045-intercom-48000.wav');
    const asset: Asset = { id: 'unit045-audio', kind: 'audio', subjectId: cue.id, path: 'assets/unit045-audio.wav', mimeType: 'audio/wav', sha256: sha256Bytes(bytes),
      description: 'UNIT-045 가이드 음성', durationMs: 2000, version: 1, audioMetadata: { sampleRate: 48000, channels: 1, codec: 'pcm_s16le' } };
    const project: Project = parseProject({ ...base, assets: [asset], audioCues: base.audioCues.map((value: AudioCue): AudioCue => value.id === cue.id
      ? { ...value, startMs: 849000, endMs: 851000, timingStatus: 'measured', timingRelation: 'j-cut', assetId: asset.id } : value) });
    return { base, project, cue, asset, bytes };
  }

  it('prj007_structure_remains_unchanged', async (): Promise<void> => {
    const project: Project = await productionOutline(); expect({ scenes: project.dataset.scenes.length, segments: project.dataset.segments.length,
      sourceUnits: project.dataset.units.filter((unit): boolean => unit.kind !== 'PANEL').length,
      panelTurns: project.dataset.units.filter((unit): boolean => unit.kind === 'PANEL').length,
      textPlacements: project.dataset.textPlacements.length }).toEqual({ scenes: 12, segments: 32, sourceUnits: 79, panelTurns: 16, textPlacements: 25 });
  });
  it('prj007_source_text_remains_unchanged', async (): Promise<void> => {
    const imported = importPackage(await productionPackage()); const project: Project = createSourceOutline(imported, { proposedTextHoldMs: 3000 });
    expect(project.dataset.units.map((unit): string => unit.text)).toEqual(imported.dataset.units.map((unit): string => unit.text));
  });
  it('prj007_timeline_remains_1500000ms', async (): Promise<void> => { expect((await productionOutline()).dataset.segments.at(-1)?.endMs).toBe(1_500_000); });
  it('prj007_unit045_asset_id_is_preserved', async (): Promise<void> => {
    const fixture = await unit045AssetProject(); expect(fixture.project.audioCues.find((cue: AudioCue): boolean => cue.unitId === 'UNIT-045')?.assetId).toBe('unit045-audio');
  });
  it('prj007_unit045_j_cut_is_preserved', async (): Promise<void> => {
    const fixture = await unit045AssetProject(); expect(fixture.project.audioCues.find((cue: AudioCue): boolean => cue.unitId === 'UNIT-045')?.timingRelation).toBe('j-cut');
  });
  it('prj007_unit045_safe_audio_still_works', async (): Promise<void> => {
    const media = await unit045AssetProject(); const root: string = await temporaryRoot('storyboard-prj007-'); const dataRoot: string = join(root, 'data'); const store: ProjectStore = new ProjectStore(dataRoot);
    await store.create(media.base); await store.update(media.base.projectId, 0, (): Project => media.project, [{ relativePath: media.asset.path, content: media.bytes }]);
    const app: FastifyInstance = await appForStore(root, dataRoot, store); const response = await app.inject({ method: 'GET', url: `/api/projects/PRJ-007/output/audio/${media.cue.id}` });
    expect(response.statusCode).toBe(200); expect(response.rawPayload.subarray(0, 4).toString('ascii')).toBe('RIFF'); await app.close();
  });
  it('prj007_information_gates_remain_unchanged', async (): Promise<void> => {
    const fixture = await unit045AssetProject(); expect(fixture.project.dataset.informationRules).toEqual(fixture.base.dataset.informationRules);
  });
  it('prj007_asset_catalog_remains_append_only', async (): Promise<void> => {
    const media = await unit045AssetProject(); const root: string = await temporaryRoot('storyboard-prj007-assets-'); const store: ProjectStore = new ProjectStore(join(root, 'data'));
    await store.create(media.base); const one: Project = await store.update(media.base.projectId, 0, (): Project => media.project, [{ relativePath: media.asset.path, content: media.bytes }]);
    const two: Project = await store.update(media.base.projectId, one.revision, (current: Project): Project => ({ ...current, title: `${current.title} 검토` }), []);
    expect(two.assets).toEqual(one.assets); expect(two.assets).toContainEqual(media.asset);
  });
});

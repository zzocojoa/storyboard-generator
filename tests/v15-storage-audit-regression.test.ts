import { randomUUID } from 'node:crypto';
import { hostname, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, unlink, writeFile } from 'node:fs/promises';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { CodexRequestStore } from '../src/codex/requests.js';
import { auditGenerationRecords } from '../src/domain/generation-records.js';
import type { Asset, GenerationRecord, Project, Shot, StoryboardFrame } from '../src/domain/schema.js';
import { exportProjectJson } from '../src/exporters/json.js';
import { importPackage } from '../src/importers/import-package.js';
import { sha256Bytes, sha256Text } from '../src/importers/integrity.js';
import { createSourceOutline } from '../src/proposal/outline.js';
import { createApp } from '../src/server/app.js';
import type { AppConfig } from '../src/server/config.js';
import { ProjectStore } from '../src/server/store.js';
import type { StorageFaultInjector, StorageFaultPoint } from '../src/server/store.js';
import { clearAssetIntegrityIssue, emptyRecoveryUiState, reconcileAssetIntegrityIssues, recordRecoveryUiError } from '../web/src/ui-policy.js';
import { nativeData, nativePackage, png, TEST_AUDIO_NORMALIZATION_OPTIONS, withNativeData } from './helpers.js';

const roots: string[] = [];
const stores: ProjectStore[] = [];
let baseProject: Project;

type Barrier = { injector: StorageFaultInjector; reached: Promise<void>; release(): void };

beforeAll(async (): Promise<void> => {
  const payload = await nativePackage();
  baseProject = createSourceOutline(importPackage(payload), { proposedTextHoldMs: 2000 });
});

afterEach(async (): Promise<void> => {
  await Promise.all(stores.splice(0).map((store: ProjectStore): Promise<void> => store.close()));
  await Promise.all(roots.splice(0).map((root: string): Promise<void> => rm(root, { recursive: true, force: true })));
});

async function temporaryRoot(prefix: string): Promise<string> {
  const value: string = await mkdtemp(join(tmpdir(), prefix)); roots.push(value); return value;
}

async function outline(projectId: string): Promise<Project> {
  const payload = await nativePackage();
  return createSourceOutline(importPackage(withNativeData(payload, { ...nativeData(payload), projectId })), { proposedTextHoldMs: 2000 });
}

function trackedStore(dataRoot: string, injector?: StorageFaultInjector, processInstanceId?: string): ProjectStore {
  const store = new ProjectStore(dataRoot, injector, processInstanceId === undefined ? undefined
    : { processInstanceId, processStartedAt: '2026-09-07T00:00:00.000Z', heartbeatFreshnessMs: 3000 });
  stores.push(store); return store;
}

function projectDirectory(dataRoot: string, projectId: string): string { return join(dataRoot, sha256Text(projectId)); }
function processRegistry(dataRoot: string, processInstanceId: string): string { return join(dataRoot, '.process-instances', `${processInstanceId}.json`); }

async function exists(path: string): Promise<boolean> {
  try { await stat(path); return true; }
  catch (error: unknown) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return false;
    throw error;
  }
}

async function waitForCondition(predicate: () => Promise<boolean>, timeoutMs: number, errorMessage: string): Promise<void> {
  const deadlineMs: number = Date.now() + timeoutMs;
  while (Date.now() < deadlineMs) {
    if (await predicate()) return;
    await new Promise<void>((resolve): void => { setTimeout(resolve, 50); });
  }
  throw new Error(errorMessage);
}

function barrier(point: StorageFaultPoint): Barrier {
  let reached: (() => void) | null = null;
  let release: (() => void) | null = null;
  let triggered: boolean = false;
  const reachedPromise: Promise<void> = new Promise<void>((resolve): void => { reached = resolve; });
  const held: Promise<void> = new Promise<void>((resolve): void => { release = resolve; });
  return { reached: reachedPromise, release(): void { release?.(); }, injector: {
    ownerPid: process.pid,
    async trigger(candidate: StorageFaultPoint): Promise<void> {
      if (candidate !== point || triggered) return;
      triggered = true; reached?.(); await held;
    },
  } };
}

function record(id: string, shotIds: readonly string[], assetIds: readonly string[], prompt: string): GenerationRecord {
  return { id, provider: 'codex-app', model: 'current', generatorBuild: null, modelVersion: null, requestId: `request:${id}`, prompt,
    templateVersion: '1.0.0', seed: null, referenceHashes: [], resultAssetIds: [...assetIds], shotIds: [...shotIds],
    createdAt: '2026-09-07T00:00:00.000Z' };
}

function revision(project: Project, number: number, records: readonly GenerationRecord[]): Project {
  return { ...project, revision: number, generationRecords: [...records] };
}

function imageAsset(id: string, frameId: string, content: Buffer): Asset {
  return { id, kind: 'image', subjectId: frameId, path: `assets/${id}.png`, mimeType: 'image/png', sha256: sha256Bytes(content),
    description: '무결성 검증 이미지', durationMs: null, version: 1 };
}

async function assetFixture(projectId: string): Promise<{ dataRoot: string; store: ProjectStore; project: Project; asset: Asset; path: string }> {
  const fixtureRoot: string = await temporaryRoot('storyboard-v15-asset-'); const dataRoot: string = join(fixtureRoot, 'data');
  const store: ProjectStore = trackedStore(dataRoot); const initial: Project = await store.create(await outline(projectId));
  const frame: StoryboardFrame = initial.frames[0] as StoryboardFrame; const bytes: Buffer = await png(2, 2);
  const asset: Asset = imageAsset(`${projectId}-image`, frame.id, bytes);
  const project: Project = await store.update(projectId, 0, (current: Project): Project => ({ ...current,
    assets: [...current.assets, asset], frames: current.frames.map((candidate: StoryboardFrame): StoryboardFrame => candidate.id === frame.id
      ? { ...candidate, imageAssetId: asset.id, visualReview: 'accepted' } : candidate),
  }), [{ relativePath: asset.path, content: bytes }]);
  return { dataRoot, store, project, asset, path: join(projectDirectory(dataRoot, projectId), asset.path) };
}

async function appFor(dataRoot: string, store: ProjectStore): Promise<FastifyInstance> {
  const root: string = await temporaryRoot('storyboard-v15-app-'); const webRoot: string = join(root, 'web');
  await mkdir(join(webRoot, 'assets'), { recursive: true }); await writeFile(join(webRoot, 'index.html'), '<div id="root"></div>');
  const config: AppConfig = { host: '127.0.0.1', port: 0, dataRoot, webRoot,
    pdfFontPath: resolve('assets/fonts/NanumGothic-Regular.ttf'), audioNormalization: TEST_AUDIO_NORMALIZATION_OPTIONS,
    codex: { requestRoot: join(root, 'requests'), speechVoice: 'Yuna' } };
  return createApp(config, store, new CodexRequestStore(config.codex.requestRoot));
}

describe('15차 주기 heartbeat와 상태 갱신', (): void => {
  it('periodic_heartbeat_starts_after_initialize', async (): Promise<void> => {
    const root: string = await temporaryRoot('storyboard-v15-heartbeat-'); const dataRoot: string = join(root, 'data'); const id: string = randomUUID();
    const store: ProjectStore = trackedStore(dataRoot, undefined, id); await store.initialize();
    const first = JSON.parse(await readFile(processRegistry(dataRoot, id), 'utf8')) as { heartbeatAt: string };
    await waitForCondition(async (): Promise<boolean> => {
      const current = JSON.parse(await readFile(processRegistry(dataRoot, id), 'utf8')) as { heartbeatAt: string };
      return current.heartbeatAt !== first.heartbeatAt;
    }, 5000, '주기 heartbeat가 제한 시간 안에 갱신되지 않았습니다.');
    const second = JSON.parse(await readFile(processRegistry(dataRoot, id), 'utf8')) as { heartbeatAt: string };
    expect(second.heartbeatAt).not.toBe(first.heartbeatAt);
  });

  it('periodic_heartbeat_keeps_long_transaction_live', async (): Promise<void> => {
    const root: string = await temporaryRoot('storyboard-v15-long-heartbeat-'); const dataRoot: string = join(root, 'data'); const id: string = randomUUID();
    const creator: ProjectStore = trackedStore(dataRoot, undefined, id); const project: Project = await creator.create(await outline('heartbeat-long'));
    const gate: Barrier = barrier('after-update-current-read'); const writer: ProjectStore = trackedStore(dataRoot, gate.injector, id);
    const pending: Promise<Project> = writer.update(project.projectId, 0, (current: Project): Project => ({ ...current, title: '장시간 저장' }), []);
    await gate.reached; const first = JSON.parse(await readFile(processRegistry(dataRoot, id), 'utf8')) as { heartbeatAt: string };
    await waitForCondition(async (): Promise<boolean> => {
      const current = JSON.parse(await readFile(processRegistry(dataRoot, id), 'utf8')) as { heartbeatAt: string };
      return current.heartbeatAt !== first.heartbeatAt;
    }, 5000, '장시간 transaction 중 heartbeat가 제한 시간 안에 갱신되지 않았습니다.');
    const second = JSON.parse(await readFile(processRegistry(dataRoot, id), 'utf8')) as { heartbeatAt: string };
    expect(second.heartbeatAt).not.toBe(first.heartbeatAt); gate.release(); await pending;
  });

  it('periodic_heartbeat_is_shared_per_root_and_instance', async (): Promise<void> => {
    const root: string = await temporaryRoot('storyboard-v15-shared-heartbeat-'); const dataRoot: string = join(root, 'data'); const id: string = randomUUID();
    const first: ProjectStore = trackedStore(dataRoot, undefined, id); const second: ProjectStore = trackedStore(dataRoot, undefined, id);
    await Promise.all([first.initialize(), second.initialize()]); await first.close();
    expect(await exists(processRegistry(dataRoot, id))).toBe(true);
    const before = JSON.parse(await readFile(processRegistry(dataRoot, id), 'utf8')) as { heartbeatAt: string };
    await waitForCondition(async (): Promise<boolean> => {
      const current = JSON.parse(await readFile(processRegistry(dataRoot, id), 'utf8')) as { heartbeatAt: string };
      return current.heartbeatAt !== before.heartbeatAt;
    }, 5000, '공유 heartbeat가 제한 시간 안에 갱신되지 않았습니다.');
    const after = JSON.parse(await readFile(processRegistry(dataRoot, id), 'utf8')) as { heartbeatAt: string };
    expect(after.heartbeatAt).not.toBe(before.heartbeatAt);
  });

  it('periodic_heartbeat_timer_is_unrefed', async (): Promise<void> => {
    const root: string = await temporaryRoot('storyboard-v15-unref-heartbeat-'); const dataRoot: string = join(root, 'data'); const id: string = randomUUID();
    const store: ProjectStore = trackedStore(dataRoot, undefined, id); await store.initialize();
    expect(store.processHeartbeatTimerHasRef()).toBe(false);
  });

  it('periodic_heartbeat_stops_after_last_store_close', async (): Promise<void> => {
    const root: string = await temporaryRoot('storyboard-v15-stop-heartbeat-'); const dataRoot: string = join(root, 'data'); const id: string = randomUUID();
    const store: ProjectStore = trackedStore(dataRoot, undefined, id); await store.initialize(); await store.close();
    expect(store.processHeartbeatTimerHasRef()).toBeNull(); expect(await exists(processRegistry(dataRoot, id))).toBe(false);
  });

  it('heartbeat_failure_is_exposed_in_status', async (): Promise<void> => {
    const root: string = await temporaryRoot('storyboard-v15-failed-heartbeat-'); const dataRoot: string = join(root, 'data'); const id: string = randomUUID();
    const store: ProjectStore = trackedStore(dataRoot, undefined, id); await store.initialize();
    await writeFile(processRegistry(dataRoot, id), JSON.stringify({ version: 1, processInstanceId: id, host: hostname(), pid: process.pid,
      startedAt: '2026-09-07T00:00:00.001Z', heartbeatAt: new Date().toISOString() }));
    await waitForCondition(async (): Promise<boolean> => !store.processHeartbeat().healthy, 5000,
      'Heartbeat 실패 상태가 제한 시간 안에 기록되지 않았습니다.');
    expect((await store.statusSnapshot()).processHeartbeat).toMatchObject({ healthy: false, lastError: { code: 'STORE_RECOVERY_REQUIRED' } });
  });

  it('status_refreshes_stale_active_create', async (): Promise<void> => {
    const root: string = await temporaryRoot('storyboard-v15-status-create-'); const dataRoot: string = join(root, 'data'); const gate: Barrier = barrier('after-create-staging-complete');
    const writer: ProjectStore = trackedStore(dataRoot, gate.injector); const project: Project = await outline('active-create-refresh');
    const pending: Promise<Project> = writer.create(project); await gate.reached;
    const observer: ProjectStore = trackedStore(dataRoot); await observer.initialize(); expect(observer.activeCreates()).toHaveLength(1);
    gate.release(); await pending; expect((await observer.statusSnapshot()).activeCreates).toHaveLength(0);
  });

  it('status_refreshes_stale_active_update', async (): Promise<void> => {
    const root: string = await temporaryRoot('storyboard-v15-status-update-'); const dataRoot: string = join(root, 'data');
    const creator: ProjectStore = trackedStore(dataRoot); const project: Project = await creator.create(await outline('active-update-refresh'));
    const gate: Barrier = barrier('after-update-current-read'); const writer: ProjectStore = trackedStore(dataRoot, gate.injector);
    const pending: Promise<Project> = writer.update(project.projectId, 0, (current: Project): Project => ({ ...current, title: '갱신' }), []);
    await gate.reached; const observer: ProjectStore = trackedStore(dataRoot); await observer.initialize(); expect(observer.activeUpdates()).toHaveLength(1);
    gate.release(); await pending; expect((await observer.statusSnapshot()).activeUpdates).toHaveLength(0);
  });

  it('status_does_not_fail_for_unrelated_malformed_lock', async (): Promise<void> => {
    const root: string = await temporaryRoot('storyboard-v15-status-lock-'); const dataRoot: string = join(root, 'data'); const store: ProjectStore = trackedStore(dataRoot);
    await store.create(await outline('status-good')); await writeFile(join(projectDirectory(dataRoot, 'status-good'), 'write.lock'), '{bad');
    await expect(store.statusSnapshot()).resolves.toMatchObject({ processHeartbeat: { healthy: true } });
  });

  it('status_exposes_heartbeat_health', async (): Promise<void> => {
    const root: string = await temporaryRoot('storyboard-v15-status-health-'); const store: ProjectStore = trackedStore(join(root, 'data')); await store.initialize();
    expect((await store.statusSnapshot()).processHeartbeat).toMatchObject({ processInstanceId: store.processInstanceId(), healthy: true, lastError: null });
  });

  it('status_snapshot_is_idempotent', async (): Promise<void> => {
    const root: string = await temporaryRoot('storyboard-v15-status-repeat-'); const store: ProjectStore = trackedStore(join(root, 'data')); await store.initialize();
    const first = await store.statusSnapshot(); const second = await store.statusSnapshot();
    expect(second).toEqual(first);
  });
});

describe('15차 historical generation audit', (): void => {
  const shotId: string = 'shot-1';

  it('audit_scans_union_of_all_version_record_ids', (): void => {
    const a = record('ledger-a', [shotId], [], 'a'); const b = record('ledger-b', [shotId], [], 'b'); const c = record('ledger-c', [shotId], [], 'c');
    expect(auditGenerationRecords(revision(baseProject, 2, [c]), [revision(baseProject, 0, [a]), revision(baseProject, 1, [b])]).map((entry) => entry.recordId)).toEqual(['ledger-a', 'ledger-b', 'ledger-c']);
  });

  it('audit_reports_record_removed_before_current', (): void => {
    const value = record('ledger-removed', [shotId], [], 'original');
    expect(auditGenerationRecords(revision(baseProject, 1, []), [revision(baseProject, 0, [value])])[0]).toMatchObject({ presentInCurrent: false, removedAtRevision: 1, recordPresenceState: 'legacy-removed' });
  });

  it('audit_detects_intermediate_metadata_mutation', (): void => {
    const value = record('ledger-mutated', [shotId], [], 'original'); const changed = { ...value, prompt: 'changed' };
    expect(auditGenerationRecords(revision(baseProject, 2, [value]), [revision(baseProject, 0, [value]), revision(baseProject, 1, [changed])])[0]).toMatchObject({ mutatedAtRevisions: [1], recordIntegrityState: 'legacy-mutated' });
  });

  it('audit_detects_record_reappearance', (): void => {
    const value = record('ledger-reappeared', [shotId], [], 'original');
    expect(auditGenerationRecords(revision(baseProject, 2, [value]), [revision(baseProject, 0, [value]), revision(baseProject, 1, [])])[0]).toMatchObject({ reappearedAtRevisions: [2], recordPresenceState: 'legacy-reappeared' });
  });

  it('audit_reports_mixed_current_and_historical_shot_targets', (): void => {
    const historicalShot: Shot = { ...(baseProject.shots[0] as Shot), id: 'historical-shot' };
    const value = record('ledger-mixed', [shotId, historicalShot.id], [], 'mixed');
    const past: Project = { ...revision(baseProject, 0, [value]), shots: [...baseProject.shots, historicalShot] };
    expect(auditGenerationRecords(revision(baseProject, 1, [value]), [past])[0]).toMatchObject({ currentTargetState: 'mixed', shotTargets: expect.arrayContaining([{ shotId: historicalShot.id, state: 'historical' }]) });
  });

  it('audit_reports_historical_asset_targets', async (): Promise<void> => {
    const asset: Asset = imageAsset('historical-asset', 'frame-1', await png(1, 1)); const value = record('ledger-asset', [], [asset.id], 'asset');
    const past: Project = { ...revision(baseProject, 0, [value]), assets: [asset] };
    expect(auditGenerationRecords(revision(baseProject, 1, []), [past])[0]?.assetTargets).toEqual([{ assetId: asset.id, state: 'historical' }]);
  });

  it('audit_uses_consistent_current_and_version_snapshot', async (): Promise<void> => {
    const root: string = await temporaryRoot('storyboard-v15-audit-consistent-'); const store: ProjectStore = trackedStore(join(root, 'data'));
    const created: Project = await store.create(await outline('audit-consistent')); const value = record('audit-current', [created.shots[0]?.id ?? ''], [], 'stable');
    await store.update(created.projectId, 0, (current: Project): Project => ({ ...current, generationRecords: [value] }), []);
    expect(await store.generationRecordAudit(created.projectId)).toContainEqual(expect.objectContaining({ recordId: value.id, introducedRevision: 1 }));
  });

  it('audit_retries_once_when_current_changes', async (): Promise<void> => {
    const root: string = await temporaryRoot('storyboard-v15-audit-retry-'); const dataRoot: string = join(root, 'data'); let attempts: number = 0; let next: Project | null = null;
    const injector: StorageFaultInjector = { ownerPid: process.pid, async trigger(point: StorageFaultPoint): Promise<void> {
      if (point !== 'before-audit-current-recheck' || attempts > 0 || next === null) return;
      attempts += 1; const directory: string = projectDirectory(dataRoot, next.projectId); const content: string = exportProjectJson(next);
      await writeFile(join(directory, 'versions', '000001.json'), content); await writeFile(join(directory, 'project.json'), content);
    } };
    const store: ProjectStore = trackedStore(dataRoot, injector); const created: Project = await store.create(await outline('audit-retry'));
    next = { ...created, revision: 1, title: 'changed-once' };
    expect(await store.generationRecordAudit(created.projectId)).toEqual([]); expect(attempts).toBe(1);
  });

  it('audit_returns_conflict_when_snapshot_keeps_changing', async (): Promise<void> => {
    const root: string = await temporaryRoot('storyboard-v15-audit-conflict-'); const dataRoot: string = join(root, 'data'); let revisionNumber: number = 0; let current: Project | null = null;
    const injector: StorageFaultInjector = { ownerPid: process.pid, async trigger(point: StorageFaultPoint): Promise<void> {
      if (point !== 'before-audit-current-recheck' || current === null) return;
      revisionNumber += 1; current = { ...current, revision: revisionNumber, title: `changed-${revisionNumber}` };
      const directory: string = projectDirectory(dataRoot, current.projectId); const content: string = exportProjectJson(current);
      await writeFile(join(directory, 'versions', `${String(revisionNumber).padStart(6, '0')}.json`), content); await writeFile(join(directory, 'project.json'), content);
    } };
    const store: ProjectStore = trackedStore(dataRoot, injector); current = await store.create(await outline('audit-conflict'));
    await expect(store.generationRecordAudit(current.projectId)).rejects.toMatchObject({ code: 'AUDIT_SNAPSHOT_CHANGED' });
  });

  it('audit_does_not_modify_project_or_versions', (): void => {
    const value = record('ledger-pure', [shotId], [], 'pure'); const past: Project = revision(baseProject, 0, [value]); const current: Project = revision(baseProject, 1, []);
    const before: string = JSON.stringify([past, current]); auditGenerationRecords(current, [past]); expect(JSON.stringify([past, current])).toBe(before);
  });
});

describe('15차 recovery marker 격리', (): void => {
  async function corruptedFixture(projectId: string): Promise<{ dataRoot: string; store: ProjectStore }> {
    const root: string = await temporaryRoot('storyboard-v15-marker-'); const dataRoot: string = join(root, 'data'); const creator: ProjectStore = trackedStore(dataRoot);
    await creator.create(await outline(projectId)); await creator.close(); await writeFile(join(dataRoot, '.recovery-blocks', 'broken.json'), '{bad');
    const store: ProjectStore = trackedStore(dataRoot); await store.initialize(); return { dataRoot, store };
  }

  it('malformed_recovery_marker_is_quarantined', async (): Promise<void> => {
    const fixture = await corruptedFixture('marker-quarantine'); const names: string[] = await readdir(join(fixture.dataRoot, '.recovery-blocks', '.invalid'));
    expect(names.some((name: string): boolean => name.endsWith('-broken.json'))).toBe(true);
  });

  it('invalid_recovery_marker_does_not_block_unrelated_project_list', async (): Promise<void> => {
    const fixture = await corruptedFixture('marker-list'); expect((await fixture.store.list()).map((project) => project.projectId)).toContain('marker-list');
  });

  it('invalid_recovery_marker_does_not_block_unrelated_update', async (): Promise<void> => {
    const fixture = await corruptedFixture('marker-update'); const project: Project = await fixture.store.read('marker-update');
    await expect(fixture.store.update(project.projectId, project.revision, (current: Project): Project => ({ ...current, title: '수정됨' }), [])).resolves.toMatchObject({ title: '수정됨' });
  });

  it('invalid_recovery_marker_does_not_block_unrelated_create', async (): Promise<void> => {
    const fixture = await corruptedFixture('marker-existing'); await expect(fixture.store.create(await outline('marker-new'))).resolves.toMatchObject({ projectId: 'marker-new' });
  });

  it('status_exposes_invalid_recovery_markers', async (): Promise<void> => {
    const fixture = await corruptedFixture('marker-status'); expect((await fixture.store.statusSnapshot()).invalidRecoveryMarkers[0]).toMatchObject({ fileName: 'broken.json' });
  });

  it('valid_recovery_marker_still_blocks_only_own_project', async (): Promise<void> => {
    const root: string = await temporaryRoot('storyboard-v15-valid-marker-'); const dataRoot: string = join(root, 'data'); const creator: ProjectStore = trackedStore(dataRoot);
    const blocked: Project = await creator.create(await outline('marker-blocked')); await creator.create(await outline('marker-open')); await creator.close();
    const directoryName: string = sha256Text(blocked.projectId); await writeFile(join(dataRoot, '.recovery-blocks', `${directoryName}.json`), JSON.stringify({
      version: 1, projectId: blocked.projectId, directoryName, transactionId: 'manual-review', code: 'STORE_RECOVERY_REQUIRED', message: '검토 필요', detectedAt: '2026-09-07T00:00:00.000Z',
    }));
    const store: ProjectStore = trackedStore(dataRoot); await store.initialize();
    await expect(store.assertMutable(blocked.projectId)).rejects.toMatchObject({ code: 'STORE_RECOVERY_BLOCKED' });
    await expect(store.assertMutable('marker-open')).resolves.toBeUndefined();
  });
});

describe('15차 asset scope와 UI reconciliation', (): void => {
  it('stored_asset_path_unsafe_returns_asset_scope_423', async (): Promise<void> => {
    const fixture = await assetFixture('asset-path-http'); const outside: string = join(await temporaryRoot('storyboard-v15-outside-'), 'outside.png'); await writeFile(outside, await png(1, 1));
    await unlink(fixture.path); await symlink(outside, fixture.path); const app: FastifyInstance = await appFor(fixture.dataRoot, fixture.store);
    const response = await app.inject({ method: 'GET', url: `/api/projects/${fixture.project.projectId}/assets/${fixture.asset.id}` }); await app.close();
    expect(response.statusCode).toBe(423); expect(response.json().error).toMatchObject({ code: 'STORED_ASSET_PATH_UNSAFE', scope: 'asset', resourceId: fixture.asset.id, mutationBlocked: false });
  });

  it('stored_asset_symlink_error_is_not_validation_400', async (): Promise<void> => {
    const fixture = await assetFixture('asset-symlink-http'); const outside: string = join(await temporaryRoot('storyboard-v15-outside-'), 'outside.png'); await writeFile(outside, await png(1, 1));
    await unlink(fixture.path); await symlink(outside, fixture.path); const app: FastifyInstance = await appFor(fixture.dataRoot, fixture.store);
    const response = await app.inject({ method: 'GET', url: `/api/projects/${fixture.project.projectId}/output/frame/${fixture.project.frames[0]?.id ?? ''}` }); await app.close();
    expect(response.statusCode).toBe(423); expect(response.json().error.category).toBe('locked');
  });

  it('stored_asset_path_issue_does_not_block_project_mutation', async (): Promise<void> => {
    const fixture = await assetFixture('asset-mutation'); const outside: string = join(await temporaryRoot('storyboard-v15-outside-'), 'outside.png'); await writeFile(outside, await png(1, 1));
    await unlink(fixture.path); await symlink(outside, fixture.path);
    await expect(fixture.store.update(fixture.project.projectId, fixture.project.revision, (current: Project): Project => ({ ...current, title: '자산과 무관한 수정' }), [])).resolves.toMatchObject({ revision: 2 });
  });

  it('asset_integrity_endpoint_reports_current_output_references', async (): Promise<void> => {
    const fixture = await assetFixture('asset-integrity-api'); await writeFile(fixture.path, Buffer.from('corrupt'));
    const app: FastifyInstance = await appFor(fixture.dataRoot, fixture.store); const response = await app.inject({ method: 'GET', url: `/api/projects/${fixture.project.projectId}/asset-integrity` }); await app.close();
    expect(response.statusCode).toBe(200); expect(response.json().issues[0]).toMatchObject({ assetId: fixture.asset.id, outputTargetIds: [`frame:${fixture.project.frames[0]?.id ?? ''}`] });
  });

  it('asset_integrity_reconcile_clears_repaired_asset', (): void => {
    const error = { code: 'STORED_ASSET_HASH_MISMATCH', message: 'broken', scope: 'asset' as const, projectId: 'project', resourceId: 'asset', mutationBlocked: false };
    const broken = recordRecoveryUiError(emptyRecoveryUiState(), error); const repaired = clearAssetIntegrityIssue(broken, 'project', 'asset');
    expect(repaired.assetIntegrityIssues).toEqual([]);
  });

  it('unreferenced_historical_corrupt_asset_does_not_keep_current_ui_banner', async (): Promise<void> => {
    const fixture = await assetFixture('asset-historical'); const frameId: string = fixture.project.frames[0]?.id ?? '';
    const current: Project = await fixture.store.update(fixture.project.projectId, fixture.project.revision, (project: Project): Project => ({ ...project,
      frames: project.frames.map((frame: StoryboardFrame): StoryboardFrame => frame.id === frameId ? { ...frame, imageAssetId: null, visualReview: 'pending' } : frame),
    }), []); await writeFile(fixture.path, Buffer.from('corrupt'));
    expect(await fixture.store.currentAssetIntegrityIssues(current.projectId)).toEqual([]);
  });

  it('project_refresh_reconciles_asset_integrity_issues', (): void => {
    const initial = reconcileAssetIntegrityIssues(emptyRecoveryUiState(), 'project', [{ projectId: 'project', assetId: 'asset', code: 'BROKEN', message: 'broken' }]);
    expect(reconcileAssetIntegrityIssues(initial, 'project', []).assetIntegrityIssues).toEqual([]);
  });
});

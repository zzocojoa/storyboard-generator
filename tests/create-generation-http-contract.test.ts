import { randomUUID } from 'node:crypto';
import { hostname, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { CodexRequestStore } from '../src/codex/requests.js';
import { applyGeneratedImage, applyGeneratedProposal, applyGeneratedSpeech } from '../src/domain/media.js';
import { assertGenerationRecordTransition, generationRecordIssues } from '../src/domain/generation-records.js';
import { contractError, issue } from '../src/domain/errors.js';
import { setFrameReview } from '../src/domain/frame.js';
import type { Asset, GenerationRecord, Project } from '../src/domain/schema.js';
import { applySourceUpdate } from '../src/domain/source-update.js';
import { exportProjectJson } from '../src/exporters/json.js';
import { importPackage } from '../src/importers/import-package.js';
import { sha256Bytes } from '../src/importers/integrity.js';
import { parseProject } from '../src/io/project.js';
import { createSourceOutline } from '../src/proposal/outline.js';
import { errorBody, httpErrorPolicy, createApp } from '../src/server/app.js';
import type { AppConfig } from '../src/server/config.js';
import { ProjectStore, projectStoreKey, SimulatedStorageCrash } from '../src/server/store.js';
import type { StorageFaultInjector, StorageFaultPoint } from '../src/server/store.js';
import { ApiError, apiErrorMessage, shouldRetryApiError } from '../web/src/api.js';
import { importButtonState, mutationControlsDisabled } from '../web/src/ui-policy.js';
import { nativeData, nativePackage, pcmWav, png, productionPackage, TEST_AUDIO_NORMALIZATION_OPTIONS, testAudioNormalizer, withNativeData } from './helpers.js';

const roots: string[] = [];
const DEAD_PROCESS_ID: number = 2_147_483_647;

type Barrier = { injector: StorageFaultInjector; reached: Promise<void>; release(): void };
type ActiveCreate = { root: string; dataRoot: string; project: Project; pending: Promise<Project>; gate: Barrier };

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

function projectDirectory(dataRoot: string, projectId: string): string { return join(dataRoot, projectStoreKey(projectId)); }
function rootLockPath(dataRoot: string, projectId: string): string { return join(dataRoot, '.create-locks', `${projectStoreKey(projectId)}.lock`); }

async function exists(path: string): Promise<boolean> {
  try { await stat(path); return true; }
  catch (error: unknown) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return false;
    throw error;
  }
}

async function errorCode(action: Promise<unknown>): Promise<string> {
  try { await action; }
  catch (error: unknown) { return error instanceof Error && 'code' in error ? String(error.code) : error instanceof Error ? error.name : String(error); }
  throw new Error('실패해야 하는 작업이 성공했습니다.');
}

function barrier(point: StorageFaultPoint, ownerPid: number): Barrier {
  let reach: (() => void) | null = null;
  let resume: (() => void) | null = null;
  let triggered: boolean = false;
  const reached: Promise<void> = new Promise<void>((resolveReached): void => { reach = resolveReached; });
  const hold: Promise<void> = new Promise<void>((resolveHold): void => { resume = resolveHold; });
  return { reached, release(): void { resume?.(); }, injector: { ownerPid, async trigger(candidate: StorageFaultPoint): Promise<void> {
    if (candidate !== point || triggered) return;
    triggered = true; reach?.(); await hold;
  } } };
}

async function activeCreate(point: StorageFaultPoint, projectId: string): Promise<ActiveCreate> {
  const root: string = await temporaryRoot('storyboard-root-create-');
  const dataRoot: string = join(root, 'data');
  const project: Project = await outline(projectId);
  const gate: Barrier = barrier(point, process.pid);
  const store: ProjectStore = new ProjectStore(dataRoot, gate.injector);
  const pending: Promise<Project> = store.create(project);
  await gate.reached;
  return { root, dataRoot, project, pending, gate };
}

async function crashedCreate(point: StorageFaultPoint, projectId: string): Promise<{ root: string; dataRoot: string; project: Project }> {
  const root: string = await temporaryRoot('storyboard-root-crash-');
  const dataRoot: string = join(root, 'data');
  const project: Project = await outline(projectId);
  const injector: StorageFaultInjector = { ownerPid: DEAD_PROCESS_ID, trigger(candidate: StorageFaultPoint): void {
    if (candidate === point) throw new SimulatedStorageCrash(candidate);
  } };
  await expect(new ProjectStore(dataRoot, injector).create(project)).rejects.toMatchObject({ code: 'SIMULATED_STORAGE_CRASH' });
  return { root, dataRoot, project };
}

async function concurrentCreate(projectId: string): Promise<{ dataRoot: string; project: Project; loserCode: string }> {
  const root: string = await temporaryRoot('storyboard-concurrent-create-');
  const dataRoot: string = join(root, 'data');
  const second: ProjectStore = new ProjectStore(dataRoot);
  await second.initialize();
  const project: Project = await outline(projectId);
  const gate: Barrier = barrier('after-root-create-lock-acquired', process.pid);
  const pending: Promise<Project> = new ProjectStore(dataRoot, gate.injector).create(project);
  await gate.reached;
  const loserCode: string = await errorCode(second.create(project));
  gate.release();
  await pending;
  return { dataRoot, project, loserCode };
}

async function appForRoot(root: string, dataRoot: string): Promise<FastifyInstance> {
  const webRoot: string = join(root, 'web');
  await mkdir(webRoot); await writeFile(join(webRoot, 'index.html'), '<main></main>', 'utf8');
  const config: AppConfig = { host: '127.0.0.1', port: 4317, dataRoot, webRoot,
    pdfFontPath: resolve('assets/fonts/NanumGothic-Regular.ttf'), audioNormalization: TEST_AUDIO_NORMALIZATION_OPTIONS,
    codex: { requestRoot: join(root, 'requests'), speechVoice: 'Yuna' } };
  return createApp(config, new ProjectStore(dataRoot), new CodexRequestStore(config.codex.requestRoot));
}

function record(id: string, shotIds: readonly string[], resultAssetIds: readonly string[]): GenerationRecord {
  return { id, provider: 'codex-app', model: 'model', modelVersion: null, requestId: `request:${id}`, prompt: `prompt:${id}`,
    templateVersion: '1.0.0', seed: null, referenceHashes: [], resultAssetIds: [...resultAssetIds], shotIds: [...shotIds],
    createdAt: '2026-09-06T00:00:00.000Z' };
}

function withRecord(project: Project, id: string): Project {
  const shotId: string = project.shots[0]?.id ?? '';
  return { ...project, generationRecords: [...project.generationRecords, record(id, [shotId], [])] };
}

function policyError(code: string): Error {
  return contractError(code, `message:${code}`, [issue('TEST_ISSUE', 'error', 'entity', 'field', '문제', null, null, [])]);
}

describe('A. Project-scoped root create lock', (): void => {
  it('root_create_lock_uses_project_key', async (): Promise<void> => {
    const scenario = await activeCreate('after-root-create-lock-acquired', 'root-key');
    expect(await readdir(join(scenario.dataRoot, '.create-locks'))).toEqual([`${projectStoreKey('root-key')}.lock`]);
    scenario.gate.release(); await scenario.pending;
  });
  it('root_create_lock_is_acquired_before_target_check', async (): Promise<void> => {
    const points: StorageFaultPoint[] = []; const root = await temporaryRoot('storyboard-order-');
    await new ProjectStore(join(root, 'data'), { ownerPid: process.pid, trigger(point: StorageFaultPoint): void { points.push(point); } }).create(await outline('root-order'));
    expect(points.indexOf('after-root-create-lock-acquired')).toBeLessThan(points.indexOf('after-create-target-rechecked'));
  });
  it('root_create_lock_uses_exclusive_create', async (): Promise<void> => {
    const scenario = await activeCreate('after-root-create-lock-acquired', 'root-exclusive');
    expect(await errorCode(new ProjectStore(scenario.dataRoot).create(scenario.project))).toBe('PROJECT_BUSY');
    scenario.gate.release(); await scenario.pending;
  });
  it('root_create_lock_records_project_and_transaction', async (): Promise<void> => {
    const scenario = await activeCreate('after-root-create-lock-acquired', 'root-metadata');
    const metadata = JSON.parse(await readFile(rootLockPath(scenario.dataRoot, scenario.project.projectId), 'utf8')) as Record<string, unknown>;
    expect(metadata).toMatchObject({ version: 3, projectId: scenario.project.projectId, host: hostname(), pid: process.pid });
    expect(metadata.transactionId).toMatch(/^[0-9a-f-]{36}$/); expect(metadata.processInstanceId).toMatch(/^[0-9a-f-]{36}$/); scenario.gate.release(); await scenario.pending;
  });
  it('root_create_lock_is_removed_after_success', async (): Promise<void> => {
    const root = await temporaryRoot('storyboard-root-clean-'); const dataRoot = join(root, 'data'); const project = await outline('root-clean');
    await new ProjectStore(dataRoot).create(project); expect(await exists(rootLockPath(dataRoot, project.projectId))).toBe(false);
  });
  it('different_projects_use_different_create_locks', async (): Promise<void> => {
    expect(rootLockPath('/tmp/data', 'first')).not.toBe(rootLockPath('/tmp/data', 'second'));
  });
  it('different_project_creates_can_run_concurrently', async (): Promise<void> => {
    const root = await temporaryRoot('storyboard-different-create-'); const dataRoot = join(root, 'data'); const first = await outline('different-a'); const second = await outline('different-b');
    const values = await Promise.all([new ProjectStore(dataRoot).create(first), new ProjectStore(dataRoot).create(second)]);
    expect(values.map((project: Project): string => project.projectId).sort()).toEqual(['different-a', 'different-b']);
  });
  it('create_internal_lock_directory_is_not_listed_as_project', async (): Promise<void> => {
    const root = await temporaryRoot('storyboard-lock-list-'); const store = new ProjectStore(join(root, 'data')); await store.initialize(); expect(await store.list()).toEqual([]);
  });
});

describe('B. Concurrent create', (): void => {
  it('concurrent_create_commits_exactly_once', async (): Promise<void> => { expect((await concurrentCreate('create-once')).loserCode).toBe('PROJECT_BUSY'); });
  it('concurrent_create_loser_returns_project_busy', async (): Promise<void> => { expect((await concurrentCreate('create-busy')).loserCode).toBe('PROJECT_BUSY'); });
  it('concurrent_create_retry_returns_project_already_exists', async (): Promise<void> => {
    const result = await concurrentCreate('create-retry'); expect(await errorCode(new ProjectStore(result.dataRoot).create(result.project))).toBe('PROJECT_ALREADY_EXISTS');
  });
  it('concurrent_create_leaves_one_final_project', async (): Promise<void> => {
    const result = await concurrentCreate('create-final'); expect((await readdir(result.dataRoot)).filter((name: string): boolean => /^[a-f0-9]{64}$/.test(name))).toHaveLength(1);
  });
  it('concurrent_create_leaves_one_version_zero', async (): Promise<void> => {
    const result = await concurrentCreate('create-version'); expect(await readdir(join(projectDirectory(result.dataRoot, result.project.projectId), 'versions'))).toEqual(['000000.json']);
  });
  it('concurrent_create_leaves_no_recovery_block', async (): Promise<void> => {
    const result = await concurrentCreate('create-block'); expect(await readdir(join(result.dataRoot, '.recovery-blocks'))).toEqual([]);
  });
  it('concurrent_create_cleans_loser_staging', async (): Promise<void> => {
    const result = await concurrentCreate('create-staging'); expect(await readdir(join(result.dataRoot, '.create-transactions'))).toEqual([]);
  });
  it('concurrent_create_cleans_root_lock', async (): Promise<void> => {
    const result = await concurrentCreate('create-lock-clean'); expect(await readdir(join(result.dataRoot, '.create-locks'))).toEqual([]);
  });
  it('concurrent_create_does_not_return_raw_eexist', async (): Promise<void> => { expect((await concurrentCreate('create-eexist')).loserCode).not.toBe('EEXIST'); });
  it('concurrent_create_does_not_return_raw_enotempty', async (): Promise<void> => { expect((await concurrentCreate('create-enotempty')).loserCode).not.toBe('ENOTEMPTY'); });
  it('concurrent_create_preserves_winner_project_hash', async (): Promise<void> => {
    const result = await concurrentCreate('create-hash'); expect(exportProjectJson(await new ProjectStore(result.dataRoot).read(result.project.projectId))).toBe(exportProjectJson(result.project));
  });
  it('concurrent_create_preserves_source_snapshot', async (): Promise<void> => {
    const result = await concurrentCreate('create-source'); expect((await new ProjectStore(result.dataRoot).read(result.project.projectId)).sources).toEqual(result.project.sources);
  });
  it('concurrent_create_http_returns_one_201_and_one_409', async (): Promise<void> => {
    const root = await temporaryRoot('storyboard-http-create-'); const app = await appForRoot(root, join(root, 'data'));
    const payload = { handoffPath: resolve('tests/fixtures/native/storyboard_handoff.json'), proposedTextHoldMs: 2000 };
    const responses = await Promise.all([app.inject({ method: 'POST', url: '/api/projects/import', payload }), app.inject({ method: 'POST', url: '/api/projects/import', payload })]);
    expect(responses.map((response): number => response.statusCode).sort()).toEqual([201, 409]); await app.close();
  });
  it('concurrent_create_double_import_does_not_create_duplicate_project', async (): Promise<void> => {
    const root = await temporaryRoot('storyboard-http-duplicate-'); const dataRoot = join(root, 'data'); const app = await appForRoot(root, dataRoot);
    const payload = { handoffPath: resolve('tests/fixtures/native/storyboard_handoff.json'), proposedTextHoldMs: 2000 };
    await Promise.all([app.inject({ method: 'POST', url: '/api/projects/import', payload }), app.inject({ method: 'POST', url: '/api/projects/import', payload })]);
    expect((await new ProjectStore(dataRoot).list())).toHaveLength(1); await app.close();
  });
});

describe('C. Root create lock recovery', (): void => {
  it('crash_after_root_lock_before_journal_is_recovered', async (): Promise<void> => {
    const fixture = await crashedCreate('after-root-create-lock-acquired', 'crash-root'); const recovered = new ProjectStore(fixture.dataRoot); await recovered.initialize();
    expect(await exists(rootLockPath(fixture.dataRoot, fixture.project.projectId))).toBe(false); await expect(recovered.create(fixture.project)).resolves.toMatchObject({ revision: 0 });
  });
  it('dead_root_lock_without_journal_is_removed', async (): Promise<void> => {
    const fixture = await crashedCreate('after-root-create-lock-acquired', 'dead-root'); await new ProjectStore(fixture.dataRoot).initialize(); expect(await readdir(join(fixture.dataRoot, '.create-locks'))).toEqual([]);
  });
  it('dead_root_lock_with_matching_journal_is_recovered', async (): Promise<void> => {
    const fixture = await crashedCreate('after-create-staging-complete', 'matching-root'); const store = new ProjectStore(fixture.dataRoot); await store.initialize();
    expect(await readdir(join(fixture.dataRoot, '.create-locks'))).toEqual([]); expect(await readdir(join(fixture.dataRoot, '.create-transactions'))).toEqual([]);
  });
  it('dead_root_lock_with_complete_final_is_removed', async (): Promise<void> => {
    const fixture = await crashedCreate('before-root-create-lock-removal', 'complete-final'); const store = new ProjectStore(fixture.dataRoot); await store.initialize();
    expect((await store.read(fixture.project.projectId)).revision).toBe(0); expect(await exists(rootLockPath(fixture.dataRoot, fixture.project.projectId))).toBe(false);
  });
  it('live_root_create_lock_is_preserved', async (): Promise<void> => {
    const scenario = await activeCreate('after-root-create-lock-acquired', 'live-root'); const observer = new ProjectStore(scenario.dataRoot); await observer.initialize();
    expect(observer.activeCreates()).toContainEqual(expect.objectContaining({ projectId: scenario.project.projectId })); expect(await exists(rootLockPath(scenario.dataRoot, scenario.project.projectId))).toBe(true); scenario.gate.release(); await scenario.pending;
  });
  it('foreign_host_root_create_lock_is_preserved', async (): Promise<void> => {
    const fixture = await crashedCreate('after-root-create-lock-acquired', 'foreign-root'); const path = rootLockPath(fixture.dataRoot, fixture.project.projectId);
    const metadata = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>; await writeFile(path, JSON.stringify({ ...metadata, host: 'foreign.example' }));
    const observer = new ProjectStore(fixture.dataRoot); await observer.initialize(); expect(observer.recoveryBlocks()).toContainEqual(expect.objectContaining({ projectId: fixture.project.projectId, code: 'STORE_CREATE_RECOVERY_REQUIRED' })); expect(await exists(path)).toBe(true);
  });
  it('malformed_root_create_lock_creates_recovery_block', async (): Promise<void> => {
    const root = await temporaryRoot('storyboard-malformed-root-'); const dataRoot = join(root, 'data'); const store = new ProjectStore(dataRoot); await store.initialize();
    const projectId = 'malformed-root'; await writeFile(rootLockPath(dataRoot, projectId), '{}'); const observer = new ProjectStore(dataRoot); await observer.initialize();
    expect(observer.recoveryBlocks()).toContainEqual(expect.objectContaining({ directoryName: projectStoreKey(projectId), code: 'STORE_CREATE_RECOVERY_REQUIRED' })); expect(await exists(rootLockPath(dataRoot, projectId))).toBe(true);
  });
  it('root_lock_journal_transaction_mismatch_is_isolated', async (): Promise<void> => {
    const fixture = await crashedCreate('after-create-journal-prepared', 'mismatch-root'); const path = rootLockPath(fixture.dataRoot, fixture.project.projectId);
    const metadata = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>; await writeFile(path, JSON.stringify({ ...metadata, transactionId: randomUUID() }));
    const observer = new ProjectStore(fixture.dataRoot); await observer.initialize(); expect(observer.recoveryBlocks()).toEqual([]); expect(await readdir(join(fixture.dataRoot, '.create-locks'))).toEqual([]);
  });
  it('root_create_recovery_is_idempotent', async (): Promise<void> => {
    const fixture = await crashedCreate('after-root-create-lock-acquired', 'idempotent-root'); await new ProjectStore(fixture.dataRoot).initialize(); await new ProjectStore(fixture.dataRoot).initialize();
    expect(await readdir(join(fixture.dataRoot, '.create-locks'))).toEqual([]);
  });
  it('create_recovery_removes_root_and_final_lock', async (): Promise<void> => {
    const fixture = await crashedCreate('after-create-directory-publish', 'remove-both-locks'); await new ProjectStore(fixture.dataRoot).initialize();
    expect(await exists(rootLockPath(fixture.dataRoot, fixture.project.projectId))).toBe(false); expect(await exists(join(projectDirectory(fixture.dataRoot, fixture.project.projectId), 'write.lock'))).toBe(false);
  });
  it('create_recovery_does_not_delete_complete_project', async (): Promise<void> => {
    const fixture = await crashedCreate('before-root-create-lock-removal', 'preserve-complete'); const observer = new ProjectStore(fixture.dataRoot); await observer.initialize();
    expect(exportProjectJson(await observer.read(fixture.project.projectId))).toBe(exportProjectJson(fixture.project));
  });
});

describe('D. Project-scoped active create', (): void => {
  async function activeWithExisting(): Promise<{ scenario: ActiveCreate; observer: ProjectStore; existing: Project }> {
    const root = await temporaryRoot('storyboard-active-scope-'); const dataRoot = join(root, 'data'); const normal = new ProjectStore(dataRoot); const existing = await normal.create(await outline(`existing-${randomUUID()}`));
    const project = await outline(`active-${randomUUID()}`); const gate = barrier('after-root-create-lock-acquired', process.pid); const pending = new ProjectStore(dataRoot, gate.injector).create(project); await gate.reached;
    const observer = new ProjectStore(dataRoot); await observer.initialize(); return { scenario: { root, dataRoot, project, pending, gate }, observer, existing };
  }
  it('live_create_does_not_block_unrelated_project_read', async (): Promise<void> => {
    const value = await activeWithExisting(); expect((await value.observer.read(value.existing.projectId)).revision).toBe(0); value.scenario.gate.release(); await value.scenario.pending;
  });
  it('live_create_does_not_block_unrelated_project_update', async (): Promise<void> => {
    const value = await activeWithExisting(); expect((await value.observer.update(value.existing.projectId, 0, (project: Project): Project => ({ ...project, title: 'changed' }), [])).revision).toBe(1); value.scenario.gate.release(); await value.scenario.pending;
  });
  it('live_create_does_not_block_unrelated_project_create', async (): Promise<void> => {
    const value = await activeWithExisting(); expect((await value.observer.create(await outline(`third-${randomUUID()}`))).revision).toBe(0); value.scenario.gate.release(); await value.scenario.pending;
  });
  it('active_project_create_returns_busy', async (): Promise<void> => {
    const scenario = await activeCreate('after-root-create-lock-acquired', 'active-create-busy'); expect(await errorCode(new ProjectStore(scenario.dataRoot).create(scenario.project))).toBe('PROJECT_BUSY'); scenario.gate.release(); await scenario.pending;
  });
  it('active_project_update_returns_busy', async (): Promise<void> => {
    const scenario = await activeCreate('after-create-directory-publish', 'active-update-busy'); const observer = new ProjectStore(scenario.dataRoot); await observer.initialize();
    expect(await errorCode(observer.update(scenario.project.projectId, 0, (project: Project): Project => project, []))).toBe('PROJECT_BUSY'); scenario.gate.release(); await scenario.pending;
  });
  it('active_create_state_is_cleared_after_completion', async (): Promise<void> => {
    const scenario = await activeCreate('after-root-create-lock-acquired', 'active-cleared'); const observer = new ProjectStore(scenario.dataRoot); await observer.initialize(); scenario.gate.release(); await scenario.pending;
    await observer.update(scenario.project.projectId, 0, (project: Project): Project => ({ ...project, title: 'complete' }), []); expect(observer.activeCreates()).toEqual([]);
  });
  it('active_create_does_not_create_global_recovery_block', async (): Promise<void> => {
    const scenario = await activeCreate('after-root-create-lock-acquired', 'active-no-block'); const observer = new ProjectStore(scenario.dataRoot); await observer.initialize(); expect(observer.recoveryBlocks()).toEqual([]); scenario.gate.release(); await scenario.pending;
  });
});

describe('E. Generation Record transition', (): void => {
  it('existing_generation_record_is_immutable', async (): Promise<void> => {
    const current = withRecord(await outline('generation-stable'), 'record-1'); expect(assertGenerationRecordTransition(current, current).preserved).toEqual(current.generationRecords);
  });
  it('existing_generation_record_removal_is_rejected', async (): Promise<void> => {
    const current = withRecord(await outline('generation-remove'), 'record-1'); expect(() => assertGenerationRecordTransition(current, { ...current, generationRecords: [] })).toThrowError(expect.objectContaining({ code: 'GENERATION_RECORD_REMOVAL_FORBIDDEN' }));
  });
  it('existing_generation_record_reordering_is_rejected', async (): Promise<void> => {
    const first = withRecord(await outline('generation-reorder'), 'record-1'); const current = withRecord(first, 'record-2');
    expect(() => assertGenerationRecordTransition(current, { ...current, generationRecords: [current.generationRecords[1] as GenerationRecord, current.generationRecords[0] as GenerationRecord] })).toThrowError(expect.objectContaining({ code: 'GENERATION_RECORD_ORDER_IMMUTABLE' }));
  });
  it('existing_generation_record_provider_change_is_rejected', async (): Promise<void> => {
    const current = withRecord(await outline('generation-provider'), 'record-1'); const first = current.generationRecords[0] as GenerationRecord;
    expect(() => assertGenerationRecordTransition(current, { ...current, generationRecords: [{ ...first, provider: 'changed' }] })).toThrowError(expect.objectContaining({ code: 'GENERATION_RECORD_IMMUTABLE' }));
  });
  it('existing_generation_record_model_change_is_rejected', async (): Promise<void> => {
    const current = withRecord(await outline('generation-model'), 'record-1'); const first = current.generationRecords[0] as GenerationRecord;
    expect(() => assertGenerationRecordTransition(current, { ...current, generationRecords: [{ ...first, model: 'changed' }] })).toThrowError(expect.objectContaining({ code: 'GENERATION_RECORD_IMMUTABLE' }));
  });
  it('existing_generation_record_prompt_change_is_rejected', async (): Promise<void> => {
    const current = withRecord(await outline('generation-prompt'), 'record-1'); const first = current.generationRecords[0] as GenerationRecord;
    expect(() => assertGenerationRecordTransition(current, { ...current, generationRecords: [{ ...first, prompt: 'changed' }] })).toThrowError(expect.objectContaining({ code: 'GENERATION_RECORD_IMMUTABLE' }));
  });
  it('existing_generation_record_result_asset_change_is_rejected', async (): Promise<void> => {
    const current = withRecord(await outline('generation-result'), 'record-1'); const first = current.generationRecords[0] as GenerationRecord;
    expect(() => assertGenerationRecordTransition(current, { ...current, generationRecords: [{ ...first, resultAssetIds: ['changed'] }] })).toThrowError(expect.objectContaining({ code: 'GENERATION_RECORD_IMMUTABLE' }));
  });
  it('existing_generation_record_shot_change_is_rejected', async (): Promise<void> => {
    const current = withRecord(await outline('generation-shot'), 'record-1'); const first = current.generationRecords[0] as GenerationRecord;
    expect(() => assertGenerationRecordTransition(current, { ...current, generationRecords: [{ ...first, shotIds: [] }] })).toThrowError(expect.objectContaining({ code: 'GENERATION_RECORD_IMMUTABLE' }));
  });
  it('existing_generation_record_created_at_change_is_rejected', async (): Promise<void> => {
    const current = withRecord(await outline('generation-created'), 'record-1'); const first = current.generationRecords[0] as GenerationRecord;
    expect(() => assertGenerationRecordTransition(current, { ...current, generationRecords: [{ ...first, createdAt: '2026-09-06T00:00:01.000Z' }] })).toThrowError(expect.objectContaining({ code: 'GENERATION_RECORD_IMMUTABLE' }));
  });
  it('new_generation_record_is_appended', async (): Promise<void> => {
    const current = withRecord(await outline('generation-append'), 'record-1'); const next = withRecord(current, 'record-2'); expect(assertGenerationRecordTransition(current, next).added.map((value): string => value.id)).toEqual(['record-2']);
  });
  it('new_generation_record_cannot_be_inserted_before_existing', async (): Promise<void> => {
    const current = withRecord(await outline('generation-insert'), 'record-1'); const inserted = record('record-new', [], []);
    expect(() => assertGenerationRecordTransition(current, { ...current, generationRecords: [inserted, ...current.generationRecords] })).toThrowError(expect.objectContaining({ code: 'GENERATION_RECORD_ORDER_IMMUTABLE' }));
  });
  it('multiple_new_generation_records_preserve_order', async (): Promise<void> => {
    const current = withRecord(await outline('generation-many'), 'record-1'); const next = withRecord(withRecord(current, 'record-2'), 'record-3'); expect(assertGenerationRecordTransition(current, next).added.map((value): string => value.id)).toEqual(['record-2', 'record-3']);
  });
  it('new_generation_record_shot_ids_must_exist', async (): Promise<void> => {
    const current = await outline('generation-missing-shot'); const next = { ...current, generationRecords: [record('record-1', ['missing-shot'], [])] };
    expect(generationRecordIssues(next)).not.toContainEqual(expect.objectContaining({ code: 'GENERATION_RECORD_SHOT_NOT_FOUND' })); expect(() => assertGenerationRecordTransition(current, next)).toThrowError(expect.objectContaining({ code: 'GENERATION_RECORD_SHOT_NOT_FOUND' }));
  });
  it('new_generation_record_result_assets_must_exist', async (): Promise<void> => {
    const root = await temporaryRoot('storyboard-generation-asset-'); const store = new ProjectStore(join(root, 'data')); const project = await store.create(await outline('generation-missing-asset'));
    await expect(store.update(project.projectId, 0, (current: Project): Project => ({ ...current, generationRecords: [record('record-1', [], ['missing-asset'])] }), [])).rejects.toMatchObject({ code: 'ASSET_REFERENCE_NOT_FOUND' });
  });
  it('new_generation_record_can_reference_new_asset_in_same_revision', async (): Promise<void> => {
    const root = await temporaryRoot('storyboard-generation-new-asset-'); const store = new ProjectStore(join(root, 'data')); const project = await store.create(await outline('generation-new-asset')); const bytes = await png(1, 1);
    const asset: Asset = { id: 'new-prop', kind: 'prop', subjectId: null, path: 'assets/new-prop.png', mimeType: 'image/png', sha256: sha256Bytes(bytes), description: '새 자산', durationMs: null, version: 1 };
    const updated = await store.update(project.projectId, 0, (current: Project): Project => ({ ...current, assets: [asset], generationRecords: [record('record-1', [], [asset.id])] }), [{ relativePath: asset.path, content: bytes }]); expect(updated.generationRecords[0]?.resultAssetIds).toEqual([asset.id]);
  });
  async function failedTransition(projectId: string): Promise<{ dataRoot: string; store: ProjectStore; current: Project }> {
    const root = await temporaryRoot('storyboard-generation-failure-'); const dataRoot = join(root, 'data'); const store = new ProjectStore(dataRoot); const base = await store.create(await outline(projectId));
    const current = await store.update(base.projectId, 0, (project: Project): Project => withRecord(project, 'record-1'), []); const existing = current.generationRecords[0] as GenerationRecord;
    await expect(store.update(current.projectId, current.revision, (project: Project): Project => ({ ...project, generationRecords: [{ ...existing, provider: 'changed' }] }), [])).rejects.toMatchObject({ code: 'GENERATION_RECORD_IMMUTABLE' });
    return { dataRoot, store, current };
  }
  it('generation_record_transition_failure_creates_no_journal', async (): Promise<void> => {
    const value = await failedTransition('generation-no-journal'); expect(await readdir(join(projectDirectory(value.dataRoot, value.current.projectId), '.transactions'))).toEqual([]);
  });
  it('generation_record_transition_failure_releases_lock', async (): Promise<void> => {
    const value = await failedTransition('generation-release-lock'); expect(await exists(join(projectDirectory(value.dataRoot, value.current.projectId), 'write.lock'))).toBe(false);
  });
  it('generation_record_transition_failure_creates_no_recovery_block', async (): Promise<void> => {
    const value = await failedTransition('generation-no-block'); expect(value.store.recoveryBlocks()).toEqual([]); expect(await readdir(join(value.dataRoot, '.recovery-blocks'))).toEqual([]);
  });
});

describe('F. Codex and source update audit', (): void => {
  it('image_apply_appends_generation_record', async (): Promise<void> => {
    const project = await outline('image-append'); const frame = project.frames[0]; if (frame === undefined) throw new Error('검증용 Frame이 없습니다.');
    const mutation = await applyGeneratedImage(project, frame.id, 'image-record', '2026-09-06T00:00:00.000Z', { bytes: await png(1, 1), provider: 'codex-app', prompt: 'image', model: 'codex-imagegen', requestId: 'request-image', mimeType: 'image/png', referenceHashes: [] });
    expect(mutation.project.generationRecords.at(-1)).toMatchObject({ id: 'image-record', resultAssetIds: ['image-record:image'] });
  });
  it('speech_apply_appends_generation_record', async (): Promise<void> => {
    const project = await outline('speech-append'); const cue = project.audioCues.find((value): boolean => ['dialogue', 'voiceover', 'panel'].includes(value.kind)); if (cue === undefined) throw new Error('검증용 Cue가 없습니다.');
    const normalizer = testAudioNormalizer(); const mutation = await applyGeneratedSpeech(project, cue.id, 'speech-record', '2026-09-06T00:00:00.000Z', { bytes: pcmWav(500, 48000, 1, 16), provider: 'codex-app', prompt: 'speech', model: 'macos-say:Yuna', requestId: 'request-speech', mimeType: 'audio/wav' }, normalizer); await normalizer.close();
    expect(mutation.project.generationRecords.at(-1)).toMatchObject({ id: 'speech-record', resultAssetIds: ['speech-record:audio'] });
  });
  it('proposal_apply_preserves_generation_records', async (): Promise<void> => {
    const base = await outline('proposal-preserve'); const existing = record('existing-record', [], []); const project: Project = { ...base, generationRecords: [existing] }; const segment = project.dataset.segments[0]; if (segment === undefined) throw new Error('검증용 Segment가 없습니다.');
    const sourceLinks = project.dataset.units.filter((unit): boolean => unit.segmentId === segment.id).map((unit) => ({ unitId: unit.id, usage: 'primary-visual' as const }));
    const mutation = applyGeneratedProposal(project, segment.id, 'proposal-record', '2026-09-06T00:00:01.000Z', { provider: 'codex-app', prompt: 'proposal', model: 'current', requestId: 'request-proposal', proposal: { shots: [{ sourceLinks, durationWeight: 1, action: '원문 행동', visualLocationId: project.dataset.scenes[0]?.storyLocationId ?? null, camera: { size: 'MS', angle: 'eye-level', move: 'static' }, presence: [], propIds: [], cameraAxis: null, screenDirection: null, informationIds: [], transitionOut: { kind: 'cut', durationMs: 0, note: '' }, frameDescription: '원문 프레임' }] } });
    expect(mutation.project.generationRecords[0]).toEqual(existing); expect(mutation.project.generationRecords.at(-1)?.id).toBe('proposal-record');
  });
  it('source_update_preserves_generation_records', async (): Promise<void> => {
    const current = { ...(await outline('source-records')), generationRecords: [record('existing-record', [], [])] }; const incoming = await outline(current.projectId); expect(applySourceUpdate(current, incoming, 'source-update').generationRecords).toEqual(current.generationRecords);
  });
  it('asset_replacement_does_not_rewrite_generation_history', async (): Promise<void> => {
    const project = await outline('asset-history'); const frame = project.frames[0]; if (frame === undefined) throw new Error('검증용 Frame이 없습니다.'); const bytes = await png(1, 1);
    const first = await applyGeneratedImage(project, frame.id, 'image-first', '2026-09-06T00:00:00.000Z', { bytes, provider: 'codex-app', prompt: 'first', model: 'image', requestId: 'first', mimeType: 'image/png', referenceHashes: [] });
    const second = await applyGeneratedImage(first.project, frame.id, 'image-second', '2026-09-06T00:00:01.000Z', { bytes, provider: 'codex-app', prompt: 'second', model: 'image', requestId: 'second', mimeType: 'image/png', referenceHashes: [] });
    expect(second.project.generationRecords[0]).toEqual(first.project.generationRecords[0]); expect(second.project.generationRecords.at(-1)?.resultAssetIds).toEqual(['image-second:image']);
  });
  it('generation_records_survive_json_round_trip', async (): Promise<void> => {
    const project = withRecord(withRecord(await outline('generation-roundtrip'), 'record-1'), 'record-2'); expect(parseProject(JSON.parse(exportProjectJson(project)) as unknown).generationRecords).toEqual(project.generationRecords);
  });
  it('generation_records_survive_storage_recovery', async (): Promise<void> => {
    const root = await temporaryRoot('storyboard-generation-recovery-'); const dataRoot = join(root, 'data'); const store = new ProjectStore(dataRoot); const base = await store.create(await outline('generation-recovery')); const current = await store.update(base.projectId, 0, (project: Project): Project => withRecord(project, 'record-1'), []);
    const crashing = new ProjectStore(dataRoot, { ownerPid: DEAD_PROCESS_ID, trigger(point: StorageFaultPoint): void { if (point === 'after-update-current-published') throw new SimulatedStorageCrash(point); } }); await crashing.initialize();
    await expect(crashing.update(current.projectId, current.revision, (project: Project): Project => ({ ...project, title: 'recovered' }), [])).rejects.toMatchObject({ code: 'SIMULATED_STORAGE_CRASH' }); const recovered = new ProjectStore(dataRoot); await recovered.initialize(); expect((await recovered.read(current.projectId)).generationRecords).toEqual(current.generationRecords);
  });
});

describe('G. Explicit HTTP status policy', (): void => {
  it('validation_error_returns_400', (): void => { expect(httpErrorPolicy(policyError('INVALID_INPUT')).status).toBe(400); });
  it('project_not_found_returns_404', (): void => { expect(httpErrorPolicy(policyError('PROJECT_NOT_FOUND')).status).toBe(404); });
  it('project_busy_returns_409', (): void => { expect(httpErrorPolicy(policyError('PROJECT_BUSY')).status).toBe(409); });
  it('revision_conflict_returns_409', (): void => { expect(httpErrorPolicy(policyError('REVISION_CONFLICT')).status).toBe(409); });
  it('project_already_exists_returns_409', (): void => { expect(httpErrorPolicy(policyError('PROJECT_ALREADY_EXISTS')).status).toBe(409); });
  it('recovery_blocked_returns_423', (): void => { expect(httpErrorPolicy(policyError('STORE_RECOVERY_BLOCKED')).status).toBe(423); });
  it('recovery_required_returns_423', (): void => { expect(httpErrorPolicy(policyError('STORE_RECOVERY_REQUIRED')).status).toBe(423); });
  it('create_recovery_required_returns_423', (): void => { expect(httpErrorPolicy(policyError('STORE_CREATE_RECOVERY_REQUIRED')).status).toBe(423); });
  it('lock_cleanup_required_returns_423', (): void => { expect(httpErrorPolicy(policyError('STORE_LOCK_CLEANUP_REQUIRED')).status).toBe(423); });
  it('concurrent_modification_returns_423', (): void => { expect(httpErrorPolicy(policyError('STORE_CONCURRENT_MODIFICATION')).status).toBe(423); });
  it('lock_acquisition_failed_returns_503', (): void => { expect(httpErrorPolicy(policyError('STORE_LOCK_ACQUISITION_FAILED')).status).toBe(503); });
  it('unknown_server_error_returns_500', (): void => { expect(httpErrorPolicy(new Error('unexpected')).status).toBe(500); });
  it('asset_reference_not_found_remains_400', (): void => { expect(httpErrorPolicy(policyError('ASSET_REFERENCE_NOT_FOUND')).status).toBe(400); });
  it('missing_expected_revision_remains_400', (): void => { expect(httpErrorPolicy(policyError('MISSING_EXPECTED_REVISION')).status).toBe(400); });
  it('recovery_error_is_not_classified_by_generic_required_suffix', (): void => {
    expect(httpErrorPolicy(policyError('STORE_RECOVERY_REQUIRED'))).toMatchObject({ status: 423, category: 'locked' }); expect(httpErrorPolicy(policyError('SPEECH_CUE_REQUIRED'))).toMatchObject({ status: 400, category: 'validation' });
  });
});

describe('H. Error response metadata', (): void => {
  it('conflict_error_is_marked_retryable', (): void => { expect(httpErrorPolicy(policyError('PROJECT_BUSY'))).toMatchObject({ category: 'conflict', retryable: true, operatorActionRequired: false }); });
  it('recovery_error_requires_operator_action', (): void => { expect(httpErrorPolicy(policyError('STORE_RECOVERY_BLOCKED'))).toMatchObject({ category: 'locked', retryable: false, operatorActionRequired: true }); });
  it('validation_error_does_not_require_operator_action', (): void => { expect(httpErrorPolicy(policyError('INVALID_INPUT'))).toMatchObject({ category: 'validation', retryable: false, operatorActionRequired: false }); });
  it('unavailable_error_is_marked_retryable', (): void => { expect(httpErrorPolicy(policyError('STORE_LOCK_ACQUISITION_FAILED'))).toMatchObject({ category: 'unavailable', retryable: true }); });
  it('existing_error_code_message_and_issues_are_preserved', (): void => {
    const error = policyError('INVALID_INPUT'); expect(errorBody(error)).toMatchObject({ error: { code: 'INVALID_INPUT', message: 'message:INVALID_INPUT', issues: [expect.objectContaining({ code: 'TEST_ISSUE' })], category: 'validation', retryable: false, operatorActionRequired: false } });
  });
});

describe('I. Web UI error states', (): void => {
  function apiError(code: string, category: 'validation' | 'not-found' | 'conflict' | 'locked' | 'unavailable' | 'internal', retryable: boolean, operator: boolean): ApiError {
    return new ApiError(code, `message:${code}`, category === 'locked' ? 423 : category === 'unavailable' ? 503 : category === 'conflict' ? 409 : 400, category, retryable, operator, []);
  }
  it('import_button_is_disabled_while_request_is_pending', (): void => {
    expect(importButtonState(true, false)).toEqual({ disabled: true, label: 'IMPORTING' });
  });
  it('project_busy_message_requests_reload_or_retry', (): void => { expect(apiErrorMessage(apiError('PROJECT_BUSY', 'conflict', true, false))).toMatch(/완료 후.*재시도/); });
  it('project_already_exists_message_is_distinct', (): void => { expect(apiErrorMessage(apiError('PROJECT_ALREADY_EXISTS', 'conflict', false, false))).toBe('같은 Project가 이미 저장돼 있습니다.'); });
  it('recovery_423_displays_storage_recovery_banner', (): void => { expect(apiErrorMessage(apiError('STORE_RECOVERY_BLOCKED', 'locked', false, true))).toContain('STORAGE RECOVERY REQUIRED'); });
  it('recovery_423_disables_mutation_controls', (): void => { expect(mutationControlsDisabled(false, 'blocked', { blockedProjectIds: ['blocked'], assetIntegrityIssues: [] })).toBe(true); });
  it('recovery_423_is_not_automatically_retried', (): void => { expect(shouldRetryApiError(apiError('STORE_RECOVERY_BLOCKED', 'locked', false, true))).toBe(false); });
  it('storage_503_displays_temporary_unavailable_message', (): void => { expect(apiErrorMessage(apiError('STORE_LOCK_ACQUISITION_FAILED', 'unavailable', true, false))).toContain('STORAGE TEMPORARILY UNAVAILABLE'); });
});

describe('J. Existing storage regression', (): void => {
  it('create_update_serialization_still_passes', async (): Promise<void> => {
    const root = await temporaryRoot('storyboard-create-update-'); const dataRoot = join(root, 'data'); const store = new ProjectStore(dataRoot); const project = await store.create(await outline('create-update'));
    const updated = await store.update(project.projectId, 0, (current: Project): Project => ({ ...current, title: 'revision one' }), []); expect(updated.revision).toBe(1); expect(await readdir(join(projectDirectory(dataRoot, project.projectId), 'versions'))).toEqual(['000000.json', '000001.json']);
  });
  it('asset_reference_closure_still_passes', async (): Promise<void> => {
    const root = await temporaryRoot('storyboard-asset-closure-'); const store = new ProjectStore(join(root, 'data')); const project = await store.create(await outline('asset-closure'));
    await expect(store.update(project.projectId, 0, (current: Project): Project => ({ ...current, generationRecords: [record('missing-result', [], ['missing'])] }), [])).rejects.toMatchObject({ code: 'ASSET_REFERENCE_NOT_FOUND' });
  });
  it('asset_metadata_immutability_still_passes', async (): Promise<void> => {
    const root = await temporaryRoot('storyboard-asset-immutable-'); const store = new ProjectStore(join(root, 'data')); const project = await store.create(await outline('asset-immutable')); const bytes = await png(1, 1);
    const asset: Asset = { id: 'prop', kind: 'prop', subjectId: null, path: 'assets/prop.png', mimeType: 'image/png', sha256: sha256Bytes(bytes), description: 'prop', durationMs: null, version: 1 };
    const current = await store.update(project.projectId, 0, (value: Project): Project => ({ ...value, assets: [asset] }), [{ relativePath: asset.path, content: bytes }]);
    await expect(store.update(current.projectId, current.revision, (value: Project): Project => ({ ...value, assets: [{ ...asset, description: 'changed' }] }), [])).rejects.toMatchObject({ code: 'ASSET_METADATA_IMMUTABLE' });
  });
  it('safe_frame_and_audio_output_still_pass', async (): Promise<void> => {
    const root = await temporaryRoot('storyboard-safe-output-'); const store = new ProjectStore(join(root, 'data')); const base = await store.create(await outline('safe-output')); const frame = base.frames[0]; const cue = base.audioCues.find((value): boolean => ['dialogue', 'voiceover', 'panel'].includes(value.kind)); if (frame === undefined || cue === undefined) throw new Error('검증용 Frame 또는 Cue가 없습니다.');
    const image = await applyGeneratedImage(base, frame.id, 'safe-image', '2026-09-06T00:00:00.000Z', { bytes: await png(1, 1), provider: 'codex-app', prompt: 'safe', model: 'image', requestId: 'safe-image', mimeType: 'image/png', referenceHashes: [] });
    let current = await store.update(base.projectId, 0, (): Project => image.project, [{ relativePath: image.relativePath as string, content: image.content as Buffer }]); current = await store.update(current.projectId, current.revision, (value: Project): Project => setFrameReview(value, frame.id, 'accepted'), []);
    const normalizer = testAudioNormalizer(); const speech = await applyGeneratedSpeech(current, cue.id, 'safe-speech', '2026-09-06T00:00:01.000Z', { bytes: pcmWav(500, 48000, 1, 16), provider: 'codex-app', prompt: 'safe', model: 'speech', requestId: 'safe-speech', mimeType: 'audio/wav' }, normalizer); await normalizer.close();
    current = await store.update(current.projectId, current.revision, (): Project => speech.project, [{ relativePath: speech.relativePath as string, content: speech.content as Buffer }]); expect((await store.safeFrame(current.projectId, frame.id)).content.subarray(1, 4).toString()).toBe('PNG'); expect((await store.safeAudio(current.projectId, cue.id)).content.subarray(0, 4).toString()).toBe('RIFF');
  });
});

describe('K. PRJ-007 Generation Record regression', (): void => {
  it('prj007_generation_records_remain_unchanged', async (): Promise<void> => {
    const project = createSourceOutline(importPackage(await productionPackage()), { proposedTextHoldMs: 3000 }); const roundTrip = parseProject(JSON.parse(exportProjectJson(project)) as unknown); expect(roundTrip.projectId).toBe('PRJ-007'); expect(roundTrip.generationRecords).toEqual(project.generationRecords);
  });
});

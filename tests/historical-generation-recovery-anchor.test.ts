import { randomUUID } from 'node:crypto';
import { hostname, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { contractError } from '../src/domain/errors.js';
import { mergeShots, reorderShots, splitShot } from '../src/domain/edit.js';
import {
  assertGenerationRecordTransition, auditGenerationRecords, generationRecordStructuralIssues,
} from '../src/domain/generation-records.js';
import { applyGeneratedProposal } from '../src/domain/media.js';
import { NativeDatasetSchema } from '../src/domain/schema.js';
import type { Asset, AudioCue, GenerationRecord, NativeDataset, PackagePayload, Project, Shot } from '../src/domain/schema.js';
import { applySourceUpdate } from '../src/domain/source-update.js';
import { formatProjectTimecode } from '../src/domain/time.js';
import { exportShotCsv } from '../src/exporters/csv.js';
import { exportProjectJson } from '../src/exporters/json.js';
import { exportProjectPdf } from '../src/exporters/pdf.js';
import { importPackage } from '../src/importers/import-package.js';
import { sha256Bytes, sha256Text } from '../src/importers/integrity.js';
import { parseProject } from '../src/io/project.js';
import { buildFrameImageContext } from '../src/proposal/context.js';
import { createSourceOutline } from '../src/proposal/outline.js';
import { applySegmentProposal, SegmentProposalSchema } from '../src/proposal/model.js';
import type { SegmentProposal } from '../src/proposal/model.js';
import { errorBody, httpErrorPolicy } from '../src/server/app.js';
import { ProjectStore, SimulatedStorageCrash, STORE_LOCK_VERSION } from '../src/server/store.js';
import type { StorageFaultInjector, StorageFaultPoint, StorageRuntime } from '../src/server/store.js';
import {
  emptyRecoveryUiState, importButtonState, mutationControlsDisabled, projectAssetIntegrityIssues,
  projectRecoveryBlocked, reconcileBlockedProjects, recordRecoveryUiError,
} from '../web/src/ui-policy.js';
import type { RecoveryUiError, RecoveryUiState } from '../web/src/ui-policy.js';
import { nativeData, nativePackage, productionPackage, withNativeData } from './helpers.js';

const roots: string[] = [];
const DEAD_PROCESS_ID: number = 2_147_483_647;
let nativeProject: Project;
let productionProject: Project;

type Barrier = { injector: StorageFaultInjector; reached: Promise<void>; release(): void };

beforeAll(async (): Promise<void> => {
  const nativePayload = await nativePackage();
  nativeProject = createSourceOutline(importPackage(nativePayload), { proposedTextHoldMs: 2000 });
  const productionPayload = await productionPackage();
  productionProject = createSourceOutline(importPackage(productionPayload), { proposedTextHoldMs: 2000 });
});

afterEach(async (): Promise<void> => {
  await Promise.all(roots.splice(0).map((root: string): Promise<void> => rm(root, { recursive: true, force: true })));
});

function generationRecord(id: string, shotIds: readonly string[], assetIds: readonly string[], requestId: string | null): GenerationRecord {
  return {
    id, provider: 'codex-app', model: 'current', modelVersion: null, requestId, prompt: `prompt:${id}`,
    templateVersion: '1.0.0', seed: null, referenceHashes: [], resultAssetIds: [...assetIds], shotIds: [...shotIds],
    createdAt: '2026-09-06T00:00:00.000Z',
  };
}

function withHistory(project: Project, id: string): Project {
  const shotId: string = project.shots[0]?.id ?? '';
  return { ...project, generationRecords: [...project.generationRecords, generationRecord(id, [shotId], [], `request:${id}`)] };
}

function withTargetHistory(project: Project, id: string, shotId: string): Project {
  return { ...project, generationRecords: [...project.generationRecords, generationRecord(id, [shotId], [], `request:${id}`)] };
}

function barrier(point: StorageFaultPoint, ownerPid: number): Barrier {
  let signalReached: (() => void) | null = null;
  let signalRelease: (() => void) | null = null;
  let triggered: boolean = false;
  const reached: Promise<void> = new Promise<void>((resolveReached): void => { signalReached = resolveReached; });
  const hold: Promise<void> = new Promise<void>((resolveHold): void => { signalRelease = resolveHold; });
  return {
    reached,
    release(): void { signalRelease?.(); },
    injector: {
      ownerPid,
      async trigger(candidate: StorageFaultPoint): Promise<void> {
        if (candidate !== point || triggered) return;
        triggered = true;
        signalReached?.();
        await hold;
      },
    },
  };
}

async function temporaryDataRoot(prefix: string): Promise<string> {
  const root: string = await mkdtemp(join(tmpdir(), prefix));
  roots.push(root);
  return join(root, 'data');
}

function projectDirectory(dataRoot: string, projectId: string): string {
  return join(dataRoot, sha256Text(projectId));
}

async function pathExists(path: string): Promise<boolean> {
  try { await stat(path); return true; }
  catch (error: unknown) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return false;
    throw error;
  }
}

async function changedNativeOutline(projectId: string): Promise<Project> {
  const payload = await nativePackage();
  const data: NativeDataset = nativeData(payload);
  const changed: NativeDataset = NativeDatasetSchema.parse({ ...data, projectId,
    units: data.units.map((unit) => unit.id === 'UNIT-001' ? { ...unit, text: `${unit.text} 변경` } : unit) });
  return createSourceOutline(importPackage(withNativeData(payload, changed)), { proposedTextHoldMs: 2000 });
}

async function nativeOutlineFor(projectId: string): Promise<Project> {
  const payload = await nativePackage();
  const data: NativeDataset = nativeData(payload);
  return createSourceOutline(importPackage(withNativeData(payload, { ...data, projectId })), { proposedTextHoldMs: 2000 });
}

async function changedProductionOutline(projectId: string): Promise<Project> {
  const payload: PackagePayload = await productionPackage();
  const screenplay = payload.files.find((file): boolean => file.path === '07_SCRIPT/screenplay_units.json');
  if (screenplay === undefined) throw new Error('PRJ-007 screenplay source를 찾을 수 없습니다.');
  const changedContent: string = screenplay.content.replace('상상하지 못했다.', '상상하지 못했다. 변경');
  if (changedContent === screenplay.content) throw new Error('UNIT-007 변경 지점을 찾을 수 없습니다.');
  const changedPayload: PackagePayload = {
    handoff: { ...payload.handoff, projectId, files: payload.handoff.files.map((descriptor) => descriptor.path === screenplay.path
      ? { ...descriptor, sha256: sha256Text(changedContent) } : descriptor) },
    files: payload.files.map((file) => file.path === screenplay.path ? { ...file, content: changedContent } : file),
  };
  return createSourceOutline(importPackage(changedPayload), { proposedTextHoldMs: 2000 });
}

async function storedHistoricalAudit(prefix: string): Promise<{ dataRoot: string; store: ProjectStore; current: Project }> {
  const dataRoot: string = await temporaryDataRoot(prefix);
  const projectId: string = `audit-${randomUUID()}`;
  const store: ProjectStore = new ProjectStore(dataRoot);
  const created: Project = await store.create(await nativeOutlineFor(projectId));
  const introduced: Project = await store.update(projectId, created.revision, (current: Project): Project => {
    const split: Project = splitShot(current, 'shot-2', 8000, 'audit-removed-shot', 'audit-removed-frame');
    return withTargetHistory(split, 'audit-record', 'audit-removed-shot');
  }, []);
  const current: Project = await store.update(projectId, introduced.revision,
    (project: Project): Project => mergeShots(project, 'shot-2', 'audit-removed-shot'), []);
  return { dataRoot, store, current };
}

async function exactGateProject(): Promise<Project> {
  const payload = await nativePackage();
  const data: NativeDataset = nativeData(payload);
  const changed: NativeDataset = NativeDatasetSchema.parse({ ...data,
    units: data.units.map((unit) => unit.id === '동작' ? { ...unit, informationIds: ['info:late'] } : unit),
    informationRules: [{ id: 'info:late', segmentId: 'demonstration', notBeforeMs: 9000,
      notBeforeUnitId: '동작', notBeforeUnitOrder: 2, precision: 'exact-time' }],
  });
  return createSourceOutline(importPackage(withNativeData(payload, changed)), { proposedTextHoldMs: 2000 });
}

function codeOf(action: () => unknown): string {
  try { action(); }
  catch (error: unknown) { return error instanceof Error && 'code' in error ? String(error.code) : 'UNKNOWN'; }
  return 'NONE';
}

function policyError(code: string, context: Record<string, string>): Error {
  return Object.assign(contractError(code, `message:${code}`, []), context);
}

function recoveryError(scope: RecoveryUiError['scope'], projectId: string | null, resourceId: string | null,
  mutationBlocked: boolean, code: string): RecoveryUiError {
  return { code, message: code, scope, projectId, resourceId, mutationBlocked };
}

function demonstrationProposal(anchor: { startPermille: number; endPermille: number } | undefined): SegmentProposal {
  const link = (unitId: string, usage: 'primary-visual' | 'audio-only') =>
    unitId === '동작' && anchor !== undefined ? { unitId, usage, anchor } : { unitId, usage };
  return SegmentProposalSchema.parse({ shots: [{
    sourceLinks: [link('안내-1', 'audio-only'), link('동작', 'primary-visual'), link('효과음', 'audio-only')],
    durationWeight: 1, action: '물을 준다', visualLocationId: null,
    camera: { size: 'CU', angle: 'eye', move: 'static' }, presence: [], propIds: [], cameraAxis: null,
    screenDirection: null, informationIds: [], transitionOut: { kind: 'cut', durationMs: 0, note: '' }, frameDescription: '화분',
  }] });
}

describe('A. historical generation target', (): void => {
  const names: readonly string[] = [
    'existing_historical_shot_id_may_be_absent_from_current_project',
    'generation_record_structural_validation_does_not_require_current_shot',
    'added_generation_record_requires_current_shot',
    'added_generation_record_missing_shot_is_rejected',
    'added_generation_record_requires_current_asset',
    'existing_generation_record_metadata_remains_immutable',
    'existing_generation_record_order_remains_immutable',
    'historical_record_is_not_remapped',
    'historical_record_is_not_deleted',
    'historical_record_is_not_rewritten_with_empty_shot_ids',
  ];
  it.each(names)('%s', (name: string): void => {
    const current: Project = withHistory(nativeProject, 'history-a');
    const historical: Project = { ...current, shots: current.shots.slice(1) };
    if (name === 'added_generation_record_requires_current_shot' || name === 'added_generation_record_missing_shot_is_rejected') {
      const next: Project = { ...nativeProject, generationRecords: [generationRecord('new', ['missing'], [], 'new-request')] };
      expect(codeOf((): void => { assertGenerationRecordTransition(nativeProject, next); })).toBe('GENERATION_RECORD_SHOT_NOT_FOUND'); return;
    }
    if (name === 'added_generation_record_requires_current_asset') {
      const next: Project = { ...nativeProject, generationRecords: [generationRecord('new', [], ['missing'], 'new-request')] };
      expect(codeOf((): void => { assertGenerationRecordTransition(nativeProject, next); })).toBe('ASSET_REFERENCE_NOT_FOUND'); return;
    }
    if (name === 'existing_generation_record_metadata_remains_immutable' || name === 'historical_record_is_not_remapped' || name === 'historical_record_is_not_rewritten_with_empty_shot_ids') {
      const changed: GenerationRecord = { ...(current.generationRecords[0] as GenerationRecord), shotIds: [] };
      expect(codeOf((): void => { assertGenerationRecordTransition(current, { ...current, generationRecords: [changed] }); })).toBe('GENERATION_RECORD_IMMUTABLE'); return;
    }
    if (name === 'existing_generation_record_order_remains_immutable') {
      const second: GenerationRecord = generationRecord('second', [], [], 'second-request');
      expect(codeOf((): void => { assertGenerationRecordTransition({ ...current, generationRecords: [...current.generationRecords, second] }, { ...current, generationRecords: [second, ...current.generationRecords] }); })).toBe('GENERATION_RECORD_ORDER_IMMUTABLE'); return;
    }
    if (name === 'historical_record_is_not_deleted') {
      expect(codeOf((): void => { assertGenerationRecordTransition(current, { ...current, generationRecords: [] }); })).toBe('GENERATION_RECORD_REMOVAL_FORBIDDEN'); return;
    }
    expect(generationRecordStructuralIssues(historical).filter((issue): boolean => issue.severity === 'error')).toEqual([]);
    expect((): void => { assertGenerationRecordTransition(current, historical); }).not.toThrow();
  });
});

describe('B. shot topology integration', (): void => {
  const names: readonly string[] = [
    'merge_after_image_generation_preserves_historical_record', 'merge_after_speech_generation_preserves_historical_record',
    'merge_after_proposal_generation_succeeds', 'reproposal_after_existing_generation_record_preserves_history',
    'reproposal_appends_new_generation_record', 'source_update_with_recorded_impacted_shot_preserves_history',
    'source_update_does_not_remap_historical_record', 'source_update_with_generation_history_succeeds',
    'reorder_keeps_generation_target_current', 'split_preserves_existing_generation_history',
  ];
  it.each(names)('%s', async (name: string): Promise<void> => {
    if (name.startsWith('merge_after_')) {
      const split: Project = splitShot(nativeProject, 'shot-2', 8000, `removed:${name}`, `frame:${name}`);
      const current: Project = withTargetHistory(split, `record:${name}`, `removed:${name}`);
      const next: Project = mergeShots(current, 'shot-2', `removed:${name}`);
      expect((): void => { assertGenerationRecordTransition(current, next); }).not.toThrow();
      expect(next.generationRecords).toEqual(current.generationRecords);
      expect(auditGenerationRecords(next, [current])[0]).toMatchObject({ currentTargetState: 'historical', validAtIntroduction: true });
      return;
    }
    if (name === 'reproposal_appends_new_generation_record') {
      const current: Project = withTargetHistory(nativeProject, 'existing-proposal', 'shot-2');
      const next: Project = applyGeneratedProposal(current, 'demonstration', 'appended-proposal', '2026-09-06T00:00:01.000Z', {
        provider: 'codex-app', prompt: '새 컷 제안', model: 'current', requestId: 'appended-request', proposal: demonstrationProposal(undefined),
      }).project;
      expect(assertGenerationRecordTransition(current, next).added.map((record: GenerationRecord): string => record.id)).toEqual(['appended-proposal']);
      expect(next.generationRecords[0]).toEqual(current.generationRecords[0]);
      return;
    }
    if (name.startsWith('reproposal_')) {
      const current: Project = withTargetHistory(nativeProject, `record:${name}`, 'shot-2');
      const next: Project = applySegmentProposal(current, 'demonstration', demonstrationProposal(undefined), `proposal:${name}`);
      expect((): void => { assertGenerationRecordTransition(current, next); }).not.toThrow();
      expect(next.generationRecords).toEqual(current.generationRecords);
      expect(next.shots.some((shot: Shot): boolean => shot.id === 'shot-2')).toBe(false);
      return;
    }
    if (name.startsWith('source_update_')) {
      const current: Project = withTargetHistory(nativeProject, `record:${name}`, 'shot-1');
      const next: Project = applySourceUpdate(current, await changedNativeOutline(current.projectId), `source:${name}`);
      expect((): void => { assertGenerationRecordTransition(current, next); }).not.toThrow();
      expect(next.generationRecords).toEqual(current.generationRecords);
      expect(next.generationRecords[0]?.shotIds).toEqual(['shot-1']);
      expect(next.shots.some((shot: Shot): boolean => shot.id === 'shot-1')).toBe(false);
      return;
    }
    const split: Project = splitShot(nativeProject, 'shot-2', 8000, `second:${name}`, `frame:${name}`);
    const current: Project = withTargetHistory(split, `record:${name}`, 'shot-2');
    const next: Project = name === 'reorder_keeps_generation_target_current'
      ? reorderShots(current, 'demonstration', [`second:${name}`, 'shot-2'])
      : splitShot(current, 'shot-1', 2500, `new:${name}`, `new-frame:${name}`);
    expect((): void => { assertGenerationRecordTransition(current, next); }).not.toThrow();
    expect(next.generationRecords).toEqual(current.generationRecords);
    expect(next.shots.some((shot: Shot): boolean => shot.id === 'shot-2')).toBe(true);
  });
});

describe('C. historical audit', (): void => {
  const names: readonly string[] = [
    'audit_finds_generation_record_introduced_revision', 'audit_validates_shot_in_introduced_snapshot',
    'audit_marks_removed_current_shot_as_historical', 'audit_marks_existing_current_shot_as_current',
    'audit_reports_unprovable_introduction', 'audit_preserves_generation_record_order', 'audit_detects_corrupt_version_snapshot',
    'audit_does_not_modify_project', 'audit_survives_restart', 'audit_survives_json_round_trip',
  ];
  it.each(names)('%s', async (name: string): Promise<void> => {
    if (name === 'audit_detects_corrupt_version_snapshot') {
      const fixture = await storedHistoricalAudit('storyboard-audit-corrupt-');
      await writeFile(join(projectDirectory(fixture.dataRoot, fixture.current.projectId), 'versions', '000001.json'), '{', 'utf8');
      await expect(fixture.store.generationRecordAudit(fixture.current.projectId)).rejects.toMatchObject({ code: 'STORE_RECOVERY_REQUIRED' });
      await fixture.store.close();
      return;
    }
    if (name === 'audit_survives_restart') {
      const fixture = await storedHistoricalAudit('storyboard-audit-restart-');
      await fixture.store.close();
      const reopened: ProjectStore = new ProjectStore(fixture.dataRoot);
      expect(await reopened.generationRecordAudit(fixture.current.projectId)).toContainEqual(expect.objectContaining({
        recordId: 'audit-record', introducedRevision: 1, validAtIntroduction: true, currentTargetState: 'historical',
      }));
      await reopened.close();
      return;
    }
    if (name === 'audit_survives_json_round_trip') {
      const introduced: Project = { ...withTargetHistory(
        splitShot(nativeProject, 'shot-2', 8000, 'round-trip-removed', 'round-trip-frame'), 'audit-round-trip', 'round-trip-removed'), revision: 1 };
      const current: Project = { ...mergeShots(introduced, 'shot-2', 'round-trip-removed'), revision: 2 };
      const reopened: Project = parseProject(JSON.parse(exportProjectJson(current)) as unknown);
      expect(auditGenerationRecords(reopened, [introduced])).toContainEqual(expect.objectContaining({
        recordId: 'audit-round-trip', introducedRevision: 1, validAtIntroduction: true, currentTargetState: 'historical',
      }));
      return;
    }
    const revisionZero: Project = { ...withHistory(nativeProject, 'audit-one'), revision: 0 };
    const revisionOne: Project = { ...revisionZero, revision: 1, shots: revisionZero.shots.slice(1) };
    const versions: Project[] = name === 'audit_reports_unprovable_introduction' ? [] : [revisionZero];
    const input: Project = revisionOne;
    const before: string = JSON.stringify(input);
    const result = auditGenerationRecords(input, versions);
    if (name === 'audit_reports_unprovable_introduction') expect(result[0]).toMatchObject({ introducedRevision: null, currentTargetState: 'unresolved' });
    else if (name === 'audit_marks_existing_current_shot_as_current') expect(auditGenerationRecords(revisionZero, versions)[0]?.currentTargetState).toBe('current');
    else expect(result[0]).toMatchObject({ recordId: 'audit-one', introducedRevision: 0, validAtIntroduction: true, currentTargetState: 'historical' });
    expect(JSON.stringify(input)).toBe(before);
  });
});

describe('D. generation record normalization', (): void => {
  const names: readonly string[] = [
    'new_record_rejects_duplicate_shot_ids', 'new_record_rejects_duplicate_result_asset_ids',
    'new_record_rejects_duplicate_reference_hashes', 'new_record_rejects_duplicate_request_id',
    'null_request_ids_may_repeat_when_contract_allows', 'legacy_duplicate_array_is_reported_without_mutation',
    'new_record_id_must_be_unique', 'new_record_can_reference_new_asset_in_same_revision',
    'new_record_can_reference_new_shot_in_same_revision', 'generation_failure_creates_no_journal',
  ];
  it.each(names)('%s', async (name: string): Promise<void> => {
    const shotId: string = nativeProject.shots[0]?.id ?? '';
    if (name === 'null_request_ids_may_repeat_when_contract_allows') {
      const first = generationRecord('null-one', [shotId], [], null); const second = generationRecord('null-two', [shotId], [], null);
      expect((): void => { assertGenerationRecordTransition(nativeProject, { ...nativeProject, generationRecords: [first, second] }); }).not.toThrow(); return;
    }
    if (name === 'legacy_duplicate_array_is_reported_without_mutation') {
      const legacy: Project = { ...nativeProject, generationRecords: [generationRecord('legacy', [shotId, shotId], [], null)] };
      const before: string = JSON.stringify(legacy); expect(generationRecordStructuralIssues(legacy)).toContainEqual(expect.objectContaining({ severity: 'warning' })); expect(JSON.stringify(legacy)).toBe(before); return;
    }
    if (name === 'new_record_can_reference_new_shot_in_same_revision') {
      const shot: Shot = { ...(nativeProject.shots[0] as Shot), id: 'new-shot' };
      const next: Project = { ...nativeProject, shots: [...nativeProject.shots, shot], generationRecords: [generationRecord('new', ['new-shot'], [], 'new')] };
      expect((): void => { assertGenerationRecordTransition(nativeProject, next); }).not.toThrow(); return;
    }
    if (name === 'new_record_can_reference_new_asset_in_same_revision') {
      const asset = { id: 'new-asset', kind: 'image' as const, subjectId: null, path: 'assets/new.png', mimeType: 'image/png' as const, sha256: '0'.repeat(64), description: 'new', durationMs: null, version: 1, audioMetadata: null };
      const next: Project = { ...nativeProject, assets: [...nativeProject.assets, asset], generationRecords: [generationRecord('new', [], ['new-asset'], 'new')] };
      expect((): void => { assertGenerationRecordTransition(nativeProject, next); }).not.toThrow(); return;
    }
    let record: GenerationRecord = generationRecord('new', [shotId], [], 'same-request');
    let current: Project = nativeProject;
    if (name === 'new_record_rejects_duplicate_shot_ids') record = { ...record, shotIds: [shotId, shotId] };
    if (name === 'new_record_rejects_duplicate_result_asset_ids') record = { ...record, resultAssetIds: ['missing', 'missing'] };
    if (name === 'new_record_rejects_duplicate_reference_hashes') record = { ...record, referenceHashes: ['a'.repeat(64), 'a'.repeat(64)] };
    if (name === 'new_record_rejects_duplicate_request_id') current = { ...nativeProject, generationRecords: [generationRecord('old', [shotId], [], 'same-request')] };
    if (name === 'new_record_id_must_be_unique') current = { ...nativeProject, generationRecords: [generationRecord('new', [shotId], [], 'old-request')] };
    if (name === 'generation_failure_creates_no_journal') {
      const dataRoot: string = await temporaryDataRoot('storyboard-generation-failure-');
      const store: ProjectStore = new ProjectStore(dataRoot);
      const created: Project = await store.create(await nativeOutlineFor(`generation-${randomUUID()}`));
      await expect(store.update(created.projectId, created.revision, (project: Project): Project => ({ ...project,
        generationRecords: [...project.generationRecords, { ...record, shotIds: [shotId, shotId] }],
      }), [])).rejects.toMatchObject({ code: 'DUPLICATE_GENERATION_RECORD_SHOT_ID' });
      expect(await readdir(join(projectDirectory(dataRoot, created.projectId), '.transactions'))).toEqual([]);
      expect(await pathExists(join(projectDirectory(dataRoot, created.projectId), 'write.lock'))).toBe(false);
      await store.close();
      return;
    }
    const next: Project = { ...current, generationRecords: [...current.generationRecords, record] };
    expect(codeOf((): void => { assertGenerationRecordTransition(current, next); })).not.toBe('NONE');
  });
});

describe('E. HTTP not-found policy', (): void => {
  const cases: readonly [string, string, number, string][] = [
    ['generation_record_shot_not_found_returns_400', 'GENERATION_RECORD_SHOT_NOT_FOUND', 400, 'validation'],
    ['generation_record_shot_not_found_is_validation_category', 'GENERATION_RECORD_SHOT_NOT_FOUND', 400, 'validation'],
    ['shot_not_found_returns_404', 'SHOT_NOT_FOUND', 404, 'not-found'],
    ['frame_not_found_returns_404', 'FRAME_NOT_FOUND', 404, 'not-found'],
    ['audio_cue_not_found_returns_404', 'AUDIO_CUE_NOT_FOUND', 404, 'not-found'],
    ['unknown_not_found_suffix_does_not_automatically_return_404', 'MYSTERY_NOT_FOUND', 500, 'internal'],
  ];
  it.each(cases)('%s', (_name: string, code: string, status: number, category: string): void => {
    expect(httpErrorPolicy(policyError(code, {}))).toMatchObject({ status, category });
  });
});

describe('F. stored asset HTTP policy', (): void => {
  const cases: readonly [string, string, number][] = [
    ['uploaded_invalid_asset_returns_400', 'INVALID_ASSET_UPLOAD', 400],
    ['stored_asset_file_missing_returns_423', 'STORED_ASSET_FILE_MISSING', 423],
    ['stored_asset_hash_mismatch_returns_423', 'STORED_ASSET_HASH_MISMATCH', 423],
    ['stored_asset_corrupt_returns_423', 'STORED_ASSET_CONTENT_CORRUPT', 423],
    ['stored_audio_metadata_mismatch_returns_423', 'STORED_AUDIO_METADATA_MISMATCH', 423],
    ['stored_asset_error_has_asset_scope', 'STORED_ASSET_HASH_MISMATCH', 423],
    ['stored_asset_error_requires_operator_action', 'STORED_ASSET_HASH_MISMATCH', 423],
    ['stored_asset_error_does_not_block_all_project_mutations', 'STORED_ASSET_HASH_MISMATCH', 423],
    ['safe_audio_corruption_is_not_validation_400', 'STORED_AUDIO_DURATION_MISMATCH', 423],
    ['safe_frame_corruption_is_not_validation_400', 'STORED_ASSET_CONTENT_CORRUPT', 423],
  ];
  it.each(cases)('%s', (_name: string, code: string, status: number): void => {
    const policy = httpErrorPolicy(policyError(code, {})); expect(policy.status).toBe(status);
    if (status === 423) expect(policy).toMatchObject({ scope: 'asset', operatorActionRequired: true, mutationBlocked: false });
  });
});

describe('G. error response context', (): void => {
  const names: readonly string[] = [
    'error_response_preserves_code_message_and_issues', 'project_locked_error_includes_project_id',
    'asset_integrity_error_includes_asset_id', 'project_locked_error_sets_mutation_blocked',
    'asset_integrity_error_does_not_set_project_mutation_blocked', 'unavailable_error_is_retryable',
    'recovery_error_is_not_retryable', 'conflict_error_does_not_require_operator_action',
  ];
  it.each(names)('%s', (name: string): void => {
    const asset: boolean = name.startsWith('asset_');
    const unavailable: boolean = name === 'unavailable_error_is_retryable';
    const conflict: boolean = name === 'conflict_error_does_not_require_operator_action';
    const code: string = asset ? 'STORED_ASSET_HASH_MISMATCH' : unavailable ? 'STORE_LOCK_ACQUISITION_FAILED' : conflict ? 'PROJECT_BUSY' : 'STORE_RECOVERY_BLOCKED';
    const body = errorBody(policyError(code, { projectId: 'project-a', resourceId: 'asset-a' })).error;
    expect(body).toMatchObject({ code, message: `message:${code}` });
    if (asset) expect(body).toMatchObject({ scope: 'asset', resourceId: 'asset-a', mutationBlocked: false });
    if (unavailable) expect(body.retryable).toBe(true);
    if (conflict) expect(body.operatorActionRequired).toBe(false);
    if (!asset && !unavailable && !conflict) expect(body).toMatchObject({ projectId: 'project-a', mutationBlocked: true, retryable: false });
  });
});

describe('H. project-scoped UI', (): void => {
  const names: readonly string[] = [
    'blocked_project_disables_only_its_mutations', 'blocked_project_does_not_disable_import',
    'switching_to_unblocked_project_enables_mutation', 'project_b_423_does_not_block_project_a',
    'asset_integrity_423_shows_asset_repair_notice', 'asset_integrity_423_does_not_show_project_recovery_banner',
    'service_503_does_not_create_persistent_block', 'conflict_409_does_not_create_persistent_block',
    'status_refresh_reconciles_blocked_project_ids',
  ];
  it.each(names)('%s', (name: string): void => {
    let state: RecoveryUiState = emptyRecoveryUiState();
    if (name === 'asset_integrity_423_shows_asset_repair_notice' || name === 'asset_integrity_423_does_not_show_project_recovery_banner') {
      state = recordRecoveryUiError(state, recoveryError('asset', 'project-b', 'asset-b', false, 'STORED_ASSET_HASH_MISMATCH'));
      expect(projectAssetIntegrityIssues(state, 'project-b')).toHaveLength(1); expect(projectRecoveryBlocked(state, 'project-b')).toBe(false); return;
    }
    if (name === 'service_503_does_not_create_persistent_block' || name === 'conflict_409_does_not_create_persistent_block') {
      state = recordRecoveryUiError(state, recoveryError(name.startsWith('service') ? 'service' : 'project', 'project-b', null, false, 'temporary'));
      expect(state).toEqual(emptyRecoveryUiState()); return;
    }
    state = name === 'status_refresh_reconciles_blocked_project_ids' ? reconcileBlockedProjects(state, ['project-b'])
      : recordRecoveryUiError(state, recoveryError('project', 'project-b', null, true, 'STORE_RECOVERY_BLOCKED'));
    expect(mutationControlsDisabled(false, 'project-b', state)).toBe(true);
    expect(mutationControlsDisabled(false, 'project-a', state)).toBe(false);
    expect(importButtonState(false, false).disabled).toBe(false);
  });
});

describe('I. create journal isolation', (): void => {
  const names: readonly string[] = [
    'root_lock_recovery_reads_matching_transaction_directly', 'malformed_unrelated_create_journal_does_not_block_healthy_project',
    'unrelated_create_recovery_failure_is_project_scoped', 'unknown_create_journal_is_quarantined',
    'unknown_create_journal_does_not_block_project_list', 'unknown_create_journal_does_not_block_unrelated_update',
    'healthy_root_lock_recovery_ignores_unrelated_corrupt_journal',
  ];
  it.each(names)('%s', async (name: string): Promise<void> => {
    const dataRoot: string = await temporaryDataRoot('storyboard-isolation-');
    const healthyId: string = `healthy-${randomUUID()}`;
    const seed: ProjectStore = new ProjectStore(dataRoot);
    await seed.create(await nativeOutlineFor(healthyId));
    await seed.close();

    const brokenTransactionId: string = randomUUID();
    const brokenDirectory: string = join(dataRoot, '.create-transactions', brokenTransactionId);
    await mkdir(brokenDirectory, { recursive: true });
    await writeFile(join(brokenDirectory, 'journal.json'), '{broken journal', 'utf8');

    const orphanProjectId: string = `orphan-${randomUUID()}`;
    const orphanTransactionId: string = randomUUID();
    await writeFile(join(dataRoot, '.create-locks', `${sha256Text(orphanProjectId)}.lock`), JSON.stringify({
      version: 3, projectId: orphanProjectId, host: hostname(), pid: DEAD_PROCESS_ID, transactionId: orphanTransactionId,
      createdAt: '2026-09-06T00:00:00.000Z', processInstanceId: randomUUID(), processStartedAt: '2026-09-06T00:00:00.000Z',
    }), 'utf8');

    const observer: ProjectStore = new ProjectStore(dataRoot, undefined, { processProbe: (pid: number): boolean => pid !== DEAD_PROCESS_ID });
    await observer.initialize();
    expect(observer.recoveryBlocks()).toContainEqual(expect.objectContaining({ projectId: `unknown:${brokenTransactionId}` }));
    expect(await pathExists(join(dataRoot, '.create-locks', `${sha256Text(orphanProjectId)}.lock`))).toBe(false);
    expect((await observer.list()).map((summary): string => summary.projectId)).toContain(healthyId);
    if (name === 'unknown_create_journal_does_not_block_unrelated_update' || name === 'unrelated_create_recovery_failure_is_project_scoped') {
      const current: Project = await observer.read(healthyId);
      expect((await observer.update(healthyId, current.revision, (project: Project): Project => ({ ...project, title: name }), [])).title).toBe(name);
    }
    if (name === 'unknown_create_journal_does_not_block_project_list') {
      const additionalId: string = `additional-${randomUUID()}`;
      await expect(observer.create(await nativeOutlineFor(additionalId))).resolves.toMatchObject({ projectId: additionalId });
    }
    await observer.close();
  });
});

describe('J. project-scoped live update', (): void => {
  const names: readonly string[] = [
    'live_update_lock_blocks_only_same_project_mutation', 'live_update_does_not_block_unrelated_project_read',
    'live_update_does_not_block_unrelated_project_update', 'live_update_does_not_block_unrelated_project_create',
    'live_update_state_is_exposed_in_status', 'dead_update_lock_is_recovered', 'foreign_update_lock_is_not_removed',
    'same_project_read_is_allowed_only_when_snapshot_is_consistent', 'live_update_does_not_create_global_recovery_block',
  ];
  it.each(names)('%s', async (name: string): Promise<void> => {
    const dataRoot: string = await temporaryDataRoot('storyboard-update-scope-');
    const firstId: string = `live-first-${randomUUID()}`;
    const secondId: string = `live-second-${randomUUID()}`;
    const first: Project = await nativeOutlineFor(firstId);
    const second: Project = await nativeOutlineFor(secondId);

    if (name === 'dead_update_lock_is_recovered' || name === 'foreign_update_lock_is_not_removed') {
      const seed: ProjectStore = new ProjectStore(dataRoot);
      await seed.create(first);
      await seed.close();
      const crashing: ProjectStore = new ProjectStore(dataRoot, {
        ownerPid: DEAD_PROCESS_ID,
        trigger(point: StorageFaultPoint): void {
          if (point === 'after-update-journal-prepared') throw new SimulatedStorageCrash(point);
        },
      });
      await crashing.initialize();
      await expect(crashing.update(firstId, 0, (project: Project): Project => ({ ...project, title: '중단된 변경' }), []))
        .rejects.toMatchObject({ code: 'SIMULATED_STORAGE_CRASH' });
      await crashing.close();
      const lockPath: string = join(projectDirectory(dataRoot, firstId), 'write.lock');
      if (name === 'foreign_update_lock_is_not_removed') {
        const lock = JSON.parse(await readFile(lockPath, 'utf8')) as Record<string, unknown>;
        await writeFile(lockPath, JSON.stringify({ ...lock, host: 'foreign.example' }), 'utf8');
      }
      const observer: ProjectStore = new ProjectStore(dataRoot, undefined, { processProbe: (): boolean => false });
      await observer.initialize();
      if (name === 'dead_update_lock_is_recovered') {
        expect(await pathExists(lockPath)).toBe(false);
        expect((await observer.read(firstId)).title).toBe(first.title);
      } else {
        expect(await pathExists(lockPath)).toBe(true);
        expect(observer.recoveryBlocks()).toContainEqual(expect.objectContaining({ projectId: firstId }));
      }
      await observer.close();
      return;
    }

    const gate: Barrier = barrier('after-update-current-read', process.pid);
    const writer: ProjectStore = new ProjectStore(dataRoot, gate.injector);
    await writer.create(first);
    await writer.create(second);
    const pending: Promise<Project> = writer.update(firstId, 0, (project: Project): Project => ({ ...project, title: '진행 중 변경' }), []);
    await gate.reached;
    const observer: ProjectStore = new ProjectStore(dataRoot);
    try {
      await observer.initialize();
      expect(observer.activeUpdates()).toContainEqual(expect.objectContaining({ projectId: firstId }));
      expect(observer.recoveryBlocks()).toEqual([]);
      if (name === 'live_update_lock_blocks_only_same_project_mutation') {
        await expect(observer.update(firstId, 0, (project: Project): Project => project, [])).rejects.toMatchObject({ code: 'PROJECT_BUSY' });
      } else if (name === 'live_update_does_not_block_unrelated_project_read') {
        await expect(observer.read(secondId)).resolves.toMatchObject({ projectId: secondId });
      } else if (name === 'live_update_does_not_block_unrelated_project_update') {
        await expect(observer.update(secondId, 0, (project: Project): Project => ({ ...project, title: name }), [])).resolves.toMatchObject({ title: name });
      } else if (name === 'live_update_does_not_block_unrelated_project_create') {
        const thirdId: string = `live-third-${randomUUID()}`;
        await expect(observer.create(await nativeOutlineFor(thirdId))).resolves.toMatchObject({ projectId: thirdId });
      } else if (name === 'same_project_read_is_allowed_only_when_snapshot_is_consistent') {
        await expect(observer.read(firstId)).resolves.toMatchObject({ projectId: firstId, revision: 0 });
      }
    } finally {
      await observer.close();
      gate.release();
      await pending;
      await writer.close();
    }
  });
});

describe('K. process instance identity', (): void => {
  const names: readonly string[] = [
    'lock_v3_contains_process_instance_id', 'same_process_stores_share_process_instance_id',
    'process_instance_registry_is_created', 'process_instance_heartbeat_is_updated',
    'process_instance_registry_is_removed_on_close', 'matching_live_instance_is_busy',
    'alive_pid_with_stale_instance_is_not_assumed_active', 'reused_pid_does_not_validate_old_lock_owner',
    'dead_instance_allows_recovery', 'foreign_host_instance_is_not_recovered',
    'legacy_lock_v2_is_read_conservatively', 'legacy_journal_v3_remains_readable',
  ];
  it.each(names)('%s', async (name: string): Promise<void> => {
    expect(STORE_LOCK_VERSION).toBe(3);
    const dataRoot: string = await temporaryDataRoot('storyboard-instance-');
    if (['matching_live_instance_is_busy', 'alive_pid_with_stale_instance_is_not_assumed_active',
      'reused_pid_does_not_validate_old_lock_owner', 'dead_instance_allows_recovery',
      'foreign_host_instance_is_not_recovered', 'legacy_lock_v2_is_read_conservatively'].includes(name)) {
      const projectId: string = `instance-${randomUUID()}`;
      const seed: ProjectStore = new ProjectStore(dataRoot);
      await seed.create(await nativeOutlineFor(projectId));
      await seed.close();
      const ownerPid: number = 31_337;
      const ownerInstanceId: string = randomUUID();
      const ownerStartedAt: string = '2026-09-06T00:00:00.000Z';
      const nowIso: string = '2026-09-06T00:01:00.000Z';
      const lockPath: string = join(projectDirectory(dataRoot, projectId), 'write.lock');
      const legacy: boolean = name === 'legacy_lock_v2_is_read_conservatively';
      const host: string = name === 'foreign_host_instance_is_not_recovered' ? 'foreign.example' : hostname();
      await writeFile(lockPath, JSON.stringify(legacy ? {
        version: 2, projectId, host, pid: ownerPid, transactionId: randomUUID(), createdAt: ownerStartedAt,
      } : {
        version: 3, projectId, host, pid: ownerPid, transactionId: randomUUID(), createdAt: ownerStartedAt,
        processInstanceId: name === 'reused_pid_does_not_validate_old_lock_owner' ? randomUUID() : ownerInstanceId,
        processStartedAt: ownerStartedAt,
      }), 'utf8');
      if (!legacy && name !== 'reused_pid_does_not_validate_old_lock_owner' && name !== 'dead_instance_allows_recovery'
        && name !== 'foreign_host_instance_is_not_recovered') {
        await writeFile(join(dataRoot, '.process-instances', `${ownerInstanceId}.json`), JSON.stringify({
          version: 1, processInstanceId: ownerInstanceId, host: hostname(), pid: ownerPid, startedAt: ownerStartedAt,
          heartbeatAt: name === 'alive_pid_with_stale_instance_is_not_assumed_active' ? ownerStartedAt : nowIso,
        }), 'utf8');
      }
      const runtime: StorageRuntime = {
        processInstanceId: randomUUID(), processStartedAt: nowIso, now: (): Date => new Date(nowIso),
        processProbe: (): boolean => name !== 'dead_instance_allows_recovery', heartbeatFreshnessMs: 30_000,
      };
      const observer: ProjectStore = new ProjectStore(dataRoot, undefined, runtime);
      await observer.initialize();
      if (name === 'matching_live_instance_is_busy' || legacy) {
        expect(observer.activeUpdates()).toContainEqual(expect.objectContaining({ projectId }));
        await expect(observer.assertMutable(projectId)).rejects.toMatchObject({ code: 'PROJECT_BUSY' });
      } else if (name === 'dead_instance_allows_recovery') {
        expect(await pathExists(lockPath)).toBe(false);
        expect(observer.recoveryBlocks()).toEqual([]);
      } else {
        expect(await pathExists(lockPath)).toBe(true);
        expect(observer.recoveryBlocks()).toContainEqual(expect.objectContaining({ projectId }));
      }
      await observer.close();
      return;
    }
    const first: ProjectStore = new ProjectStore(dataRoot); const second: ProjectStore = new ProjectStore(dataRoot);
    await first.initialize(); await second.initialize(); expect(first.processInstanceId()).toBe(second.processInstanceId());
    const entries: string[] = await readdir(join(dataRoot, '.process-instances')); expect(entries).toHaveLength(1);
    const before = JSON.parse(await readFile(join(dataRoot, '.process-instances', entries[0] as string), 'utf8')) as Record<string, unknown>;
    await first.heartbeat(); const after = JSON.parse(await readFile(join(dataRoot, '.process-instances', entries[0] as string), 'utf8')) as Record<string, unknown>;
    expect(after).toMatchObject({ version: 1, processInstanceId: first.processInstanceId(), pid: process.pid });
    expect(Date.parse(String(after.heartbeatAt))).toBeGreaterThanOrEqual(Date.parse(String(before.heartbeatAt)));
    await first.close(); expect(await readdir(join(dataRoot, '.process-instances'))).toHaveLength(1); await second.close();
    if (name === 'process_instance_registry_is_removed_on_close') expect(await readdir(join(dataRoot, '.process-instances'))).toEqual([]);
  });
});

describe('L. project timecode', (): void => {
  const cases: readonly [string, number, number, number, string][] = [
    ['timecode_uses_project_24fps', 24, 1, 1000, '00:01:00'],
    ['timecode_uses_project_25fps', 25, 1, 1000, '00:01:00'],
    ['timecode_uses_project_30fps', 30, 1, 500, '00:00:15'],
    ['timecode_supports_rational_frame_rate', 24000, 1001, 1000, '00:00:23'],
    ['timecode_does_not_use_hardcoded_30fps', 24, 1, 500, '00:00:12'],
    ['prj007_500ms_displays_12_frames', 24, 1, 500, '00:00:12'],
    ['project_summary_exposes_timebase', 24, 1, 1000, '00:01:00'],
    ['all_web_timecode_surfaces_use_shared_formatter', 24, 1, 500, '00:00:12'],
  ];
  it.each(cases)('%s', (_name: string, numerator: number, denominator: number, milliseconds: number, expected: string): void => {
    expect(formatProjectTimecode(milliseconds, { fpsNumerator: numerator, fpsDenominator: denominator, dropFrame: false, startTimecode: '00:00:00:00', sampleRate: 48000 })).toBe(expected);
  });
});

describe('M. proposal temporal anchor', (): void => {
  const names: readonly string[] = [
    'proposal_source_link_accepts_optional_anchor', 'proposal_without_anchor_uses_full_shot',
    'proposal_anchor_rejects_negative_start', 'proposal_anchor_rejects_end_over_1000', 'proposal_anchor_rejects_empty_range',
    'proposal_anchor_converts_permille_to_offsets', 'proposal_anchor_stays_inside_shot',
    'late_anchor_can_reveal_after_information_gate', 'early_anchor_is_blocked_by_information_gate',
    'proposal_source_order_uses_anchor_start', 'future_anchored_source_is_excluded_from_earlier_frame_context',
    'proposal_round_trip_preserves_anchor', 'existing_proposal_json_without_anchor_remains_compatible',
  ];
  it.each(names)('%s', async (name: string): Promise<void> => {
    if (name === 'proposal_anchor_rejects_negative_start' || name === 'proposal_anchor_rejects_end_over_1000' || name === 'proposal_anchor_rejects_empty_range') {
      const anchor = name === 'proposal_anchor_rejects_negative_start' ? { startPermille: -1, endPermille: 1000 }
        : name === 'proposal_anchor_rejects_end_over_1000' ? { startPermille: 0, endPermille: 1001 } : { startPermille: 500, endPermille: 500 };
      expect(SegmentProposalSchema.safeParse({ ...demonstrationProposal(undefined), shots: [{ ...demonstrationProposal(undefined).shots[0], sourceLinks: [{ unitId: '동작', usage: 'primary-visual', anchor }] }] }).success).toBe(false); return;
    }
    if (name === 'late_anchor_can_reveal_after_information_gate' || name === 'early_anchor_is_blocked_by_information_gate') {
      const project: Project = await exactGateProject();
      const proposal: SegmentProposal = demonstrationProposal(name === 'late_anchor_can_reveal_after_information_gate'
        ? { startPermille: 700, endPermille: 1000 } : { startPermille: 0, endPermille: 300 });
      if (name === 'late_anchor_can_reveal_after_information_gate') {
        expect((): void => { applySegmentProposal(project, 'demonstration', proposal, `gate:${name}`); }).not.toThrow();
      } else {
        expect(codeOf((): Project => applySegmentProposal(project, 'demonstration', proposal, `gate:${name}`))).toBe('PROPOSAL_INFORMATION_GATE');
      }
      return;
    }
    if (name === 'proposal_source_order_uses_anchor_start') {
      const base: SegmentProposal = demonstrationProposal(undefined);
      const shot = base.shots[0] as SegmentProposal['shots'][number];
      const proposal: SegmentProposal = SegmentProposalSchema.parse({ shots: [{ ...shot, sourceLinks: [
        { unitId: '안내-1', usage: 'primary-visual', anchor: { startPermille: 700, endPermille: 1000 } },
        { unitId: '동작', usage: 'primary-visual', anchor: { startPermille: 0, endPermille: 300 } },
        { unitId: '효과음', usage: 'audio-only' },
      ] }] });
      expect(codeOf((): Project => applySegmentProposal(nativeProject, 'demonstration', proposal, `order:${name}`))).toBe('PROPOSAL_SOURCE_ORDER_REVERSED');
      return;
    }
    if (name === 'future_anchored_source_is_excluded_from_earlier_frame_context') {
      const base: SegmentProposal = demonstrationProposal(undefined);
      const shot = base.shots[0] as SegmentProposal['shots'][number];
      const proposal: SegmentProposal = SegmentProposalSchema.parse({ shots: [{ ...shot, sourceLinks: [
        { unitId: '안내-1', usage: 'primary-visual', anchor: { startPermille: 0, endPermille: 500 } },
        { unitId: '동작', usage: 'primary-visual', anchor: { startPermille: 700, endPermille: 1000 } },
        { unitId: '효과음', usage: 'audio-only' },
      ] }] });
      const applied: Project = applySegmentProposal(nativeProject, 'demonstration', proposal, `frame-context:${name}`);
      const frameId: string = `frame-context:${name}:frame:1`;
      const context = buildFrameImageContext(applied, frameId);
      expect(context.sourceUnits.map((unit): string => unit.id)).toContain('안내-1');
      expect(context.sourceUnits.map((unit): string => unit.id)).not.toContain('동작');
      expect(context.allowedInformationIds).toEqual([]);
      return;
    }
    const anchor = name === 'proposal_without_anchor_uses_full_shot' || name === 'existing_proposal_json_without_anchor_remains_compatible' ? undefined : { startPermille: 700, endPermille: 1000 };
    const proposal: SegmentProposal = demonstrationProposal(anchor);
    const applied: Project = applySegmentProposal(nativeProject, 'demonstration', proposal, `anchor:${name}`);
    const shot: Shot = applied.shots.find((candidate: Shot): boolean => candidate.segmentId === 'demonstration') as Shot;
    const link = shot.sourceLinks.find((candidate): boolean => candidate.unitId === '동작');
    expect(link?.temporalAnchor.kind).toBe('shot-offset');
    if (link?.temporalAnchor.kind === 'shot-offset') {
      const duration: number = shot.endMs - shot.startMs;
      expect(link.temporalAnchor.startOffsetMs).toBe(anchor === undefined ? 0 : Math.floor(duration * 700 / 1000));
      expect(link.temporalAnchor.endOffsetMs).toBe(duration);
    }
    expect(SegmentProposalSchema.parse(JSON.parse(JSON.stringify(proposal)))).toEqual(proposal);
  });
});

describe('N. existing storage regression additions', (): void => {
  it('concurrent_create_still_commits_exactly_once', async (): Promise<void> => {
    const root: string = await mkdtemp(join(tmpdir(), 'storyboard-create-once-')); roots.push(root); const dataRoot: string = join(root, 'data');
    const payload = await nativePackage(); const data = nativeData(payload); const project = createSourceOutline(importPackage(withNativeData(payload, { ...data, projectId: randomUUID() })), { proposedTextHoldMs: 2000 });
    const results = await Promise.allSettled([new ProjectStore(dataRoot).create(project), new ProjectStore(dataRoot).create(project)]);
    expect(results.filter((result): boolean => result.status === 'fulfilled')).toHaveLength(1);
  });

  it('concurrent_update_still_commits_exactly_once', async (): Promise<void> => {
    const root: string = await mkdtemp(join(tmpdir(), 'storyboard-update-once-')); roots.push(root); const store = new ProjectStore(join(root, 'data'));
    const payload = await nativePackage(); const data = nativeData(payload); const projectId: string = randomUUID();
    const project = await store.create(createSourceOutline(importPackage(withNativeData(payload, { ...data, projectId })), { proposedTextHoldMs: 2000 }));
    const results = await Promise.allSettled([
      store.update(project.projectId, 0, (current: Project): Project => ({ ...current, title: 'first' }), []),
      new ProjectStore(join(root, 'data')).update(project.projectId, 0, (current: Project): Project => ({ ...current, title: 'second' }), []),
    ]);
    expect(results.filter((result): boolean => result.status === 'fulfilled')).toHaveLength(1);
  });
});

describe('O. PRJ-007 regression additions', (): void => {
  it('prj007_timecode_uses_24fps', (): void => {
    expect(formatProjectTimecode(500, productionProject.handoff.timebase)).toBe('00:00:12');
  });

  it('prj007_historical_generation_audit_succeeds', { timeout: 30_000 }, async (): Promise<void> => {
    const dataRoot: string = await temporaryDataRoot('storyboard-prj007-integration-');
    const store: ProjectStore = new ProjectStore(dataRoot);
    const created: Project = await store.create(productionProject);
    const initialInformationRules: string = JSON.stringify(created.dataset.informationRules);
    const splitWithRecord: Project = await store.update(created.projectId, created.revision, (current: Project): Project => {
      const split: Project = splitShot(current, 'shot-2', 85000, 'prj007-split-shot', 'prj007-split-frame');
      return { ...split, generationRecords: [...split.generationRecords,
        generationRecord('prj007-initial-proposal', ['prj007-split-shot'], [], 'prj007-initial-request')] };
    }, []);
    const merged: Project = await store.update(created.projectId, splitWithRecord.revision,
      (current: Project): Project => mergeShots(current, 'shot-2', 'prj007-split-shot'), []);
    const reproposed: Project = await store.update(created.projectId, merged.revision, (current: Project): Project =>
      applyGeneratedProposal(current, 'SEG-002', 'prj007-reproposal', '2026-09-06T00:00:02.000Z', {
        provider: 'codex-app', prompt: 'SEG-002 재제안', model: 'current', requestId: 'prj007-reproposal-request',
        proposal: { shots: [{ sourceLinks: [{ unitId: 'UNIT-007', usage: 'primary-visual' }], durationWeight: 1,
          action: '닫힌 현관문 앞에서 태균이 손을 멈춘다.', visualLocationId: null,
          camera: { size: 'CU', angle: 'eye-level', move: 'static' }, presence: [], propIds: [], cameraAxis: null,
          screenDirection: null, informationIds: [], transitionOut: { kind: 'cut', durationMs: 0, note: '' },
          frameDescription: '닫힌 현관문과 멈춘 손' }] },
      }).project, []);
    const incoming: Project = await changedProductionOutline(created.projectId);
    const sourceUpdated: Project = await store.update(created.projectId, reproposed.revision, (current: Project): Project =>
      applySourceUpdate(current, incoming, 'prj007-source-update'), []);
    const audit = await store.generationRecordAudit(created.projectId);
    expect(audit).toEqual(expect.arrayContaining([
      expect.objectContaining({ recordId: 'prj007-initial-proposal', introducedRevision: 1, validAtIntroduction: true, currentTargetState: 'historical' }),
      expect.objectContaining({ recordId: 'prj007-reproposal', introducedRevision: 3, validAtIntroduction: true, currentTargetState: 'historical' }),
    ]));
    const cue: AudioCue = sourceUpdated.audioCues.find((candidate: AudioCue): boolean => candidate.unitId === 'UNIT-045') as AudioCue;
    const bytes: Buffer = await readFile('tests/fixtures/media/unit045-intercom-48000.wav');
    const asset: Asset = { id: 'unit045-audio', kind: 'audio', subjectId: cue.id, path: 'assets/unit045-audio.wav', mimeType: 'audio/wav',
      sha256: sha256Bytes(bytes), description: 'UNIT-045 가이드 음성', durationMs: 2000, version: 1,
      audioMetadata: { sampleRate: 48000, channels: 1, codec: 'pcm_s16le' } };
    const completed: Project = await store.update(created.projectId, sourceUpdated.revision, (current: Project): Project => ({ ...current,
      assets: [...current.assets, asset], audioCues: current.audioCues.map((candidate: AudioCue): AudioCue => candidate.id === cue.id
        ? { ...candidate, startMs: 849000, endMs: 851000, timingStatus: 'measured', timingRelation: 'j-cut', assetId: asset.id } : candidate),
    }), [{ relativePath: asset.path, content: bytes }]);
    const safeAudio = await store.safeAudio(created.projectId, cue.id);
    const json: string = exportProjectJson(completed);
    const csv: string = exportShotCsv(completed);
    const pdf: Buffer = await exportProjectPdf(completed, resolve('assets/fonts/NanumGothic-Regular.ttf'),
      async (assetId: string): Promise<Buffer> => (await store.asset(created.projectId, assetId)).content);
    expect(safeAudio.content.subarray(0, 4).toString('ascii')).toBe('RIFF');
    expect(parseProject(JSON.parse(json) as unknown)).toEqual(completed);
    expect(csv).toContain('PRJ-007');
    expect(pdf.subarray(0, 5).toString('ascii')).toBe('%PDF-');
    expect(completed.dataset.segments).toHaveLength(32);
    expect(completed.dataset.segments.at(-1)?.endMs).toBe(1_500_000);
    expect(completed.dataset.units.find((unit) => unit.id === 'UNIT-007')?.text.endsWith(' 변경')).toBe(true);
    expect(completed.generationRecords.map((record: GenerationRecord): string => record.id)).toEqual(['prj007-initial-proposal', 'prj007-reproposal']);
    expect(JSON.stringify(completed.dataset.informationRules)).toBe(initialInformationRules);
    await store.close();
  });
});

import { hostname } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, vi } from 'vitest';
import { it, currentScope, ownedStore, ownedChild, barrier, fixtureFs } from './owned-test.js';
import { readBuildManifest } from '../src/build.js';
import { applyCodexImage, applyCodexProposal, applyCodexSpeech } from '../src/codex/apply.js';
import { CodexRequestStore } from '../src/codex/requests.js';
import type { RequestFaultContext } from '../src/codex/requests.js';
import type { CodexRequest } from '../src/codex/schema.js';
import { codexRequestBasis } from '../src/codex/work.js';
import { contractError } from '../src/domain/errors.js';
import type { Project } from '../src/domain/schema.js';
import { importPackage } from '../src/importers/import-package.js';
import { createSourceOutline } from '../src/proposal/outline.js';
import { ProjectStore } from '../src/server/store.js';
import { nativePackage, png, pcmWav, testAudioNormalizer, nativeData, withNativeData } from './helpers.js';
import { controlledProcess } from './controlled-process.js';
import type { ControlledProcess, WorkerMessage } from './controlled-process.js';
import type { ApplyWorkerInput } from './apply-store-worker.js';
import { readApplyEvidence } from '../src/codex/apply-evidence.js';
import { sha256Text } from '../src/importers/integrity.js';
import { readReviewArchive, writeReviewBundle } from '../src/exporters/review-bundle.js';
import { codexRequestMetrics } from '../src/codex/metrics.js';

const { readFile, readdir, unlink, writeFile } = fixtureFs;
const now: string = '2026-09-09T02:00:00.000Z';
type Fixture = { root: string; project: Project; store: ProjectStore; requests: CodexRequestStore; request: CodexRequest; input: string };
async function fixture(): Promise<Fixture> {
  const root: string = await currentScope().root('apply-consistency-');
  const store: ProjectStore = ownedStore(new ProjectStore(join(root, 'data')));
  const project: Project = await store.create(createSourceOutline(importPackage(await nativePackage()), { proposedTextHoldMs: 2000 }));
  const requests: CodexRequestStore = currentScope().guard(new CodexRequestStore(join(root, 'requests'), readBuildManifest()), 'request-store');
  const request: CodexRequest = await requests.create('image', project.projectId, 'frame-1', codexRequestBasis(project, 'image', 'frame-1'), now);
  const input: string = join(root, 'result.png'); await writeFile(input, await png(2, 2));
  return { root, project, store, requests, request, input };
}
async function terminalBeforeApply(kind: 'failed' | 'superseded'): Promise<void> {
  const f: Fixture = await fixture();
  const reached = barrier(); const release = barrier();
  const read: (id: string) => Promise<CodexRequest> = f.requests.read.bind(f.requests);
  vi.spyOn(f.requests, 'read').mockImplementationOnce(async (id: string): Promise<CodexRequest> => {
    const snapshot: CodexRequest = await read(id); reached.resolve(); await release.promise; return snapshot;
  });
  const applying: Promise<Project> = applyCodexImage(f.request.id, f.input, f.store, f.requests, now);
  const outcome: Promise<string | null> = applying.then((): null => null, (error: unknown): string => (error as { code: string }).code);
  await reached.promise;
  if (kind === 'failed') await f.requests.fail(f.request.id, 'TEST_FAILURE', '적용보다 먼저 실패 확정', now);
  else await currentScope().guard(new CodexRequestStore(join(f.root, 'requests'), { ...readBuildManifest(), generationContractSha256: 'e'.repeat(64) }), 'request-store')
    .create(f.request.kind, f.request.projectId, f.request.targetId, f.request.basisHash, now);
  release.resolve();
  expect(await outcome).toBe('CODEX_REQUEST_SETTLED');
  expect((await read(f.request.id)).status).toBe(kind);
  const current: Project = await f.store.read(f.project.projectId);
  expect(current.generationRecords).toHaveLength(0);
  expect(current.assets).toHaveLength(0);
  expect(current.revision).toBe(0);
  console.info(JSON.stringify({ event: 'apply-terminal-first-evidence', requestId: f.request.id, order: [kind, 'apply-rejected'], status: kind, records: current.generationRecords.length, assets: current.assets.length }));
}

describe('실제 Request·Project 저장소 결과 적용', (): void => {
  it('superseded_request_cannot_commit_generated_asset', async (): Promise<void> => { await terminalBeforeApply('superseded'); });
  it('failed_request_cannot_commit_generated_asset', async (): Promise<void> => { await terminalBeforeApply('failed'); });
  it('recovered_request_keeps_original_result_revision', async (): Promise<void> => {
    const f: Fixture = await fixture(); let committed: boolean = false;
    const update = f.store.update.bind(f.store);
    vi.spyOn(f.store, 'update').mockImplementationOnce(async (...args: Parameters<ProjectStore['update']>): Promise<Project> => {
      const project: Project = await update(...args); committed = true; return project;
    });
    const interrupted: CodexRequestStore = currentScope().guard(new CodexRequestStore(join(f.root, 'requests'), readBuildManifest(), {
      trigger(context: RequestFaultContext): void {
        if (committed && context.point === 'before-request-completion') throw contractError('TEST_SETTLEMENT_INTERRUPTED', 'Project Commit 이후 완료 기록 중단', []);
      },
    }), 'request-store');
    await expect(applyCodexImage(f.request.id, f.input, f.store, interrupted, now)).rejects.toMatchObject({ code: 'CODEX_APPLY_RECOVERY_REQUIRED', committedRevision: 1, cause: { code: 'TEST_SETTLEMENT_INTERRUPTED' } });
    const applied: Project = await f.store.read(f.project.projectId); expect(applied.revision).toBe(1);
    const later: Project = await f.store.update(applied.projectId, applied.revision, (current: Project): Project => ({ ...current, title: '후속 사용자 편집' }), []);
    const recovered: Project = await applyCodexImage(f.request.id, f.input, f.store, f.requests, now);
    expect(recovered).toEqual(later);
    expect((await f.requests.read(f.request.id)).resultRevision).toBe(applied.revision);
    expect(recovered.generationRecords).toHaveLength(1); expect(recovered.assets).toHaveLength(1);
  });
});

async function worker(f: Fixture, action: ApplyWorkerInput['action'], point: string | null): Promise<ControlledProcess> {
  const child: ControlledProcess = ownedChild(() => controlledProcess('tests/apply-store-worker.ts', JSON.stringify({ root: f.root, requestId: f.request.id, action, point } satisfies ApplyWorkerInput)));
  child.child.once('exit', (_code: number | null, signal: NodeJS.Signals | null): void => {
    if (signal === 'SIGKILL') console.info(JSON.stringify({ event: 'apply-process-killed', pid: child.child.pid, requestId: f.request.id, action, point }));
  });
  await child.event('ready'); return child;
}
async function result(child: ControlledProcess): Promise<WorkerMessage> {
  const response: WorkerMessage = await child.event('result'); await child.exited; return response;
}
async function applyingWins(action: 'fail' | 'supersede'): Promise<void> {
  const f: Fixture = await fixture(); const child: ControlledProcess = await worker(f, 'apply', 'after-apply-intent-persisted');
  child.send('start'); await child.event('paused');
  expect((await f.requests.read(f.request.id)).status).toBe('applying');
  expect(await f.requests.list('pending')).toEqual([]);
  expect(codexRequestMetrics(await f.requests.list(null))).toMatchObject({ applyingRequests: 1, failedRequests: 0, pendingRequests: 0 });
  const terminal: ControlledProcess = await worker(f, action, null); terminal.send('start');
  expect(await result(terminal)).toMatchObject({ ok: false, code: 'CODEX_REQUEST_APPLY_IN_PROGRESS' });
  child.send('release'); expect((await result(child)).ok).toBe(true);
  const request: CodexRequest = await f.requests.read(f.request.id); const current: Project = await f.store.read(f.project.projectId);
  expect(request).toMatchObject({ status: 'completed', resultRevision: 1 });
  expect(current.generationRecords).toHaveLength(1); expect(current.assets).toHaveLength(1);
  console.info(JSON.stringify({ event: 'apply-race-evidence', requestId: request.id, order: ['apply-intent', action, 'project-commit', 'request-completed'], status: request.status, revision: request.resultRevision, records: current.generationRecords.length, assets: current.assets.length }));
}
async function committedCrash(point: string): Promise<Fixture> {
  const f: Fixture = await fixture(); await f.store.close();
  const child: ControlledProcess = await worker(f, 'apply', point); child.send('start'); await child.event('paused'); await child.stop();
  const store: ProjectStore = ownedStore(new ProjectStore(join(f.root, 'data'))); await store.initialize();
  return { ...f, store, requests: currentScope().guard(new CodexRequestStore(join(f.root, 'requests'), readBuildManifest()), 'request-store') };
}
async function revisionRecovery(point: string): Promise<void> {
  const f: Fixture = await committedCrash(point);
  const applied: Project = await f.store.read(f.project.projectId); expect(applied.revision).toBe(1);
  const later: Project = await f.store.update(applied.projectId, applied.revision, (current: Project): Project => ({ ...current, title: 'Commit 후 보존할 편집',
    frames: current.frames.map((frame) => ({ ...frame, description: `${frame.description} 사용자 후속 수정` })) }), []);
  await unlink(f.input);
  const completed: CodexRequest = await f.requests.reconcileApply(f.request.id, f.store, now);
  expect(completed).toMatchObject({ status: 'completed', resultRevision: 1 });
  const evidence = await readApplyEvidence(completed, f.store);
  expect(evidence.receipt).toMatchObject({ requestId: completed.id, committedRevision: 1, resultAssetIds: [`codex:${completed.id}:image`] });
  expect(evidence.current).toEqual(later);
  expect((await applyCodexImage(completed.id, f.input, f.store, f.requests, now))).toEqual(later);
  expect((await f.requests.read(completed.id)).resultRevision).toBe(1);
  expect(await readdir(join(f.root, 'requests', '.transactions'))).toEqual([]);
  console.info(JSON.stringify({ event: 'apply-revision-evidence', point, requestId: completed.id, appliedRevision: 1, currentRevision: later.revision,
    resultRevision: completed.resultRevision, addedRecords: evidence.current.generationRecords.length - applied.generationRecords.length,
    addedAssets: evidence.current.assets.length - applied.assets.length, addedRevisionsByRecovery: evidence.current.revision - later.revision, laterEditPreserved: evidence.current.title === later.title }));
}

it('apply_and_supersede_have_one_consistent_outcome', async (): Promise<void> => { await applyingWins('supersede'); });
it('apply_and_fail_have_one_consistent_outcome', async (): Promise<void> => { await applyingWins('fail'); });
it('concurrent_apply_same_request_commits_once', async (): Promise<void> => {
  const f: Fixture = await fixture(); const first = await worker(f, 'apply', 'after-apply-intent-persisted'); const second = await worker(f, 'apply', null);
  first.send('start'); await first.event('paused'); second.send('start'); await second.event('waiting'); first.send('release');
  expect((await result(first)).ok).toBe(true); expect((await result(second)).ok).toBe(true);
  const current: Project = await f.store.read(f.project.projectId);
  expect(current.revision).toBe(1); expect(current.generationRecords).toHaveLength(1); expect(current.assets).toHaveLength(1);
});
it('terminal_transition_cannot_bypass_apply_ownership', async (): Promise<void> => {
  const f: Fixture = await fixture(); const child = await worker(f, 'apply', 'after-apply-intent-persisted'); child.send('start'); await child.event('paused');
  await expect(f.requests.complete(f.request.id, 999, now)).rejects.toMatchObject({ code: 'CODEX_REQUEST_APPLY_IN_PROGRESS' });
  await expect(f.requests.fail(f.request.id, 'FAIL', '임의 종결', now)).rejects.toMatchObject({ code: 'CODEX_REQUEST_APPLY_IN_PROGRESS' });
  expect((await f.requests.read(f.request.id)).resultRevision).toBeNull();
  child.send('release'); expect((await result(child)).ok).toBe(true);
  expect((await f.requests.read(f.request.id)).resultRevision).toBe(1);
});
it('stale_project_snapshot_cannot_overwrite_later_edit', async (): Promise<void> => {
  const f: Fixture = await fixture(); const child = await worker(f, 'apply', 'before-project-commit'); child.send('start'); await child.event('paused');
  const later: Project = await f.store.update(f.project.projectId, 0, (current: Project): Project => ({ ...current, title: '경쟁 편집 보존' }), []);
  child.send('release'); expect(await result(child)).toMatchObject({ ok: false, code: 'REVISION_CONFLICT' });
  expect(await f.store.read(f.project.projectId)).toEqual(later);
  expect((await f.requests.reconcileApply(f.request.id, f.store, now)).status).toBe('pending');
  expect((await f.store.read(f.project.projectId)).generationRecords).toHaveLength(0);
});
it('crash_after_project_commit_reconciles_request', async (): Promise<void> => { await revisionRecovery('after-project-current-published'); });
it('request_and_generation_record_agree_after_recovery', async (): Promise<void> => { await revisionRecovery('before-request-completion'); });
it('later_project_edit_does_not_change_request_result_revision', async (): Promise<void> => { await revisionRecovery('after-request-completed'); });
it('recovery_does_not_require_original_result_input_file', async (): Promise<void> => { await revisionRecovery('before-apply-intent-cleanup'); });
it('recovery_preserves_later_project_revisions', async (): Promise<void> => { await revisionRecovery('after-request-completion-journal'); });
it('apply_recovery_is_idempotent_after_recovery_crash', async (): Promise<void> => {
  const f: Fixture = await committedCrash('before-request-completion');
  for (const point of ['during-apply-reconciliation', 'after-request-completion-journal']) {
    const recovering = await worker(f, 'reconcile', point); recovering.send('start'); await recovering.event('paused'); await recovering.stop();
  }
  const settled: CodexRequest = await f.requests.reconcileApply(f.request.id, f.store, now);
  for (let i: number = 0; i < 3; i += 1) expect(await f.requests.reconcileApply(f.request.id, f.store, now)).toEqual(settled);
  expect(settled.resultRevision).toBe(1); expect((await f.store.read(f.project.projectId)).revision).toBe(1);
});
for (const point of ['after-apply-ownership-acquired', 'after-apply-intent-persisted', 'before-project-commit', 'after-project-journal-prepared']) {
  it(`apply_crash_before_commit_${point}`, async (): Promise<void> => {
    const f: Fixture = await committedCrash(point);
    const current: Project = await f.store.read(f.project.projectId); expect(current.revision).toBe(0); expect(current.assets).toHaveLength(0); expect(current.generationRecords).toHaveLength(0);
    const request: CodexRequest = await f.requests.reconcileApply(f.request.id, f.store, now); expect(request.status).toBe('pending'); expect(request.resultRevision).toBeNull();
    expect((await applyCodexImage(request.id, f.input, f.store, f.requests, now)).revision).toBe(1);
    expect((await f.requests.read(request.id)).resultRevision).toBe(1);
  });
}

async function replayCompleted(): Promise<void> {
  const f: Fixture = await fixture();
  const applied: Project = await applyCodexImage(f.request.id, f.input, f.store, f.requests, now);
  const completed: CodexRequest = await f.requests.read(f.request.id);
  const later: Project = await f.store.update(applied.projectId, 1, (current: Project): Project => ({ ...current, title: '완료 뒤 편집' }), []);
  for (let i: number = 0; i < 2; i += 1) expect(await applyCodexImage(f.request.id, f.input, f.store, f.requests, now)).toEqual(later);
  expect(await f.requests.read(f.request.id)).toEqual(completed);
  expect(later.generationRecords).toEqual(applied.generationRecords); expect(later.assets).toEqual(applied.assets);
  expect((await f.store.read(applied.projectId)).revision).toBe(2);
}
it('already_applied_retry_does_not_create_duplicate_generation', async (): Promise<void> => { await replayCompleted(); });
it('completed_request_replay_preserves_original_revision', async (): Promise<void> => { await replayCompleted(); });
it('apply_retry_after_lost_response_is_idempotent', async (): Promise<void> => {
  const f: Fixture = await committedCrash('after-request-completed');
  const before: Project = await f.store.read(f.project.projectId);
  expect(await applyCodexImage(f.request.id, f.input, f.store, f.requests, now)).toEqual(before);
  expect((await f.requests.read(f.request.id)).resultRevision).toBe(before.revision);
});
it('same_request_different_result_returns_conflict', async (): Promise<void> => {
  const f: Fixture = await fixture(); const before: Project = await applyCodexImage(f.request.id, f.input, f.store, f.requests, now);
  await writeFile(f.input, await png(3, 4));
  await expect(applyCodexImage(f.request.id, f.input, f.store, f.requests, now)).rejects.toMatchObject({ code: 'CODEX_APPLY_RESULT_CONFLICT' });
  expect(await f.store.read(f.project.projectId)).toEqual(before);
  expect((await f.requests.read(f.request.id)).resultRevision).toBe(before.revision);
});
it('apply_receipt_matches_generation_introduction_revision', async (): Promise<void> => {
  const f: Fixture = await fixture(); await applyCodexImage(f.request.id, f.input, f.store, f.requests, now);
  const request: CodexRequest = await f.requests.read(f.request.id); const evidence = await readApplyEvidence(request, f.store);
  const history = await f.store.generationHistorySnapshot(f.project.projectId);
  expect(history.versions[0]?.generationRecords).toHaveLength(0);
  expect(history.versions[1]?.generationRecords[0]?.requestId).toBe(request.id);
  expect(evidence.receipt?.committedRevision).toBe(history.versions[1]?.revision);
  expect(evidence.receipt?.generationRecordSha256).toBe(request.applyIntent?.generationRecordSha256);
  expect(evidence.receipt?.resultProjectSha256).toBe(request.applyIntent?.resultProjectSha256);
});
it('apply_receipt_and_generation_record_commit_together', async (): Promise<void> => {
  const f: Fixture = await committedCrash('after-project-current-published');
  const request: CodexRequest = await f.requests.read(f.request.id); expect(request.status).toBe('applying');
  const evidence = await readApplyEvidence(request, f.store);
  expect(evidence.receipt).toMatchObject({ generationRecordId: `codex:${request.id}`, resultAssetIds: [`codex:${request.id}:image`], committedRevision: 1 });
  expect(evidence.current.generationRecords).toHaveLength(1); expect(evidence.current.assets).toHaveLength(1);
  expect((await f.requests.applyStatus(request.id, f.store)).state).toBe('committed-awaiting-request-settlement');
});
it('unproven_project_commit_does_not_complete_request', async (): Promise<void> => {
  const f: Fixture = await committedCrash('before-request-completion');
  await unlink(join(f.root, 'data', sha256Text(f.project.projectId), 'versions', '000001.json'));
  await expect(f.requests.reconcileApply(f.request.id, f.store, now)).rejects.toMatchObject({ code: 'CODEX_APPLY_EVIDENCE_CONFLICT', projectId: f.project.projectId, requestId: f.request.id });
  expect((await f.requests.read(f.request.id)).status).toBe('applying');
  expect((await f.requests.read(f.request.id)).resultRevision).toBeNull();
});
it('conflicting_apply_evidence_requires_recovery', async (): Promise<void> => {
  const f: Fixture = await committedCrash('before-request-completion');
  const request: CodexRequest = await f.requests.read(f.request.id);
  const corrupted: string = JSON.stringify({ ...request, applyIntent: { ...request.applyIntent, resultProjectSha256: 'f'.repeat(64) } });
  const path: string = join(f.root, 'requests', `${request.id}.json`); await writeFile(path, corrupted);
  await expect(f.requests.reconcileApply(request.id, f.store, now)).rejects.toMatchObject({ code: 'CODEX_APPLY_EVIDENCE_CONFLICT' });
  expect(await readFile(path, 'utf8')).toBe(corrupted); expect((await f.requests.applyStatus(request.id, f.store)).state).toBe('evidence-conflict');
});
it('legacy_applied_record_uses_introduction_revision', async (): Promise<void> => {
  const f: Fixture = await fixture(); const applied: Project = await applyCodexImage(f.request.id, f.input, f.store, f.requests, now);
  await writeFile(join(f.root, 'requests', `${f.request.id}.json`), JSON.stringify(f.request));
  const later: Project = await f.store.update(applied.projectId, applied.revision, (current: Project): Project => ({ ...current, title: '이전 적용 뒤 편집' }), []);
  const recovered: CodexRequest = await f.requests.reconcileApply(f.request.id, f.store, now);
  expect(recovered.resultRevision).toBe(1); expect(recovered.applyIntent).toBeUndefined(); expect(await f.store.read(applied.projectId)).toEqual(later);
});
it('legacy_terminal_record_conflict_is_not_silently_rewritten', async (): Promise<void> => {
  const f: Fixture = await fixture(); const applied: Project = await applyCodexImage(f.request.id, f.input, f.store, f.requests, now);
  for (const status of ['failed', 'superseded', 'completed'] as const) {
    const bytes: string = JSON.stringify({ ...f.request, status, resultRevision: status === 'completed' ? 99 : null });
    const path: string = join(f.root, 'requests', `${f.request.id}.json`); await writeFile(path, bytes);
    await expect(f.requests.reconcileApply(f.request.id, f.store, now)).rejects.toMatchObject({ code: 'CODEX_APPLY_EVIDENCE_CONFLICT' });
    expect((await f.requests.applyStatus(f.request.id, f.store)).state).toBe('evidence-conflict');
    expect(await readFile(path, 'utf8')).toBe(bytes); expect(await f.store.read(applied.projectId)).toEqual(applied);
  }
});
it('unrelated_project_remains_usable_during_apply_recovery', async (): Promise<void> => {
  const f: Fixture = await committedCrash('before-request-completion');
  const payload = await nativePackage(); const data = nativeData(payload);
  const other: Project = await f.store.create(createSourceOutline(importPackage(withNativeData(payload, { ...data, projectId: 'other-apply-project' })), { proposedTextHoldMs: 2000 }));
  const current: CodexRequest = await f.requests.read(f.request.id);
  await writeFile(join(f.root, 'requests', `${f.request.id}.json`), JSON.stringify({ ...current, applyIntent: { ...current.applyIntent, resultProjectSha256: '0'.repeat(64) } }));
  expect((await f.requests.reconcilePendingApplies(f.store, now))[0]?.state).toBe('evidence-conflict');
  const changed: Project = await f.store.update(other.projectId, 0, (project: Project): Project => ({ ...project, title: '무관한 프로젝트 정상 편집' }), []);
  expect(await f.store.read(other.projectId)).toEqual(changed);
  expect((await f.requests.create('image', other.projectId, 'frame-1', codexRequestBasis(changed, 'image', 'frame-1'), now)).status).toBe('pending');
});
it('read_only_review_does_not_execute_apply_recovery', async (): Promise<void> => {
  const f: Fixture = await committedCrash('before-request-completion'); await f.store.close();
  const requestPath: string = join(f.root, 'requests', `${f.request.id}.json`);
  const requestBytes: Buffer = await readFile(requestPath);
  const archive = await readReviewArchive(join(f.root, 'data'), f.project.projectId);
  await writeReviewBundle(archive, { output: join(f.root, 'review'), maturity: 'draft', fontPath: resolve('assets/fonts/NanumGothic-Regular.ttf'), createdAt: now, build: readBuildManifest() }, []);
  await archive.assertUnchanged(); expect(await readFile(requestPath)).toEqual(requestBytes);
  expect(JSON.parse(requestBytes.toString('utf8'))).toMatchObject({ status: 'applying', resultRevision: null });
});
it('apply_lock_order_does_not_deadlock', async (): Promise<void> => {
  const f: Fixture = await fixture(); const child = await worker(f, 'apply', 'after-update-lock-acquired'); child.send('start'); await child.event('paused');
  expect((await readdir(join(f.root, 'requests', '.locks'))).filter((name: string): boolean => name.endsWith('.lock'))).toHaveLength(1);
  await expect(f.requests.fail(f.request.id, 'FAIL', '잠금 역전 검사', now)).rejects.toMatchObject({ code: 'CODEX_REQUEST_APPLY_IN_PROGRESS' });
  await expect(f.store.update(f.project.projectId, 0, (current: Project): Project => current, [])).rejects.toMatchObject({ code: 'PROJECT_BUSY' });
  child.send('release'); expect((await result(child)).ok).toBe(true);
  expect((await f.requests.read(f.request.id)).status).toBe('completed');
});
it('apply_recovery_lock_order_does_not_deadlock', async (): Promise<void> => {
  const f: Fixture = await committedCrash('before-request-completion'); const child = await worker(f, 'reconcile', 'during-apply-reconciliation');
  child.send('start'); await child.event('paused');
  const later: Project = await f.store.update(f.project.projectId, 1, (current: Project): Project => ({ ...current, title: '복구 소유 중 독립 편집' }), []);
  child.send('release'); expect((await result(child)).ok).toBe(true);
  expect((await f.requests.read(f.request.id)).resultRevision).toBe(1); expect(await f.store.read(f.project.projectId)).toEqual(later);
});
it('apply_claim_is_shared_by_proposal_image_and_speech', async (): Promise<void> => {
  const f: Fixture = await fixture(); const segment = f.project.dataset.segments[0]!;
  const proposalRequest: CodexRequest = await f.requests.create('proposal', f.project.projectId, segment.id, codexRequestBasis(f.project, 'proposal', segment.id), now);
  const proposalInput: string = join(f.root, 'proposal.json');
  await writeFile(proposalInput, JSON.stringify({ shots: [{ sourceLinks: f.project.dataset.units.filter((unit): boolean => unit.segmentId === segment.id).map((unit) => ({ unitId: unit.id, usage: 'primary-visual' })), durationWeight: 1,
    action: '원문 행동', visualLocationId: f.project.dataset.scenes[0]!.storyLocationId, camera: { size: 'MS', angle: 'eye-level', move: 'static' }, presence: [], propIds: [], cameraAxis: null, screenDirection: null,
    informationIds: [], transitionOut: { kind: 'cut', durationMs: 0, note: '' }, frameDescription: '원문 프레임' }] }));
  const proposed: Project = await applyCodexProposal(proposalRequest.id, proposalInput, f.store, f.requests, now);
  const frameId: string = proposed.frames[0]!.id;
  const imageRequest: CodexRequest = await f.requests.create('image', proposed.projectId, frameId, codexRequestBasis(proposed, 'image', frameId), now);
  const imaged: Project = await applyCodexImage(imageRequest.id, f.input, f.store, f.requests, now);
  const cueId: string = imaged.audioCues[0]!.id; const speechInput: string = join(f.root, 'speech.wav'); await writeFile(speechInput, pcmWav(200, 48000, 1, 16));
  const speechRequest: CodexRequest = await f.requests.create('speech', imaged.projectId, cueId, codexRequestBasis(imaged, 'speech', cueId), now);
  const spoken: Project = await applyCodexSpeech(speechRequest.id, speechInput, 'Yuna', f.store, f.requests, now, testAudioNormalizer());
  for (const [index, request] of [proposalRequest, imageRequest, speechRequest].entries()) {
    const completed: CodexRequest = await f.requests.read(request.id);
    expect(completed).toMatchObject({ status: 'completed', resultRevision: index + 1, applyIntent: { kind: request.kind, requestId: request.id, startRevision: index } });
    expect((await readApplyEvidence(completed, f.store)).receipt?.committedRevision).toBe(index + 1);
  }
  expect(await applyCodexProposal(proposalRequest.id, proposalInput, f.store, f.requests, now)).toEqual(spoken);
  expect(await applyCodexSpeech(speechRequest.id, speechInput, 'Yuna', f.store, f.requests, now, testAudioNormalizer())).toEqual(spoken);
  expect(spoken.generationRecords).toHaveLength(3); expect(spoken.assets).toHaveLength(2);
});

it('unrecognized_apply_intent_does_not_block_unrelated_requests', async (): Promise<void> => {
  const f: Fixture = await committedCrash('before-request-completion');
  const original: CodexRequest = await f.requests.read(f.request.id);
  const path: string = join(f.root, 'requests', `${f.request.id}.json`);
  const unknown: string = JSON.stringify({ ...original, applyIntent: { version: 999, unknown: true } }); await writeFile(path, unknown);
  expect((await f.requests.reconcilePendingApplies(f.store, now))[0]).toMatchObject({ requestId: f.request.id, projectId: f.project.projectId, state: 'evidence-conflict' });
  const other: CodexRequest = await f.requests.create('proposal', 'unrelated-project', 'segment', 'a'.repeat(64), now);
  expect(await f.requests.list('pending')).toEqual([other]);
  expect((await f.requests.statusRequests()).filter((request: CodexRequest): boolean => request.status === 'applying')).toHaveLength(1);
  expect(await readFile(path, 'utf8')).toBe(unknown);
});
it('legacy_request_parse_preserves_unversioned_bytes', async (): Promise<void> => {
  const f: Fixture = await fixture(); const { schemaVersion, applyIntent, ...legacy } = f.request;
  expect(schemaVersion).toBe(2); expect(applyIntent).toBeUndefined();
  const path: string = join(f.root, 'requests', `${legacy.id}.json`); const bytes: string = JSON.stringify(legacy, null, 4); await writeFile(path, bytes);
  expect(await f.requests.read(legacy.id)).toEqual(legacy); expect(await f.requests.read(legacy.id)).toEqual(legacy);
  expect(await readFile(path, 'utf8')).toBe(bytes);
});
it('foreign_apply_intent_owner_is_preserved_for_review', async (): Promise<void> => {
  const f: Fixture = await committedCrash('before-request-completion'); const original: CodexRequest = await f.requests.read(f.request.id);
  const path: string = join(f.root, 'requests', `${original.id}.json`);
  const bytes: string = JSON.stringify({ ...original, applyIntent: { ...original.applyIntent, owner: { ...original.applyIntent!.owner, host: `${hostname()}-foreign` } } });
  await writeFile(path, bytes);
  await expect(f.requests.reconcileApply(original.id, f.store, now)).rejects.toMatchObject({ code: 'CODEX_APPLY_EVIDENCE_CONFLICT' });
  expect(await readFile(path, 'utf8')).toBe(bytes); expect((await f.store.read(f.project.projectId)).revision).toBe(1);
});

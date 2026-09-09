import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { describe, expect } from 'vitest';
import { it, currentScope, ownedChild, fixtureFs } from './owned-test.js';
import { readBuildManifest } from '../src/build.js';
import { codexRequestKey, CodexRequestStore } from '../src/codex/requests.js';
import type { RequestFaultContext } from '../src/codex/requests.js';
import { CodexRequestSchema } from '../src/codex/schema.js';
import type { CodexRequest } from '../src/codex/schema.js';
import { httpErrorPolicy } from '../src/server/app.js';
import { contractError } from '../src/domain/errors.js';
import { stableJsonStringify } from '../src/io/stable-json.js';
import { codexRequestMetrics } from '../src/codex/metrics.js';
import { controlledProcess } from './controlled-process.js';
import type { ControlledProcess, WorkerMessage } from './controlled-process.js';
import type { RequestWorkerInput } from './request-store-worker.js';

const { readFile, readdir, writeFile } = fixtureFs;
const now: string = '2026-09-08T12:00:00.000Z'; const basis: string = 'a'.repeat(64);
const firstHash: string = 'b'.repeat(64); const nextHash: string = 'c'.repeat(64);
async function root(): Promise<string> { return currentScope().root('request-transaction-'); }
function store(path: string, sourceHash: string): CodexRequestStore { return currentScope().guard(new CodexRequestStore(path, { ...readBuildManifest(), sourceTreeSha256: sourceHash }), 'request-store'); }
async function worker(path: string, action: RequestWorkerInput['action'], sourceHash: string, id: string | null, point: string | null, index: number | null): Promise<ControlledProcess> {
  const child: ControlledProcess = ownedChild(() => controlledProcess('tests/request-store-worker.ts', JSON.stringify({ root: path, action, sourceHash, id, point, index } satisfies RequestWorkerInput)));
  await child.event('ready'); return child;
}
async function result(child: ControlledProcess): Promise<WorkerMessage> { const value: WorkerMessage = await child.event('result'); await child.exited; return value; }
async function sameBuildRace(path: string, hash: string): Promise<[WorkerMessage, WorkerMessage]> {
  const first = await worker(path, 'create', hash, null, 'after-lock-acquired', null);
  const second = await worker(path, 'create', hash, null, null, null);
  first.send('start'); await first.event('paused'); second.send('start'); await second.event('waiting');
  first.send('release'); return [await result(first), await result(second)];
}
async function seed(path: string): Promise<CodexRequest> { return store(path, firstHash).create('proposal', 'project', 'segment', basis, now); }
async function terminalWins(action: 'complete' | 'fail'): Promise<void> {
  const path: string = await root(); const old: CodexRequest = await seed(path);
  const terminal = await worker(path, action, firstHash, old.id, 'after-lock-acquired', null);
  const superseding = await worker(path, 'create', nextHash, null, null, null);
  terminal.send('start'); await terminal.event('paused'); superseding.send('start'); await superseding.event('waiting'); terminal.send('release');
  expect((await result(terminal)).ok).toBe(true); expect((await result(superseding)).ok).toBe(true);
  expect((await store(path, nextHash).read(old.id)).status).toBe(action === 'complete' ? 'completed' : 'failed');
}
async function crashCreate(path: string, point: string, index: number | null): Promise<void> {
  const child = await worker(path, 'create', nextHash, null, point, index); child.send('start'); await child.event('paused'); await child.stop();
}

describe('Request Key 직렬화와 Terminal CAS', (): void => {
  it('concurrent_same_build_request_creates_exactly_one_pending', async (): Promise<void> => {
    const path: string = await root(); const values = await sameBuildRace(path, firstHash); expect(values.map((value): boolean | undefined => value.ok)).toEqual([true, true]);
    expect(await store(path, firstHash).list('pending')).toHaveLength(1);
  });
  it('concurrent_same_build_request_returns_same_request_id', async (): Promise<void> => {
    const values = await sameBuildRace(await root(), firstHash);
    expect(CodexRequestSchema.parse(values[0].result).id).toBe(CodexRequestSchema.parse(values[1].result).id);
  });
  it('concurrent_new_build_request_supersedes_once', async (): Promise<void> => {
    const path: string = await root(); const old: CodexRequest = await seed(path); const values = await sameBuildRace(path, nextHash);
    expect(CodexRequestSchema.parse(values[0].result).id).toBe(CodexRequestSchema.parse(values[1].result).id);
    const requests: CodexRequest[] = await store(path, nextHash).list(null); expect(requests).toHaveLength(2);
    expect(requests.filter((request: CodexRequest): boolean => request.status === 'superseded').map((request: CodexRequest): string => request.id)).toEqual([old.id]);
  });
  it('completed_request_cannot_be_overwritten_by_supersede', async (): Promise<void> => { await terminalWins('complete'); });
  it('failed_request_cannot_be_overwritten_by_supersede', async (): Promise<void> => { await terminalWins('fail'); });
  it('concurrent_complete_and_fail_settle_exactly_once', async (): Promise<void> => {
    const path: string = await root(); const old: CodexRequest = await seed(path);
    const completing = await worker(path, 'complete', firstHash, old.id, 'after-lock-acquired', null);
    const failing = await worker(path, 'fail', firstHash, old.id, null, null);
    completing.send('start'); await completing.event('paused'); failing.send('start'); await failing.event('waiting'); completing.send('release');
    expect((await result(completing)).ok).toBe(true); expect(await result(failing)).toMatchObject({ ok: false, code: 'CODEX_REQUEST_SETTLED' });
    expect((await store(path, firstHash).read(old.id)).status).toBe('completed');
  });
  it('concurrent_complete_and_supersede_settle_exactly_once', async (): Promise<void> => {
    const path: string = await root(); const old: CodexRequest = await seed(path);
    const superseding = await worker(path, 'create', nextHash, null, 'after-lock-acquired', null);
    const completing = await worker(path, 'complete', firstHash, old.id, null, null);
    superseding.send('start'); await superseding.event('paused'); completing.send('start'); await completing.event('waiting'); superseding.send('release');
    expect((await result(superseding)).ok).toBe(true); expect(await result(completing)).toMatchObject({ ok: false, code: 'CODEX_REQUEST_SETTLED' });
    expect((await store(path, nextHash).read(old.id)).status).toBe('superseded');
  });
  it('request_status_transition_uses_compare_and_swap', async (): Promise<void> => {
    const path: string = await root(); const old: CodexRequest = await seed(path);
    const foreign: string = JSON.stringify({ ...old, status: 'failed', error: { code: 'EXTERNAL', message: '외부 상태 변경' } });
    const changed: CodexRequestStore = currentScope().guard(new CodexRequestStore(path, readBuildManifest(), {
      async trigger(context: RequestFaultContext): Promise<void> { if (context.point === 'before-state-cas') await writeFile(join(path, `${old.id}.json`), foreign); },
    }), 'request-store');
    await expect(changed.complete(old.id, 1, now)).rejects.toMatchObject({ code: 'CODEX_REQUEST_STATE_CONFLICT' });
    expect(await readFile(join(path, `${old.id}.json`), 'utf8')).toBe(foreign);
    expect(await readdir(join(path, '.transactions'))).toEqual([]);
  });
});

describe('Request Journal 실제 Process 중단 복구', (): void => {
  it('legacy_request_journal_one_recovers_without_schema_rewrite', async (): Promise<void> => {
    const path: string = await root(); const seeded: CodexRequest = await seed(path);
    const { schemaVersion: _version, ...legacy } = seeded;
    await writeFile(join(path, `${legacy.id}.json`), JSON.stringify(legacy));
    const child = await worker(path, 'complete', firstHash, legacy.id, 'after-journal-published', null);
    child.send('start'); await child.event('paused'); await child.stop();
    const journalPath: string = join(path, '.transactions', `${codexRequestKey(legacy)}.json`);
    const journal: { version: number } = JSON.parse(await readFile(journalPath, 'utf8')) as { version: number };
    await writeFile(journalPath, stableJsonStringify({ ...journal, version: 1 }));
    const recovered: CodexRequest = await store(path, firstHash).read(legacy.id);
    expect(recovered).toMatchObject({ status: 'completed', resultRevision: 1 });
    expect(recovered.schemaVersion).toBeUndefined(); expect(recovered.generatorBuild).toEqual(legacy.generatorBuild);
    expect(await readdir(join(path, '.transactions'))).toEqual([]);
  });
  it('request_supersession_is_crash_recoverable', async (): Promise<void> => {
    for (const position of [{ point: 'after-journal-published', index: null }, { point: 'after-request-published', index: 0 }, { point: 'after-request-published', index: 1 }]) {
      const path: string = await root(); const old: CodexRequest = await seed(path);
      const legacy: CodexRequest = { ...old, id: randomUUID() }; await writeFile(join(path, `${legacy.id}.json`), JSON.stringify(legacy));
      await crashCreate(path, position.point, position.index);
      const requests: CodexRequest[] = await store(path, nextHash).list(null);
      expect(requests).toHaveLength(3); expect(requests.filter((request: CodexRequest): boolean => request.status === 'pending')).toHaveLength(1);
      expect(requests.filter((request: CodexRequest): boolean => request.status === 'superseded')).toHaveLength(2);
      expect(await readdir(join(path, '.transactions'))).toEqual([]); expect(await readdir(join(path, '.locks'))).toEqual([]);
    }
  });
  it('request_terminal_transition_is_crash_recoverable', async (): Promise<void> => {
    for (const point of ['after-journal-published', 'after-request-published', 'after-journal-cleanup']) {
      const path: string = await root(); const old: CodexRequest = await seed(path);
      const child = await worker(path, 'complete', firstHash, old.id, point, null); child.send('start'); await child.event('paused'); await child.stop();
      expect((await store(path, firstHash).read(old.id)).status).toBe('completed');
      expect(await readdir(join(path, '.transactions'))).toEqual([]); expect(await readdir(join(path, '.locks'))).toEqual([]);
    }
  });
  it('request_store_recovery_is_idempotent', async (): Promise<void> => {
    const path: string = await root(); await seed(path); await crashCreate(path, 'after-request-published', 0);
    const recovering = await worker(path, 'recover', nextHash, null, 'after-recovery-request-published', 0);
    recovering.send('start'); await recovering.event('paused'); await recovering.stop();
    const first: CodexRequest[] = await store(path, nextHash).list(null);
    for (let repeat: number = 0; repeat < 3; repeat += 1) expect(await store(path, nextHash).list(null)).toEqual(first);
    expect(first.map((request: CodexRequest): string => request.status).sort()).toEqual(['pending', 'superseded']);
  });
  it('legacy_request_without_revision_remains_readable', async (): Promise<void> => {
    const path: string = await root(); const old: CodexRequest = await seed(path);
    const { generatorBuild, ...legacy } = old; expect(generatorBuild).toBeDefined();
    const bytes: string = JSON.stringify(legacy, null, 4); const file: string = join(path, `${old.id}.json`); await writeFile(file, bytes);
    expect((await store(path, firstHash).read(old.id)).status).toBe('pending'); expect(await readFile(file, 'utf8')).toBe(bytes);
  });
  it('superseded_request_remains_excluded_from_failure_rate', async (): Promise<void> => {
    const path: string = await root(); await seed(path); await store(path, nextHash).create('proposal', 'project', 'segment', basis, now);
    expect(codexRequestMetrics(await store(path, nextHash).list(null))).toMatchObject({ failedRequests: 0, supersededRequests: 1, pendingRequests: 1, averageLatencyMs: null });
  });
});

describe('Request 복구 경계와 오류 계약', (): void => {
  it('concurrent_request_recovery_elects_one_process', async (): Promise<void> => {
    const path: string = await root(); await seed(path); await crashCreate(path, 'after-request-published', 0);
    const first = await worker(path, 'recover', nextHash, null, 'after-recovery-request-published', 0);
    const second = await worker(path, 'recover', nextHash, null, null, null);
    first.send('start'); await first.event('paused'); second.send('start'); await second.event('waiting'); first.send('release');
    const left: WorkerMessage = await result(first); const right: WorkerMessage = await result(second);
    expect(left.ok).toBe(true); expect(right.ok).toBe(true); expect(left.result).toEqual(right.result);
  });
  it('request_recovery_preserves_unexpected_terminal_bytes', async (): Promise<void> => {
    const path: string = await root(); const old: CodexRequest = await seed(path);
    const child = await worker(path, 'complete', firstHash, old.id, 'after-journal-published', null);
    child.send('start'); await child.event('paused');
    const foreign: string = JSON.stringify({ ...old, status: 'failed', error: { code: 'FOREIGN', message: '외부 종료 기록' } });
    await writeFile(join(path, `${old.id}.json`), foreign); await child.stop();
    await expect(store(path, firstHash).initialize()).rejects.toMatchObject({ code: 'CODEX_REQUEST_RECOVERY_REQUIRED' });
    expect(await readFile(join(path, `${old.id}.json`), 'utf8')).toBe(foreign);
    expect((await readdir(join(path, '.transactions'))).some((name: string): boolean => name.endsWith('.json'))).toBe(true);
  });
  it('request_unknown_transaction_file_is_preserved', async (): Promise<void> => {
    const path: string = await root(); await seed(path); const unknown: string = join(path, '.transactions', 'unknown.tmp'); await writeFile(unknown, '{');
    await expect(store(path, firstHash).initialize()).rejects.toMatchObject({ code: 'CODEX_REQUEST_RECOVERY_REQUIRED' });
    expect(await readFile(unknown, 'utf8')).toBe('{');
  });
  it('request_cross_host_lock_requires_operator_action', async (): Promise<void> => {
    const path: string = await root(); const old: CodexRequest = await seed(path); const key: string = codexRequestKey(old);
    const file: string = join(path, '.locks', `${key}.lock`);
    const bytes: string = JSON.stringify({ version: 1, key, transactionId: randomUUID(), parentTransactionId: null, host: `${hostname()}-foreign`, pid: process.pid, createdAt: now });
    await writeFile(file, bytes);
    await expect(store(path, firstHash).initialize()).rejects.toMatchObject({ code: 'CODEX_REQUEST_RECOVERY_REQUIRED' });
    expect(await readFile(file, 'utf8')).toBe(bytes);
    expect(httpErrorPolicy(contractError('CODEX_REQUEST_RECOVERY_REQUIRED', '복구 필요', []))).toMatchObject({ status: 423, scope: 'request', operatorActionRequired: true, mutationBlocked: false });
  });
  it('request_storage_conflicts_use_structured_http_contracts', (): void => {
    for (const code of ['CODEX_REQUEST_SETTLED', 'CODEX_REQUEST_STATE_CONFLICT', 'CODEX_REQUEST_STORE_BUSY']) {
      expect(httpErrorPolicy(contractError(code, '경쟁', []))).toMatchObject({ status: 409, scope: 'request', mutationBlocked: false });
    }
    expect(httpErrorPolicy(contractError('CODEX_REQUEST_STORE_UNAVAILABLE', '일시 파일 오류', []))).toMatchObject({ status: 503, retryable: true, mutationBlocked: false });
  });
  it('request_contract_versions_are_in_current_build_manifest', (): void => {
    expect(readBuildManifest()).toMatchObject({ requestLockVersion: 1, requestJournalVersion: 2 });
  });
});

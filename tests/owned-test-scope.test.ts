import { access, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { createOwnedTestScope } from './owned-test-scope.js';
import type { OwnedTestScope, ScopeEvent } from './owned-test-scope.js';
import { controlledProcess } from './controlled-process.js';
import { ProjectStore } from '../src/server/store.js';
import { createSourceOutline } from '../src/proposal/outline.js';
import { importPackage } from '../src/importers/import-package.js';
import { nativePackage } from './helpers.js';

function fixture(drainMs: number): { scope: OwnedTestScope; controller: AbortController; events: ScopeEvent[] } {
  const controller = new AbortController(); const events: ScopeEvent[] = [];
  const scope: OwnedTestScope = createOwnedTestScope({ signal: controller.signal, testFile: 'owned-test-scope.test.ts', testName: 'scope-boundary',
    drainMs, observe: (event: ScopeEvent): void => { events.push(event); } });
  return { scope, controller, events };
}

it('cancelled_scope_finishes_started_writer_and_rejects_new_work', async (): Promise<void> => {
  const { scope, controller, events } = fixture(1000); const root: string = await scope.root('owned-writer-');
  const reached = Promise.withResolvers<void>(); const release = Promise.withResolvers<void>();
  scope.releaseOnFinish(release.resolve);
  const body: Promise<void> = scope.body((): Promise<void> => scope.phase('observed-sequence', async (): Promise<void> => {
    await scope.run('transaction', async (): Promise<void> => {
      reached.resolve(); await release.promise;
      // 이미 시작된 Transaction의 내부 쓰기는 취소 뒤에도 완료돼야 한다.
      await scope.run('transaction-final-write', (): Promise<void> => writeFile(join(root, 'result'), 'complete'));
    });
    await scope.run('unexpected-next-write', (): Promise<void> => writeFile(join(root, 'next'), 'bad'));
  }));
  const rejected = expect(body).rejects.toMatchObject({ code: 'OWNED_TEST_STOPPED' });
  await reached.promise; controller.abort(new Error('통제된 취소')); await scope.close(); await rejected;
  expect(events.findIndex(e => e.phase === 'operation-settled' && e.operationId?.startsWith('transaction:')))
    .toBeLessThan(events.findIndex(e => e.phase === 'root-remove-start'));
  expect(events.some(e => e.operationId?.startsWith('unexpected-next-write'))).toBe(false);
  expect(events.find(e => e.phase === 'phase-failed')).toMatchObject({ errorCode: 'OWNED_TEST_STOPPED' });
  await expect(scope.root('after-close-')).rejects.toMatchObject({ code: 'OWNED_TEST_STOPPED' });
  await expect(access(root)).rejects.toMatchObject({ code: 'ENOENT' });
  const next = fixture(1000); const nextRoot: string = await next.scope.root('owned-next-');
  expect(await readdir(nextRoot)).toEqual([]); await next.scope.close(); expect(next.scope.settled()).toBe(true);
});

it('unsettled_scope_preserves_root_and_reports_bounded_drain_failure', async (): Promise<void> => {
  const { scope, controller, events } = fixture(30); const root: string = await scope.root('owned-unsettled-');
  const release = Promise.withResolvers<void>(); const reached = Promise.withResolvers<void>();
  const body: Promise<void> = scope.body(async (): Promise<void> => { reached.resolve(); await release.promise; });
  try {
    await reached.promise; controller.abort();
    await expect(scope.close()).rejects.toMatchObject({ errors: expect.arrayContaining([expect.objectContaining({ code: 'OWNED_TEST_DRAIN_TIMEOUT' })]) });
    await access(root); expect(scope.settled()).toBe(false);
    expect(events.some(e => e.phase === 'root-remove-start')).toBe(false);
    expect(events.some(e => e.phase === 'root-preserved')).toBe(true);
  } finally { release.resolve(); await body; await rm(root, { recursive: true, force: true }); }
});

it('fixture_initialization_failure_closes_registered_store_and_root', async (): Promise<void> => {
  const { scope } = fixture(1000); let root: string | null = null; let store: ProjectStore | null = null;
  const failure = new Error('Fixture 초기화 중단');
  await expect(scope.body(async (): Promise<void> => {
    root = await scope.root('owned-init-'); store = new ProjectStore(join(root, 'data'));
    const owned: ProjectStore = store; scope.own('store', owned.processInstanceId(), (): Promise<void> => owned.close());
    const guarded: ProjectStore = scope.guard(owned, 'dependent-store');
    scope.own('app', 'dependent-close', (): Promise<void> => guarded.close());
    await owned.create(createSourceOutline(importPackage(await nativePackage()), { proposedTextHoldMs: 2000 }));
    throw failure;
  })).rejects.toBe(failure);
  await scope.close();
  if (store === null || root === null) throw new Error('초기화 실패 전 자원이 등록되지 않았습니다.');
  expect((store as ProjectStore).processHeartbeatTimerHasRef()).toBeNull();
  await expect(access(root)).rejects.toMatchObject({ code: 'ENOENT' });
});

it('cleanup_failure_preserves_primary_error_and_closes_independent_resources', async (): Promise<void> => {
  const { scope } = fixture(1000); const root: string = await scope.root('owned-close-failure-');
  const primary = new Error('최초 본문 오류'); const cleanup = new Error('첫 Store 종료 오류'); let secondClosed: boolean = false;
  scope.own('store', 'first', async (): Promise<void> => { throw cleanup; });
  scope.own('store', 'second', async (): Promise<void> => { secondClosed = true; });
  await expect(scope.body((): never => { throw primary; })).rejects.toBe(primary);
  await expect(scope.close()).rejects.toMatchObject({ errors: [cleanup] });
  expect(secondClosed).toBe(true); await access(root);
  await rm(root, { recursive: true, force: true });
});

it('controlled_process_stop_waits_for_stdio_close', async (): Promise<void> => {
  const child = controlledProcess('tests/fixtures/ci-timeout/process-worker.ts', '{}'); let closed: boolean = false;
  child.child.once('close', (): void => { closed = true; });
  try { await child.event('ready'); await child.stop(); expect(closed).toBe(true); }
  finally { await child.stop(); }
});

it('guard_preserves_sync_methods_and_drains_unawaited_async_operation', async (): Promise<void> => {
  const { scope, controller } = fixture(1000); const root: string = await scope.root('owned-detached-');
  const release = Promise.withResolvers<void>(); scope.releaseOnFinish(release.resolve);
  const target = scope.guard({ value(): number { return 7; }, async write(): Promise<void> { await release.promise; await writeFile(join(root, 'result'), 'ok'); } }, 'boundary');
  expect(target.value()).toBe(7);
  const writing: Promise<void> = target.write(); const rejected = expect(writing).rejects.toMatchObject({ code: 'OWNED_TEST_STOPPED' });
  controller.abort(); await scope.close(); await rejected;
  await expect(readFile(join(root, 'result'))).rejects.toMatchObject({ code: 'ENOENT' });
});

it('nested_writer_is_drained_after_its_parent_operation_returns', async (): Promise<void> => {
  const { scope } = fixture(1000); const root: string = await scope.root('owned-nested-');
  const release = Promise.withResolvers<void>(); const phases: string[] = [];
  scope.releaseOnFinish(release.resolve);
  scope.own('store', 'nested-writer-store', async (): Promise<void> => { phases.push('store-close'); });
  const target = scope.guard({ async write(): Promise<void> {
    await release.promise; await writeFile(join(root, 'result'), 'complete'); phases.push('writer-settled');
  } }, 'nested-writer');
  let writing: Promise<void> | null = null;
  try {
    await scope.phase('observed-parent', (): Promise<void> => scope.run('parent', (): void => { writing = target.write(); }));
    await scope.close();
    await writing;
    expect(phases).toEqual(['writer-settled', 'store-close']);
    await expect(access(root)).rejects.toMatchObject({ code: 'ENOENT' });
  } finally { release.resolve(); await writing; await rm(root, { recursive: true, force: true }); }
});

it('settled_operation_context_cannot_start_a_writer_after_cleanup', async (): Promise<void> => {
  const { scope } = fixture(1000); const root: string = await scope.root('owned-stale-context-');
  const release = Promise.withResolvers<void>();
  const target = scope.guard({ async write(): Promise<void> {
    await mkdir(root, { recursive: true }); await writeFile(join(root, 'late'), 'unexpected');
  } }, 'late-writer');
  let writing: Promise<void> | null = null;
  try {
    await scope.run('schedule', (): void => { writing = release.promise.then((): Promise<void> => target.write()); });
    await scope.close(); release.resolve();
    await expect(writing).rejects.toMatchObject({ code: 'OWNED_TEST_STOPPED' });
    await expect(access(root)).rejects.toMatchObject({ code: 'ENOENT' });
  } finally {
    release.resolve();
    await Promise.allSettled(writing === null ? [] : [writing]);
    await rm(root, { recursive: true, force: true });
  }
});

import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { appendFileSync, mkdirSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative } from 'node:path';

type Outcome = { ok: true } | { ok: false; error: unknown };
type ResourceKind = 'child' | 'app' | 'worker' | 'store';
type Resource = { kind: ResourceKind; id: string; close: () => Promise<void> };
export type ScopeEvent = {
  investigationRunId: string; testFile: string; testName: string; fixtureId: string; operationId: string | null;
  pid: number; workerId: string | null; phase: string; elapsedMs: number; errorCode: string | null;
  resourceCount: { operations: number; children: number; apps: number; workers: number; stores: number; roots: number; timers: null };
};
export type ScopeOptions = { signal: AbortSignal; testFile: string; testName: string; drainMs: number; observe: (event: ScopeEvent) => void };
export type OwnedTestScope = {
  body(operation: () => void | Promise<void>): Promise<void>;
  run<T>(label: string, operation: () => T | Promise<T>): Promise<T>;
  phase<T>(label: string, operation: () => T | Promise<T>): Promise<T>;
  guard<T extends object>(target: T, label: string): T;
  root(prefix: string): Promise<string>;
  own(kind: ResourceKind, id: string, close: () => Promise<void>): void;
  releaseOnFinish(release: () => void): void;
  close(): Promise<void>;
  settled(): boolean;
};
type OperationContext = { scope: OwnedTestScope; active: boolean };
const operations = new AsyncLocalStorage<OperationContext>();

function code(error: unknown): string {
  return error instanceof Error && 'code' in error && typeof error.code === 'string' ? error.code : error instanceof Error ? error.name : 'UNKNOWN';
}
function stopped(): Error { return Object.assign(new Error('종료된 Test는 새 작업을 시작할 수 없습니다.'), { code: 'OWNED_TEST_STOPPED' }); }
function outcome(promise: Promise<unknown>): Promise<Outcome> {
  return promise.then((): Outcome => ({ ok: true }), (error: unknown): Outcome => ({ ok: false, error }));
}
async function beforeDeadline<T>(promise: Promise<T>, deadline: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_resolve, reject): void => {
      timer = setTimeout((): void => { reject(Object.assign(new Error('소유 자원 종료를 제한 시간 안에 증명하지 못했습니다. Root를 보존합니다.'), { code: 'OWNED_TEST_DRAIN_TIMEOUT' })); }, Math.max(0, deadline - performance.now()));
    })]);
  } finally { if (timer !== undefined) clearTimeout(timer); }
}

/** 외부 Test 호출만 취소하고 시작된 Transaction 내부 호출은 끝까지 정산한다. */
export function createOwnedTestScope(options: ScopeOptions): OwnedTestScope {
  const fixtureId: string = randomUUID(); const started: number = performance.now();
  const pending: Map<string, Promise<Outcome>> = new Map(); const resources: Resource[] = []; const roots: string[] = [];
  const releases: (() => void)[] = []; const lateErrors: unknown[] = [];
  let closing: boolean = false; let bodyResult: Promise<Outcome> | null = null; let bodySettled: boolean = true;
  let cleanup: Promise<void> | null = null;
  const emit = (phase: string, operationId: string | null, error: unknown): void => {
    options.observe({ investigationRunId: process.env['STORYBOARD_TEST_RUN_ID'] ?? 'local', testFile: options.testFile, testName: options.testName,
      fixtureId, operationId, pid: process.pid, workerId: process.env['VITEST_POOL_ID'] ?? null, phase, elapsedMs: performance.now() - started,
      errorCode: error === null ? null : code(error), resourceCount: { operations: pending.size, children: resources.filter(r => r.kind === 'child').length,
        apps: resources.filter(r => r.kind === 'app').length, workers: resources.filter(r => r.kind === 'worker').length,
        stores: resources.filter(r => r.kind === 'store').length, roots: roots.length, timers: null } });
  };
  const insideActiveOperation = (): boolean => {
    const context: OperationContext | undefined = operations.getStore();
    return context?.scope === scope && context.active;
  };
  const assertOpen = (): void => { if ((closing || options.signal.aborted) && !insideActiveOperation()) throw stopped(); };
  const invoke = (label: string, operation: () => unknown): unknown => {
    assertOpen();
    const nested: boolean = insideActiveOperation();
    const context: OperationContext = { scope, active: true };
    const id: string = `${label}:${randomUUID()}`; emit('operation-start', id, null);
    let result: unknown;
    try { result = operations.run(context, operation); }
    catch (error: unknown) { context.active = false; emit('operation-settled', id, error); throw error; }
    if (typeof result !== 'object' || result === null || !('then' in result) || typeof result.then !== 'function') {
      context.active = false; emit('operation-settled', id, null); return result;
    }
    const promise: Promise<unknown> = Promise.resolve(result as PromiseLike<unknown>);
    const observed: Promise<Outcome> = outcome(promise).then((settled: Outcome): Outcome => {
      context.active = false; pending.delete(id); emit('operation-settled', id, settled.ok ? null : settled.error);
      if (!settled.ok && closing && code(settled.error) !== 'OWNED_TEST_STOPPED') lateErrors.push(settled.error);
      return settled;
    });
    pending.set(id, observed);
    // 중첩 작업도 개별 추적하되 이미 시작된 Transaction의 반환은 취소로 가로막지 않는다.
    return nested ? promise : promise.then((value: unknown): unknown => { assertOpen(); return value; });
  };
  const abort = (): void => { emit('test-aborted', null, options.signal.reason); };
  options.signal.addEventListener('abort', abort, { once: true });
  const closeResources = async (kind: ResourceKind, deadline: number): Promise<unknown[]> => {
    const selected: Resource[] = resources.filter(resource => resource.kind === kind);
    return (await Promise.all(selected.map(async (resource: Resource): Promise<Outcome> => {
      emit(`${kind}-close-start`, resource.id, null);
      try {
        const context: OperationContext = { scope, active: true };
        const closingResource: Promise<void> = operations.run(context, async (): Promise<void> => {
          try { await resource.close(); } finally { context.active = false; }
        });
        await beforeDeadline(closingResource, deadline); resources.splice(resources.indexOf(resource), 1);
        emit(`${kind}-close-end`, resource.id, null); return { ok: true };
      } catch (error: unknown) { emit('cleanup-failed', resource.id, error); return { ok: false, error }; }
    }))).flatMap(result => result.ok ? [] : [result.error]);
  };
  const finish = async (): Promise<void> => {
    closing = true; emit('cleanup-start', null, null);
    const errors: unknown[] = []; const deadline: number = performance.now() + options.drainMs;
    for (const release of releases.splice(0)) {
      try { release(); } catch (error: unknown) { errors.push(error); }
    }
    errors.push(...await closeResources('child', deadline));
    try {
      if (bodyResult !== null) {
        const result: Outcome = await beforeDeadline(bodyResult, deadline);
        if (!result.ok && options.signal.aborted && code(result.error) !== 'OWNED_TEST_STOPPED') errors.push(result.error);
      }
      while (pending.size > 0) await beforeDeadline(Promise.all([...pending.values()]), deadline);
    } catch (error: unknown) { errors.push(error); }
    if (bodySettled && pending.size === 0) {
      for (const kind of ['app', 'worker', 'store'] as const) errors.push(...await closeResources(kind, deadline));
    }
    errors.push(...lateErrors);
    if (bodySettled && pending.size === 0 && resources.length === 0) {
      for (const root of [...roots]) {
        emit('root-remove-start', root, null);
        try { await beforeDeadline(rm(root, { recursive: true, force: true }), deadline); roots.splice(roots.indexOf(root), 1); emit('root-remove-end', root, null); }
        catch (error: unknown) { errors.push(error); emit('cleanup-failed', root, error); }
      }
    } else {
      for (const root of roots) emit('root-preserved', root, null);
    }
    options.signal.removeEventListener('abort', abort);
    if (errors.length > 0) throw new AggregateError([...new Set(errors)], 'Test 정리에 실패했습니다. 원래 Test 오류와 각 정리 오류를 함께 확인하세요.');
  };
  const scope: OwnedTestScope = {
    body(operation): Promise<void> {
      assertOpen(); bodySettled = false; emit('test-start', null, null);
      const promise: Promise<void> = Promise.resolve().then(operation).finally((): void => { bodySettled = true; emit('test-body-settled', null, null); });
      bodyResult = outcome(promise); return promise;
    },
    async run<T>(label: string, operation: () => T | Promise<T>): Promise<T> {
      return invoke(label, operation) as T | Promise<T>;
    },
    // 단계 관찰은 Transaction 문맥을 만들지 않아 취소 뒤 다음 작업을 허용하지 않는다.
    async phase<T>(label: string, operation: () => T | Promise<T>): Promise<T> {
      assertOpen();
      const id: string = `${label}:${randomUUID()}`; emit('phase-start', id, null);
      try {
        const result: T = await operation(); emit('phase-end', id, null); return result;
      } catch (error: unknown) { emit('phase-failed', id, error); throw error; }
    },
    guard<T extends object>(target: T, label: string): T {
      assertOpen();
      const methods: Map<PropertyKey, { original: unknown; bound: unknown }> = new Map();
      return new Proxy(target, {
        get(object, key): unknown {
          const value: unknown = Reflect.get(object, key, object);
          if (typeof value !== 'function') return value;
          const cached = methods.get(key); if (cached?.original === value) return cached.bound;
          const bound = new Proxy(value, { apply(original, _receiver, args: unknown[]): unknown {
            return invoke(`${label}.${String(key)}`, (): unknown => Reflect.apply(original, object, args));
          } });
          methods.set(key, { original: value, bound }); return bound;
        },
      });
    },
    root(prefix: string): Promise<string> {
      return scope.run('fixture-root', async (): Promise<string> => {
        const root: string = await mkdtemp(join(tmpdir(), prefix)); roots.push(root); emit('fixture-ready', root, null); return root;
      });
    },
    own(kind: ResourceKind, id: string, close: () => Promise<void>): void { assertOpen(); resources.push({ kind, id, close }); },
    releaseOnFinish(release: () => void): void { assertOpen(); releases.push(release); },
    close(): Promise<void> { cleanup ??= finish(); return cleanup; },
    settled(): boolean { return bodySettled && pending.size === 0 && resources.length === 0; },
  };
  return scope;
}

/** 선택한 진단 경로에만 작은 단계 이벤트를 기록한다. 제작 데이터·환경 전체는 기록하지 않는다. */
export function diagnosticObserver(): (event: ScopeEvent) => void {
  const directory: string | undefined = process.env['STORYBOARD_TEST_DIAGNOSTICS_DIR'];
  if (directory === undefined) return (): void => {};
  if (!isAbsolute(directory)) throw new Error('STORYBOARD_TEST_DIAGNOSTICS_DIR은 삭제 Root 밖의 절대경로여야 합니다.');
  mkdirSync(directory, { recursive: true });
  const file: string = join(directory, `lifecycle-${process.pid}-${randomUUID()}.jsonl`);
  return (event: ScopeEvent): void => {
    if (event.phase === 'fixture-ready' && event.operationId !== null && !relative(event.operationId, file).startsWith('..')) {
      throw new Error('진단 로그가 삭제 대상 Root 안에 있습니다.');
    }
    appendFileSync(file, `${JSON.stringify(event)}\n`);
  };
}

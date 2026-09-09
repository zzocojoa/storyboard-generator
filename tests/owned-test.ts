import { AsyncLocalStorage } from 'node:async_hooks';
import * as filesystem from 'node:fs/promises';
import { it as test, vi } from 'vitest';
import type { TestContext } from 'vitest';
import type { ProjectStore } from '../src/server/store.js';
import type { ControlledProcess } from './controlled-process.js';
import { createOwnedTestScope, diagnosticObserver } from './owned-test-scope.js';
import type { OwnedTestScope } from './owned-test-scope.js';

const scopes = new AsyncLocalStorage<OwnedTestScope>();
let unsettledScope: OwnedTestScope | null = null;

export function currentScope(): OwnedTestScope {
  const scope: OwnedTestScope | undefined = scopes.getStore();
  if (scope === undefined) throw new Error('소유 Test Scope 밖에서 Fixture를 만들 수 없습니다.');
  return scope;
}

/** Vitest의 timeout Wrapper와 별개로 원래 Test 본문을 추적하고 종료 Hook에서 정산한다. */
export function it(name: string, body: () => void | Promise<void>): void {
  test(name, async (context: TestContext): Promise<void> => {
    if (unsettledScope !== null && !unsettledScope.settled()) throw new Error('이전 Test의 미종료 작업을 격리했습니다. 이 Process에서 다음 Fixture를 시작하지 않습니다.');
    const scope: OwnedTestScope = createOwnedTestScope({ signal: context.signal, testFile: context.task.file.filepath,
      testName: name, drainMs: 4000, observe: diagnosticObserver() });
    context.onTestFinished(async (): Promise<void> => {
      try { await scope.close(); }
      finally {
        if (scope.settled()) vi.restoreAllMocks(); else unsettledScope = scope;
      }
    });
    await scopes.run(scope, (): Promise<void> => scope.body(body));
  });
}

export function ownedStore(store: ProjectStore): ProjectStore {
  const scope: OwnedTestScope = currentScope(); scope.own('store', store.processInstanceId(), (): Promise<void> => store.close());
  return scope.guard(store, 'project-store');
}
export function ownedChild(create: () => ControlledProcess): ControlledProcess {
  const scope: OwnedTestScope = currentScope(); const child: ControlledProcess = scope.guard({ create }, 'child-create').create();
  scope.own('child', String(child.child.pid), (): Promise<void> => child.stop());
  return scope.guard(child, `child:${child.child.pid}`);
}
export function barrier(): PromiseWithResolvers<void> {
  const value = Promise.withResolvers<void>(); currentScope().releaseOnFinish(value.resolve); return value;
}

// 직접 Fixture 파일 작업도 새 작업 차단과 진행 중 Promise 정산에 포함한다.
export const fixtureFs: Pick<typeof filesystem, 'mkdir' | 'readFile' | 'readdir' | 'rm' | 'unlink' | 'writeFile'> = new Proxy(filesystem, {
  get(target, key): unknown {
    const value: unknown = Reflect.get(target, key);
    if (typeof value !== 'function') return value;
    return new Proxy(value, { apply(original, _receiver, args: unknown[]): unknown {
      return currentScope().run(`fixture-fs.${String(key)}`, (): unknown => Reflect.apply(original, target, args));
    } });
  },
});

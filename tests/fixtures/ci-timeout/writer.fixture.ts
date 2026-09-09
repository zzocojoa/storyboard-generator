import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, it } from 'vitest';
import { ProjectStore } from '../../../src/server/store.js';
import type { StorageFaultPoint } from '../../../src/server/store.js';
import type { Project } from '../../../src/domain/schema.js';
import { importPackage } from '../../../src/importers/import-package.js';
import { createSourceOutline } from '../../../src/proposal/outline.js';
import { nativePackage } from '../../helpers.js';
import { createOwnedTestScope } from '../../owned-test-scope.js';
import type { OwnedTestScope } from '../../owned-test-scope.js';

const output: string | undefined = process.env['CI_TIMEOUT_PROBE_LOG'];
if (output === undefined) throw new Error('진단 로그 경로가 필요합니다.');
const started: number = performance.now();
function event(phase: string): void { appendFileSync(output!, `${JSON.stringify({ phase, pid: process.pid, elapsedMs: performance.now() - started })}\n`); }
const release = Promise.withResolvers<void>();
let root: string;
let store: ProjectStore;
let project: Project;
let operation: Promise<void>;
let scope: OwnedTestScope;

beforeEach(async ({ signal }): Promise<void> => {
  scope = createOwnedTestScope({ signal, testFile: 'writer.fixture.ts', testName: 'intentional_writer_timeout', drainMs: 1500,
    observe: (entry): void => { if (entry.phase === 'root-remove-start' || entry.phase === 'root-remove-end') event(entry.phase); },
  });
  scope.releaseOnFinish(release.resolve);
  root = await scope.root('timeout-writer-');
  store = new ProjectStore(join(root, 'data'), { ownerPid: process.pid,
    async trigger(point: StorageFaultPoint): Promise<void> {
      if (point === 'after-update-journal-prepared') { event('journal-prepared'); await release.promise; }
    },
  });
  scope.own('store', 'writer-store', async (): Promise<void> => {
    event('store-close-start'); await store.close(); event('store-close-end');
  });
  project = await store.create(createSourceOutline(importPackage(await nativePackage()), { proposedTextHoldMs: 2000 }));
  event('fixture-ready');
});

afterEach(async (): Promise<void> => {
  await scope.close();
});

it('intentional_writer_timeout', async ({ signal }): Promise<void> => {
  signal.addEventListener('abort', (): void => { event('test-aborted'); }, { once: true });
  event('test-start');
  operation = scope.body((): Promise<void> => scope.run('update', (): Promise<void> =>
    store.update(project.projectId, project.revision, (current: Project): Project => ({ ...current, title: '진단 변경' }), [])
      .then((): void => { event('operation-settled'); }, (error: unknown): never => { event('operation-settled'); throw error; })));
  await operation;
});

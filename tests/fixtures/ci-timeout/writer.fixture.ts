import { appendFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, it } from 'vitest';
import { ProjectStore } from '../../../src/server/store.js';
import type { StorageFaultPoint } from '../../../src/server/store.js';
import type { Project } from '../../../src/domain/schema.js';
import { importPackage } from '../../../src/importers/import-package.js';
import { createSourceOutline } from '../../../src/proposal/outline.js';
import { nativePackage } from '../../helpers.js';

const output: string | undefined = process.env['CI_TIMEOUT_PROBE_LOG'];
if (output === undefined) throw new Error('진단 로그 경로가 필요합니다.');
const started: number = performance.now();
function event(phase: string): void { appendFileSync(output!, `${JSON.stringify({ phase, pid: process.pid, elapsedMs: performance.now() - started })}\n`); }
const release = Promise.withResolvers<void>();
let root: string;
let store: ProjectStore;
let project: Project;
let operation: Promise<void>;

beforeEach(async (): Promise<void> => {
  root = await mkdtemp(join(tmpdir(), 'timeout-writer-'));
  store = new ProjectStore(join(root, 'data'), { ownerPid: process.pid,
    async trigger(point: StorageFaultPoint): Promise<void> {
      if (point === 'after-update-journal-prepared') { event('journal-prepared'); await release.promise; }
    },
  });
  project = await store.create(createSourceOutline(importPackage(await nativePackage()), { proposedTextHoldMs: 2000 }));
  event('fixture-ready');
});

afterEach(async (): Promise<void> => {
  event('store-close-start'); await store.close(); event('store-close-end');
  event('root-remove-start');
  const removing: Promise<void> = rm(root, { recursive: true, force: true });
  release.resolve();
  const outcomes = await Promise.allSettled([operation, removing]);
  for (const outcome of outcomes) if (outcome.status === 'rejected') event('cleanup-or-writer-error');
  // 관찰을 끝낸 뒤 Writer 종료가 증명된 전용 Root만 정리한다.
  await rm(root, { recursive: true, force: true }); event('root-remove-end');
});

it('intentional_writer_timeout', async ({ signal }): Promise<void> => {
  signal.addEventListener('abort', (): void => { event('test-aborted'); }, { once: true });
  event('test-start');
  operation = store.update(project.projectId, project.revision, (current: Project): Project => ({ ...current, title: '진단 변경' }), [])
    .then((): void => { event('operation-settled'); }, (error: unknown): never => { event('operation-settled'); throw error; });
  await operation;
});

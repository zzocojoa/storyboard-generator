import { join } from 'node:path';
import { z } from 'zod';
import { readBuildManifest } from '../src/build.js';
import { applyCodexImage } from '../src/codex/apply.js';
import { requestErrorCode } from '../src/codex/request-lock.js';
import { CodexRequestStore } from '../src/codex/requests.js';
import type { RequestFaultContext } from '../src/codex/requests.js';
import { ProjectStore } from '../src/server/store.js';
import type { StorageFaultPoint } from '../src/server/store.js';

const InputSchema = z.strictObject({ root: z.string(), requestId: z.uuid(), action: z.enum(['apply', 'reconcile', 'fail', 'supersede']), point: z.string().nullable() });
export type ApplyWorkerInput = z.infer<typeof InputSchema>;
const input: ApplyWorkerInput = InputSchema.parse(JSON.parse(process.argv[2]!));
function waitMessage(expected: string): Promise<void> {
  return new Promise<void>((resolve): void => {
    const listener = (message: unknown): void => { if (message === expected) { process.off('message', listener); resolve(); } };
    process.on('message', listener);
  });
}
let paused: boolean = false;
async function fault(point: string): Promise<void> {
  if (paused || point !== input.point) return;
  paused = true; const release: Promise<void> = waitMessage('release'); process.send?.({ event: 'paused', point }); await release;
}
const warn = console.warn;
console.warn = (...values: unknown[]): void => {
  warn(...values); if (typeof values[0] === 'string' && values[0].includes('codex-request-lock-wait')) process.send?.({ event: 'waiting' });
};
const store: ProjectStore = new ProjectStore(join(input.root, 'data'), { ownerPid: process.pid,
  trigger(point: StorageFaultPoint): Promise<void> { return fault(point === 'after-update-journal-prepared' ? 'after-project-journal-prepared' : point === 'after-update-current-published' ? 'after-project-current-published' : point); },
});
const requests: CodexRequestStore = new CodexRequestStore(join(input.root, 'requests'), input.action === 'supersede'
  ? { ...readBuildManifest(), generationContractSha256: 'e'.repeat(64) } : readBuildManifest(), {
  trigger(context: RequestFaultContext): Promise<void> { return fault(context.point); },
});
const start: Promise<void> = waitMessage('start'); process.send?.({ event: 'ready' }); await start;
try {
  const request = await requests.read(input.requestId);
  const result = input.action === 'apply' ? await applyCodexImage(input.requestId, join(input.root, 'result.png'), store, requests, '2026-09-09T02:00:01.000Z')
    : input.action === 'reconcile' ? await requests.reconcileApply(input.requestId, store, '2026-09-09T02:00:02.000Z')
      : input.action === 'fail' ? await requests.fail(input.requestId, 'TEST_FAILURE', '경쟁 실패 요청', '2026-09-09T02:00:01.000Z')
        : await requests.create(request.kind, request.projectId, request.targetId, request.basisHash, '2026-09-09T02:00:01.000Z');
  process.send?.({ event: 'result', ok: true, result });
} catch (error: unknown) { process.send?.({ event: 'result', ok: false, code: requestErrorCode(error), message: error instanceof Error ? error.message : String(error) }); }
finally { await store.close(); process.disconnect(); }

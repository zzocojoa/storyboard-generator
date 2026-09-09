import { readBuildManifest } from '../src/build.js';
import { CodexRequestStore } from '../src/codex/requests.js';
import type { RequestFaultContext, RequestFaultPoint } from '../src/codex/requests.js';
import { requestErrorCode } from '../src/codex/request-lock.js';
import { z } from 'zod';

const InputSchema = z.strictObject({ root: z.string(), action: z.enum(['create', 'complete', 'fail', 'recover']), sourceHash: z.string(),
  id: z.string().nullable(), point: z.string().nullable(), index: z.number().int().nullable() });
export type RequestWorkerInput = z.infer<typeof InputSchema>;
const input: RequestWorkerInput = InputSchema.parse(JSON.parse(process.argv[2]!));
function waitMessage(expected: string): Promise<void> {
  return new Promise<void>((resolve): void => {
    const listener = (message: unknown): void => { if (message === expected) { process.off('message', listener); resolve(); } };
    process.on('message', listener);
  });
}
const warning = console.warn;
console.warn = (...values: unknown[]): void => {
  warning(...values);
  if (typeof values[0] === 'string' && values[0].includes('codex-request-lock-wait')) process.send?.({ event: 'waiting' });
};
const start: Promise<void> = waitMessage('start'); process.send?.({ event: 'ready' }); await start;
let paused: boolean = false;
const store: CodexRequestStore = new CodexRequestStore(input.root, { ...readBuildManifest(), sourceTreeSha256: input.sourceHash }, {
  async trigger(context: RequestFaultContext): Promise<void> {
    if (!paused && context.point === input.point as RequestFaultPoint && (input.index === null || context.index === input.index)) {
      paused = true; const release: Promise<void> = waitMessage('release'); process.send?.({ event: 'paused', context }); await release;
    }
  },
});
try {
  const result = input.action === 'create' ? await store.create('proposal', 'project', 'segment', 'a'.repeat(64), '2026-09-08T12:00:00.000Z')
    : input.action === 'complete' ? await store.complete(input.id!, 1, '2026-09-08T12:00:01.000Z')
      : input.action === 'fail' ? await store.fail(input.id!, 'TEST_FAILURE', '의도된 실패', '2026-09-08T12:00:01.000Z')
        : await store.list(null);
  process.send?.({ event: 'result', ok: true, result });
} catch (error: unknown) { process.send?.({ event: 'result', ok: false, code: requestErrorCode(error), message: error instanceof Error ? error.message : String(error) }); }
process.disconnect();

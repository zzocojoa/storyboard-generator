import { z } from 'zod';
import { resolve } from 'node:path';
import { readBuildManifest } from '../src/build.js';
import { readReviewArchive, writeReviewBundle } from '../src/exporters/review-bundle.js';
const InputSchema = z.strictObject({ dataRoot: z.string(), projectId: z.string(), output: z.string(), hold: z.boolean() });
const input = InputSchema.parse(JSON.parse(process.argv[2]!));
function waitMessage(expected: string): Promise<void> {
  return new Promise<void>((done): void => {
    const listener = (message: unknown): void => { if (message === expected) { process.off('message', listener); done(); } }; process.on('message', listener);
  });
}
const start: Promise<void> = waitMessage('start'); process.send?.({ event: 'ready' }); await start;
try {
  const original = await readReviewArchive(input.dataRoot, input.projectId); let checks: number = 0;
  const archive = { ...original, assertUnchanged: async (): Promise<void> => {
    await original.assertUnchanged(); checks += 1;
    if (input.hold && checks === 2) { const release: Promise<void> = waitMessage('release'); process.send?.({ event: 'paused' }); await release; }
  } };
  const manifest = await writeReviewBundle(archive, { output: input.output, maturity: 'draft', fontPath: resolve('assets/fonts/NanumGothic-Regular.ttf'),
    createdAt: '2026-09-08T00:00:00.000Z', build: readBuildManifest() }, []);
  process.send?.({ event: 'result', ok: true, result: manifest });
} catch (error: unknown) { process.send?.({ event: 'result', ok: false, code: error instanceof Error && 'code' in error ? String(error.code) : 'UNKNOWN' }); }
process.disconnect();

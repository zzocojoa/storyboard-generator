import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';
import { z } from 'zod';

const execute = promisify(execFile);
const ProbeEventSchema = z.object({ phase: z.string(), pid: z.number(), elapsedMs: z.number() });

it('vitest_timeout_drains_writer_before_store_close_and_root_removal', async (): Promise<void> => {
  const root: string = await mkdtemp(join(tmpdir(), 'timeout-observer-'));
  const output: string = join(root, 'events.jsonl');
  try {
    let failure: unknown = null;
    try {
      await execute(process.execPath, [resolve('node_modules/vitest/vitest.mjs'), 'run', '--config', 'tests/fixtures/ci-timeout/vitest.config.ts'],
        { env: { ...process.env, CI_TIMEOUT_PROBE_LOG: output, TMPDIR: root }, timeout: 4000, maxBuffer: 1024 * 1024 });
    } catch (error: unknown) { failure = error; }
    expect(failure).toMatchObject({ code: 1 });
    expect(String((failure as { stderr: string }).stderr)).toContain('Test timed out in 250ms');
    const events = (await readFile(output, 'utf8')).trim().split('\n').map((line: string) => ProbeEventSchema.parse(JSON.parse(line)));
    const phases: string[] = events.map((entry): string => entry.phase);
    console.info(JSON.stringify({ event: 'timeout-cleanup-evidence', events }));
    expect(phases).toContain('journal-prepared'); expect(phases).toContain('test-aborted');
    expect(phases.indexOf('operation-settled')).toBeLessThan(phases.indexOf('store-close-start'));
    expect(phases.indexOf('operation-settled')).toBeLessThan(phases.indexOf('root-remove-start'));
    expect(phases).not.toContain('cleanup-or-writer-error');
  } finally { await rm(root, { recursive: true, force: true }); }
});

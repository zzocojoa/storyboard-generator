import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';
import { z } from 'zod';

const execute = promisify(execFile);
const ProbeEventSchema = z.object({ phase: z.string(), pid: z.number(), elapsedMs: z.number() });
const ProbeReportSchema = z.object({ numTotalTests: z.literal(1), numFailedTests: z.literal(1),
  testResults: z.array(z.object({ assertionResults: z.array(z.object({ failureMessages: z.array(z.string()) })) })) });

it('vitest_timeout_drains_writer_before_store_close_and_root_removal', async (): Promise<void> => {
  const root: string = await mkdtemp(join(tmpdir(), 'timeout-observer-'));
  const output: string = join(root, 'events.jsonl');
  const report: string = join(root, 'result.json');
  try {
    let failure: unknown = null;
    try {
      await execute(process.execPath, [resolve('node_modules/vitest/vitest.mjs'), 'run', '--config', 'tests/fixtures/ci-timeout/vitest.config.ts',
        '--reporter=default', '--reporter=json', '--outputFile', report],
        { env: { ...process.env, CI_TIMEOUT_PROBE_LOG: output, TMPDIR: root }, timeout: 4000, killSignal: 'SIGKILL', maxBuffer: 1024 * 1024 });
    } catch (error: unknown) { failure = error; }
    expect(failure).toMatchObject({ code: 1 });
    expect(String((failure as { stderr: string }).stderr)).toContain('Test timed out in 250ms');
    const events = (await readFile(output, 'utf8')).trim().split('\n').map((line: string) => ProbeEventSchema.parse(JSON.parse(line)));
    const result = ProbeReportSchema.parse(JSON.parse(await readFile(report, 'utf8')));
    const errors: string[] = result.testResults.flatMap(file => file.assertionResults.flatMap(test => test.failureMessages));
    expect(errors).toHaveLength(1); expect(errors[0]).toContain('Test timed out in 250ms');
    expect(String((failure as { stderr: string }).stderr)).not.toMatch(/Unhandled|Uncaught/);
    const phases: string[] = events.map((entry): string => entry.phase);
    const diagnostics: string | undefined = process.env['STORYBOARD_TEST_DIAGNOSTICS_DIR'];
    if (diagnostics !== undefined) {
      await mkdir(diagnostics, { recursive: true });
      await writeFile(join(diagnostics, `timeout-probe-${process.pid}.json`), JSON.stringify({ events, errors }, null, 2));
    }
    console.info(JSON.stringify({ event: 'timeout-cleanup-evidence', events }));
    expect(phases).toContain('journal-prepared'); expect(phases).toContain('test-aborted');
    expect(phases.indexOf('journal-prepared')).toBeLessThan(phases.indexOf('test-start'));
    expect(phases.indexOf('operation-settled')).toBeLessThan(phases.indexOf('store-close-start'));
    expect(phases.indexOf('operation-settled')).toBeLessThan(phases.indexOf('root-remove-start'));
    expect(phases).not.toContain('cleanup-or-writer-error');
  } finally { await rm(root, { recursive: true, force: true }); }
});

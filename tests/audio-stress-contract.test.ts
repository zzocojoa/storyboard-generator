import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { get } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import { AudioServerDiagnostics } from './audio-diagnostics.js';
import type { AudioLifecycleEvent } from './audio-diagnostics.js';
import { ObservedAudioNormalizer, ObservedAudioStore } from './e2e/audio-observers.js';
import { TEST_AUDIO_NORMALIZATION_OPTIONS } from './helpers.js';
import { summarizeAudioStress } from '../scripts/audio-stress-reporter.js';
import type { AudioCaseResult, ExpectedAudioCase } from '../scripts/audio-stress-reporter.js';
import { expect, it } from 'vitest';
async function workflow(): Promise<string> { return readFile('.github/workflows/audio-stress.yml', 'utf8'); }
async function diagnostics(): Promise<string> { return readFile('tests/audio-diagnostics.ts', 'utf8'); }
it('audio_stress_workflow_has_no_test_retry', async (): Promise<void> => {
  expect(await workflow()).not.toMatch(/--retries|continue-on-error/u); expect(await readFile('playwright.config.ts', 'utf8')).toContain('retries: 0');
  expect(await workflow()).toContain('shell: bash');
});
it('audio_stress_workflow_keeps_default_timeouts', async (): Promise<void> => {
  expect(await workflow()).not.toContain('--timeout'); expect(await readFile('playwright.config.ts', 'utf8')).not.toMatch(/timeout:|setTimeout/u);
});
it('audio_stress_workflow_uses_real_audio_spec', async (): Promise<void> => {
  const value: string = await workflow(); expect(value).toContain('tests/e2e/real-audio.spec.ts'); expect(value).toContain('ubuntu-latest'); expect(value).toContain('node-version: 24');
  expect(await readFile('.github/workflows/ci.yml', 'utf8')).toContain('real-audio.spec.ts --repeat-each=3');
});
it('audio_stress_workflow_supports_50_to_100_repetitions', async (): Promise<void> => {
  const value: string = await workflow(); for (const part of ['workflow_dispatch:', 'schedule:', "default: '50'", "- '100'", '--repeat-each=']) expect(value).toContain(part);
});
it('audio_stress_failure_uploads_trace_and_logs', async (): Promise<void> => {
  const value: string = await workflow(); for (const part of ['actions/upload-artifact@v4', 'if: failure()', 'test-results/', '.local/audio-stress/', 'audio-stress-reporter.ts']) expect(value).toContain(part);
  expect(await readFile('playwright.config.ts', 'utf8')).toContain("trace: 'retain-on-failure'");
  expect(value).toContain('include-hidden-files: true');
});
it('audio_diagnostics_record_request_send_finish_close', async (): Promise<void> => {
  const value: string = await diagnostics(); for (const part of ["'request'", "'send'", "'finish'", "'close'", "'aborted'", "'socket-error'", 'rangePresent', 'elapsedMs']) expect(value).toContain(part);
});
it('audio_diagnostics_record_browser_media_events', async (): Promise<void> => {
  const value: string = await diagnostics(); for (const part of ["'loadedmetadata'", "'canplay'", "'playing'", "'seeking'", "'seeked'", "'pause'", "'ended'", "'error'", 'currentTime', 'duration', 'networkState', 'readyState']) expect(value).toContain(part);
});

async function consumeAudio(url: string): Promise<void> {
  return new Promise<void>((done, reject): void => {
    const request = get(url, { agent: false, headers: { Range: 'bytes=0-63', 'X-Private': 'PRIVATE_HEADER' } }, (response): void => {
      response.on('error', reject); response.on('end', done); response.resume();
    }); request.on('error', reject);
  });
}
async function observedServer(): Promise<{ app: FastifyInstance; diagnostics: AudioServerDiagnostics; url: string }> {
  const app: FastifyInstance = Fastify({ logger: false }); const diagnostics: AudioServerDiagnostics = new AudioServerDiagnostics(app);
  app.get('/output/audio/:cueId', async (_request, reply): Promise<Buffer> => { reply.type('audio/wav'); return Buffer.from('PRIVATE_MEDIA_BYTES'); });
  const url: string = await app.listen({ host: '127.0.0.1', port: 0 }); return { app, diagnostics, url };
}
it('audio_diagnostics_do_not_log_media_bytes', async (): Promise<void> => {
  const value = await observedServer();
  try {
    await consumeAudio(`${value.url}/output/audio/cue`);
  } finally { await value.app.close(); await value.diagnostics.waitForClosedConnections(); value.diagnostics.dispose(); }
  const events = value.diagnostics.events();
  expect(events.map((event): string => event.event)).toEqual(['request', 'send', 'finish', 'close']);
  expect(events[1]).toMatchObject({ rangePresent: true, bytes: 19, status: 200, method: 'GET', route: '/output/audio/:cueId' });
  const serialized: string = JSON.stringify(events); expect(serialized).not.toContain('PRIVATE_MEDIA_BYTES'); expect(serialized).not.toContain('PRIVATE_HEADER');
  expect(value.diagnostics.resources()).toEqual({ listeners: 0, sockets: 0, requests: 0 });
});
it('audio_diagnostics_cleanup_all_contexts_and_resources', async (): Promise<void> => {
  const root: string = await realpath(await mkdtemp(join(tmpdir(), 'audio-cleanup-'))); const events: AudioLifecycleEvent[] = [];
  const record = (event: AudioLifecycleEvent): void => { events.push(event); };
  const store: ObservedAudioStore = new ObservedAudioStore(root, record); const normalizer: ObservedAudioNormalizer = new ObservedAudioNormalizer(TEST_AUDIO_NORMALIZATION_OPTIONS, record);
  try { await store.initialize(); expect(store.heartbeatTimers()).toBe(1); }
  finally { await Promise.all([store.close(), normalizer.close()]); await rm(root, { recursive: true, force: true }); }
  expect(events.map((event: AudioLifecycleEvent): string => event.event).sort()).toEqual(['store-close-end', 'store-close-start', 'worker-close-end', 'worker-close-start']);
  expect(store.heartbeatTimers()).toBe(0); expect(normalizer.diagnostics()).toEqual({ closed: true, activeWorkers: 0, queuedJobs: 0, queueTimers: 0, executionTimers: 0, reservedInputBytes: 0 });
  const browserCheck: string = await readFile('tests/e2e/real-audio.spec.ts', 'utf8'); expect(browserCheck).toContain('expect(contextClosed).toBe(true)'); expect(browserCheck).toContain('browserContexts: 0');
});
it('audio_stress_summary_preserves_first_failed_repetition', (): void => {
  const expected: ExpectedAudioCase[] = [{ key: 'a1', title: 'decode', repetition: 1 }, { key: 'b1', title: 'seek', repetition: 1 }, { key: 'a2', title: 'decode', repetition: 2 }, { key: 'b2', title: 'seek', repetition: 2 }];
  const results: AudioCaseResult[] = expected.slice(0, 3).map((entry, index): AudioCaseResult => ({ ...entry, status: index === 2 ? 'failed' : 'passed', retry: 0, durationMs: 1 }));
  expect(summarizeAudioStress(expected, results, 2, 'failed', 0)).toMatchObject({ successfulRepetitions: 1, failedRepetitions: 1, firstFailedRepetition: 2, firstFailedTest: 'decode', passedTests: 2, failedTests: 1, notRunTests: 1, retriesObserved: 0 });
});
it('audio_stress_summary_does_not_count_incomplete_repetition_as_success', (): void => {
  const expected: ExpectedAudioCase[] = [{ key: 'a1', title: 'decode', repetition: 1 }, { key: 'b1', title: 'seek', repetition: 1 }];
  expect(summarizeAudioStress(expected, [{ ...expected[0]!, status: 'passed', retry: 0, durationMs: 1 }], 1, 'interrupted', 0)).toMatchObject({ successfulRepetitions: 0, incompleteRepetitions: 1, firstFailedRepetition: null, notRunTests: 1 });
});

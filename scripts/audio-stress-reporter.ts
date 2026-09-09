import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { FullConfig, FullResult, Reporter, Suite, TestCase, TestResult } from '@playwright/test/reporter';

export type ExpectedAudioCase = { key: string; title: string; repetition: number };
export type AudioCaseResult = ExpectedAudioCase & { status: TestResult['status']; retry: number; durationMs: number };
export type AudioStressSummary = {
  repetitions: number; expectedTests: number; passedTests: number; failedTests: number; skippedTests: number; notRunTests: number;
  successfulRepetitions: number; failedRepetitions: number; incompleteRepetitions: number;
  firstFailedRepetition: number | null; firstFailedTest: string | null; retriesObserved: number;
  unexpectedHeartbeatErrors: number; status: string; results: readonly AudioCaseResult[];
};

/** 각 반복의 모든 Case가 통과한 경우만 성공 반복으로 세고 첫 실패를 실행 순서대로 보존한다. */
export function summarizeAudioStress(expected: readonly ExpectedAudioCase[], results: readonly AudioCaseResult[], repetitions: number, status: string, heartbeatErrors: number): AudioStressSummary {
  const failed: AudioCaseResult[] = results.filter((result: AudioCaseResult): boolean => !['passed', 'skipped'].includes(result.status));
  const passed: AudioCaseResult[] = results.filter((result: AudioCaseResult): boolean => result.status === 'passed');
  let successfulRepetitions: number = 0; let failedRepetitions: number = 0;
  for (let repetition: number = 1; repetition <= repetitions; repetition += 1) {
    const cases: ExpectedAudioCase[] = expected.filter((entry: ExpectedAudioCase): boolean => entry.repetition === repetition);
    if (failed.some((entry: AudioCaseResult): boolean => entry.repetition === repetition)) failedRepetitions += 1;
    else if (cases.length > 0 && cases.every((entry: ExpectedAudioCase): boolean => passed.some((result: AudioCaseResult): boolean => result.key === entry.key))) successfulRepetitions += 1;
  }
  return { repetitions, expectedTests: expected.length, passedTests: passed.length, failedTests: failed.length,
    skippedTests: results.filter((result: AudioCaseResult): boolean => result.status === 'skipped').length,
    notRunTests: expected.filter((entry: ExpectedAudioCase): boolean => !results.some((result: AudioCaseResult): boolean => result.key === entry.key)).length,
    successfulRepetitions, failedRepetitions, incompleteRepetitions: repetitions - successfulRepetitions - failedRepetitions,
    firstFailedRepetition: failed[0]?.repetition ?? null, firstFailedTest: failed[0]?.title ?? null,
    retriesObserved: results.filter((result: AudioCaseResult): boolean => result.retry > 0).length,
    unexpectedHeartbeatErrors: heartbeatErrors, status, results: [...results] };
}
function expectedCase(test: TestCase): ExpectedAudioCase { return { key: `${test.id}:${test.repeatEachIndex}`, title: test.title, repetition: test.repeatEachIndex + 1 }; }

/** Playwright의 완료 이벤트를 즉시 파일로 남겨 첫 실패 이후 중단돼도 Summary를 보존한다. */
export default class AudioStressReporter implements Reporter {
  #expected: ExpectedAudioCase[] = [];
  #results: AudioCaseResult[] = [];
  #repetitions: number = 0;
  #heartbeatErrors: number = 0;
  readonly #output: string = resolve('test-results/audio-stress-summary.json');
  onBegin(config: FullConfig, suite: Suite): void {
    this.#expected = suite.allTests().map(expectedCase);
    this.#repetitions = Math.max(0, ...config.projects.map((project): number => project.repeatEach)); this.#write('running');
  }
  onTestEnd(test: TestCase, result: TestResult): void {
    this.#results.push({ ...expectedCase(test), status: result.status, retry: result.retry, durationMs: result.duration }); this.#write('running');
  }
  onStdErr(chunk: string | Buffer): void {
    this.#heartbeatErrors += (chunk.toString().match(/project-store-heartbeat-failed/gu) ?? []).length;
  }
  onEnd(result: FullResult): void { this.#write(result.status); }
  #write(status: string): void {
    mkdirSync(dirname(this.#output), { recursive: true }); const temporary: string = `${this.#output}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(summarizeAudioStress(this.#expected, this.#results, this.#repetitions, status, this.#heartbeatErrors), null, 2)}\n`);
    renameSync(temporary, this.#output);
  }
}

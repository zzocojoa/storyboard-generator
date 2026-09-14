import { readInstalledSpeechVoices } from '../codex/speech-voices.js';
import type { FastifyBaseLogger } from 'fastify';
import { tmpdir } from 'node:os';
import { AutomationDiskSpace, readDiskSpace } from '../automation/disk-space.js';
import { AutomationApplicationStore } from '../automation/application-store.js';
import { AutomationRunStore } from '../automation/run-store.js';
import { AutomationService } from '../automation/service.js';
import { AutomaticSpeechCache } from '../automation/speech-cache.js';
import { createAutomationEngines } from '../automation/task-executor.js';
import { buildForSpeechVoice, generatorBuildProvenance } from '../build.js';
import type { AppConfig } from './config.js';
import type { ProjectStore } from './store.js';

export function createAutomationRuntime(config: AppConfig, projects: ProjectStore, logger: FastifyBaseLogger): AutomationService | null {
  const runtime = config.automation;
  if (runtime === undefined) return null;
  return new AutomationService({ listSpeechVoices: () => readInstalledSpeechVoices(runtime.sayExecutable, tmpdir(), AbortSignal.timeout(5000)), services: {
    projects, runs: new AutomationRunStore(runtime.root, async (): Promise<void> => {}),
    applications: new AutomationApplicationStore(runtime.root, 1024 * 1024 * 1024, async (): Promise<void> => {}),
    speechCache: new AutomaticSpeechCache(runtime.root, async (): Promise<void> => {}),
    diskSpace: new AutomationDiskSpace({ project: config.dataRoot, automation: runtime.root, temporary: tmpdir() }, runtime.minimumFreeBytes, readDiskSpace),
    generatorBuild: generatorBuildProvenance(buildForSpeechVoice(config.codex.speechVoice)), textFontPath: { defaultPath: config.pdfFontPath, registrations: config.textFonts ?? [] },
    engines: (settings, remainingMs) => createAutomationEngines(runtime, settings, remainingMs),
    onProgress: async (runId, jobId, progress): Promise<void> => { logger.info({ event: 'automation-progress', runId, jobId, progress }, '자동 제작 진행'); },
    onSpeechReady: async (runId, attemptId, speech): Promise<void> => { logger.info({ event: 'automation-speech-measured', runId, attemptId, cueId: speech.cueId, durationMs: speech.result.inspection.durationMs, bytes: speech.result.bytes.length, cache: speech.result.cacheEvidence }, '가이드 음성 준비 완료'); },
    onWarning: async (runId, jobId, problem): Promise<void> => { logger.warn({ event: 'automation-retry', runId, jobId, problem }, '자동 제작의 일시 오류를 유한 재시도합니다.'); },
  }, onError: (runId, problem): void => { logger.error({ event: 'automation-service-error', runId, problem }, '자동 제작 실행 또는 저장 정산에 실패했습니다.'); } });
}

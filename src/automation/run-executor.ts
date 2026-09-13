import type { TextFontSource } from '../rendering/text-font-source.js';
import { randomUUID } from 'node:crypto';
import { sameGenerationBuild } from '../build-fingerprint.js';
import { contractError } from '../domain/errors.js';
import type { GeneratorBuildProvenance, Project } from '../domain/schema.js';
import type { ProjectStore } from '../server/store.js';
import { stableJsonStringify } from '../io/stable-json.js';
import { isDiskInterruption } from './disk-space.js';
import type { AutomationDiskSpace } from './disk-space.js';
import { automaticHash } from './application-evidence.js';
import type { AutomaticApplication } from './application-schema.js';
import type { AutomationApplicationStore } from './application-store.js';
import { nextAutomaticWork } from './job-graph.js';
import type { StagedSpeech } from './plan-audio.js';
import type { AutomationAttempt, AutomationJob, AutomationProblem, AutomationRunEvent, AutomationSettings } from './run-schema.js';
import { latestAttempt } from './run-state.js';
import type { AutomationRunSnapshot, AutomationRunStore } from './run-store.js';
import type { AutomaticSpeechCache } from './speech-cache.js';
import { executeAutomaticTask } from './task-executor.js';
import type { AutomationEngines, AutomaticTaskProgress } from './task-executor.js';

export type AutomationRunExecutionServices = {
  projects: ProjectStore; runs: AutomationRunStore; applications: AutomationApplicationStore; speechCache: AutomaticSpeechCache;
  generatorBuild: GeneratorBuildProvenance; textFontPath: TextFontSource;
  diskSpace: AutomationDiskSpace;
  engines: (settings: AutomationSettings, remainingMs: number) => AutomationEngines;
  onProgress: (runId: string, jobId: string, progress: AutomaticTaskProgress) => Promise<void>;
  onSpeechReady: (runId: string, attemptId: string, speech: StagedSpeech) => Promise<void>;
  onWarning: (runId: string, jobId: string, problem: AutomationProblem) => Promise<void>;
};

function problemFor(error: unknown): AutomationProblem {
  const code: string = error instanceof Error && 'code' in error && typeof error.code === 'string' ? error.code : error instanceof Error ? error.name : 'AUTOMATION_UNKNOWN_FAILURE';
  return { code: code.slice(0, 200), message: (error instanceof Error ? error.message : String(error)).slice(0, 16000) || '자동 제작 중 알 수 없는 오류가 발생했습니다.' };
}

function retryable(problem: AutomationProblem): boolean {
  return ['CODEX_ENGINE_EXIT', 'CODEX_ENGINE_IO', 'CODEX_RPC_TIMEOUT', 'CODEX_IMAGE_ASPECT_MISMATCH', 'AUTOMATION_PROCESS_INTERRUPTED'].includes(problem.code);
}

function requireBinding(application: AutomaticApplication, snapshot: AutomationRunSnapshot, job: AutomationJob, attempt: AutomationAttempt): void {
  if (application.id !== attempt.id || application.runId !== snapshot.run.id || application.jobId !== job.id || application.projectId !== snapshot.run.projectId
    || application.settingsHash !== snapshot.run.settingsHash || application.basisRevision !== attempt.revision || application.basisProjectHash !== attempt.projectHash
    || (attempt.applicationHash !== null && automaticHash(application) !== attempt.applicationHash)) {
    throw contractError('AUTOMATION_APPLICATION_BINDING', `저장 후보와 실행·작업·입력 기준이 다릅니다: runId=${snapshot.run.id}, jobId=${job.id}, attemptId=${attempt.id}`, []);
  }
}

/** 브라우저와 독립된 실행 루프다. 실제 게시 영수증을 정산한 뒤에만 다음 생성으로 진행한다. */
export class AutomationRunExecutor {
  readonly #services: AutomationRunExecutionServices;
  constructor(services: AutomationRunExecutionServices) { this.#services = { ...services, generatorBuild: structuredClone(services.generatorBuild) }; }

  async run(id: string, signal: AbortSignal): Promise<AutomationRunSnapshot> {
    return this.#services.runs.withWorker(id, async (assertOwnership): Promise<AutomationRunSnapshot> => this.#work(id, signal, assertOwnership));
  }

  /** Worker가 종료한 뒤 취소한다. 이미 게시된 결과는 정산하고 미게시 결과는 보존한다. */
  async cancel(id: string): Promise<AutomationRunSnapshot> {
    const { runs, applications, projects } = this.#services;
    return runs.withWorker(id, async (assertOwnership): Promise<AutomationRunSnapshot> => {
      let snapshot = await runs.read(id);
      const append = async (event: AutomationRunEvent): Promise<void> => { await assertOwnership(); snapshot = await runs.append(id, snapshot.sequence, event); };
      const at = (): string => new Date(Math.max(Date.now(), Date.parse(snapshot.run.updatedAt))).toISOString();
      if (snapshot.run.status === 'cancelled' || snapshot.run.status === 'review-ready') return snapshot;
      if (snapshot.run.status === 'running') await append({ type: 'paused', reason: '사용자가 자동 제작 취소를 요청했습니다.', at: at() });
      for (const job of snapshot.run.jobs) {
        const attempt = latestAttempt(job);
        if (attempt?.status !== 'applying') continue;
        const application = await applications.findPrepared(attempt.id);
        if (application === null) throw contractError('AUTOMATION_PREPARED_RESULT_MISSING', `취소할 적용 후보를 찾을 수 없습니다: ${attempt.id}`, []);
        requireBinding(application, snapshot, job, attempt);
        const receipt = await applications.reconcile(attempt.id, projects);
        if (receipt !== null) await append({ type: 'attempt-committed', jobId: job.id, attemptId: attempt.id, receipt, at: at() });
        else await append({ type: 'apply-uncommitted', jobId: job.id, attemptId: attempt.id, problem: { code: 'AUTOMATION_CANCELLED', message: '게시되지 않은 생성 후보를 보존하고 실행을 취소했습니다.' }, at: at() });
      }
      await append({ type: 'cancelled', at: at() });
      return snapshot;
    });
  }

  async #work(id: string, signal: AbortSignal, assertOwnership: () => Promise<void>): Promise<AutomationRunSnapshot> {
    const services = this.#services;
    let snapshot: AutomationRunSnapshot = await services.runs.read(id);
    const at = (): string => new Date(Math.max(Date.now(), Date.parse(snapshot.run.updatedAt))).toISOString();
    const append = async (event: AutomationRunEvent): Promise<void> => {
      await assertOwnership(); snapshot = await services.runs.append(id, snapshot.sequence, event);
    };
    const pause = async (): Promise<AutomationRunSnapshot> => {
      if (snapshot.run.status === 'running') await append({ type: 'paused', reason: '사용자 또는 서버 종료 요청으로 실행을 중단했습니다. 완료 결과와 준비 파일은 보존합니다.', at: at() });
      return snapshot;
    };
    const attention = async (problem: AutomationProblem): Promise<AutomationRunSnapshot> => {
      await append({ type: 'needs-attention', problem, at: at() }); return snapshot;
    };
    const prepared = async (job: AutomationJob, attempt: AutomationAttempt, application: AutomaticApplication): Promise<void> => {
      requireBinding(application, snapshot, job, attempt);
      const total: number = snapshot.run.stagedBytes + await services.speechCache.bytes(id) + application.assets.reduce((sum, asset): number => sum + asset.size, 0);
      if (total > snapshot.run.settings.maxStagedBytes) throw contractError('AUTOMATION_STAGING_BUDGET', `음성 보존 파일과 생성 후보가 저장 한도를 초과했습니다: bytes=${total}, maxBytes=${snapshot.run.settings.maxStagedBytes}`, []);
      await append({ type: 'result-prepared', jobId: job.id, attemptId: attempt.id, applicationHash: automaticHash(application), stagedBytes: application.assets.reduce((sum, asset): number => sum + asset.size, 0), at: at() });
    };
    const settle = async (job: AutomationJob, attempt: AutomationAttempt): Promise<boolean> => {
      const application = await services.applications.findPrepared(attempt.id);
      if (application === null) throw contractError('AUTOMATION_PREPARED_RESULT_MISSING', `적용 중인 후보가 없습니다: ${attempt.id}`, []);
      requireBinding(application, snapshot, job, attempt);
      const receipt = await services.applications.reconcile(attempt.id, services.projects);
      if (receipt === null) return false;
      await append({ type: 'attempt-committed', jobId: job.id, attemptId: attempt.id, receipt, at: at() });
      return true;
    };

    while (true) {
      await assertOwnership();
      // 같은 Worker의 append가 반환한 Snapshot을 이어 쓴다. 외부 쓰기는 다음 CAS에서 검출한다.
      const active = snapshot.run.jobs.find((job): boolean => ['running', 'prepared', 'applying', 'interrupted'].includes(latestAttempt(job)?.status ?? ''));
      if (active !== undefined) {
        const attempt: AutomationAttempt = latestAttempt(active)!;
        // Commit 뒤 중단한 작업은 Build 변경·취소보다 먼저 정산한다.
        if (attempt.status === 'applying' && await settle(active, attempt)) continue;
        if (snapshot.run.status !== 'running') return snapshot;
        if (signal.aborted) return pause();
        if (!sameGenerationBuild(snapshot.run.generatorBuild, services.generatorBuild)) return attention({ code: 'AUTOMATION_BUILD_CHANGED', message: '실행 중 생성 코드·계약·음성 설정이 변경됐습니다. 이전 결과는 보존하며 같은 Build에서 재개해야 합니다.' });
        if (['running', 'interrupted'].includes(attempt.status)) {
          const application = await services.applications.findPrepared(attempt.id);
          if (application !== null) { await prepared(active, attempt, application); continue; }
          if (attempt.status === 'interrupted') {
            // 일시 중지 전에 끝나지 않은 호출은 새 시도 ID로만 다시 실행한다.
            const next = nextAutomaticWork(snapshot.run, await services.projects.read(snapshot.run.projectId));
            if (next.kind !== 'execute') throw contractError('AUTOMATION_INTERRUPTED_JOB', '중단한 작업의 재시도 대상을 찾을 수 없습니다.', []);
          } else {
            await append({ type: 'attempt-failed', jobId: active.id, attemptId: attempt.id, problem: { code: 'AUTOMATION_PROCESS_INTERRUPTED', message: '이전 실행이 결과 게시 전에 중단되었습니다. 유한 재시도 한도 안에서 다시 실행합니다.' }, at: at() });
            continue;
          }
        } else {
          try {
            const application = await services.applications.findPrepared(attempt.id);
            if (application === null) throw contractError('AUTOMATION_PREPARED_RESULT_MISSING', `적용 후보가 없습니다: ${attempt.id}`, []);
            await services.diskSpace.assertApplication(application.assets.reduce((sum, asset): number => sum + asset.size, 0));
          } catch (error: unknown) { return attention(problemFor(error)); }
          if (attempt.status === 'prepared') await append({ type: 'apply-started', jobId: active.id, attemptId: attempt.id, at: at() });
          try {
            const receipt = await services.applications.apply(attempt.id, services.projects, signal);
            await append({ type: 'attempt-committed', jobId: active.id, attemptId: attempt.id, receipt, at: at() });
          } catch (error: unknown) {
            const currentJob: AutomationJob = snapshot.run.jobs.find((job): boolean => job.id === active.id)!;
            if (await settle(currentJob, latestAttempt(currentJob)!)) continue;
            if (signal.aborted) return pause();
            // 미반영 후보를 실패로 소모하지 않는다. 사용자는 보존한 결과로 재개할 수 있다.
            return attention(problemFor(error));
          }
          continue;
        }
      }
      if (snapshot.run.status !== 'running') return snapshot;
      if (signal.aborted) return pause();
      if (!sameGenerationBuild(snapshot.run.generatorBuild, services.generatorBuild)) return attention({ code: 'AUTOMATION_BUILD_CHANGED', message: '현재 생성 Build가 실행 시작 당시와 다릅니다. 같은 Build에서 재개하거나 기존 실행을 취소하고 새 실행을 시작하세요.' });
      let project: Project;
      let work;
      try { project = await services.projects.read(snapshot.run.projectId); work = nextAutomaticWork(snapshot.run, project); }
      catch (error: unknown) { return attention(problemFor(error)); }
      if (work.kind === 'register') { await append({ type: 'jobs-added', jobs: work.jobs, at: at() }); continue; }
      if (work.kind === 'review') { await append({ type: 'review-ready', at: at() }); return snapshot; }
      const job: AutomationJob = work.job;
      try { await services.diskSpace.assertGeneration(snapshot.run.settings.maxStagedBytes - snapshot.run.stagedBytes); }
      catch (error: unknown) { return attention(problemFor(error)); }
      const prior = latestAttempt(job);
      if (prior?.problem !== null && prior?.problem !== undefined) {
        if (!retryable(prior.problem) && prior.status !== 'interrupted') return attention(prior.problem);
        if (job.attempts.length >= snapshot.run.settings.maxAttemptsPerJob) return attention(prior.problem);
        await services.onWarning(id, job.id, prior.problem);
      }
      const remainingMs: number = snapshot.run.settings.maxActiveMs - snapshot.run.activeMs - Math.max(0, Date.now() - Date.parse(snapshot.run.updatedAt));
      if (remainingMs <= 0) return attention({ code: 'AUTOMATION_TIME_BUDGET', message: '설정한 자동 제작 실행 시간을 모두 사용했습니다. 완료 결과는 검토할 수 있습니다.' });
      const attemptId: string = randomUUID();
      try { await append({ type: 'attempt-started', jobId: job.id, attemptId, revision: project.revision, projectHash: automaticHash(project), at: at() }); }
      catch (error: unknown) { return attention(problemFor(error)); }
      const controller = new AbortController();
      const deadline = setTimeout((): void => { controller.abort(contractError('AUTOMATION_TIME_BUDGET', '자동 제작 전체 실행 시간 한도에 도달했습니다.', [])); }, remainingMs);
      const combined = AbortSignal.any([signal, controller.signal]);
      try {
        const limit: number = snapshot.run.settings.maxStagedBytes - snapshot.run.stagedBytes;
        const engines: AutomationEngines = services.engines(snapshot.run.settings, remainingMs);
        const checkedEngines: AutomationEngines = {
          ...(engines.voiceCatalog === undefined ? {} : { voiceCatalog: engines.voiceCatalog }),
          model: { run: async (input, modelSignal) => { await services.diskSpace.assertGeneration(limit); return engines.model.run(input, modelSignal); } },
          image: { run: async (input, imageSignal) => { await services.diskSpace.assertGeneration(limit); return engines.image.run(input, imageSignal); } },
          speech: { run: async (input, speechSignal) => {
            await services.diskSpace.assertGeneration(limit);
            const result = await engines.speech.run(input, speechSignal);
            await services.diskSpace.assertPreservation(result.bytes.length + 64 * 1024);
            return result;
          } },
        };
        const cachedEngines: AutomationEngines = { ...checkedEngines, speech: { run: async (input, speechSignal) => services.speechCache.generate(
          { runId: id, projectId: snapshot.run.projectId, settingsHash: snapshot.run.settingsHash }, input, checkedEngines.speech, limit, speechSignal) } };
        const candidate = await executeAutomaticTask({ project, task: job.task, settings: snapshot.run.settings,
          remainingBytes: limit - await services.speechCache.bytes(id),
          provenance: { generationId: attemptId, generatorBuild: snapshot.run.generatorBuild, createdAt: at() } }, {
          store: services.projects, engines: cachedEngines, textFontPath: services.textFontPath,
          onProgress: async (progress): Promise<void> => { await assertOwnership(); await services.onProgress(id, job.id, progress); },
          onSpeechReady: async (speech): Promise<void> => { await assertOwnership(); await services.onSpeechReady(id, attemptId, speech); },
        }, combined);
        if (combined.aborted) throw controller.signal.aborted ? controller.signal.reason : contractError('AUTOMATION_CANCELLED', '자동 제작이 중단되었습니다.', []);
        await assertOwnership();
        const candidateBytes: number = candidate.writes.reduce((sum, write): number => sum + write.content.length, 0);
        const cachedBytes: number = await services.speechCache.bytes(id);
        if (candidateBytes + cachedBytes > limit) throw contractError('AUTOMATION_STAGING_BUDGET', `음성 보존 파일과 새 후보를 저장할 공간 한도가 부족합니다: cachedBytes=${cachedBytes}, candidateBytes=${candidateBytes}, remainingBytes=${limit}`, []);
        await services.diskSpace.assertPreservation(candidateBytes + Buffer.byteLength(stableJsonStringify(project)) + Buffer.byteLength(stableJsonStringify(candidate.project)));
        const application = await services.applications.prepare({ id: attemptId, runId: id, jobId: job.id, settingsHash: snapshot.run.settingsHash }, project, candidate.project, candidate.writes);
        await prepared(job, latestAttempt(snapshot.run.jobs.find((value): boolean => value.id === job.id)!)!, application);
      } catch (error: unknown) {
        const application = await services.applications.findPrepared(attemptId);
        if (application !== null) {
          const attempt = latestAttempt(snapshot.run.jobs.find((value): boolean => value.id === job.id)!)!;
          if (attempt.status === 'running') await prepared(job, attempt, application);
          if (signal.aborted) return pause();
          return attention(problemFor(error));
        }
        if (signal.aborted) return pause();
        const problem = problemFor(controller.signal.aborted ? controller.signal.reason : error);
        if (isDiskInterruption(problem.code)) {
          await append({ type: 'paused', reason: problem.message, at: at() });
          return attention(problem);
        }
        await append({ type: 'attempt-failed', jobId: job.id, attemptId, problem, at: at() });
        if (!retryable(problem)) return attention(problem);
      } finally { clearTimeout(deadline); }
    }
  }
}

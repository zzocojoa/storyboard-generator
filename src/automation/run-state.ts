import { automaticVoicePlanning } from './run-schema.js';
import { contractError } from '../domain/errors.js';
import { automaticHash } from './application-evidence.js';
import { AutomationRunCreatedSchema, AutomationRunEventSchema } from './run-schema.js';
import type { AutomationAttempt, AutomationJob, AutomationRun, AutomationRunCreated, AutomationRunEvent, AutomationTask } from './run-schema.js';

function invalid(message: string): never { throw contractError('AUTOMATION_RUN_TRANSITION', message, []); }
export function latestAttempt(job: AutomationJob): AutomationAttempt | null { return job.attempts.at(-1) ?? null; }
export function jobCompleted(job: AutomationJob): boolean { return latestAttempt(job)?.status === 'completed'; }
export function runTerminal(run: AutomationRun): boolean { return run.status === 'cancelled' || run.status === 'review-ready'; }

export function createAutomationRun(input: AutomationRunCreated): AutomationRun {
  const value = AutomationRunCreatedSchema.parse(input);
  if (new Set(value.segmentIds).size !== value.segmentIds.length) invalid('자동 제작 대상 구간은 중복될 수 없습니다.');
  return { id: value.id, projectId: value.projectId, segmentIds: value.segmentIds, settings: value.settings, generatorBuild: value.generatorBuild,
    ...(value.purpose === undefined ? {} : { purpose: value.purpose }),
    status: 'running', initialRevision: value.revision, initialProjectHash: value.projectHash, revision: value.revision, projectHash: value.projectHash,
    settingsHash: automaticHash({ settings: value.settings, generatorBuild: value.generatorBuild, ...(value.purpose === undefined ? {} : { purpose: value.purpose }) }),
    createdAt: value.at, updatedAt: value.at, activeMs: 0, imageAttempts: 0, stagedBytes: 0, jobs: [], problem: null };
}

function requireJob(run: AutomationRun, id: string): AutomationJob {
  const job = run.jobs.find((value): boolean => value.id === id);
  if (job === undefined) invalid(`자동 제작 작업을 찾을 수 없습니다: ${id}`);
  return job;
}
function requireAttempt(job: AutomationJob, id: string): AutomationAttempt {
  const attempt = latestAttempt(job);
  if (attempt?.id !== id) invalid(`현재 실행 시도와 다른 ID입니다: jobId=${job.id}, attemptId=${id}`);
  return attempt;
}
function changeAttempt(run: AutomationRun, job: AutomationJob, attempt: AutomationAttempt): AutomationRun {
  return { ...run, jobs: run.jobs.map((value): AutomationJob => value.id === job.id ? { ...job, attempts: [...job.attempts.slice(0, -1), attempt] } : value) };
}
function executing(run: AutomationRun): void { if (run.status !== 'running') invalid(`현재 자동 제작이 실행 중이 아닙니다: ${run.status}`); }
function requireBasis(run: AutomationRun, revision: number, projectHash: string): void {
  if (revision !== run.revision || projectHash !== run.projectHash) throw contractError('AUTOMATION_RUN_STALE', `자동 실행 이후 프로젝트가 변경되었습니다. expectedRevision=${run.revision}, currentRevision=${revision}`, []);
}
function taskKey(task: AutomationTask): string {
  switch (task.kind) {
    case 'speech-retake': return automaticHash(task);
    case 'text-layout': return automaticHash({ kind: task.kind });
    case 'voice-casting': case 'production': return automaticHash({ kind: task.kind, segmentIds: [...task.segmentIds].sort() });
    case 'segment': case 'repair': case 'audio-mix': case 'audio-instructions': return automaticHash({ kind: task.kind, segmentId: task.segmentId });
    case 'reference': return automaticHash({ kind: task.kind, resourceId: task.resourceId });
    case 'image': return automaticHash({ kind: task.kind, frameId: task.frameId });
  }
}

/** 생성 시도·예산·중단·적용을 이벤트로 계산한다. 사람 승인 상태는 생성하지 않는다. */
export function reduceAutomationRun(input: AutomationRun, rawEvent: AutomationRunEvent): AutomationRun {
  const event = AutomationRunEventSchema.parse(rawEvent);
  const delta: number = Date.parse(event.at) - Date.parse(input.updatedAt);
  if (!Number.isSafeInteger(delta) || delta < 0) invalid('자동 실행 이벤트 시각이 이전 상태보다 빠릅니다.');
  if (event.type === 'created' || runTerminal(input)) invalid('이미 생성했거나 종료한 자동 실행은 다시 변경할 수 없습니다.');
  const run: AutomationRun = { ...structuredClone(input), updatedAt: event.at, activeMs: input.activeMs + (input.status === 'running' ? delta : 0) };
  switch (event.type) {
    case 'jobs-added': {
      executing(run);
      if (run.jobs.length + event.jobs.length > run.settings.maxJobs) throw contractError('AUTOMATION_JOB_BUDGET', '자동 제작 작업 수 한도를 초과했습니다.', []);
      const seen: Set<string> = new Set(run.jobs.map((job): string => job.id));
      const tasks: Set<string> = new Set(run.jobs.map((job): string => taskKey(job.task)));
      const productionSegments: Set<string> = new Set(run.jobs.flatMap((job): string[] => job.task.kind === 'production' ? job.task.segmentIds : []));
      for (const job of event.jobs) {
        if (run.purpose !== undefined ? automaticHash(job.task) !== automaticHash(run.purpose) : job.task.kind === 'speech-retake') invalid('선택 발화 재생성은 시작할 때 고정한 한 발화·음성·범위만 처리할 수 있습니다.');
        if (job.task.kind === 'voice-casting' && (!automaticVoicePlanning(run.settings) || new Set(job.task.segmentIds).size !== job.task.segmentIds.length || job.task.segmentIds.some((id): boolean => !run.segmentIds.includes(id)))) invalid('음성 자동 배정 설정과 선택 구간을 확인하세요.');
        if (job.task.kind === 'text-layout' && (!('textLayoutPlanning' in run.settings) || run.settings.textLayoutPlanning !== 'automatic')) invalid('글자 배치 자동 계획을 선택한 실행에서만 배치 작업을 등록할 수 있습니다.');
        if (job.task.kind === 'audio-mix' && (!('audioMixPlanning' in run.settings) || run.settings.audioMixPlanning !== 'automatic')) invalid('음량 자동 계획을 선택한 실행에서만 음량 작업을 등록할 수 있습니다.');
        if (seen.has(job.id) || tasks.has(taskKey(job.task))) invalid(`이미 등록한 자동 제작 작업입니다: ${job.id}`);
        if (new Set(job.dependsOn).size !== job.dependsOn.length || job.dependsOn.some((id): boolean => !seen.has(id))) invalid(`의존 작업은 앞서 등록한 서로 다른 작업이어야 합니다: ${job.id}`);
        if (job.task.kind === 'production' && (new Set(job.task.segmentIds).size !== job.task.segmentIds.length || job.task.segmentIds.some((id): boolean => !run.segmentIds.includes(id)) || job.task.segmentIds.length > run.settings.productionBatchSize)
          || (job.task.kind === 'segment' || job.task.kind === 'repair' || job.task.kind === 'audio-mix' || job.task.kind === 'audio-instructions') && !run.segmentIds.includes(job.task.segmentId)) invalid(`실행 범위를 벗어난 구간 작업입니다: ${job.id}`);
        if (job.task.kind === 'production') {
          if (job.task.segmentIds.some((id): boolean => productionSegments.has(id))) invalid(`제작 계획의 구간 범위가 중복됩니다: ${job.id}`);
          for (const id of job.task.segmentIds) productionSegments.add(id);
        }
        seen.add(job.id); tasks.add(taskKey(job.task));
      }
      return { ...run, jobs: [...run.jobs, ...event.jobs.map((job): AutomationJob => ({ ...job, attempts: [] }))] };
    }
    case 'attempt-started': {
      executing(run); requireBasis(run, event.revision, event.projectHash);
      if (run.activeMs >= run.settings.maxActiveMs) throw contractError('AUTOMATION_TIME_BUDGET', '자동 제작 실행 시간 한도에 도달했습니다.', []);
      if (run.jobs.some((job): boolean => ['running', 'prepared', 'applying'].includes(latestAttempt(job)?.status ?? ''))) invalid('이전 작업의 생성 또는 적용을 먼저 정산해야 합니다.');
      if (run.jobs.some((job): boolean => job.attempts.some((attempt): boolean => attempt.id === event.attemptId))) invalid('생성 시도 ID는 다시 사용할 수 없습니다.');
      const job = requireJob(run, event.jobId);
      if (jobCompleted(job) || job.dependsOn.some((id): boolean => !jobCompleted(requireJob(run, id)))) invalid('완료한 작업을 다시 실행하거나 미완료 의존 작업을 건너뛸 수 없습니다.');
      if (job.attempts.length >= run.settings.maxAttemptsPerJob) throw contractError('AUTOMATION_ATTEMPT_BUDGET', `작업의 유한 재시도 한도에 도달했습니다: ${job.id}`, []);
      const image: boolean = job.task.kind === 'image' || job.task.kind === 'reference';
      if (image && run.imageAttempts >= run.settings.maxImageAttempts) throw contractError('AUTOMATION_IMAGE_BUDGET', '자동 제작 이미지 시도 한도에 도달했습니다.', []);
      const attempt: AutomationAttempt = { id: event.attemptId, status: 'running', revision: event.revision, projectHash: event.projectHash,
        startedAt: event.at, finishedAt: null, applicationHash: null, stagedBytes: 0, committedRevision: null, problem: null };
      return { ...run, imageAttempts: run.imageAttempts + (image ? 1 : 0), jobs: run.jobs.map((value): AutomationJob => value.id === job.id ? { ...job, attempts: [...job.attempts, attempt] } : value) };
    }
    case 'result-prepared': {
      executing(run);
      const job = requireJob(run, event.jobId); const attempt = requireAttempt(job, event.attemptId);
      if (!['running', 'interrupted'].includes(attempt.status) || attempt.applicationHash !== null) invalid('실행 중이거나 중단 직전에 보존한 생성 결과만 준비 상태로 전환할 수 있습니다.');
      requireBasis(run, attempt.revision, attempt.projectHash);
      if (run.stagedBytes + event.stagedBytes > run.settings.maxStagedBytes) throw contractError('AUTOMATION_STAGING_BUDGET', '자동 제작의 누적 임시 파일 한도에 도달했습니다.', []);
      return { ...changeAttempt(run, job, { ...attempt, status: 'prepared', applicationHash: event.applicationHash, stagedBytes: event.stagedBytes, finishedAt: null, problem: null }), stagedBytes: run.stagedBytes + event.stagedBytes };
    }
    case 'apply-started': {
      executing(run);
      const job = requireJob(run, event.jobId); const attempt = requireAttempt(job, event.attemptId);
      if (attempt.status !== 'prepared') invalid('검증된 준비 결과만 프로젝트에 적용할 수 있습니다.');
      return changeAttempt(run, job, { ...attempt, status: 'applying' });
    }
    case 'attempt-committed': {
      const job = requireJob(run, event.jobId); const attempt = requireAttempt(job, event.attemptId); const receipt = event.receipt;
      if (attempt.status !== 'applying' || receipt.applicationId !== attempt.id || receipt.applicationHash !== attempt.applicationHash
        || receipt.projectId !== run.projectId || receipt.committedRevision !== attempt.revision + 1) invalid('완료 영수증과 현재 적용 시도가 일치하지 않습니다.');
      requireBasis(run, attempt.revision, attempt.projectHash);
      return { ...changeAttempt(run, job, { ...attempt, status: 'completed', committedRevision: receipt.committedRevision, finishedAt: event.at }), revision: receipt.committedRevision, projectHash: receipt.resultProjectHash };
    }
    case 'attempt-failed':
    case 'apply-uncommitted': {
      const job = requireJob(run, event.jobId); const attempt = requireAttempt(job, event.attemptId);
      if (event.type === 'attempt-failed' ? !['running', 'prepared'].includes(attempt.status) : attempt.status !== 'applying') invalid('실제 적용 여부를 정산한 후 실패 상태로 전환해야 합니다.');
      return changeAttempt(run, job, { ...attempt, status: 'failed', finishedAt: event.at, problem: event.problem });
    }
    case 'paused': {
      if (run.status !== 'running' && run.status !== 'needs-attention') invalid('이미 중단한 자동 실행입니다.');
      return { ...run, status: 'paused', problem: { code: 'AUTOMATION_PAUSED', message: event.reason }, jobs: run.jobs.map((job): AutomationJob => {
        const attempt = latestAttempt(job);
        return attempt?.status !== 'running' ? job : { ...job, attempts: [...job.attempts.slice(0, -1), { ...attempt, status: 'interrupted', finishedAt: event.at, problem: { code: 'AUTOMATION_INTERRUPTED', message: event.reason } }] };
      }) };
    }
    case 'resumed': {
      if (run.status !== 'paused' && run.status !== 'needs-attention') invalid('중단되거나 검토가 필요한 실행만 재개할 수 있습니다.');
      requireBasis(run, event.revision, event.projectHash);
      return { ...run, status: 'running', problem: null };
    }
    case 'cancelled': {
      if (run.jobs.some((job): boolean => ['running', 'applying'].includes(latestAttempt(job)?.status ?? ''))) invalid('실행을 중단하고 적용 결과를 정산한 후 취소해야 합니다.');
      return { ...run, status: 'cancelled', problem: null };
    }
    case 'needs-attention': {
      if (run.jobs.some((job): boolean => latestAttempt(job)?.status === 'running')) invalid('실행 중인 모델 호출을 먼저 중단해야 합니다.');
      return { ...run, status: 'needs-attention', problem: event.problem };
    }
    case 'review-ready': {
      executing(run);
      if (run.jobs.length === 0 || run.jobs.some((job): boolean => !jobCompleted(job))) invalid('모든 등록 작업의 실제 반영이 끝나야 검토 단계로 이동할 수 있습니다.');
      return { ...run, status: 'review-ready', problem: null };
    }
  }
}

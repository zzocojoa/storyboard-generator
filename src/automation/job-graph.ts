import { automationAudioProduction } from './run-schema.js';
import { missingVoiceCastingSpeakers } from './speech-settings.js';
import { automaticAudioMixTargets } from './audio-mix-basis.js';
import { automaticAudioInstructionTargets } from './audio-instruction-targets.js';
import { contractError } from '../domain/errors.js';
import type { Project } from '../domain/schema.js';
import { automaticHash } from './application-evidence.js';
import { textLayoutPlanningHash } from './plan-text-layout.js';
import { automaticShotProtected, sourceRepairScope } from './repair-basis.js';
import type { AutomationJob, AutomationJobDefinition, AutomationRun, AutomationTask } from './run-schema.js';
import { jobCompleted, latestAttempt } from './run-state.js';

export type AutomaticWork = { kind: 'register'; jobs: AutomationJobDefinition[] } | { kind: 'execute'; job: AutomationJob } | { kind: 'review' };

/** 같은 실행·같은 작업에는 재시작 후에도 같은 식별자를 배정한다. */
function jobId(runId: string, task: AutomationTask): string {
  const hex: string = automaticHash({ runId, task });
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

function register(run: AutomationRun, tasks: AutomationTask[]): AutomaticWork {
  if (run.jobs.length + tasks.length > run.settings.maxJobs) throw contractError('AUTOMATION_JOB_BUDGET', `파생 프레임을 포함한 작업 수가 한도 ${run.settings.maxJobs}개를 초과했습니다.`, []);
  const jobs: AutomationJobDefinition[] = tasks.map((task, index): AutomationJobDefinition => ({ id: jobId(run.id, task), task,
    dependsOn: index === 0 ? run.jobs.map((job): string => job.id) : [jobId(run.id, tasks[index - 1]!)] }));
  return { kind: 'register', jobs };
}

/** 시간순 계획→기준 그림→실측 음성·컷→프레임 그림을 현재 결과로 확장한다. 수동·확정 구간은 보존한다. */
export function nextAutomaticWork(run: AutomationRun, project: Project): AutomaticWork {
  if (run.status !== 'running') throw contractError('AUTOMATION_RUN_NOT_RUNNING', `중단되거나 종료한 자동 실행입니다: ${run.status}`, []);
  if (run.projectId !== project.projectId || run.revision !== project.revision || run.projectHash !== automaticHash(project)) throw contractError('AUTOMATION_RUN_STALE', '자동 실행 기준 이후 프로젝트가 변경되었습니다. 사용자의 편집을 보존하세요.', []);
  if (run.jobs.some((job): boolean => ['running', 'prepared', 'applying'].includes(latestAttempt(job)?.status ?? ''))) throw contractError('AUTOMATION_UNSETTLED_ATTEMPT', '진행 중인 생성·적용 작업을 정산한 후 다음 작업을 선택하세요.', []);
  const pending: AutomationJob[] = run.jobs.filter((job): boolean => !jobCompleted(job));
  if (pending.length > 0) {
    const ready = pending.find((job): boolean => job.dependsOn.every((id): boolean => run.jobs.some((dependency): boolean => dependency.id === id && jobCompleted(dependency))));
    if (ready === undefined) throw contractError('AUTOMATION_JOB_DEPENDENCY', '실행할 수 있는 선행 작업이 없습니다. 저장된 작업 연결을 확인하세요.', []);
    return { kind: 'execute', job: structuredClone(ready) };
  }
  const selected: Set<string> = new Set(run.segmentIds);
  if (run.purpose !== undefined) return run.jobs.length === 0 ? register(run, [run.purpose]) : { kind: 'review' };
  const instructions: AutomationTask[] = project.dataset.segments.filter((segment): boolean => selected.has(segment.id))
    .sort((left, right): number => left.startMs - right.startMs)
    .filter((segment): boolean => automaticAudioInstructionTargets(project, segment.id).length > 0)
    .map((segment): AutomationTask => ({ kind: 'audio-instructions', segmentId: segment.id }));
  if (instructions.length > 0) return register(run, instructions);
  if ('textLayoutPlanning' in run.settings && run.settings.textLayoutPlanning === 'automatic'
    && project.textLayoutControl.mode === 'automatic' && project.textCues.length > 0
    && project.textLayoutControl.plannedInputHash !== textLayoutPlanningHash(project)
    && !run.jobs.some((job): boolean => job.task.kind === 'text-layout')) return register(run, [{ kind: 'text-layout' }]);
  if (missingVoiceCastingSpeakers(project, run.segmentIds, run.settings).length > 0) {
    if (run.jobs.some((job): boolean => job.task.kind === 'voice-casting')) throw contractError('AUTOMATION_VOICE_CASTING_STALE', '원문 변경으로 음성 배정을 다시 확인해야 합니다. 현재 원본에서 새 실행을 시작하세요.', []);
    return register(run, [{ kind: 'voice-casting', segmentIds: [...run.segmentIds] }]);
  }
  const repairs: AutomationTask[] = project.dataset.segments.filter((segment): boolean => selected.has(segment.id))
    .sort((left, right): number => left.startMs - right.startMs)
    .filter((segment): boolean => project.shots.some((shot): boolean => shot.segmentId === segment.id && (shot.proposalOrigin !== 'source-outline' || automaticShotProtected(project, shot))))
    .filter((segment): boolean => !run.jobs.some((job): boolean => job.task.kind === 'repair' && job.task.segmentId === segment.id))
    .filter((segment): boolean => { const scope = sourceRepairScope(project, segment.id); return scope.soundCueIds.length > 0 || (automationAudioProduction(run.settings) === 'guide-voice'
      ? scope.targets.length > 0 || scope.audioCueIds.length > 0 || scope.speechCueIds.length > 0
      : scope.targets.some((target): boolean => { const link = project.shots.find((shot): boolean => shot.id === target.shotId)?.sourceLinks[target.linkIndex]; return link?.status !== 'confirmed' || link.temporalAnchor.status !== 'confirmed'; })); })
    .map((segment): AutomationTask => ({ kind: 'repair', segmentId: segment.id }));
  if (repairs.length > 0) return register(run, repairs);
  const protectedSegments: Set<string> = new Set(project.shots.filter((shot): boolean => automaticShotProtected(project, shot)).map((shot): string => shot.segmentId));
  const segments = project.dataset.segments.filter((segment): boolean => selected.has(segment.id) && !protectedSegments.has(segment.id)).sort((left, right): number => left.startMs - right.startMs);
  const planned: Set<string> = new Set(project.productionPlan?.segments.map((segment): string => segment.segmentId));
  const missingPlans: string[] = segments.filter((segment): boolean => !planned.has(segment.id)).map((segment): string => segment.id);
  if (missingPlans.length > 0) {
    const tasks: AutomationTask[] = [];
    for (let index: number = 0; index < missingPlans.length; index += run.settings.productionBatchSize) tasks.push({ kind: 'production', segmentIds: missingPlans.slice(index, index + run.settings.productionBatchSize) });
    return register(run, tasks);
  }
  const eligibleIds: Set<string> = new Set(segments.map((segment): string => segment.id));
  const resourceIds: Set<string> = new Set(project.productionPlan?.segments.filter((segment): boolean => eligibleIds.has(segment.segmentId)).flatMap((segment): string[] => segment.resourceIds));
  const firstUse = (id: string): number => Math.min(...segments.filter((segment): boolean => project.productionPlan?.segments.some((value): boolean => value.segmentId === segment.id && value.resourceIds.includes(id)) ?? false).map((segment): number => segment.startMs));
  const references = (project.productionPlan?.resources ?? []).filter((resource): boolean => resourceIds.has(resource.id) && resource.referenceAssetId === null)
    .sort((left, right): number => firstUse(left.id) - firstUse(right.id));
  if (references.length > 0) return register(run, references.map((resource): AutomationTask => ({ kind: 'reference', resourceId: resource.id })));
  const segmentTasks: AutomationTask[] = segments.filter((segment): boolean => !run.jobs.some((job): boolean => job.task.kind === 'segment' && job.task.segmentId === segment.id))
    .filter((segment): boolean => project.shots.filter((shot): boolean => shot.segmentId === segment.id).every((shot): boolean => shot.proposalOrigin === 'source-outline'))
    .map((segment): AutomationTask => ({ kind: 'segment', segmentId: segment.id, replaceShotIds: project.shots.filter((shot): boolean => shot.segmentId === segment.id).map((shot): string => shot.id) }));
  if (segmentTasks.length > 0) return register(run, segmentTasks);
  const imageShots = project.shots.filter((shot): boolean => selected.has(shot.segmentId) && shot.visualMode === 'sourced' && shot.approvalStatus !== 'approved' && shot.lockedFields.length === 0);
  const shots: Set<string> = new Set(imageShots.map((shot): string => shot.id));
  const initialImages: Set<string> = new Set(imageShots.filter((shot): boolean => eligibleIds.has(shot.segmentId)).map((shot): string => shot.id));
  // 명시적으로 재생성을 요청한 그림은 같은 구간의 다른 승인 그림 때문에 제외하지 않는다.
  const frames = project.frames.filter((frame): boolean => shots.has(frame.shotId) && frame.visualReview !== 'accepted'
    && (frame.visualReview === 'rejected' || initialImages.has(frame.shotId) && frame.imageAssetId === null))
    .filter((frame): boolean => !run.jobs.some((job): boolean => job.task.kind === 'image' && job.task.frameId === frame.id))
    .sort((left, right): number => (project.shots.find((shot): boolean => shot.id === left.shotId)!.startMs + left.offsetMs) - (project.shots.find((shot): boolean => shot.id === right.shotId)!.startMs + right.offsetMs));
  if (frames.length > 0) return register(run, frames.map((frame): AutomationTask => ({ kind: 'image', frameId: frame.id })));
  if (automationAudioProduction(run.settings) === 'guide-voice' && 'audioMixPlanning' in run.settings && run.settings.audioMixPlanning === 'automatic') {
    const mixes: AutomationTask[] = project.dataset.segments.filter((segment): boolean => selected.has(segment.id))
      .filter((segment): boolean => !run.jobs.some((job): boolean => job.task.kind === 'audio-mix' && job.task.segmentId === segment.id))
      .filter((segment): boolean => automaticAudioMixTargets(project, segment.id).length > 0)
      .map((segment): AutomationTask => ({ kind: 'audio-mix', segmentId: segment.id }));
    if (mixes.length > 0) return register(run, mixes);
  }
  if (run.jobs.length === 0) throw contractError('AUTOMATION_NO_WORK', '현재 선택에는 자동 생성할 항목이 없습니다. 보존된 결과를 검토하거나 필요한 프레임을 재생성으로 표시하세요.', []);
  return { kind: 'review' };
}

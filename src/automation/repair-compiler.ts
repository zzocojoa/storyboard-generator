import { reviewVisualPlanChangeIssues } from '../domain/edit.js';
import { contractError } from '../domain/errors.js';
import { reviewFinalReadiness } from '../domain/final-readiness.js';
import { assertGenerationRecordTransition } from '../domain/generation-records.js';
import { reviewIssuesForFrame } from '../domain/mapping.js';
import { ProjectSchema } from '../domain/schema.js';
import type { GenerationRecord, Issue, Project, Shot, StoryboardFrame } from '../domain/schema.js';
import { validateProject } from '../domain/validation.js';
import { stableJsonStringify } from '../io/stable-json.js';
import { validateExistingAudioScope } from './plan-audio.js';
import type { ExistingAudioFile, PlannedAssetWrite, StagedSpeech } from './plan-audio.js';
import { AutomaticPlanProvenanceSchema, automaticSpeechRecords } from './plan-compiler.js';
import type { AutomaticPlanProvenance } from './plan-compiler.js';
import { plannedSourceLink, sourceRevealFrames } from './plan-shots.js';
import { automaticEmissionIssues, automaticUnitOrderIssues } from './plan-validation.js';
import { assertSourceRepairBasis, SourceRepairResultSchema } from './repair-basis.js';
import type { SourceRepairBasis, SourceRepairPlan } from './repair-basis.js';
import { compileRepairAudio } from './repair-audio.js';

export type SourceRepairCandidate = { project: Project; writes: PlannedAssetWrite[]; exceptions: Issue[]; basis: SourceRepairBasis; plan: SourceRepairPlan };

function repairIssues(project: Project, segmentId: string): Issue[] {
  return [...validateProject(project, project.dataset), ...automaticEmissionIssues(project), ...automaticUnitOrderIssues(project, segmentId),
    ...project.frames.flatMap((frame): Issue[] => reviewIssuesForFrame(project, frame.id))];
}

function validateRepair(before: Project, next: Project, basis: SourceRepairBasis): Issue[] {
  const prior: Set<string> = new Set(repairIssues(before, basis.segmentId).map((value): string => stableJsonStringify(value)));
  const changed: string[] = [...new Set(basis.targets.map((target): string => target.shotId))];
  const current: Issue[] = repairIssues(next, basis.segmentId);
  const issues: Issue[] = [...changed.flatMap((id): Issue[] => reviewVisualPlanChangeIssues(before, next, id).blockingIssues),
    ...current.filter((value): boolean => value.severity === 'error' || value.severity === 'conflict' && (!prior.has(stableJsonStringify(value)) || basis.audioCueIds.includes(value.entityId) || basis.speechCueIds.includes(value.entityId)))];
  const unique: Issue[] = [...new Map(issues.map((value): [string, Issue] => [stableJsonStringify(value), value])).values()];
  if (unique.length > 0) throw contractError('AUTOMATION_REPAIR_INVALID', `${basis.segmentId}: 기존 컷과 확정 시각을 보존하면서 연결을 보정하세요.\n${unique.map((value): string => `${value.code}: ${value.entityId}.${value.field}: ${value.message}`).join('\n')}`, unique);
  return [...new Map(current.map((value): [string, Issue] => [stableJsonStringify(value), value])).values()];
}

/** 미정 연결과 미등록 발화를 함께 검사한다. 연출·컷 시각·기존 프레임과 모든 과거 자산은 보존한다. */
export function compileSourceRepair(project: Project, basis: SourceRepairBasis, input: unknown, files: readonly ExistingAudioFile[], speech: readonly StagedSpeech[], provenance: AutomaticPlanProvenance, maxFrames: number): SourceRepairCandidate {
  assertSourceRepairBasis(project, basis);
  AutomaticPlanProvenanceSchema.parse(provenance);
  const plan: SourceRepairPlan = SourceRepairResultSchema.parse(input);
  if (project.generationRecords.some((record): boolean => record.id === provenance.generationId || record.requestId === provenance.generationId)) throw contractError('AUTOMATION_DUPLICATE_GENERATION', `이미 사용한 연결 검토 ID입니다: ${provenance.generationId}`, []);
  const keys: string[] = plan.links.map((link): string => stableJsonStringify([link.shotId, link.linkIndex, link.unitId]));
  if (plan.segmentId !== basis.segmentId || new Set(keys).size !== keys.length || keys.length !== basis.targets.length
    || basis.targets.some((target): boolean => !keys.includes(stableJsonStringify([target.shotId, target.linkIndex, target.unitId])))) {
    throw contractError('AUTOMATION_REPAIR_SCOPE', '명시한 미정 링크마다 결과가 정확히 하나 필요합니다. 확정 링크·다른 컷을 수정하거나 원문을 누락하지 마세요.', []);
  }
  const evidence = validateExistingAudioScope(project, basis.segmentId, files);
  const changed: Set<string> = new Set(basis.targets.map((target): string => target.shotId));
  const shots: Shot[] = project.shots.map((shot): Shot => !changed.has(shot.id) ? shot : { ...shot, sourceLinks: shot.sourceLinks.map((link, index) => {
    const proposed = plan.links.find((value): boolean => value.shotId === shot.id && value.linkIndex === index);
    if (proposed !== undefined && link.status === 'confirmed' && proposed.usage !== link.usage) throw contractError('AUTOMATION_REPAIR_SCOPE', `${shot.id}/${link.unitId}: 이미 확정한 원문 용도는 ${link.usage}로 보존하고 미정 시각만 보완하세요.`, []);
    return proposed === undefined ? link : plannedSourceLink(project, basis.segmentId, shot, proposed);
  }) });
  const addedFrames: StoryboardFrame[] = shots.filter((shot): boolean => changed.has(shot.id)).flatMap((shot): StoryboardFrame[] => {
    const existing = project.frames.filter((frame): boolean => frame.shotId === shot.id);
    const ids: Set<string> = new Set(existing.map((frame): string => frame.id));
    return sourceRevealFrames(shot, existing, `${provenance.generationId}:${shot.id}`).filter((frame): boolean => !ids.has(frame.id));
  });
  if (!Number.isSafeInteger(maxFrames) || maxFrames < 1 || maxFrames > 2048
    || project.frames.filter((frame): boolean => shots.some((shot): boolean => shot.id === frame.shotId && shot.segmentId === basis.segmentId)).length + addedFrames.length > maxFrames) {
    throw contractError('AUTOMATION_FRAME_BUDGET', `연결 보완의 파생 프레임을 포함한 개수가 구간 한도 ${maxFrames}개를 초과했습니다.`, []);
  }
  const audio = compileRepairAudio(project, basis, plan, speech, evidence, provenance.generationId);
  const next: Project = ProjectSchema.parse({ ...project, shots, frames: [...project.frames, ...addedFrames], audioCues: audio.audioCues, assets: audio.assets });
  const sourceReview: Issue[] = validateRepair(project, next, basis);
  const integrity: Record<string, string> = Object.fromEntries([...evidence.map((value): [string, string] => [value.assetId, 'verified']),
    ...audio.assets.filter((asset): boolean => !project.assets.some((value): boolean => value.id === asset.id)).map((asset): [string, string] => [asset.id, 'verified'])]);
  const exceptions: Issue[] = [...new Map([...sourceReview, ...reviewFinalReadiness(next, integrity).issues]
    .map((value): [string, Issue] => [stableJsonStringify(value), value])).values()];
  const record: GenerationRecord = { id: provenance.generationId, provider: 'codex-app', model: provenance.model, modelVersion: null,
    requestId: provenance.generationId, templateVersion: `automatic-source-repair-${plan.schemaVersion}`, seed: null, createdAt: provenance.createdAt, generatorBuild: provenance.generatorBuild,
    prompt: stableJsonStringify({ input: provenance.prompt, output: plan, turnId: provenance.turnId, basis, existingAudio: evidence, remainingReview: exceptions }),
    referenceHashes: [basis.projectHash, ...evidence.map((value): string => value.inspection.sha256), ...speech.map((value): string => value.result.inspection.sha256)], resultAssetIds: [], shotIds: [...changed] };
  const candidate: Project = ProjectSchema.parse({ ...next, generationRecords: [...next.generationRecords, record, ...automaticSpeechRecords(next, speech, provenance)] });
  assertGenerationRecordTransition(project, candidate);
  return { project: candidate, writes: audio.writes, exceptions, basis: structuredClone(basis), plan };
}

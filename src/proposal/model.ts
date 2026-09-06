import { z } from 'zod';
import { contractError } from '../domain/errors.js';
import { effectiveInformationGate } from '../domain/mapping.js';
import type { Project, Segment, Shot, ShotSourceLink, SourceUnit, StoryboardFrame } from '../domain/schema.js';
import { PresenceSchema, ProjectSchema, ShotSourceLinkSchema, TransitionSchema } from '../domain/schema.js';
import { validateProject } from '../domain/validation.js';
import { assertNoErrors } from '../domain/errors.js';

export const ShotProposalSchema = z.strictObject({
  sourceLinks: z.array(ShotSourceLinkSchema.pick({ unitId: true, usage: true })).min(1), durationWeight: z.number().int().positive().max(10000),
  action: z.string().min(1), visualLocationId: z.string().min(1).nullable(),
  camera: z.strictObject({ size: z.string().min(1), angle: z.string().min(1), move: z.string().min(1) }),
  presence: z.array(PresenceSchema), propIds: z.array(z.string().min(1)),
  cameraAxis: z.string().min(1).nullable(), screenDirection: z.string().min(1).nullable(),
  informationIds: z.array(z.string().min(1)), transitionOut: TransitionSchema, frameDescription: z.string().min(1),
});
export const SegmentProposalSchema = z.strictObject({ shots: z.array(ShotProposalSchema).min(1).max(64) });
export type SegmentProposal = z.infer<typeof SegmentProposalSchema>;

function validateProposalSources(project: Project, segmentId: string, proposal: SegmentProposal): void {
  const sourceUnits: SourceUnit[] = project.dataset.units.filter((unit: SourceUnit): boolean => unit.segmentId === segmentId);
  const sourceIds: string[] = sourceUnits.map((unit: SourceUnit): string => unit.id);
  const proposedLinks = proposal.shots.flatMap((shot) => shot.sourceLinks);
  const proposedIds: string[] = proposedLinks.map((link): string => link.unitId);
  const unknown: string[] = [...new Set(proposedIds.filter((id: string): boolean => !sourceIds.includes(id)))];
  const missing: string[] = sourceIds.filter((id: string): boolean => !proposedIds.includes(id));
  if (unknown.length > 0 || missing.length > 0) throw contractError('PROPOSAL_SOURCE_COVERAGE', `${segmentId}: 원문 연결을 확인하세요. unknown=${unknown.join(',')}, missing=${missing.join(',')}`, []);
  let latestPrimaryOrder: number = 0;
  const primaryCounts: Map<string, number> = new Map<string, number>();
  for (const shot of proposal.shots) {
    for (const link of shot.sourceLinks) {
      if (link.usage !== 'primary-visual') continue;
      const unit: SourceUnit = sourceUnits.find((value: SourceUnit): boolean => value.id === link.unitId) as SourceUnit;
      if (unit.order < latestPrimaryOrder) throw contractError('PROPOSAL_SOURCE_ORDER_REVERSED', `${segmentId}: ${unit.id}(${unit.order})가 앞선 원문 순서 ${latestPrimaryOrder} 뒤에 역순 배치됐습니다.`, []);
      latestPrimaryOrder = Math.max(latestPrimaryOrder, unit.order);
      primaryCounts.set(unit.id, (primaryCounts.get(unit.id) ?? 0) + 1);
    }
  }
  const repeated: string[] = [...primaryCounts].filter(([, count]): boolean => count > 1).map(([id]): string => id);
  if (repeated.length > 0) throw contractError('PROPOSAL_DUPLICATE_PRIMARY_SOURCE', `${segmentId}: 반복 원문은 continued-visual 또는 context-only로 지정하세요. units=${repeated.join(',')}`, []);
}

function validateProposalInformation(project: Project, segment: Segment, proposal: SegmentProposal, durations: readonly number[]): void {
  proposal.shots.forEach((shot, index: number): void => {
    const startMs: number = segment.startMs + durations.slice(0, index).reduce((sum: number, duration: number): number => sum + duration, 0);
    const linkedUnits: SourceUnit[] = shot.sourceLinks.flatMap((link): SourceUnit[] => {
      const unit: SourceUnit | undefined = project.dataset.units.find((candidate: SourceUnit): boolean => candidate.id === link.unitId);
      return unit === undefined ? [] : [unit];
    });
    const directInformationIds: string[] = shot.sourceLinks.filter((link): boolean => ['primary-visual', 'continued-visual'].includes(link.usage)).flatMap((link): string[] => linkedUnits.find((unit: SourceUnit): boolean => unit.id === link.unitId)?.informationIds ?? []);
    for (const informationId of [...new Set([...shot.informationIds, ...directInformationIds])]) {
      const gate = effectiveInformationGate(project, informationId);
      if (gate.reviewRequired || startMs < gate.notBeforeMs) throw contractError('PROPOSAL_INFORMATION_GATE', `${segment.id}: ${informationId}를 ${startMs}ms 컷에 배치할 수 없습니다. notBefore=${gate.notBeforeMs}`, []);
      if (shot.informationIds.includes(informationId) && !linkedUnits.some((unit: SourceUnit): boolean => unit.informationIds.includes(informationId))) throw contractError('PROPOSAL_INFORMATION_WITHOUT_SOURCE', `${segment.id}: ${informationId}를 뒷받침하는 Source Link가 필요합니다.`, []);
    }
  });
}

function allocateDurations(duration: number, weights: readonly number[]): number[] {
  if (weights.length > duration) throw contractError('TOO_MANY_PROPOSED_SHOTS', `구간 ${duration}ms에 ${weights.length}개 컷을 만들 수 없습니다.`, []);
  const total: number = weights.reduce((sum: number, value: number): number => sum + value, 0);
  const base: number[] = weights.map((weight: number): number => Math.floor(duration * weight / total));
  let remaining: number = duration - base.reduce((sum: number, value: number): number => sum + value, 0);
  return base.map((value: number): number => {
    const extra: number = remaining > 0 ? 1 : 0;
    remaining -= extra;
    return value + extra;
  });
}

/** 모델 제안을 기존 구간에 적용하되 원문과 독립 트랙은 그대로 보존한다. */
export function applySegmentProposal(project: Project, segmentId: string, input: SegmentProposal, proposalId: string): Project {
  const proposal: SegmentProposal = SegmentProposalSchema.parse(input);
  const segment: Segment | undefined = project.dataset.segments.find((value): boolean => value.id === segmentId);
  if (segment === undefined) throw contractError('SEGMENT_NOT_FOUND', `${segmentId}: 구간을 찾을 수 없습니다.`, []);
  const oldShots: Shot[] = project.shots.filter((shot: Shot): boolean => shot.segmentId === segmentId);
  if (oldShots.some((shot: Shot): boolean => shot.approvalStatus === 'approved' || shot.lockedFields.length > 0)) throw contractError('SEGMENT_HAS_LOCKED_SHOTS', `${segmentId}: 확정 또는 잠긴 컷이 있어 전체 제안을 적용할 수 없습니다.`, []);
  if (project.textMappingDecisions.some((decision): boolean => decision.status === 'unresolved' && project.dataset.textPlacements.find((placement): boolean => placement.id === decision.placementId)?.segmentId === segmentId)
    || oldShots.some((shot: Shot): boolean => shot.sourceLinks.some((link: ShotSourceLink): boolean => link.status === 'mapping-required'))) throw contractError('SEGMENT_MAPPING_REVIEW_REQUIRED', `${segmentId}: 자막 또는 Source Mapping 검토를 먼저 끝내세요.`, []);
  validateProposalSources(project, segmentId, proposal);
  const durations: number[] = allocateDurations(segment.endMs - segment.startMs, proposal.shots.map((shot): number => shot.durationWeight));
  validateProposalInformation(project, segment, proposal, durations);
  const shots: Shot[] = proposal.shots.map((shot, index): Shot => {
    const startMs: number = segment.startMs + durations.slice(0, index).reduce((sum: number, value: number): number => sum + value, 0);
    return { id: `${proposalId}:shot:${index + 1}`, segmentId, startMs, endMs: startMs + (durations[index] as number),
      sourceLinks: shot.sourceLinks.map((link): ShotSourceLink => ({ ...link, status: 'confirmed' })), visualLocationId: shot.visualLocationId, action: shot.action, camera: shot.camera,
      presence: shot.presence, propIds: shot.propIds, continuityBefore: [], continuityAfter: [], cameraAxis: shot.cameraAxis,
      screenDirection: shot.screenDirection, informationIds: shot.informationIds, transitionOut: shot.transitionOut,
      proposalOrigin: 'model', approvalStatus: 'proposed', lockedFields: [] };
  });
  const frames: StoryboardFrame[] = proposal.shots.map((shot, index): StoryboardFrame => ({ id: `${proposalId}:frame:${index + 1}`,
    shotId: `${proposalId}:shot:${index + 1}`, offsetMs: 0, role: 'start', description: shot.frameDescription, imageAssetId: null, visualReview: 'pending' }));
  const firstIndex: number = project.shots.findIndex((shot: Shot): boolean => shot.segmentId === segmentId);
  const retained: Shot[] = project.shots.filter((shot: Shot): boolean => shot.segmentId !== segmentId);
  const allShots: Shot[] = [...retained.slice(0, firstIndex), ...shots, ...retained.slice(firstIndex)];
  const next: Project = ProjectSchema.parse({ ...project, shots: allShots,
    frames: [...project.frames.filter((frame: StoryboardFrame): boolean => !oldShots.some((shot: Shot): boolean => shot.id === frame.shotId)), ...frames] });
  assertNoErrors(validateProject(next, project.dataset), 'INVALID_MODEL_PROPOSAL');
  return next;
}

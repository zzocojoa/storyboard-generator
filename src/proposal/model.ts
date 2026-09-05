import { z } from 'zod';
import { contractError } from '../domain/errors.js';
import type { Project, Segment, Shot, StoryboardFrame } from '../domain/schema.js';
import { PresenceSchema, ProjectSchema, TransitionSchema } from '../domain/schema.js';
import { validateProject } from '../domain/validation.js';
import { assertNoErrors } from '../domain/errors.js';

export const ShotProposalSchema = z.strictObject({
  sourceUnitIds: z.array(z.string().min(1)).min(1), durationWeight: z.number().int().positive().max(10000),
  action: z.string().min(1), visualLocationId: z.string().min(1).nullable(),
  camera: z.strictObject({ size: z.string().min(1), angle: z.string().min(1), move: z.string().min(1) }),
  presence: z.array(PresenceSchema), propIds: z.array(z.string().min(1)),
  cameraAxis: z.string().min(1).nullable(), screenDirection: z.string().min(1).nullable(),
  informationIds: z.array(z.string().min(1)), transitionOut: TransitionSchema, frameDescription: z.string().min(1),
});
export const SegmentProposalSchema = z.strictObject({ shots: z.array(ShotProposalSchema).min(1).max(64) });
export type SegmentProposal = z.infer<typeof SegmentProposalSchema>;

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
  const sourceIds: string[] = project.dataset.units.filter((unit): boolean => unit.segmentId === segmentId).map((unit): string => unit.id);
  const proposedIds: string[] = proposal.shots.flatMap((shot): string[] => shot.sourceUnitIds);
  const unknown: string[] = [...new Set(proposedIds.filter((id: string): boolean => !sourceIds.includes(id)))];
  const missing: string[] = sourceIds.filter((id: string): boolean => !proposedIds.includes(id));
  if (unknown.length > 0 || missing.length > 0) throw contractError('PROPOSAL_SOURCE_COVERAGE', `${segmentId}: 원문 연결을 확인하세요. unknown=${unknown.join(',')}, missing=${missing.join(',')}`, []);
  const durations: number[] = allocateDurations(segment.endMs - segment.startMs, proposal.shots.map((shot): number => shot.durationWeight));
  const shots: Shot[] = proposal.shots.map((shot, index): Shot => {
    const startMs: number = segment.startMs + durations.slice(0, index).reduce((sum: number, value: number): number => sum + value, 0);
    return { id: `${proposalId}:shot:${index + 1}`, segmentId, startMs, endMs: startMs + (durations[index] as number),
      sourceUnitIds: [...shot.sourceUnitIds], visualLocationId: shot.visualLocationId, action: shot.action, camera: shot.camera,
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

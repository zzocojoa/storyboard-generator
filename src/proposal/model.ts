import { z } from 'zod';
import { contractError } from '../domain/errors.js';
import { effectiveInformationGate } from '../domain/mapping.js';
import type { Issue, Project, Segment, Shot, ShotSourceLink, SourceUnit, StoryboardFrame } from '../domain/schema.js';
import { PresenceSchema, ProjectSchema, ShotSourceLinkSchema, ShotVisualModeSchema, TransitionSchema } from '../domain/schema.js';
import { firstVisualRevealOrderIssues, shotVisualCoverageIssues, sourcePolicyIssues } from '../domain/source-policy.js';
import { validateProject } from '../domain/validation.js';
import { assertNoErrors } from '../domain/errors.js';

export const ProposedSourceAnchorSchema = z.strictObject({
  startPermille: z.number().int().min(0).max(999),
  endPermille: z.number().int().min(1).max(1000),
}).refine((value): boolean => value.startPermille < value.endPermille, { message: 'startPermille은 endPermille보다 작아야 합니다.' });

export const ProposedFrameSchema = z.strictObject({
  atPermille: z.number().int().min(0).max(1000),
  role: z.enum(['start', 'key', 'end']),
  description: z.string().trim().min(1),
}).superRefine((frame, context): void => {
  const valid: boolean = (frame.role === 'start' && frame.atPermille === 0)
    || (frame.role === 'end' && frame.atPermille === 1000)
    || (frame.role === 'key' && frame.atPermille > 0 && frame.atPermille < 1000);
  if (!valid) context.addIssue({ code: 'custom', message: 'Frame 역할과 atPermille 위치가 일치해야 합니다.', path: ['atPermille'] });
});

export const ShotProposalSchema = z.strictObject({
  sourceLinks: z.array(ShotSourceLinkSchema.pick({ unitId: true, usage: true }).extend({ anchor: ProposedSourceAnchorSchema.optional() })),
  visualMode: ShotVisualModeSchema.optional(), frames: z.array(ProposedFrameSchema).optional(),
  durationWeight: z.number().int().positive().max(10000),
  action: z.string().min(1), visualLocationId: z.string().min(1).nullable(),
  camera: z.strictObject({ size: z.string().min(1), angle: z.string().min(1), move: z.string().min(1) }),
  presence: z.array(PresenceSchema), propIds: z.array(z.string().min(1)),
  cameraAxis: z.string().min(1).nullable(), screenDirection: z.string().min(1).nullable(),
  informationIds: z.array(z.string().min(1)), transitionOut: TransitionSchema, frameDescription: z.string().min(1),
}).superRefine((shot, context): void => {
  const values: number[] = shot.frames?.map((frame): number => frame.atPermille) ?? [];
  for (const value of new Set(values.filter((candidate: number, index: number): boolean => values.indexOf(candidate) !== index))) {
    context.addIssue({ code: 'custom', message: `같은 Shot에서 Frame atPermille ${value}을 중복할 수 없습니다.`, path: ['frames'] });
  }
});
export const SegmentProposalSchema = z.strictObject({ shots: z.array(ShotProposalSchema).min(1).max(64) });
export type SegmentProposal = z.infer<typeof SegmentProposalSchema>;
export type ProposedSourceAnchor = z.infer<typeof ProposedSourceAnchorSchema>;

function proposalAnchor(durationMs: number, anchor: ProposedSourceAnchor | undefined): ShotSourceLink['temporalAnchor'] {
  const startOffsetMs: number = anchor === undefined ? 0 : Math.floor(durationMs * anchor.startPermille / 1000);
  const endOffsetMs: number = anchor === undefined ? durationMs : Math.ceil(durationMs * anchor.endPermille / 1000);
  if (startOffsetMs < 0 || startOffsetMs >= endOffsetMs || endOffsetMs > durationMs) {
    throw contractError('INVALID_PROPOSAL_SOURCE_ANCHOR', `제안 Source Anchor가 컷 범위를 벗어났습니다: duration=${durationMs}, start=${startOffsetMs}, end=${endOffsetMs}`, []);
  }
  return { kind: 'shot-offset', startOffsetMs, endOffsetMs, basis: 'proposal', status: 'confirmed' };
}

function validateProposalSources(project: Project, segmentId: string, proposal: SegmentProposal): void {
  const sourceUnits: SourceUnit[] = project.dataset.units.filter((unit: SourceUnit): boolean => unit.segmentId === segmentId);
  const sourceIds: string[] = sourceUnits.map((unit: SourceUnit): string => unit.id);
  const proposedLinks = proposal.shots.flatMap((shot) => shot.sourceLinks);
  const proposedIds: string[] = proposedLinks.map((link): string => link.unitId);
  const unknown: string[] = [...new Set(proposedIds.filter((id: string): boolean => !sourceIds.includes(id)))];
  const missing: string[] = sourceIds.filter((id: string): boolean => !proposedIds.includes(id));
  if (unknown.length > 0 || missing.length > 0) throw contractError('PROPOSAL_SOURCE_COVERAGE', `${segmentId}: 원문 연결을 확인하세요. unknown=${unknown.join(',')}, missing=${missing.join(',')}`, []);
  const policyShots = proposal.shots.map((shot, index: number) => ({ id: `${segmentId}:proposal:${index + 1}`, visualMode: shot.visualMode ?? 'sourced', sourceLinks: [...shot.sourceLinks]
    .sort((left, right): number => (left.anchor?.startPermille ?? 0) - (right.anchor?.startPermille ?? 0))
    .map((link): ShotSourceLink => ({
    unitId: link.unitId, usage: link.usage, status: 'confirmed', temporalAnchor: { kind: 'shot-offset', startOffsetMs: 0, endOffsetMs: 1, basis: 'proposal', status: 'confirmed' },
  })) }));
  const policyIssues = sourcePolicyIssues(sourceUnits, policyShots);
  if (policyIssues.length > 0) {
    const visualMissing: boolean = policyIssues.some((value): boolean => value.code === 'SHOT_VISUAL_SOURCE_REQUIRED');
    const code: string = visualMissing ? 'PROPOSAL_VISUAL_SOURCE_REQUIRED' : 'PROPOSAL_SOURCE_POLICY';
    throw contractError(code, policyIssues.map((value): string => `${value.code}: ${value.message}`).join('\n'), policyIssues);
  }
}

function anchorStart(link: ShotSourceLink): number {
  return link.temporalAnchor.kind === 'shot-offset' ? link.temporalAnchor.startOffsetMs : 0;
}

function validateProposalInformation(project: Project, shots: readonly Shot[]): void {
  shots.forEach((shot: Shot): void => {
    const linkedUnits: SourceUnit[] = shot.sourceLinks.flatMap((link: ShotSourceLink): SourceUnit[] => {
      const unit: SourceUnit | undefined = project.dataset.units.find((candidate: SourceUnit): boolean => candidate.id === link.unitId);
      return unit === undefined ? [] : [unit];
    });
    const directLinks: ShotSourceLink[] = shot.sourceLinks.filter((link: ShotSourceLink): boolean => ['primary-visual', 'continued-visual'].includes(link.usage));
    const directInformationIds: string[] = directLinks.flatMap((link: ShotSourceLink): string[] => linkedUnits.find((unit: SourceUnit): boolean => unit.id === link.unitId)?.informationIds ?? []);
    for (const informationId of [...new Set([...shot.informationIds, ...directInformationIds])]) {
      const gate = effectiveInformationGate(project, informationId);
      const supportingLinks: ShotSourceLink[] = directLinks.filter((link: ShotSourceLink): boolean =>
        linkedUnits.find((unit: SourceUnit): boolean => unit.id === link.unitId)?.informationIds.includes(informationId) === true);
      if (supportingLinks.length === 0 || (shot.informationIds.includes(informationId) && !linkedUnits.some((unit: SourceUnit): boolean => unit.informationIds.includes(informationId)))) {
        throw contractError('PROPOSAL_INFORMATION_WITHOUT_SOURCE', `${shot.segmentId}: ${informationId}를 뒷받침하는 직접 시각 Source Link가 필요합니다.`, []);
      }
      const revealMs: number = shot.startMs + Math.min(...supportingLinks.map(anchorStart));
      if (gate.reviewRequired || revealMs < gate.effectiveNotBeforeMs) throw contractError('PROPOSAL_INFORMATION_GATE', `${shot.segmentId}: ${informationId}를 ${revealMs}ms에 공개할 수 없습니다. effectiveNotBefore=${gate.effectiveNotBeforeMs}, reasons=${gate.reviewReasons.join(',')}`, []);
    }
  });
}

type ProposalFramePoint = { offsetMs: number; role: StoryboardFrame['role']; description: string; explicit: boolean };

function frameOffset(durationMs: number, atPermille: number): number {
  if (atPermille === 1000) return durationMs;
  return Math.floor(durationMs * atPermille / 1000);
}

function derivedFrameDescription(project: Project, shot: Shot, frameDescription: string, offsetMs: number): string {
  const newlyActive: string[] = shot.sourceLinks.flatMap((link: ShotSourceLink): string[] => {
    if (!['primary-visual', 'continued-visual'].includes(link.usage) || anchorStart(link) !== offsetMs) return [];
    const unit: SourceUnit | undefined = project.dataset.units.find((candidate: SourceUnit): boolean => candidate.id === link.unitId);
    return unit === undefined ? [] : [unit.text];
  });
  return newlyActive.join('\n') || frameDescription || shot.action;
}

function proposalFrames(project: Project, shot: Shot, proposal: SegmentProposal['shots'][number], proposalId: string, shotIndex: number): StoryboardFrame[] {
  const durationMs: number = shot.endMs - shot.startMs;
  const explicit: ProposalFramePoint[] = (proposal.frames ?? []).map((frame): ProposalFramePoint => ({
    offsetMs: frameOffset(durationMs, frame.atPermille), role: frame.role, description: frame.description, explicit: true,
  }));
  const offsets: number[] = explicit.map((point: ProposalFramePoint): number => point.offsetMs);
  const collisions: number[] = [...new Set(offsets.filter((offset: number, index: number): boolean => offsets.indexOf(offset) !== index))];
  if (collisions.length > 0) throw contractError('PROPOSAL_FRAME_OFFSET_COLLISION',
    `${shot.id}: 서로 다른 명시 Frame이 같은 밀리초에 도착합니다. durationMs=${durationMs}, offsets=${collisions.join(',')}. 프레임 시점이나 컷 길이를 검토하세요.`, []);
  const anchorPoints: ProposalFramePoint[] = shot.visualMode === 'sourced' ? shot.sourceLinks.flatMap((link: ShotSourceLink): ProposalFramePoint[] => {
    const offsetMs: number = anchorStart(link);
    if (!['primary-visual', 'continued-visual'].includes(link.usage) || offsetMs <= 0 || offsetMs >= durationMs) return [];
    return [{ offsetMs, role: 'key', description: derivedFrameDescription(project, shot, proposal.frameDescription, offsetMs), explicit: false }];
  }) : [];
  const points: ProposalFramePoint[] = ([
    { offsetMs: 0, role: 'start', description: proposal.frameDescription, explicit: false },
    ...anchorPoints,
    ...explicit,
  ] as ProposalFramePoint[]).sort((left, right): number => left.offsetMs - right.offsetMs || Number(right.explicit) - Number(left.explicit));
  const merged: ProposalFramePoint[] = [];
  for (const point of points) {
    const current: ProposalFramePoint | undefined = merged.find((candidate: ProposalFramePoint): boolean => candidate.offsetMs === point.offsetMs);
    const role: StoryboardFrame['role'] = point.offsetMs === 0 ? 'start' : point.offsetMs === durationMs ? 'end' : 'key';
    if (current === undefined) merged.push({ ...point, role });
    else if (point.explicit) Object.assign(current, { ...point, role });
  }
  return merged.map((point: ProposalFramePoint, frameIndex: number): StoryboardFrame => ({
    id: frameIndex === 0 ? `${proposalId}:frame:${shotIndex + 1}` : `${proposalId}:frame:${shotIndex + 1}:${frameIndex + 1}`,
    shotId: shot.id, offsetMs: point.offsetMs, role: point.role, description: point.description,
    imageAssetId: null, visualReview: 'pending',
  }));
}

function validateProposalSourceOrder(project: Project, shots: readonly Shot[]): void {
  const next: Project = { ...project, shots: [...shots] };
  const issues: Issue[] = [...new Set(shots.map((shot: Shot): string => shot.segmentId))]
    .flatMap((segmentId: string): Issue[] => firstVisualRevealOrderIssues(next, segmentId));
  if (issues.length > 0) throw contractError('PROPOSAL_SOURCE_ORDER_REVERSED', issues.map((value: Issue): string => value.message).join('\n'), issues);
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
  const shots: Shot[] = proposal.shots.map((shot, index): Shot => {
    const startMs: number = segment.startMs + durations.slice(0, index).reduce((sum: number, value: number): number => sum + value, 0);
    return { id: `${proposalId}:shot:${index + 1}`, segmentId, startMs, endMs: startMs + (durations[index] as number), visualMode: shot.visualMode ?? 'sourced',
      sourceLinks: shot.sourceLinks.map((link): ShotSourceLink => ({ unitId: link.unitId, usage: link.usage, status: 'confirmed', temporalAnchor: proposalAnchor(durations[index] as number, link.anchor) })), visualLocationId: shot.visualLocationId, action: shot.action, camera: shot.camera,
      presence: shot.presence, propIds: shot.propIds, continuityBefore: [], continuityAfter: [], cameraAxis: shot.cameraAxis,
      screenDirection: shot.screenDirection, informationIds: shot.informationIds, transitionOut: shot.transitionOut,
      proposalOrigin: 'model', approvalStatus: 'proposed', lockedFields: [] };
  });
  validateProposalInformation(project, shots);
  validateProposalSourceOrder(project, shots);
  const coverageIssues = shots.flatMap((shot: Shot) => shotVisualCoverageIssues({ ...project, shots }, shot));
  if (coverageIssues.length > 0) throw contractError('PROPOSAL_VISUAL_COVERAGE_GAP', coverageIssues.map((value): string => value.message).join('\n'), coverageIssues);
  const frames: StoryboardFrame[] = proposal.shots.flatMap((shot, index): StoryboardFrame[] => proposalFrames(project, shots[index] as Shot, shot, proposalId, index));
  const firstIndex: number = project.shots.findIndex((shot: Shot): boolean => shot.segmentId === segmentId);
  const retained: Shot[] = project.shots.filter((shot: Shot): boolean => shot.segmentId !== segmentId);
  const allShots: Shot[] = [...retained.slice(0, firstIndex), ...shots, ...retained.slice(firstIndex)];
  const next: Project = ProjectSchema.parse({ ...project, shots: allShots,
    frames: [...project.frames.filter((frame: StoryboardFrame): boolean => !oldShots.some((shot: Shot): boolean => shot.id === frame.shotId)), ...frames] });
  assertNoErrors(validateProject(next, project.dataset), 'INVALID_MODEL_PROPOSAL');
  return next;
}

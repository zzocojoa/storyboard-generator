import { z } from 'zod';
import { assertNoErrors, contractError } from './errors.js';
import { resolveTextCueMapping } from './emission.js';
import type { Project, Segment, SourceUnit, TextCue, TextMappingDecision, TextPlacement } from './schema.js';
import { IdSchema, MillisecondsSchema, ProjectSchema } from './schema.js';
import { validateProject } from './validation.js';

const TextKindSchema = z.enum(['overlay', 'prop-text', 'dialogue-subtitle']);
export const TextCueAuthorityResolutionInputSchema = z.discriminatedUnion('authority', [
  z.strictObject({ authority: z.literal('placement'), placementId: IdSchema }),
  z.strictObject({ authority: z.literal('mapping-decision'), mappingDecisionId: IdSchema }),
  z.strictObject({ authority: z.literal('source-unit'), unitId: IdSchema, startMs: MillisecondsSchema, endMs: MillisecondsSchema, kind: TextKindSchema }),
]);
export type TextCueAuthorityResolutionInput = z.infer<typeof TextCueAuthorityResolutionInputSchema>;

function requireReviewCue(project: Project, cueId: string): TextCue {
  const cue: TextCue | undefined = project.textCues.find((candidate: TextCue): boolean => candidate.id === cueId);
  if (cue === undefined) throw contractError('TEXT_CUE_NOT_FOUND', `글자 큐를 찾을 수 없습니다: ${cueId}`, []);
  if (cue.authority !== 'review-required') throw contractError('TEXT_CUE_AUTHORITY_ALREADY_RESOLVED', `${cueId}: 검토 필요 Cue만 권한을 확정할 수 있습니다.`, []);
  return cue;
}

function finishTextEdit(before: Project, cues: readonly TextCue[]): Project {
  const project: Project = ProjectSchema.parse({ ...before, textCues: cues });
  assertNoErrors(validateProject(project, before.dataset), 'INVALID_TEXT_AUTHORITY_EDIT');
  return project;
}

function placementCue(project: Project, cue: TextCue, placementId: string): TextCue {
  const placement: TextPlacement | undefined = project.dataset.textPlacements.find((candidate: TextPlacement): boolean => candidate.id === placementId);
  if (placement === undefined) throw contractError('TEXT_PLACEMENT_NOT_FOUND', `자막 위치를 찾을 수 없습니다: ${placementId}`, []);
  if (project.textCues.some((candidate: TextCue): boolean => candidate.id !== cue.id && candidate.placementId === placement.id)) {
    throw contractError('TEXT_CUE_AUTHORITY_TARGET_IN_USE', `${placement.id}: 다른 Cue가 Placement 권한을 사용 중입니다.`, []);
  }
  const segment: Segment | undefined = project.dataset.segments.find((candidate: Segment): boolean => candidate.id === placement.segmentId);
  if (segment === undefined) throw contractError('SEGMENT_NOT_FOUND', `자막 위치의 구간을 찾을 수 없습니다: ${placement.segmentId}`, []);
  const probe: TextCue = { ...cue, segmentId: placement.segmentId, placementId: placement.id, mappingDecisionId: null, authority: 'placement',
    text: placement.text, startMs: placement.startMs, endMs: placement.endMs ?? Math.min(segment.endMs, Math.max(placement.startMs + 1, cue.endMs)) };
  const mapping = resolveTextCueMapping(project, probe);
  const unitId: string | null = mapping.status === 'resolved' && mapping.decision !== null
    && ['exact', 'abbreviation', 'replacement'].includes(mapping.decision.relation) ? mapping.decision.canonicalUnitId : null;
  return { ...probe, unitId, timingStatus: placement.endMs === null ? 'proposed' : 'confirmed' };
}

function mappingCue(project: Project, cue: TextCue, mappingDecisionId: string): TextCue {
  const decision: TextMappingDecision | undefined = project.textMappingDecisions.find((candidate: TextMappingDecision): boolean => candidate.id === mappingDecisionId);
  const unit: SourceUnit | undefined = decision?.canonicalUnitId === null || decision?.canonicalUnitId === undefined ? undefined
    : project.dataset.units.find((candidate: SourceUnit): boolean => candidate.id === decision.canonicalUnitId);
  if (decision === undefined || unit === undefined || decision.status !== 'confirmed' || !decision.renderCanonicalSeparately
    || decision.canonicalStartMs === null || decision.canonicalEndMs === null) {
    throw contractError('TEXT_MAPPING_AUTHORITY_NOT_READY', `${mappingDecisionId}: 확정되고 별도 렌더링 시각이 있는 Mapping Decision이 필요합니다.`, []);
  }
  if (project.textCues.some((candidate: TextCue): boolean => candidate.id !== cue.id && candidate.mappingDecisionId === decision.id)) {
    throw contractError('TEXT_CUE_AUTHORITY_TARGET_IN_USE', `${decision.id}: 다른 Cue가 Mapping Decision 권한을 사용 중입니다.`, []);
  }
  return { ...cue, segmentId: unit.segmentId, unitId: unit.id, placementId: null, mappingDecisionId: decision.id,
    authority: 'mapping-decision', text: unit.text, startMs: decision.canonicalStartMs, endMs: decision.canonicalEndMs,
    kind: unit.kind === 'SCREEN_TEXT' ? 'overlay' : 'prop-text', timingStatus: 'confirmed' };
}

function sourceCue(project: Project, cue: TextCue, input: Extract<TextCueAuthorityResolutionInput, { authority: 'source-unit' }>): TextCue {
  const unit: SourceUnit | undefined = project.dataset.units.find((candidate: SourceUnit): boolean => candidate.id === input.unitId);
  if (unit === undefined) throw contractError('SOURCE_UNIT_NOT_FOUND', `원문 단위를 찾을 수 없습니다: ${input.unitId}`, []);
  if (unit.segmentId !== cue.segmentId) throw contractError('TEXT_CUE_SOURCE_SEGMENT_MISMATCH', `${input.unitId}: Cue와 같은 구간의 원문을 선택하세요.`, []);
  return { ...cue, segmentId: unit.segmentId, unitId: unit.id, placementId: null, mappingDecisionId: null, authority: 'source-unit',
    text: unit.text, startMs: input.startMs, endMs: input.endMs, kind: input.kind, timingStatus: 'proposed' };
}

/** Migration으로 검토 대기 중인 Cue를 선택한 원본 권한에서 다시 만든다. */
export function resolveTextCueAuthority(project: Project, cueId: string, input: TextCueAuthorityResolutionInput): Project {
  const parsed: TextCueAuthorityResolutionInput = TextCueAuthorityResolutionInputSchema.parse(input);
  const cue: TextCue = requireReviewCue(project, cueId);
  const resolved: TextCue = parsed.authority === 'placement' ? placementCue(project, cue, parsed.placementId)
    : parsed.authority === 'mapping-decision' ? mappingCue(project, cue, parsed.mappingDecisionId) : sourceCue(project, cue, parsed);
  return finishTextEdit(project, project.textCues.map((candidate: TextCue): TextCue => candidate.id === cue.id ? resolved : candidate));
}

/** 검토 대기 Cue만 제거하고 원문·Placement·Mapping의 필수 커버리지는 다시 검증한다. */
export function deleteReviewTextCue(project: Project, cueId: string): Project {
  const cue: TextCue | undefined = project.textCues.find((candidate: TextCue): boolean => candidate.id === cueId);
  if (cue === undefined) throw contractError('TEXT_CUE_NOT_FOUND', `글자 큐를 찾을 수 없습니다: ${cueId}`, []);
  if (cue.authority === 'placement') throw contractError('REQUIRED_PLACEMENT_TEXT_CANNOT_BE_DELETED', `${cueId}: 원본 Placement를 담당하는 Cue는 삭제할 수 없습니다.`, []);
  if (cue.authority === 'mapping-decision') throw contractError('REQUIRED_CANONICAL_TEXT_CANNOT_BE_DELETED', `${cueId}: 별도 Canonical 출력을 담당하는 Cue는 삭제할 수 없습니다.`, []);
  if (cue.authority !== 'review-required') throw contractError('TEXT_CUE_DELETE_FORBIDDEN', `${cueId}: 검토 필요 Cue만 삭제할 수 있습니다.`, []);
  return finishTextEdit(project, project.textCues.filter((candidate: TextCue): boolean => candidate.id !== cueId));
}

import { z } from 'zod';
import { contractError, issue } from './errors.js';
import {
  MillisecondsSchema, ProjectSchema, ShotSourceLinkSchema, TextMappingDecisionSchema,
} from './schema.js';
import type {
  Asset, AudioCue, Dataset, InformationRule, Issue, Project, Segment, Shot, ShotSourceLink,
  SourceRef, SourceTemporalAnchor, SourceUnit, StoryboardFrame, TextCue, TextMappingDecision, TextPlacement,
} from './schema.js';
import { sourcePolicyIssues } from './source-policy.js';
import { frameDisplayAbsoluteMs, frameEvaluationAbsoluteMs } from './time.js';
import { validateProject } from './validation.js';

export const TextMappingDecisionInputSchema = z.strictObject({
  canonicalUnitId: TextMappingDecisionSchema.shape.canonicalUnitId,
  relation: TextMappingDecisionSchema.shape.relation,
  status: TextMappingDecisionSchema.shape.status,
  renderCanonicalSeparately: TextMappingDecisionSchema.shape.renderCanonicalSeparately,
  canonicalStartMs: TextMappingDecisionSchema.shape.canonicalStartMs,
  canonicalEndMs: TextMappingDecisionSchema.shape.canonicalEndMs,
  note: TextMappingDecisionSchema.shape.note,
});
export const ShotSourceLinksInputSchema = z.strictObject({ links: z.array(ShotSourceLinkSchema) });
export const MoveShotSourceLinkInputSchema = z.strictObject({
  unitId: z.string().min(1), targetShotId: z.string().min(1), usage: ShotSourceLinkSchema.shape.usage,
});
export type TextMappingDecisionInput = z.infer<typeof TextMappingDecisionInputSchema>;
export type ShotSourceLinksInput = z.infer<typeof ShotSourceLinksInputSchema>;
export type MoveShotSourceLinkInput = z.infer<typeof MoveShotSourceLinkInputSchema>;

export type GateEvidenceType = 'base-exact' | 'text-mapping' | 'source-anchor' | 'measured-audio' | 'unit-order' | 'segment-start';
export type EffectiveInformationGate = {
  id: string; segmentId: string; baseNotBeforeMs: number; effectiveNotBeforeMs: number;
  notBeforeUnitId: string | null; notBeforeUnitOrder: number | null; precision: InformationRule['precision'];
  evidenceType: GateEvidenceType; evidenceId: string | null; reviewRequired: boolean; reviewReasons: string[];
  sourceRefs: SourceRef[];
};
export type SourceAnchorRange = { startMs: number; endMs: number };

const canonicalKinds: ReadonlySet<SourceUnit['kind']> = new Set<SourceUnit['kind']>(['SCREEN_TEXT', 'CHAT', 'NOTE']);

function words(text: string): string[] {
  return [...new Set(text.normalize('NFKC').toLocaleLowerCase('ko-KR').split(/[^\p{Letter}\p{Number}]+/u).filter((word: string): boolean => word.length >= 2))];
}

function candidateScore(placement: TextPlacement, unit: SourceUnit): number {
  if (placement.text === unit.text) return Number.MAX_SAFE_INTEGER;
  const placementWords: string[] = words(placement.text);
  if (placementWords.length === 0) return 0;
  const unitWords: Set<string> = new Set<string>(words(unit.text));
  const overlap: number = placementWords.filter((word: string): boolean => unitWords.has(word) || unit.text.includes(word)).length;
  return overlap / placementWords.length;
}

function canonicalUnits(dataset: Dataset, placement: TextPlacement): SourceUnit[] {
  return dataset.units.filter((unit: SourceUnit): boolean => unit.segmentId === placement.segmentId && canonicalKinds.has(unit.kind));
}

/** Placement의 명시 연결을 우선하고 유일한 정확 일치 또는 유일한 휴리스틱 후보만 반환한다. */
export function canonicalCandidate(dataset: Dataset, placement: TextPlacement): SourceUnit | null {
  const candidates: SourceUnit[] = canonicalUnits(dataset, placement);
  const explicit: SourceUnit | undefined = candidates.find((unit: SourceUnit): boolean => unit.id === placement.unitId);
  if (explicit !== undefined) return explicit;
  const exact: SourceUnit[] = candidates.filter((unit: SourceUnit): boolean => unit.text === placement.text);
  if (exact.length === 1) return exact[0] as SourceUnit;
  if (exact.length > 1) return null;
  const ranked: { unit: SourceUnit; score: number }[] = candidates.map((unit: SourceUnit): { unit: SourceUnit; score: number } => ({ unit, score: candidateScore(placement, unit) }))
    .filter((entry): boolean => entry.score >= 0.35)
    .sort((left, right): number => right.score - left.score || left.unit.order - right.unit.order);
  const first = ranked[0];
  const second = ranked[1];
  if (first === undefined || (second !== undefined && second.score === first.score)) return null;
  return first.unit;
}

export function createInitialTextMappingDecisions(dataset: Dataset): TextMappingDecision[] {
  return dataset.textPlacements.map((placement: TextPlacement, index: number): TextMappingDecision => {
    const candidate: SourceUnit | null = canonicalCandidate(dataset, placement);
    const exact: boolean = candidate !== null && candidate.text === placement.text;
    return TextMappingDecisionSchema.parse({
      id: `text-mapping-${index + 1}`, placementId: placement.id, canonicalUnitId: candidate?.id ?? null,
      relation: candidate === null ? 'standalone-placement' : exact ? 'exact' : 'abbreviation',
      status: exact ? 'confirmed' : 'unresolved', renderCanonicalSeparately: false,
      canonicalStartMs: null, canonicalEndMs: null, note: null,
    });
  });
}

function uniqueRefs(refs: readonly SourceRef[]): SourceRef[] {
  const seen: Set<string> = new Set<string>();
  return refs.filter((ref: SourceRef): boolean => {
    const key: string = `${ref.fileId}\u0000${ref.locator}\u0000${ref.originalId ?? ''}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function anchorRange(project: Project, shot: Shot, anchor: SourceTemporalAnchor): SourceAnchorRange | null {
  const shotDurationMs: number = shot.endMs - shot.startMs;
  if (anchor.status !== 'confirmed') return null;
  if (anchor.kind === 'frame') {
    const frame: StoryboardFrame | undefined = project.frames.find((candidate: StoryboardFrame): boolean => candidate.id === anchor.frameId && candidate.shotId === shot.id);
    if (frame === undefined || frame.offsetMs > shotDurationMs) return null;
    const startMs: number = frameEvaluationAbsoluteMs(shot, frame);
    return { startMs, endMs: Math.min(shot.endMs, startMs + 1) };
  }
  if (anchor.startOffsetMs >= shotDurationMs || anchor.startOffsetMs >= anchor.endOffsetMs || anchor.endOffsetMs > shotDurationMs) return null;
  return { startMs: shot.startMs + anchor.startOffsetMs, endMs: shot.startMs + anchor.endOffsetMs };
}

export function sourceAnchorRange(project: Project, shot: Shot, link: ShotSourceLink): SourceAnchorRange | null {
  return anchorRange(project, shot, link.temporalAnchor);
}

export function directVisualLinks(shot: Shot): ShotSourceLink[] {
  return shot.sourceLinks.filter((link: ShotSourceLink): boolean => link.usage === 'primary-visual' || link.usage === 'continued-visual');
}

export function absoluteFrameTime(shot: Shot, frame: StoryboardFrame): number {
  return MillisecondsSchema.parse(frameDisplayAbsoluteMs(shot, frame));
}

type GateEvidence = { time: number; type: GateEvidenceType; id: string; refs: SourceRef[] };

function mappingEvidence(project: Project, rule: InformationRule): GateEvidence[] {
  return project.textMappingDecisions.flatMap((decision: TextMappingDecision): GateEvidence[] => {
    if (decision.canonicalUnitId === null || decision.relation === 'standalone-placement') return [];
    const placement: TextPlacement | undefined = project.dataset.textPlacements.find((value: TextPlacement): boolean => value.id === decision.placementId && value.segmentId === rule.segmentId);
    const unit: SourceUnit | undefined = project.dataset.units.find((value: SourceUnit): boolean => value.id === decision.canonicalUnitId && value.segmentId === rule.segmentId && value.informationIds.includes(rule.id));
    if (placement === undefined || unit === undefined) return [];
    const time: number | null = decision.relation === 'separate-element' ? decision.canonicalStartMs : placement.startMs;
    return time === null ? [] : [{ time, type: 'text-mapping', id: decision.id, refs: [...placement.sourceRefs, ...unit.sourceRefs] }];
  });
}

function heuristicUnitOrderEvidence(project: Project, rule: InformationRule): GateEvidence[] {
  if (rule.precision !== 'unit-order') return [];
  const units: SourceUnit[] = project.dataset.units.filter((unit: SourceUnit): boolean => unit.segmentId === rule.segmentId && unit.informationIds.includes(rule.id));
  const ranked: { placement: TextPlacement; unit: SourceUnit; score: number }[] = project.dataset.textPlacements
    .filter((placement: TextPlacement): boolean => placement.segmentId === rule.segmentId)
    .flatMap((placement: TextPlacement): { placement: TextPlacement; unit: SourceUnit; score: number }[] => units.map((unit: SourceUnit) => ({ placement, unit, score: candidateScore(placement, unit) })))
    .filter((entry): boolean => entry.score >= 0.35)
    .sort((left, right): number => right.score - left.score || left.placement.startMs - right.placement.startMs || left.unit.order - right.unit.order);
  const first = ranked[0];
  const second = ranked[1];
  if (first === undefined || (second !== undefined && second.score === first.score)) return [];
  return [{ time: first.placement.startMs, type: 'unit-order', id: `heuristic:${first.placement.id}:${first.unit.id}`, refs: [...first.placement.sourceRefs, ...first.unit.sourceRefs] }];
}

function sourceEvidence(project: Project, rule: InformationRule): GateEvidence[] {
  return project.shots.flatMap((shot: Shot): GateEvidence[] => directVisualLinks(shot).flatMap((link: ShotSourceLink): GateEvidence[] => {
    if (link.status !== 'confirmed') return [];
    const unit: SourceUnit | undefined = project.dataset.units.find((candidate: SourceUnit): boolean => candidate.id === link.unitId && candidate.segmentId === rule.segmentId && candidate.informationIds.includes(rule.id));
    const range: SourceAnchorRange | null = sourceAnchorRange(project, shot, link);
    return unit === undefined || range === null ? [] : [{ time: range.startMs, type: 'source-anchor', id: `${shot.id}:${unit.id}`, refs: unit.sourceRefs }];
  }));
}

function measuredAsset(project: Project, cue: AudioCue): Asset | null {
  if (cue.timingStatus !== 'measured' || cue.assetId === null) return null;
  const asset: Asset | undefined = project.assets.find((candidate: Asset): boolean => candidate.id === cue.assetId && candidate.kind === 'audio');
  if (asset === undefined || asset.subjectId !== cue.id || asset.durationMs !== cue.endMs - cue.startMs) return null;
  return asset;
}

function audioEvidence(project: Project, rule: InformationRule): GateEvidence[] {
  const segment: Segment | undefined = project.dataset.segments.find((candidate: Segment): boolean => candidate.id === rule.segmentId);
  if (segment === undefined) return [];
  return project.audioCues.flatMap((cue: AudioCue): GateEvidence[] => {
    if (cue.timingRelation !== 'within-segment') return [];
    const unit: SourceUnit | undefined = project.dataset.units.find((candidate: SourceUnit): boolean => candidate.id === cue.unitId && candidate.segmentId === rule.segmentId && candidate.informationIds.includes(rule.id));
    if (unit === undefined || measuredAsset(project, cue) === null || cue.startMs < segment.startMs || cue.endMs > segment.endMs) return [];
    return [{ time: cue.startMs, type: 'measured-audio', id: cue.id, refs: unit.sourceRefs }];
  });
}

function prioritizedEvidence(project: Project, rule: InformationRule): GateEvidence[] {
  const priority: Record<GateEvidenceType, number> = { 'base-exact': 0, 'text-mapping': 1, 'source-anchor': 2, 'measured-audio': 3, 'unit-order': 4, 'segment-start': 5 };
  const authoritative: GateEvidence[] = rule.precision === 'exact-time'
    ? [{ time: rule.baseNotBeforeMs, type: 'base-exact', id: rule.id, refs: rule.sourceRefs }] : [];
  return [...authoritative, ...mappingEvidence(project, rule), ...sourceEvidence(project, rule), ...audioEvidence(project, rule), ...heuristicUnitOrderEvidence(project, rule)]
    .sort((left: GateEvidence, right: GateEvidence): number => priority[left.type] - priority[right.type] || left.time - right.time || left.id.localeCompare(right.id));
}

/** 기준 규칙을 하한으로 유지하며 현재 Mapping·Anchor·측정 음성에서 유효 Gate를 매번 계산한다. */
export function effectiveInformationGate(project: Project, informationId: string): EffectiveInformationGate {
  const rule: InformationRule | undefined = project.dataset.informationRules.find((value: InformationRule): boolean => value.id === informationId);
  if (rule === undefined) throw contractError('UNRESOLVED_INFORMATION_RULE', `${informationId}의 기준 공개 규칙이 필요합니다.`, []);
  const evidence: GateEvidence[] = prioritizedEvidence(project, rule);
  const earlier: GateEvidence[] = evidence.filter((candidate: GateEvidence): boolean => candidate.time < rule.baseNotBeforeMs);
  const valid: GateEvidence[] = evidence.filter((candidate: GateEvidence): boolean => candidate.time >= rule.baseNotBeforeMs);
  const selected: GateEvidence | undefined = valid[0];
  const selectedMapping: TextMappingDecision | undefined = selected?.type === 'text-mapping' ? project.textMappingDecisions.find((decision: TextMappingDecision): boolean => decision.id === selected.id) : undefined;
  const provisional: boolean = selectedMapping?.status === 'unresolved' || selected?.id.startsWith('heuristic:') === true;
  const confirmation: GateEvidence | undefined = provisional ? valid.find((candidate: GateEvidence): boolean => (candidate.type === 'source-anchor' || candidate.type === 'measured-audio') && candidate.time >= (selected?.time ?? rule.baseNotBeforeMs)) : undefined;
  const effectiveEvidence: GateEvidence | undefined = confirmation ?? selected;
  const unitOrderConstraint: GateEvidence | undefined = rule.precision === 'unit-order' && (selected?.type === 'source-anchor' || selected?.type === 'measured-audio')
    ? valid.find((candidate: GateEvidence): boolean => candidate.type === 'unit-order') : undefined;
  const reviewReasons: string[] = earlier.map((candidate: GateEvidence): string => `EVIDENCE_PRECEDES_BASE:${candidate.type}:${candidate.id}:${candidate.time}`);
  const conflictingConfirmations: GateEvidence[] = selected?.type === 'text-mapping' || selected?.id.startsWith('heuristic:') === true
    ? valid.filter((candidate: GateEvidence): boolean => (candidate.type === 'source-anchor' || candidate.type === 'measured-audio') && candidate.time < (selected?.time ?? rule.baseNotBeforeMs)) : [];
  reviewReasons.push(...conflictingConfirmations.map((candidate: GateEvidence): string => `EVIDENCE_PRECEDES_DERIVED:${candidate.type}:${candidate.id}:${candidate.time}`));
  if (unitOrderConstraint !== undefined && selected !== undefined && selected.time < unitOrderConstraint.time) {
    reviewReasons.push(`EVIDENCE_PRECEDES_UNIT_ORDER:${selected.type}:${selected.id}:${selected.time}:${unitOrderConstraint.time}`);
  }
  if (selectedMapping?.status === 'unresolved' && confirmation === undefined) reviewReasons.push(`UNRESOLVED_TEXT_MAPPING:${selectedMapping.id}`);
  if (selected?.id.startsWith('heuristic:') === true && confirmation === undefined) reviewReasons.push(`HEURISTIC_GATE_EVIDENCE:${selected.id}`);
  const unresolvedMapping: boolean = selectedMapping === undefined && rule.notBeforeUnitId !== null && project.textMappingDecisions.some((decision: TextMappingDecision): boolean => decision.canonicalUnitId === rule.notBeforeUnitId && decision.status === 'unresolved');
  if (unresolvedMapping) reviewReasons.push(`UNRESOLVED_TEXT_MAPPING:${rule.notBeforeUnitId}`);
  if (rule.precision === 'unit-order' && selected === undefined) reviewReasons.push(`UNIT_ORDER_TEMPORAL_ANCHOR_REQUIRED:${rule.notBeforeUnitId ?? rule.id}`);
  const fallbackType: GateEvidenceType = rule.precision === 'exact-time' ? 'base-exact' : rule.precision === 'unit-order' ? 'unit-order' : 'segment-start';
  return {
    id: rule.id, segmentId: rule.segmentId, baseNotBeforeMs: rule.baseNotBeforeMs,
    effectiveNotBeforeMs: Math.max(rule.baseNotBeforeMs, selected?.time ?? rule.baseNotBeforeMs, confirmation?.time ?? rule.baseNotBeforeMs, unitOrderConstraint?.time ?? rule.baseNotBeforeMs),
    notBeforeUnitId: rule.notBeforeUnitId, notBeforeUnitOrder: rule.notBeforeUnitOrder, precision: rule.precision,
    evidenceType: effectiveEvidence?.type ?? fallbackType, evidenceId: effectiveEvidence?.id ?? null,
    reviewRequired: reviewReasons.length > 0, reviewReasons,
    sourceRefs: uniqueRefs([...rule.sourceRefs, ...(selected?.refs ?? []), ...(confirmation?.refs ?? []), ...(unitOrderConstraint?.refs ?? []), ...earlier.flatMap((candidate: GateEvidence): SourceRef[] => candidate.refs)]),
  };
}

function placementCue(project: Project, decision: TextMappingDecision, existing: readonly TextCue[]): TextCue {
  const placement: TextPlacement | undefined = project.dataset.textPlacements.find((value: TextPlacement): boolean => value.id === decision.placementId);
  if (placement === undefined) throw contractError('TEXT_PLACEMENT_NOT_FOUND', `자막 위치를 찾을 수 없습니다: ${decision.placementId}`, []);
  const current: TextCue | undefined = existing.find((cue: TextCue): boolean => cue.placementId === placement.id);
  const segment: Segment | undefined = project.dataset.segments.find((value: Segment): boolean => value.id === placement.segmentId);
  if (segment === undefined) throw contractError('SEGMENT_NOT_FOUND', `자막 구간을 찾을 수 없습니다: ${placement.segmentId}`, []);
  return {
    id: current?.id ?? `text-placement-${project.dataset.textPlacements.indexOf(placement) + 1}`, segmentId: placement.segmentId,
    unitId: decision.status === 'confirmed' && decision.relation !== 'standalone-placement' && decision.relation !== 'separate-element' ? decision.canonicalUnitId : null,
    placementId: placement.id, mappingDecisionId: null, authority: 'placement', text: placement.text, startMs: placement.startMs,
    endMs: placement.endMs ?? current?.endMs ?? Math.min(segment.endMs, placement.startMs + 2000),
    kind: current?.kind ?? 'overlay', timingStatus: placement.endMs === null ? current?.timingStatus ?? 'proposed' : 'confirmed',
  };
}

function canonicalCue(project: Project, decision: TextMappingDecision, existing: readonly TextCue[]): TextCue[] {
  if (decision.status !== 'confirmed' || decision.canonicalUnitId === null || !decision.renderCanonicalSeparately
    || decision.canonicalStartMs === null || decision.canonicalEndMs === null) return [];
  const unit: SourceUnit | undefined = project.dataset.units.find((value: SourceUnit): boolean => value.id === decision.canonicalUnitId);
  if (unit === undefined) throw contractError('SOURCE_UNIT_NOT_FOUND', `원문 단위를 찾을 수 없습니다: ${decision.canonicalUnitId}`, []);
  const current: TextCue | undefined = existing.find((cue: TextCue): boolean => cue.unitId === unit.id && cue.placementId === null);
  return [{
    id: current?.id ?? `${decision.id}:canonical`, segmentId: unit.segmentId, unitId: unit.id, placementId: null,
    mappingDecisionId: decision.id, authority: 'mapping-decision',
    text: unit.text, startMs: decision.canonicalStartMs, endMs: decision.canonicalEndMs,
    kind: unit.kind === 'SCREEN_TEXT' ? 'overlay' : 'prop-text', timingStatus: 'confirmed',
  }];
}

export function reconcileTextCues(project: Project, decisions: readonly TextMappingDecision[], holdMs: number): TextCue[] {
  if (!Number.isSafeInteger(holdMs) || holdMs <= 0) throw contractError('INVALID_TEXT_HOLD', '화면 글자 유지 시간은 양의 정수 밀리초여야 합니다.', []);
  const placed: TextCue[] = decisions.map((decision: TextMappingDecision): TextCue => {
    const cue: TextCue = placementCue(project, decision, project.textCues);
    const placement: TextPlacement = project.dataset.textPlacements.find((value: TextPlacement): boolean => value.id === decision.placementId) as TextPlacement;
    const segment: Segment = project.dataset.segments.find((value: Segment): boolean => value.id === placement.segmentId) as Segment;
    return placement.endMs === null && !project.textCues.some((current: TextCue): boolean => current.id === cue.id)
      ? { ...cue, endMs: Math.min(segment.endMs, placement.startMs + holdMs) } : cue;
  });
  const canonical: TextCue[] = decisions.flatMap((decision: TextMappingDecision): TextCue[] => canonicalCue(project, decision, project.textCues));
  const decidedUnits: Set<string> = new Set<string>(decisions.flatMap((decision: TextMappingDecision): string[] => decision.canonicalUnitId === null ? [] : [decision.canonicalUnitId]));
  const unmapped: TextCue[] = project.dataset.units.filter((unit: SourceUnit): boolean => canonicalKinds.has(unit.kind) && !decidedUnits.has(unit.id))
    .map((unit: SourceUnit): TextCue => {
      const segment: Segment = project.dataset.segments.find((value: Segment): boolean => value.id === unit.segmentId) as Segment;
      const current: TextCue | undefined = project.textCues.find((cue: TextCue): boolean => cue.unitId === unit.id && cue.placementId === null);
      return current ?? { id: `text-unit-${project.dataset.units.indexOf(unit) + 1}`, segmentId: unit.segmentId, unitId: unit.id, placementId: null,
        mappingDecisionId: null, authority: 'source-unit', text: unit.text, startMs: segment.startMs,
        endMs: Math.min(segment.endMs, segment.startMs + holdMs), kind: unit.kind === 'SCREEN_TEXT' ? 'overlay' : 'prop-text', timingStatus: 'proposed' };
    });
  return [...placed, ...canonical, ...unmapped];
}

function finishMappingEdit(before: Project, input: Project): Project {
  const project: Project = ProjectSchema.parse(input);
  const errors: Issue[] = validateProject(project, before.dataset).filter((value: Issue): boolean => value.severity === 'error');
  if (errors.length > 0) throw contractError('INVALID_MAPPING_EDIT', errors.map((value: Issue): string => value.message).join('\n'), errors);
  return project;
}

function mappingSegment(project: Project, decision: TextMappingDecision): string {
  const placement: TextPlacement | undefined = project.dataset.textPlacements.find((value: TextPlacement): boolean => value.id === decision.placementId);
  if (placement === undefined) throw contractError('TEXT_PLACEMENT_NOT_FOUND', `자막 위치를 찾을 수 없습니다: ${decision.placementId}`, []);
  return placement.segmentId;
}

function invalidatedAnchor(link: ShotSourceLink): ShotSourceLink {
  if (link.temporalAnchor.kind === 'shot-offset' && link.temporalAnchor.basis === 'text-cue') {
    return { ...link, status: 'mapping-required', temporalAnchor: { kind: 'unresolved', basis: 'mapping-change', status: 'review-required' } };
  }
  return link;
}

export function updateTextMappingDecision(project: Project, decisionId: string, input: TextMappingDecisionInput): Project {
  const parsed: TextMappingDecisionInput = TextMappingDecisionInputSchema.parse(input);
  const current: TextMappingDecision | undefined = project.textMappingDecisions.find((decision: TextMappingDecision): boolean => decision.id === decisionId);
  if (current === undefined) throw contractError('TEXT_MAPPING_NOT_FOUND', `자막 매핑 결정을 찾을 수 없습니다: ${decisionId}`, []);
  const placement: TextPlacement | undefined = project.dataset.textPlacements.find((value: TextPlacement): boolean => value.id === current.placementId);
  if (placement === undefined) throw contractError('TEXT_PLACEMENT_NOT_FOUND', `자막 위치를 찾을 수 없습니다: ${current.placementId}`, []);
  if (parsed.canonicalUnitId !== null && !project.dataset.units.some((unit: SourceUnit): boolean => unit.id === parsed.canonicalUnitId && unit.segmentId === placement.segmentId && canonicalKinds.has(unit.kind))) {
    throw contractError('INVALID_TEXT_MAPPING_UNIT', `${parsed.canonicalUnitId}: 같은 구간의 SCREEN_TEXT·CHAT·NOTE 원문을 선택하세요.`, []);
  }
  const nextDecision: TextMappingDecision = TextMappingDecisionSchema.parse({ ...current, ...parsed });
  const decisions: TextMappingDecision[] = project.textMappingDecisions.map((decision: TextMappingDecision): TextMappingDecision => decision.id === decisionId ? nextDecision : decision);
  const segmentId: string = mappingSegment(project, current);
  const currentPlacementCue: TextCue | undefined = project.textCues.find((cue: TextCue): boolean => cue.placementId === current.placementId);
  const holdMs: number = currentPlacementCue === undefined ? 2000 : Math.max(1, currentPlacementCue.endMs - currentPlacementCue.startMs);
  const shots: Shot[] = project.shots.map((shot: Shot): Shot => shot.segmentId === segmentId
    ? { ...shot, sourceLinks: shot.sourceLinks.map(invalidatedAnchor), approvalStatus: 'proposed' } : shot);
  const base: Project = { ...project, textMappingDecisions: decisions, shots };
  return finishMappingEdit(project, { ...base, textCues: reconcileTextCues(base, decisions, holdMs),
    frames: project.frames.map((frame: StoryboardFrame): StoryboardFrame => shots.some((shot: Shot): boolean => shot.id === frame.shotId && shot.segmentId === segmentId) ? { ...frame, visualReview: 'pending' } : frame),
  });
}

function requireEditableSourceShot(project: Project, shotId: string): Shot {
  const shot: Shot | undefined = project.shots.find((value: Shot): boolean => value.id === shotId);
  if (shot === undefined) throw contractError('SHOT_NOT_FOUND', `컷을 찾을 수 없습니다: ${shotId}`, []);
  if (shot.lockedFields.includes('sources')) throw contractError('SHOT_FIELD_LOCKED', `${shotId}: sources 필드를 먼저 잠금 해제하세요.`, []);
  return shot;
}

function sourcePolicyReviewIssues(project: Project, segmentId: string): Issue[] {
  return sourcePolicyIssues(
    project.dataset.units.filter((unit: SourceUnit): boolean => unit.segmentId === segmentId),
    project.shots.filter((shot: Shot): boolean => shot.segmentId === segmentId),
  );
}

function sourcePolicyIssueKey(value: Issue): string {
  return `${value.code}\u0000${value.entityId}\u0000${value.expected ?? ''}\u0000${value.actual ?? ''}`;
}

function assertSourcePolicyChange(current: Project, next: Project, segmentId: string): void {
  const currentKeys: Set<string> = new Set<string>(sourcePolicyReviewIssues(current, segmentId).map(sourcePolicyIssueKey));
  const introduced: Issue[] = sourcePolicyReviewIssues(next, segmentId).filter((value: Issue): boolean => !currentKeys.has(sourcePolicyIssueKey(value)));
  if (introduced.length > 0) throw contractError('INVALID_SOURCE_POLICY', introduced.map((value: Issue): string => `${value.code}: ${value.message}`).join('\n'), introduced);
}

export function updateShotSourceLinks(project: Project, shotId: string, input: ShotSourceLinksInput): Project {
  const parsed: ShotSourceLinksInput = ShotSourceLinksInputSchema.parse(input);
  const shot: Shot = requireEditableSourceShot(project, shotId);
  const next: Project = { ...project,
    shots: project.shots.map((candidate: Shot): Shot => candidate.id === shotId ? { ...candidate, sourceLinks: parsed.links, approvalStatus: 'proposed', proposalOrigin: 'manual' } : candidate),
    frames: project.frames.map((frame: StoryboardFrame): StoryboardFrame => frame.shotId === shot.id ? { ...frame, visualReview: 'pending' } : frame),
  };
  assertSourcePolicyChange(project, next, shot.segmentId);
  return finishMappingEdit(project, next);
}

function movedAnchor(project: Project, source: Shot, target: Shot, link: ShotSourceLink): SourceTemporalAnchor {
  const range: SourceAnchorRange | null = sourceAnchorRange(project, source, link);
  if (range !== null && range.startMs >= target.startMs && range.endMs <= target.endMs) {
    const basis: 'manual' | 'text-cue' | 'audio-cue' | 'proposal' | 'native-exact' = link.temporalAnchor.kind === 'shot-offset'
      ? link.temporalAnchor.basis : 'manual';
    return { kind: 'shot-offset', startOffsetMs: range.startMs - target.startMs, endOffsetMs: Math.max(range.endMs - target.startMs, range.startMs - target.startMs + 1), basis, status: 'confirmed' };
  }
  return { kind: 'unresolved', basis: 'source-move', status: 'review-required' };
}

export function moveShotSourceLink(project: Project, shotId: string, input: MoveShotSourceLinkInput): Project {
  const parsed: MoveShotSourceLinkInput = MoveShotSourceLinkInputSchema.parse(input);
  const source: Shot = requireEditableSourceShot(project, shotId);
  const target: Shot = requireEditableSourceShot(project, parsed.targetShotId);
  if (source.segmentId !== target.segmentId) throw contractError('INVALID_SOURCE_LINK_MOVE', '같은 구간의 컷 사이에서만 원문 연결을 이동할 수 있습니다.', []);
  const link: ShotSourceLink | undefined = source.sourceLinks.find((value: ShotSourceLink): boolean => value.unitId === parsed.unitId);
  if (link === undefined) throw contractError('SOURCE_LINK_NOT_FOUND', `${shotId}: ${parsed.unitId} 연결을 찾을 수 없습니다.`, []);
  if (target.sourceLinks.some((value: ShotSourceLink): boolean => value.unitId === parsed.unitId)) throw contractError('DUPLICATE_SOURCE_LINK', `${target.id}: ${parsed.unitId} 연결이 이미 있습니다.`, []);
  const temporalAnchor: SourceTemporalAnchor = movedAnchor(project, source, target, link);
  const next: Project = { ...project, shots: project.shots.map((shot: Shot): Shot => {
    if (shot.id === source.id) return { ...shot, sourceLinks: shot.sourceLinks.filter((value: ShotSourceLink): boolean => value.unitId !== parsed.unitId), approvalStatus: 'proposed' };
    if (shot.id === target.id) return { ...shot, sourceLinks: [...shot.sourceLinks, { unitId: parsed.unitId, usage: parsed.usage, status: temporalAnchor.status === 'confirmed' ? 'confirmed' : 'mapping-required', temporalAnchor }], approvalStatus: 'proposed' };
    return shot;
  }), frames: project.frames.map((frame: StoryboardFrame): StoryboardFrame => [source.id, target.id].includes(frame.shotId) ? { ...frame, visualReview: 'pending' } : frame) };
  assertSourcePolicyChange(project, next, source.segmentId);
  return finishMappingEdit(project, next);
}

function relationReviewIssues(decision: TextMappingDecision, refs: readonly SourceRef[]): Issue[] {
  const parsed = TextMappingDecisionSchema.safeParse(decision);
  return parsed.success ? [] : parsed.error.issues.map((problem): Issue => issue(
    'INVALID_TEXT_MAPPING_STATE', 'conflict', decision.id, problem.path.join('.'), problem.message, 'valid relation state', JSON.stringify(decision), refs,
  ));
}

export function textMappingReviewIssues(project: Project, segmentId: string): Issue[] {
  return project.textMappingDecisions.flatMap((decision: TextMappingDecision): Issue[] => {
    const placement: TextPlacement | undefined = project.dataset.textPlacements.find((value: TextPlacement): boolean => value.id === decision.placementId && value.segmentId === segmentId);
    if (placement === undefined) return [];
    const refs: SourceRef[] = [...placement.sourceRefs, ...(project.dataset.units.find((unit: SourceUnit): boolean => unit.id === decision.canonicalUnitId)?.sourceRefs ?? [])];
    const stateIssues: Issue[] = relationReviewIssues(decision, refs);
    const canonical: SourceUnit | undefined = decision.canonicalUnitId === null ? undefined : project.dataset.units.find((unit: SourceUnit): boolean => unit.id === decision.canonicalUnitId);
    const segment: Segment | undefined = project.dataset.segments.find((candidate: Segment): boolean => candidate.id === segmentId);
    const semanticIssues: Issue[] = [
      ...(decision.relation !== 'standalone-placement' && canonical === undefined
        ? [issue('UNKNOWN_CANONICAL_UNIT', 'conflict', decision.id, 'canonicalUnitId', '연결한 Canonical 원문을 찾을 수 없습니다.', 'existing canonical unit', decision.canonicalUnitId, refs)] : []),
      ...(canonical !== undefined && canonical.segmentId !== segmentId
        ? [issue('INVALID_CANONICAL_UNIT_SEGMENT', 'conflict', decision.id, 'canonicalUnitId', 'Canonical 원문은 Placement와 같은 구간에 있어야 합니다.', segmentId, canonical.segmentId, refs)] : []),
      ...(canonical !== undefined && !canonicalKinds.has(canonical.kind)
        ? [issue('INVALID_CANONICAL_UNIT_KIND', 'conflict', decision.id, 'canonicalUnitId', 'Canonical 원문은 SCREEN_TEXT·CHAT·NOTE 중 하나여야 합니다.', 'SCREEN_TEXT|CHAT|NOTE', canonical.kind, refs)] : []),
      ...(decision.status === 'confirmed' && decision.relation === 'exact' && canonical !== undefined && canonical.text !== placement.text
        ? [issue('INVALID_EXACT_TEXT_MAPPING', 'conflict', decision.id, 'relation', 'exact Mapping의 Placement와 Canonical 원문이 다릅니다.', canonical.text, placement.text, refs)] : []),
      ...(segment !== undefined && decision.canonicalStartMs !== null && decision.canonicalEndMs !== null
        && (decision.canonicalStartMs < segment.startMs || decision.canonicalEndMs > segment.endMs)
        ? [issue('INVALID_CANONICAL_TEXT_TIME', 'conflict', decision.id, 'canonicalTiming', 'Canonical 별도 렌더링 시각이 구간 범위를 벗어났습니다.', `${segment.startMs}..${segment.endMs}`, `${decision.canonicalStartMs}..${decision.canonicalEndMs}`, refs)] : []),
    ];
    if (decision.status === 'unresolved') return [...stateIssues, ...semanticIssues, issue('UNRESOLVED_TEXT_MAPPING', 'conflict', decision.id, 'status', 'Placement와 Canonical 문구의 관계를 확정하세요.', 'confirmed', decision.status, refs)];
    return [...stateIssues, ...semanticIssues];
  });
}

function sourceMappingReviewIssues(project: Project, shot: Shot): Issue[] {
  return shot.sourceLinks.flatMap((link: ShotSourceLink): Issue[] => {
    const unit: SourceUnit | undefined = project.dataset.units.find((candidate: SourceUnit): boolean => candidate.id === link.unitId);
    const refs: SourceRef[] = unit?.sourceRefs ?? [];
    if (unit === undefined) return [issue('UNKNOWN_SOURCE_UNIT', 'conflict', shot.id, 'sourceLinks', `${link.unitId} 원문 단위를 찾을 수 없습니다.`, 'existing unit', link.unitId, refs)];
    if (link.status === 'mapping-required') return [issue('SOURCE_MAPPING_REQUIRED', 'conflict', shot.id, 'sourceLinks', `${link.unitId}의 컷 배치와 용도를 확인하세요.`, 'confirmed', link.status, refs)];
    if (directVisualLinks(shot).includes(link) && link.temporalAnchor.status === 'review-required') return [issue('SOURCE_TEMPORAL_ANCHOR_REQUIRED', 'conflict', shot.id, 'sourceLinks.temporalAnchor', `${link.unitId}가 컷 안에서 처음 보이는 시각을 확정하세요.`, 'confirmed temporal anchor', link.temporalAnchor.basis, refs)];
    if (link.temporalAnchor.status === 'confirmed' && sourceAnchorRange(project, shot, link) === null) return [issue('INVALID_SOURCE_TEMPORAL_ANCHOR', 'conflict', shot.id, 'sourceLinks.temporalAnchor', `${link.unitId}의 시간 Anchor가 컷 또는 프레임 범위를 벗어났습니다.`, 'anchor inside shot', JSON.stringify(link.temporalAnchor), refs)];
    return [];
  });
}

function unresolvedRuleIssue(project: Project, entityId: string, informationId: string): Issue {
  const unitRefs: SourceRef[] = project.dataset.units.filter((unit: SourceUnit): boolean => unit.informationIds.includes(informationId)).flatMap((unit: SourceUnit): SourceRef[] => unit.sourceRefs);
  return issue('UNRESOLVED_INFORMATION_RULE', 'conflict', entityId, 'informationIds', `${informationId}의 기준 공개 규칙을 정의하세요.`, 'authoritative base rule', informationId, unitRefs);
}

function gateIssue(project: Project, entityId: string, informationId: string, actualMs: number): Issue[] {
  const rule: InformationRule | undefined = project.dataset.informationRules.find((candidate: InformationRule): boolean => candidate.id === informationId);
  if (rule === undefined) return [unresolvedRuleIssue(project, entityId, informationId)];
  const gate: EffectiveInformationGate = effectiveInformationGate(project, informationId);
  const ruleSegment: Segment | undefined = project.dataset.segments.find((segment: Segment): boolean => segment.id === rule.segmentId);
  if (actualMs < gate.effectiveNotBeforeMs) return [issue('EARLY_INFORMATION_REVEAL', 'conflict', entityId, 'informationIds', `${informationId}는 ${gate.effectiveNotBeforeMs}ms 이후에만 공개할 수 있습니다.`, String(gate.effectiveNotBeforeMs), String(actualMs), gate.sourceRefs)];
  if (gate.reviewRequired && (ruleSegment === undefined || actualMs < ruleSegment.endMs)) return [issue('INFORMATION_GATE_REVIEW_REQUIRED', 'conflict', entityId, 'informationIds', `${informationId}의 공개 시점 근거를 검토하세요: ${gate.reviewReasons.join(', ')}`, 'resolved gate evidence', gate.reviewReasons.join(', '), gate.sourceRefs)];
  return [];
}

function revealReviewIssues(project: Project, shot: Shot): Issue[] {
  const direct: ShotSourceLink[] = directVisualLinks(shot);
  const sourceIssues: Issue[] = direct.flatMap((link: ShotSourceLink): Issue[] => {
    const unit: SourceUnit | undefined = project.dataset.units.find((candidate: SourceUnit): boolean => candidate.id === link.unitId);
    const range: SourceAnchorRange | null = sourceAnchorRange(project, shot, link);
    if (unit === undefined || range === null) return [];
    return unit.informationIds.flatMap((informationId: string): Issue[] => gateIssue(project, shot.id, informationId, range.startMs));
  });
  const explicitIssues: Issue[] = [...new Set(shot.informationIds)].flatMap((informationId: string): Issue[] => {
    if (!project.dataset.informationRules.some((rule: InformationRule): boolean => rule.id === informationId)) return [unresolvedRuleIssue(project, shot.id, informationId)];
    const supporting: ShotSourceLink[] = direct.filter((link: ShotSourceLink): boolean => project.dataset.units.find((unit: SourceUnit): boolean => unit.id === link.unitId)?.informationIds.includes(informationId) === true);
    if (supporting.length === 0) return [issue('INFORMATION_WITHOUT_SOURCE_LINK', 'conflict', shot.id, 'informationIds', `${informationId}를 뒷받침하는 직접 Source Link가 현재 컷에 없습니다.`, 'direct linked source unit', informationId, [])];
    const times: number[] = supporting.flatMap((link: ShotSourceLink): number[] => {
      const range: SourceAnchorRange | null = sourceAnchorRange(project, shot, link);
      return range === null ? [] : [range.startMs];
    });
    return times.length === 0 ? [] : gateIssue(project, shot.id, informationId, Math.min(...times));
  });
  const keys: Set<string> = new Set<string>();
  return [...sourceIssues, ...explicitIssues].filter((value: Issue): boolean => {
    const key: string = `${value.code}\u0000${value.entityId}\u0000${value.actual ?? ''}\u0000${value.expected ?? ''}`;
    if (keys.has(key)) return false;
    keys.add(key);
    return true;
  });
}

export function reviewIssuesForShot(project: Project, shotId: string): Issue[] {
  const shot: Shot | undefined = project.shots.find((value: Shot): boolean => value.id === shotId);
  if (shot === undefined) return [issue('SHOT_NOT_FOUND', 'conflict', shotId, 'id', `컷을 찾을 수 없습니다: ${shotId}`, 'existing shot', shotId, [])];
  return [...textMappingReviewIssues(project, shot.segmentId), ...sourcePolicyReviewIssues(project, shot.segmentId).filter((value: Issue): boolean => value.entityId === shot.id), ...sourceMappingReviewIssues(project, shot), ...revealReviewIssues(project, shot)];
}

export function approvalIssuesForShot(project: Project, shotId: string): Issue[] {
  return reviewIssuesForShot(project, shotId);
}

export function reviewIssuesForFrame(project: Project, frameId: string): Issue[] {
  const frame: StoryboardFrame | undefined = project.frames.find((candidate: StoryboardFrame): boolean => candidate.id === frameId);
  if (frame === undefined) return [issue('FRAME_NOT_FOUND', 'conflict', frameId, 'id', `프레임을 찾을 수 없습니다: ${frameId}`, 'existing frame', frameId, [])];
  const shot: Shot | undefined = project.shots.find((candidate: Shot): boolean => candidate.id === frame.shotId);
  if (shot === undefined) return [issue('SHOT_NOT_FOUND', 'conflict', frame.id, 'shotId', `프레임의 컷을 찾을 수 없습니다: ${frame.shotId}`, 'existing shot', frame.shotId, [])];
  const frameMs: number = frameEvaluationAbsoluteMs(shot, frame);
  const active: ShotSourceLink[] = directVisualLinks(shot).filter((link: ShotSourceLink): boolean => {
    const range: SourceAnchorRange | null = sourceAnchorRange(project, shot, link);
    return range !== null && range.startMs <= frameMs && frameMs < range.endMs;
  });
  const visualIssue: Issue[] = active.length === 0 ? [issue('FRAME_VISUAL_SOURCE_REQUIRED', 'conflict', frame.id, 'sourceLinks', '이 프레임 시각에 활성화된 직접 시각 원문이 필요합니다.', 'active primary or continued source', String(frameMs), [])] : [];
  return [...reviewIssuesForShot(project, shot.id), ...visualIssue];
}

export function reviewIssuesForSegment(project: Project, segmentId: string): Issue[] {
  const segment: Segment | undefined = project.dataset.segments.find((candidate: Segment): boolean => candidate.id === segmentId);
  if (segment === undefined) return [issue('SEGMENT_NOT_FOUND', 'conflict', segmentId, 'id', `구간을 찾을 수 없습니다: ${segmentId}`, 'existing segment', segmentId, [])];
  return [...textMappingReviewIssues(project, segmentId), ...sourcePolicyReviewIssues(project, segmentId), ...project.shots.filter((shot: Shot): boolean => shot.segmentId === segmentId).flatMap((shot: Shot): Issue[] => [...sourceMappingReviewIssues(project, shot), ...revealReviewIssues(project, shot)])];
}

export function reviewIssuesForProject(project: Project): Issue[] {
  return project.dataset.segments.flatMap((segment: Segment): Issue[] => reviewIssuesForSegment(project, segment.id));
}

export function mappingReviewIssues(project: Project): Issue[] {
  return reviewIssuesForProject(project);
}

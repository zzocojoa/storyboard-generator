import { z } from 'zod';
import { contractError, issue } from './errors.js';
import {
  MillisecondsSchema, ProjectSchema, ShotSourceLinkSchema, TextMappingDecisionSchema,
} from './schema.js';
import type {
  AudioCue, Dataset, InformationRule, Issue, Project, Segment, Shot, ShotSourceLink,
  SourceRef, SourceUnit, StoryboardFrame, TextCue, TextMappingDecision, TextPlacement,
} from './schema.js';
import { validateProject } from './validation.js';

export const TextMappingDecisionInputSchema = TextMappingDecisionSchema.pick({
  canonicalUnitId: true, relation: true, status: true, renderCanonicalSeparately: true,
  canonicalStartMs: true, canonicalEndMs: true, note: true,
});
export const ShotSourceLinksInputSchema = z.strictObject({ links: z.array(ShotSourceLinkSchema) });
export const MoveShotSourceLinkInputSchema = z.strictObject({
  unitId: z.string().min(1), targetShotId: z.string().min(1), usage: ShotSourceLinkSchema.shape.usage,
});
export type TextMappingDecisionInput = z.infer<typeof TextMappingDecisionInputSchema>;
export type ShotSourceLinksInput = z.infer<typeof ShotSourceLinksInputSchema>;
export type MoveShotSourceLinkInput = z.infer<typeof MoveShotSourceLinkInputSchema>;

export type EffectiveInformationGate = InformationRule & { reviewRequired: boolean };

function words(text: string): string[] {
  return [...new Set(text.normalize('NFKC').toLocaleLowerCase('ko-KR').split(/[^\p{Letter}\p{Number}]+/u).filter((word: string): boolean => word.length >= 2))];
}

function candidateScore(placement: TextPlacement, unit: SourceUnit): number {
  if (placement.text === unit.text) return Number.MAX_SAFE_INTEGER;
  const placementWords: string[] = words(placement.text);
  if (placementWords.length === 0) return 0;
  const unitWords: Set<string> = new Set(words(unit.text));
  const overlap: number = placementWords.filter((word: string): boolean => unitWords.has(word) || unit.text.includes(word)).length;
  return overlap / placementWords.length;
}

export function canonicalCandidate(dataset: Dataset, placement: TextPlacement): SourceUnit | null {
  const candidates: SourceUnit[] = dataset.units.filter((unit: SourceUnit): boolean => unit.segmentId === placement.segmentId);
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
    const exact: SourceUnit | undefined = dataset.units.find((unit: SourceUnit): boolean => unit.segmentId === placement.segmentId && unit.text === placement.text);
    const candidate: SourceUnit | null = exact ?? canonicalCandidate(dataset, placement);
    return {
      id: `text-mapping-${index + 1}`, placementId: placement.id, canonicalUnitId: candidate?.id ?? null,
      relation: exact === undefined ? (candidate === null ? 'separate-element' : 'abbreviation') : 'exact',
      status: exact === undefined ? 'unresolved' : 'confirmed', renderCanonicalSeparately: false,
      canonicalStartMs: null, canonicalEndMs: null, note: null,
    };
  });
}

function initialRuleGate(dataset: Dataset, rule: InformationRule, decisions: readonly TextMappingDecision[]): InformationRule {
  const candidates: { placement: TextPlacement; decision: TextMappingDecision; unit: SourceUnit }[] = decisions.flatMap((decision: TextMappingDecision) => {
    const placement: TextPlacement | undefined = dataset.textPlacements.find((value: TextPlacement): boolean => value.id === decision.placementId);
    const unit: SourceUnit | undefined = dataset.units.find((value: SourceUnit): boolean => value.id === decision.canonicalUnitId && value.informationIds.includes(rule.id));
    return placement === undefined || unit === undefined || placement.segmentId !== rule.segmentId ? [] : [{ placement, decision, unit }];
  }).sort((left, right): number => left.placement.startMs - right.placement.startMs);
  const candidate = candidates[0];
  if (candidate === undefined) return rule;
  return {
    ...rule, notBeforeMs: candidate.placement.startMs, notBeforeUnitId: candidate.unit.id,
    notBeforeUnitOrder: candidate.unit.order, precision: candidate.decision.status === 'confirmed' ? 'exact-time' : 'unit-order',
    sourceRefs: [...rule.sourceRefs, ...candidate.placement.sourceRefs, ...candidate.unit.sourceRefs],
  };
}

export function refineInformationRules(dataset: Dataset, decisions: readonly TextMappingDecision[]): InformationRule[] {
  return dataset.informationRules.map((rule: InformationRule): InformationRule => initialRuleGate(dataset, rule, decisions));
}

function confirmedPlacementGate(project: Project, rule: InformationRule): { time: number; unit: SourceUnit; refs: SourceRef[] } | null {
  const records = project.textMappingDecisions.flatMap((decision: TextMappingDecision) => {
    if (decision.status !== 'confirmed' || decision.canonicalUnitId === null) return [];
    const placement: TextPlacement | undefined = project.dataset.textPlacements.find((value: TextPlacement): boolean => value.id === decision.placementId);
    const unit: SourceUnit | undefined = project.dataset.units.find((value: SourceUnit): boolean => value.id === decision.canonicalUnitId && value.informationIds.includes(rule.id));
    if (placement === undefined || unit === undefined) return [];
    if (decision.relation === 'separate-element') return decision.canonicalStartMs === null ? [] : [{ time: decision.canonicalStartMs, unit, refs: [...placement.sourceRefs, ...unit.sourceRefs] }];
    return [{ time: placement.startMs, unit, refs: [...placement.sourceRefs, ...unit.sourceRefs] }];
  }).sort((left, right): number => left.time - right.time);
  return records[0] ?? null;
}

function confirmedAudioGate(project: Project, rule: InformationRule): { time: number; unit: SourceUnit; refs: SourceRef[] } | null {
  const records = project.audioCues.flatMap((cue: AudioCue) => {
    if (cue.timingStatus !== 'measured') return [];
    const unit: SourceUnit | undefined = project.dataset.units.find((value: SourceUnit): boolean => value.id === cue.unitId && value.informationIds.includes(rule.id));
    return unit === undefined ? [] : [{ time: cue.startMs, unit, refs: unit.sourceRefs }];
  }).sort((left, right): number => left.time - right.time);
  return records[0] ?? null;
}

export function effectiveInformationGate(project: Project, informationId: string): EffectiveInformationGate {
  const rule: InformationRule | undefined = project.dataset.informationRules.find((value: InformationRule): boolean => value.id === informationId);
  if (rule === undefined) throw contractError('UNRESOLVED_PROMPT_INFORMATION', `${informationId}의 공개 시점 정의가 필요합니다.`, []);
  const placement = confirmedPlacementGate(project, rule);
  if (placement !== null) return { ...rule, notBeforeMs: placement.time, notBeforeUnitId: placement.unit.id, notBeforeUnitOrder: placement.unit.order, precision: 'exact-time', sourceRefs: [...rule.sourceRefs, ...placement.refs], reviewRequired: false };
  const audio = confirmedAudioGate(project, rule);
  if (audio !== null) return { ...rule, notBeforeMs: audio.time, notBeforeUnitId: audio.unit.id, notBeforeUnitOrder: audio.unit.order, precision: 'exact-time', sourceRefs: [...rule.sourceRefs, ...audio.refs], reviewRequired: false };
  const unresolved: boolean = project.textMappingDecisions.some((decision: TextMappingDecision): boolean => decision.status === 'unresolved' && decision.canonicalUnitId === rule.notBeforeUnitId);
  return { ...rule, reviewRequired: unresolved };
}

function placementCue(project: Project, decision: TextMappingDecision, existing: readonly TextCue[]): TextCue {
  const placement: TextPlacement | undefined = project.dataset.textPlacements.find((value: TextPlacement): boolean => value.id === decision.placementId);
  if (placement === undefined) throw contractError('TEXT_PLACEMENT_NOT_FOUND', `자막 위치를 찾을 수 없습니다: ${decision.placementId}`, []);
  const current: TextCue | undefined = existing.find((cue: TextCue): boolean => cue.placementId === placement.id);
  const segment: Segment | undefined = project.dataset.segments.find((value: Segment): boolean => value.id === placement.segmentId);
  if (segment === undefined) throw contractError('SEGMENT_NOT_FOUND', `자막 구간을 찾을 수 없습니다: ${placement.segmentId}`, []);
  return {
    id: current?.id ?? `text-placement-${project.dataset.textPlacements.indexOf(placement) + 1}`, segmentId: placement.segmentId,
    unitId: decision.status === 'confirmed' ? decision.canonicalUnitId : null, placementId: placement.id,
    text: placement.text, startMs: placement.startMs, endMs: placement.endMs ?? current?.endMs ?? Math.min(segment.endMs, placement.startMs + 2000),
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
  const decidedUnits: Set<string> = new Set(decisions.flatMap((decision: TextMappingDecision): string[] => decision.canonicalUnitId === null ? [] : [decision.canonicalUnitId]));
  const unmapped: TextCue[] = project.dataset.units.filter((unit: SourceUnit): boolean => ['SCREEN_TEXT', 'CHAT', 'NOTE'].includes(unit.kind) && !decidedUnits.has(unit.id))
    .map((unit: SourceUnit): TextCue => {
      const segment: Segment = project.dataset.segments.find((value: Segment): boolean => value.id === unit.segmentId) as Segment;
      const current: TextCue | undefined = project.textCues.find((cue: TextCue): boolean => cue.unitId === unit.id && cue.placementId === null);
      return current ?? { id: `text-unit-${project.dataset.units.indexOf(unit) + 1}`, segmentId: unit.segmentId, unitId: unit.id, placementId: null,
        text: unit.text, startMs: segment.startMs, endMs: Math.min(segment.endMs, segment.startMs + holdMs), kind: unit.kind === 'SCREEN_TEXT' ? 'overlay' : 'prop-text', timingStatus: 'proposed' };
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

export function updateTextMappingDecision(project: Project, decisionId: string, input: TextMappingDecisionInput): Project {
  const parsed: TextMappingDecisionInput = TextMappingDecisionInputSchema.parse(input);
  const current: TextMappingDecision | undefined = project.textMappingDecisions.find((decision: TextMappingDecision): boolean => decision.id === decisionId);
  if (current === undefined) throw contractError('TEXT_MAPPING_NOT_FOUND', `자막 매핑 결정을 찾을 수 없습니다: ${decisionId}`, []);
  if (parsed.canonicalUnitId !== null) {
    const placement: TextPlacement = project.dataset.textPlacements.find((value: TextPlacement): boolean => value.id === current.placementId) as TextPlacement;
    if (!project.dataset.units.some((unit: SourceUnit): boolean => unit.id === parsed.canonicalUnitId && unit.segmentId === placement.segmentId)) throw contractError('INVALID_TEXT_MAPPING_UNIT', `${parsed.canonicalUnitId}: 같은 구간의 원문 단위를 선택하세요.`, []);
  }
  const nextDecision: TextMappingDecision = { ...current, ...parsed };
  const decisions: TextMappingDecision[] = project.textMappingDecisions.map((decision: TextMappingDecision): TextMappingDecision => decision.id === decisionId ? nextDecision : decision);
  const segmentId: string = mappingSegment(project, current);
  const currentPlacementCue: TextCue | undefined = project.textCues.find((cue: TextCue): boolean => cue.placementId === current.placementId);
  const holdMs: number = currentPlacementCue === undefined ? 2000 : Math.max(1, currentPlacementCue.endMs - currentPlacementCue.startMs);
  const base: Project = { ...project, textMappingDecisions: decisions };
  return finishMappingEdit(project, { ...base, textCues: reconcileTextCues(base, decisions, holdMs),
    frames: project.frames.map((frame: StoryboardFrame): StoryboardFrame => project.shots.some((shot: Shot): boolean => shot.id === frame.shotId && shot.segmentId === segmentId) ? { ...frame, visualReview: 'pending' } : frame),
    shots: project.shots.map((shot: Shot): Shot => shot.segmentId === segmentId ? { ...shot, approvalStatus: 'proposed' } : shot),
  });
}

function requireEditableSourceShot(project: Project, shotId: string): Shot {
  const shot: Shot | undefined = project.shots.find((value: Shot): boolean => value.id === shotId);
  if (shot === undefined) throw contractError('SHOT_NOT_FOUND', `컷을 찾을 수 없습니다: ${shotId}`, []);
  if (shot.lockedFields.includes('sources')) throw contractError('SHOT_FIELD_LOCKED', `${shotId}: sources 필드를 먼저 잠금 해제하세요.`, []);
  return shot;
}

export function updateShotSourceLinks(project: Project, shotId: string, input: ShotSourceLinksInput): Project {
  const parsed: ShotSourceLinksInput = ShotSourceLinksInputSchema.parse(input);
  const shot: Shot = requireEditableSourceShot(project, shotId);
  const next: Project = { ...project,
    shots: project.shots.map((candidate: Shot): Shot => candidate.id === shotId ? { ...candidate, sourceLinks: parsed.links, approvalStatus: 'proposed', proposalOrigin: 'manual' } : candidate),
    frames: project.frames.map((frame: StoryboardFrame): StoryboardFrame => frame.shotId === shot.id ? { ...frame, visualReview: 'pending' } : frame),
  };
  return finishMappingEdit(project, next);
}

export function moveShotSourceLink(project: Project, shotId: string, input: MoveShotSourceLinkInput): Project {
  const parsed: MoveShotSourceLinkInput = MoveShotSourceLinkInputSchema.parse(input);
  const source: Shot = requireEditableSourceShot(project, shotId);
  const target: Shot = requireEditableSourceShot(project, parsed.targetShotId);
  if (source.segmentId !== target.segmentId) throw contractError('INVALID_SOURCE_LINK_MOVE', '같은 구간의 컷 사이에서만 원문 연결을 이동할 수 있습니다.', []);
  const link: ShotSourceLink | undefined = source.sourceLinks.find((value: ShotSourceLink): boolean => value.unitId === parsed.unitId);
  if (link === undefined) throw contractError('SOURCE_LINK_NOT_FOUND', `${shotId}: ${parsed.unitId} 연결을 찾을 수 없습니다.`, []);
  if (target.sourceLinks.some((value: ShotSourceLink): boolean => value.unitId === parsed.unitId)) throw contractError('DUPLICATE_SOURCE_LINK', `${target.id}: ${parsed.unitId} 연결이 이미 있습니다.`, []);
  const next: Project = { ...project, shots: project.shots.map((shot: Shot): Shot => {
    if (shot.id === source.id) return { ...shot, sourceLinks: shot.sourceLinks.filter((value: ShotSourceLink): boolean => value.unitId !== parsed.unitId), approvalStatus: 'proposed' };
    if (shot.id === target.id) return { ...shot, sourceLinks: [...shot.sourceLinks, { unitId: parsed.unitId, usage: parsed.usage, status: 'confirmed' }], approvalStatus: 'proposed' };
    return shot;
  }), frames: project.frames.map((frame: StoryboardFrame): StoryboardFrame => [source.id, target.id].includes(frame.shotId) ? { ...frame, visualReview: 'pending' } : frame) };
  return finishMappingEdit(project, next);
}

function textMappingReviewIssues(project: Project, segmentId: string): Issue[] {
  return project.textMappingDecisions.flatMap((decision: TextMappingDecision): Issue[] => {
    const placement: TextPlacement | undefined = project.dataset.textPlacements.find((value: TextPlacement): boolean => value.id === decision.placementId && value.segmentId === segmentId);
    if (placement === undefined) return [];
    const refs: SourceRef[] = [...placement.sourceRefs, ...(project.dataset.units.find((unit: SourceUnit): boolean => unit.id === decision.canonicalUnitId)?.sourceRefs ?? [])];
    if (decision.status === 'unresolved') return [issue('UNRESOLVED_TEXT_MAPPING', 'conflict', decision.id, 'status', '축약 자막과 원문 화면 문구의 관계를 확정하세요.', 'confirmed', decision.status, refs)];
    if ((decision.relation === 'exact' || decision.relation === 'abbreviation' || decision.relation === 'replacement') && decision.canonicalUnitId === null) return [issue('MISSING_CANONICAL_TEXT_UNIT', 'conflict', decision.id, 'canonicalUnitId', '이 관계에는 Canonical 원문 단위가 필요합니다.', 'unitId', null, refs)];
    if ((decision.relation === 'separate-element' || decision.renderCanonicalSeparately) && (decision.canonicalStartMs === null || decision.canonicalEndMs === null || decision.canonicalEndMs <= decision.canonicalStartMs)) return [issue('CANONICAL_TEXT_TIMING_REQUIRED', 'conflict', decision.id, 'canonicalTiming', 'Canonical 문구를 별도로 표시하려면 시작·종료 시각을 명시하세요.', 'startMs < endMs', null, refs)];
    return [];
  });
}

function sourceMappingReviewIssues(project: Project, shot: Shot): Issue[] {
  return shot.sourceLinks.filter((link: ShotSourceLink): boolean => link.status === 'mapping-required')
    .map((link: ShotSourceLink): Issue => issue('SOURCE_MAPPING_REQUIRED', 'conflict', shot.id, 'sourceLinks', `${link.unitId}의 컷 배치와 용도를 확인하세요.`, 'confirmed', link.status, project.dataset.units.find((unit: SourceUnit): boolean => unit.id === link.unitId)?.sourceRefs ?? []));
}

function revealReviewIssues(project: Project, shot: Shot): Issue[] {
  const directInformationIds: string[] = directVisualLinks(shot).flatMap((link: ShotSourceLink): string[] =>
    project.dataset.units.find((unit: SourceUnit): boolean => unit.id === link.unitId)?.informationIds ?? []);
  return [...new Set([...shot.informationIds, ...directInformationIds])].flatMap((informationId: string): Issue[] => {
    const gate: EffectiveInformationGate = effectiveInformationGate(project, informationId);
    const linked: boolean = shot.sourceLinks.some((link: ShotSourceLink): boolean => project.dataset.units.find((unit: SourceUnit): boolean => unit.id === link.unitId)?.informationIds.includes(informationId) === true);
    if (!linked) return [issue('INFORMATION_WITHOUT_SOURCE_LINK', 'conflict', shot.id, 'informationIds', `${informationId}를 뒷받침하는 Source Link가 현재 컷에 없습니다.`, 'linked source unit', informationId, gate.sourceRefs)];
    if (shot.startMs < gate.notBeforeMs) return [issue('EARLY_INFORMATION_REVEAL', 'conflict', shot.id, 'informationIds', `${informationId}는 ${gate.notBeforeMs}ms 이후에만 공개할 수 있습니다.`, String(gate.notBeforeMs), String(shot.startMs), gate.sourceRefs)];
    return [];
  });
}

export function approvalIssuesForShot(project: Project, shotId: string): Issue[] {
  const shot: Shot | undefined = project.shots.find((value: Shot): boolean => value.id === shotId);
  if (shot === undefined) throw contractError('SHOT_NOT_FOUND', `컷을 찾을 수 없습니다: ${shotId}`, []);
  return [...textMappingReviewIssues(project, shot.segmentId), ...sourceMappingReviewIssues(project, shot), ...revealReviewIssues(project, shot)];
}

export function mappingReviewIssues(project: Project): Issue[] {
  return project.shots.flatMap((shot: Shot): Issue[] => [...sourceMappingReviewIssues(project, shot), ...revealReviewIssues(project, shot)])
    .concat(project.dataset.segments.flatMap((segment: Segment): Issue[] => textMappingReviewIssues(project, segment.id)));
}

export function directVisualLinks(shot: Shot): ShotSourceLink[] {
  return shot.sourceLinks.filter((link: ShotSourceLink): boolean => ['primary-visual', 'continued-visual'].includes(link.usage));
}

export function absoluteFrameTime(shot: Shot, frame: StoryboardFrame): number {
  return MillisecondsSchema.parse(shot.startMs + frame.offsetMs);
}

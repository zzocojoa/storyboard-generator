import { issue } from './errors.js';
import type { Issue, Project, TextCue, TextMappingDecision, TextPlacement } from './schema.js';

export type EffectiveTextPlacementRange = {
  startMs: number;
  endMs: number | null;
  evidence: 'placement' | 'text-cue' | 'canonical-range' | 'unresolved';
  issues: Issue[];
};

function rangeIssue(code: string, placement: TextPlacement, message: string, actual: string | null): Issue {
  return issue(code, 'conflict', placement.id, 'endMs', message, 'one authoritative end time', actual, placement.sourceRefs);
}

/** 열린 Placement의 종료를 원본, 유일한 Cue, 확정 Canonical 범위 순서로 증명한다. */
export function effectiveTextPlacementRange(project: Project, placementId: string): EffectiveTextPlacementRange {
  const placement: TextPlacement | undefined = project.dataset.textPlacements.find((candidate: TextPlacement): boolean => candidate.id === placementId);
  if (placement === undefined) {
    return { startMs: 0, endMs: null, evidence: 'unresolved', issues: [issue(
      'TEXT_PLACEMENT_NOT_FOUND', 'error', placementId, 'id', 'Text Placement를 찾을 수 없습니다.', 'existing placement', placementId, [],
    )] };
  }
  if (placement.endMs !== null) return { startMs: placement.startMs, endMs: placement.endMs, evidence: 'placement', issues: [] };
  const cues: TextCue[] = project.textCues.filter((cue: TextCue): boolean => cue.authority === 'placement' && cue.placementId === placement.id && cue.startMs === placement.startMs);
  if (cues.length === 1) return { startMs: placement.startMs, endMs: (cues[0] as TextCue).endMs, evidence: 'text-cue', issues: [] };
  if (cues.length > 1) return { startMs: placement.startMs, endMs: null, evidence: 'unresolved', issues: [rangeIssue(
    'AMBIGUOUS_TEXT_PLACEMENT_END', placement, '열린 Placement에 연결된 종료 Cue가 둘 이상입니다.', cues.map((cue: TextCue): string => `${cue.id}:${cue.endMs}`).join(','),
  )] };
  const mappings: TextMappingDecision[] = project.textMappingDecisions.filter((decision: TextMappingDecision): boolean =>
    decision.placementId === placement.id && decision.status === 'confirmed' && decision.canonicalEndMs !== null);
  if (mappings.length === 1) return { startMs: placement.startMs, endMs: (mappings[0] as TextMappingDecision).canonicalEndMs, evidence: 'canonical-range', issues: [] };
  if (mappings.length > 1) return { startMs: placement.startMs, endMs: null, evidence: 'unresolved', issues: [rangeIssue(
    'AMBIGUOUS_TEXT_PLACEMENT_END', placement, '열린 Placement에 연결된 확정 Canonical 종료가 둘 이상입니다.', mappings.map((mapping: TextMappingDecision): string => `${mapping.id}:${mapping.canonicalEndMs}`).join(','),
  )] };
  return { startMs: placement.startMs, endMs: null, evidence: 'unresolved', issues: [rangeIssue(
    'TEXT_PLACEMENT_END_REVIEW_REQUIRED', placement, '열린 Placement가 끝나는 시각을 Cue 또는 확정 Mapping으로 지정하세요.', null,
  )] };
}

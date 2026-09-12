import { contractError } from '../domain/errors.js';
import { reconcileTextCues } from '../domain/mapping.js';
import { TextMappingDecisionSchema, TextPlacementInformationDecisionSchema } from '../domain/schema.js';
import type { Project, TextCue, TextMappingDecision, TextPlacementInformationDecision } from '../domain/schema.js';
import { stableJsonStringify } from '../io/stable-json.js';
import type { AutomaticSegmentPlan, AutomaticTextTiming } from './plan-schema.js';

export function textTimingKey(cue: Pick<TextCue, 'authority' | 'placementId' | 'mappingDecisionId' | 'unitId'>): string {
  const id: string | null = cue.authority === 'placement' ? cue.placementId : cue.authority === 'mapping-decision' ? cue.mappingDecisionId : cue.unitId;
  if (cue.authority === 'review-required' || id === null) throw contractError('AUTOMATION_TEXT_AUTHORITY', '글자 권한과 연결을 먼저 계획해야 합니다.', []);
  return `${cue.authority}:${id}`;
}

export function assertUniquePlanKeys(keys: readonly string[], field: string): void {
  if (new Set(keys).size !== keys.length) throw contractError('AUTOMATION_DUPLICATE_DECISION', `${field}: 계획 대상이 중복됩니다.`, []);
}

function compileMappings(project: Project, plan: AutomaticSegmentPlan): TextMappingDecision[] {
  assertUniquePlanKeys(plan.mappings.map((value): string => value.decisionId), 'mappings');
  const planned: Map<string, TextMappingDecision> = new Map(plan.mappings.map((input): [string, TextMappingDecision] => {
    const current: TextMappingDecision | undefined = project.textMappingDecisions.find((value): boolean => value.id === input.decisionId);
    if (current === undefined || !project.dataset.textPlacements.some((placement): boolean => placement.id === current.placementId && placement.segmentId === plan.segmentId)) throw contractError('AUTOMATION_MAPPING_SCOPE', `대상 구간의 Mapping이 아닙니다: ${input.decisionId}`, []);
    if (input.canonicalUnitId !== null && !project.dataset.units.some((unit): boolean => unit.id === input.canonicalUnitId && unit.segmentId === plan.segmentId && ['SCREEN_TEXT', 'CHAT', 'NOTE'].includes(unit.kind))) throw contractError('AUTOMATION_CANONICAL_SOURCE', `Canonical 원문 후보가 아닙니다: ${input.canonicalUnitId}`, []);
    const next: TextMappingDecision = TextMappingDecisionSchema.parse({ id: current.id, placementId: current.placementId,
      canonicalUnitId: input.canonicalUnitId, relation: input.relation, status: 'confirmed', renderCanonicalSeparately: input.renderCanonicalSeparately,
      canonicalStartMs: input.canonicalStartMs, canonicalEndMs: input.canonicalEndMs, note: input.reason });
    if (current.status === 'confirmed' && stableJsonStringify({ ...next, note: current.note }) !== stableJsonStringify(current)) throw contractError('AUTOMATION_CONFIRMED_MAPPING', `기존 확정 연결을 자동 변경할 수 없습니다: ${current.id}`, []);
    return [current.id, current.status === 'confirmed' ? current : next];
  }));
  return project.textMappingDecisions.map((current): TextMappingDecision => planned.get(current.id) ?? current);
}

function compilePlacementInformation(project: Project, mappings: readonly TextMappingDecision[], plan: AutomaticSegmentPlan, generationId: string): TextPlacementInformationDecision[] {
  assertUniquePlanKeys(plan.placementInformation.map((value): string => value.placementId), 'placementInformation');
  const independentIds: Set<string> = new Set(mappings.filter((mapping): boolean => ['separate-element', 'standalone-placement'].includes(mapping.relation)).map((mapping): string => mapping.placementId));
  if (project.textPlacementInformationDecisions.some((current): boolean => current.status !== 'unresolved' && !independentIds.has(current.placementId))) throw contractError('AUTOMATION_CONFIRMED_INFORMATION', '확정된 독립 글자의 정보성 판단을 자동 제거할 수 없습니다.', []);
  const planned: Map<string, TextPlacementInformationDecision> = new Map(plan.placementInformation.map((input, index): [string, TextPlacementInformationDecision] => {
    if (!project.dataset.textPlacements.some((placement): boolean => placement.id === input.placementId && placement.segmentId === plan.segmentId) || !independentIds.has(input.placementId)) throw contractError('AUTOMATION_PLACEMENT_INFORMATION_SCOPE', `독립 글자 정보성의 대상이 아닙니다: ${input.placementId}`, []);
    const current = project.textPlacementInformationDecisions.find((value): boolean => value.placementId === input.placementId);
    const next: TextPlacementInformationDecision = TextPlacementInformationDecisionSchema.parse({ id: current?.id ?? `${generationId}:placement:${index}`, placementId: input.placementId, status: input.status, informationIds: input.informationIds, note: input.reason });
    if (current !== undefined && current.status !== 'unresolved' && stableJsonStringify({ ...next, note: current.note }) !== stableJsonStringify(current)) throw contractError('AUTOMATION_CONFIRMED_INFORMATION', `기존 확정 정보성 판단을 자동 변경할 수 없습니다: ${current.id}`, []);
    return [input.placementId, current !== undefined && current.status !== 'unresolved' ? current : next];
  }));
  const retained: TextPlacementInformationDecision[] = project.textPlacementInformationDecisions.filter((current): boolean => independentIds.has(current.placementId)).map((current): TextPlacementInformationDecision => planned.get(current.placementId) ?? current);
  return [...retained, ...[...planned.values()].filter((value): boolean => !retained.some((current): boolean => current.placementId === value.placementId))];
}

function timedCue(project: Project, cue: TextCue, timing: AutomaticTextTiming): TextCue {
  const previous: TextCue | undefined = project.textCues.find((value): boolean => value.id === cue.id);
  const sameTiming: boolean = cue.startMs === timing.startMs && cue.endMs === timing.endMs;
  if (previous?.timingStatus === 'confirmed' && (previous.startMs !== timing.startMs || previous.endMs !== timing.endMs || previous.text !== cue.text || previous.authority !== cue.authority || previous.unitId !== cue.unitId || previous.kind !== cue.kind)) throw contractError('AUTOMATION_CONFIRMED_TEXT', `사용자가 확정한 글자를 자동 변경할 수 없습니다: ${cue.id}`, []);
  if (cue.authority === 'mapping-decision' && !sameTiming) throw contractError('AUTOMATION_CANONICAL_TIMING', `별도 Canonical 시각과 글자 계획이 다릅니다: ${cue.id}`, []);
  return { ...cue, startMs: timing.startMs, endMs: timing.endMs, timingStatus: previous?.timingStatus === 'confirmed' ? 'confirmed' : 'proposed' };
}

/** 원문 본문은 공통 Mapping 함수에서 도출하고 모델에는 연결과 시각만 허용한다. */
export function compilePlannedText(project: Project, plan: AutomaticSegmentPlan, generationId: string): Pick<Project, 'textMappingDecisions' | 'textPlacementInformationDecisions' | 'textCues'> {
  const textMappingDecisions: TextMappingDecision[] = compileMappings(project, plan);
  const textPlacementInformationDecisions: TextPlacementInformationDecision[] = compilePlacementInformation(project, textMappingDecisions, plan, generationId);
  const timings: Map<string, AutomaticTextTiming> = new Map(plan.textTimings.map((timing): [string, AutomaticTextTiming] => [`${timing.authority}:${timing.targetId}`, timing]));
  assertUniquePlanKeys(plan.textTimings.map((timing): string => `${timing.authority}:${timing.targetId}`), 'textTimings');
  // 파생 Cue의 임시 길이는 모두 아래의 명시 계획으로 교체하며 저장하지 않는다.
  const derived: TextCue[] = reconcileTextCues(project, textMappingDecisions, 1).filter((cue): boolean => cue.segmentId === plan.segmentId);
  if (derived.length !== timings.size || derived.some((cue): boolean => !timings.has(textTimingKey(cue)))) throw contractError('AUTOMATION_TEXT_TIMING_COVERAGE', `${plan.segmentId}: 파생된 모든 글자의 시작·종료 계획이 정확히 하나씩 필요합니다. 대상=${derived.map(textTimingKey).join(', ')}`, []);
  const textCues: TextCue[] = derived.map((cue): TextCue => {
    const timing: AutomaticTextTiming | undefined = timings.get(textTimingKey(cue));
    if (timing === undefined) throw contractError('AUTOMATION_TEXT_TIMING_MISSING', `글자 시각 계획이 없습니다: ${cue.id}`, []);
    return timedCue(project, cue, timing);
  });
  const protectedIds: Set<string> = new Set(textCues.map((cue): string => cue.id));
  if (project.textCues.some((cue): boolean => cue.segmentId === plan.segmentId && cue.timingStatus === 'confirmed' && !protectedIds.has(cue.id))) throw contractError('AUTOMATION_CONFIRMED_TEXT', `${plan.segmentId}: 확정된 글자 트랙을 자동 제거할 수 없습니다.`, []);
  return { textMappingDecisions, textPlacementInformationDecisions, textCues: [...project.textCues.filter((cue): boolean => cue.segmentId !== plan.segmentId), ...textCues] };
}

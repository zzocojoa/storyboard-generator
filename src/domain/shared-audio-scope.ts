import { issue } from './errors.js';
import type { AudioInstructionDecision, Instruction, Issue, Project, SharedAudioScope } from './schema.js';
import { stableJsonStringify } from '../io/stable-json.js';

function sourceIdentity(instruction: Instruction): string {
  return JSON.stringify([instruction.kind, instruction.text, instruction.sourceRefs.map((ref): string => JSON.stringify([ref.fileId, ref.locator, ref.originalId])).toSorted()]);
}

/** 같은 문구만으로 묶지 않는다. 실제 원문 출처까지 같은 공통 지시만 찾는다. */
export function sharedAudioInstructions(project: Project, instruction: Instruction): Instruction[] {
  if (instruction.sourceRefs.length === 0) return [instruction];
  const key: string = sourceIdentity(instruction);
  return project.dataset.instructions.filter((value): boolean => value.sourceRefs.length > 0 && sourceIdentity(value) === key);
}

function sameIds(left: readonly string[], right: readonly string[]): boolean {
  return JSON.stringify(left.toSorted()) === JSON.stringify(right.toSorted());
}

export function sameSharedAudioScope(left: SharedAudioScope, right: SharedAudioScope): boolean {
  return sameIds(left.instructionIds, right.instructionIds) && sameIds(left.requiredSegmentIds, right.requiredSegmentIds)
    && sameIds(left.sourceEvidence.map((value): string => JSON.stringify(value)), right.sourceEvidence.map((value): string => JSON.stringify(value)));
}

function scopeShapeIssues(project: Project, instruction: Instruction, scope: SharedAudioScope): Issue[] {
  const group: Instruction[] = sharedAudioInstructions(project, instruction);
  const segmentIds: Set<string> = new Set(group.map((value): string => value.segmentId));
  const failure = (message: string): Issue => issue('AUDIO_INSTRUCTION_SHARED_SCOPE_INVALID', 'error', instruction.id, 'sharedScope', message, null, null, instruction.sourceRefs);
  return [
    ...(!sameIds(scope.instructionIds, group.map((value): string => value.id)) || group.length < 2
      ? [failure('동일한 원문 출처를 공유하는 지시 전체를 한 번씩 지정하세요.')] : []),
    ...(new Set(scope.requiredSegmentIds).size !== scope.requiredSegmentIds.length || scope.requiredSegmentIds.some((id): boolean => !segmentIds.has(id))
      ? [failure('공통 지시의 실제 구간만 중복 없이 적용 대상으로 지정하세요.')] : []),
    ...(new Set(scope.sourceEvidence.map((value): string => value.unitId)).size !== scope.sourceEvidence.length ? [failure('공통 음향의 대본 근거를 중복 인용할 수 없습니다.')] : []),
    ...scope.sourceEvidence.flatMap((entry): Issue[] => {
      const unit = project.dataset.units.find((value): boolean => value.id === entry.unitId);
      return unit === undefined || !segmentIds.has(unit.segmentId) || !['ACTION', 'SOUND', 'MUSIC'].includes(unit.kind)
        || !unit.text.includes(entry.quote) || !scope.requiredSegmentIds.includes(unit.segmentId)
        ? [failure(`${entry.unitId}: 적용 구간에 있는 실제 지문·소리 인용을 사용하세요. 다른 구간의 발화로 음향 발생을 만들 수 없습니다.`)] : [];
    }),
  ];
}

function respectsManualDecisions(project: Project, scope: SharedAudioScope): boolean {
  return (project.audioInstructionDecisions ?? []).filter((decision): boolean => scope.instructionIds.includes(decision.instructionId)
    && (decision.origin === 'manual' || decision.reviewStatus === 'confirmed')).every((decision): boolean =>
    scope.requiredSegmentIds.includes(decision.sourceSnapshot.segmentId) === (decision.resolution === 'required'));
}

/** 직접 판정과 현재 원문에 맞는 최근 공통 제안을 후속 구간의 기준으로 사용한다. */
export function preferredSharedAudioScope(project: Project, instruction: Instruction): SharedAudioScope | null {
  const groupIds: Set<string> = new Set(sharedAudioInstructions(project, instruction).map((value): string => value.id));
  for (const decision of (project.audioInstructionDecisions ?? []).toReversed()) {
    const scope = decision.sharedScope;
    if (groupIds.has(decision.instructionId) && scope !== undefined && scope !== null
      && sourceIdentity(decision.sourceSnapshot) === sourceIdentity(instruction)
      && scopeShapeIssues(project, instruction, scope).length === 0 && respectsManualDecisions(project, scope)) return scope;
  }
  return null;
}

function sharedAudioScopeDecisionIssues(project: Project, instruction: Instruction, decision: AudioInstructionDecision): Issue[] {
  const scope = decision.sharedScope;
  if (scope === undefined || scope === null) return [];
  const failure = (message: string): Issue => issue('AUDIO_INSTRUCTION_SHARED_SCOPE_INVALID', 'error', instruction.id, 'sharedScope', message, null, null, instruction.sourceRefs);
  return [...scopeShapeIssues(project, instruction, scope),
    ...(scope.requiredSegmentIds.includes(instruction.segmentId) !== (decision.resolution === 'required') ? [failure('공통 적용 구간과 현재 구간의 음향 필요 여부가 다릅니다.')] : []),
    ...scope.sourceEvidence.flatMap((entry): Issue[] => {
      const unit = project.dataset.units.find((value): boolean => value.id === entry.unitId);
      return unit?.segmentId === instruction.segmentId && unit.informationIds.some((id): boolean => !decision.informationIds.includes(id))
        ? [failure(`${entry.unitId}: 현재 구간에서 소리로 드러나는 원문의 정보 공개 조건을 연결하세요.`)] : [];
    }),
  ];
}

/** 과거 중복 제안을 삭제하거나 승인하지 않고 적용 범위를 다시 검토하도록 남긴다. */
export function sharedAudioScopeReviewIssues(project: Project, instruction: Instruction, decision: AudioInstructionDecision): Issue[] {
  const invalid: Issue[] = sharedAudioScopeDecisionIssues(project, instruction, decision);
  if (invalid.length > 0) return invalid.map((value): Issue => ({ ...value, severity: 'conflict' }));
  if (decision.origin === 'manual') return [];
  const groupIds: Set<string> = new Set(sharedAudioInstructions(project, instruction).map((value): string => value.id));
  if (groupIds.size < 2) return [];
  const scope = decision.sharedScope;
  const requiresScope: boolean = scope !== undefined || (project.audioInstructionDecisions ?? []).some((value): boolean =>
    groupIds.has(value.instructionId) && value.resolution === 'required');
  const reference = preferredSharedAudioScope(project, instruction);
  return requiresScope && (scope === undefined || scope === null || reference === null || !sameSharedAudioScope(scope, reference))
    ? [issue('AUDIO_INSTRUCTION_SHARED_SCOPE_REVIEW_REQUIRED', 'conflict', instruction.id, 'sharedScope',
      '여러 구간에 같은 음향 원문이 연결되어 있습니다. 소리가 실제로 필요한 구간을 함께 검토하여 반복·조기 배치를 확인하세요.', 'reviewed shared instruction scope', scope === undefined || scope === null ? null : JSON.stringify(scope), instruction.sourceRefs)] : [];
}

function sharedSourceContext(project: Project, instruction: Instruction): string {
  const group = sharedAudioInstructions(project, instruction);
  const segmentIds: Set<string> = new Set(group.map((value): string => value.segmentId));
  return stableJsonStringify({ group, segments: project.dataset.segments.filter((value): boolean => segmentIds.has(value.id)),
    units: project.dataset.units.filter((value): boolean => segmentIds.has(value.segmentId)),
    instructions: project.dataset.instructions.filter((value): boolean => segmentIds.has(value.segmentId)) });
}

/** 다른 적용 구간의 원문 변경도 공통 판단을 무효화한다. 현재 구간의 수동 연결·음원과 이전 기록은 보존한다. */
export function carrySharedAudioScope(current: Project, incoming: Project, decision: AudioInstructionDecision): AudioInstructionDecision {
  if (decision.sharedScope === undefined || decision.sharedScope === null) return decision;
  const instruction = incoming.dataset.instructions.find((value): boolean => value.id === decision.instructionId);
  if (instruction !== undefined && sharedSourceContext(current, decision.sourceSnapshot) === sharedSourceContext(incoming, instruction)) return decision;
  return { ...decision, sharedScope: null, reviewStatus: 'proposed' };
}

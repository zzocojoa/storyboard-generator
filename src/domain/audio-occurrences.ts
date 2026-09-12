import { issue } from './errors.js';
import type { AudioInstructionDecision, AudioInstructionOccurrence, Instruction, Issue, Project } from './schema.js';

function sameIds(left: readonly string[], right: readonly string[]): boolean {
  return JSON.stringify([...new Set(left)].toSorted()) === JSON.stringify([...new Set(right)].toSorted());
}

/** 한 발생의 원문·정보만 검사하며 다른 발생의 뒤늦은 공개 조건을 합치지 않는다. */
export function audioOccurrenceStructureIssues(project: Project, instruction: Instruction, decision: AudioInstructionDecision): Issue[] {
  if (decision.occurrences === undefined) return [];
  const occurrences: AudioInstructionOccurrence[] = decision.occurrences;
  const failure = (message: string): Issue => issue('AUDIO_INSTRUCTION_OCCURRENCE_INVALID', 'error', instruction.id, 'occurrences', message, null, null, instruction.sourceRefs);
  return [
    ...(!sameIds(occurrences.map((value): string => value.cueId), decision.cueIds) || new Set(occurrences.map((value): string => value.cueId)).size !== occurrences.length
      ? [failure('발생별 연결은 전체 음향 트랙을 중복 없이 한 번씩 지정해야 합니다.')] : []),
    ...(!sameIds(occurrences.flatMap((value): string[] => value.informationIds), decision.informationIds)
      ? [failure('전체 정보 연결은 발생별 정보 연결의 합집합과 같아야 합니다.')] : []),
    ...(decision.resolution === 'none' && occurrences.length > 0 ? [failure('추가 음향 없음 판정에는 발생별 연결을 둘 수 없습니다.')] : []),
    ...(decision.resolution === 'required' && occurrences.length === 0 ? [failure('필요한 음향의 발생별 연결을 지정하세요.')] : []),
    ...(decision.sourceEvidence ?? []).flatMap((entry): Issue[] => occurrences.some((value): boolean => (value.source.kind === 'unit'
      && value.source.unitId === entry.unitId && entry.quote.includes(value.source.quote)) || (value.supportingUnitIds ?? []).includes(entry.unitId))
      ? [] : [failure(`${entry.unitId}: 인용한 소리의 발생별 트랙이 없습니다.`)]),
    ...occurrences.flatMap((occurrence): Issue[] => {
      const cue = project.audioCues.find((value): boolean => value.id === occurrence.cueId);
      const source = occurrence.source;
      const unit = source.kind === 'unit' ? project.dataset.units.find((value): boolean => value.id === source.unitId) : undefined;
      const supportingIds: string[] = occurrence.supportingUnitIds ?? [];
      const supporting = supportingIds.map((id) => project.dataset.units.find((value): boolean => value.id === id));
      const validSource: boolean = source.kind === 'instruction' ? instruction.text.includes(source.quote) && !['-', '–', '—'].includes(source.quote.trim())
        : unit !== undefined && unit.segmentId === instruction.segmentId && ['ACTION', 'SOUND', 'MUSIC'].includes(unit.kind) && unit.text.includes(source.quote)
          && (decision.sourceEvidence ?? []).some((entry): boolean => entry.unitId === unit.id && entry.quote.includes(source.quote));
      return [
        ...(!validSource ? [failure(`${occurrence.cueId}: 현재 지시 또는 같은 구간의 검증된 소리 인용을 지정하세요.`)] : []),
        ...(new Set(supportingIds).size !== supportingIds.length || supportingIds.includes(unit?.id ?? '')
          || supporting.some((value): boolean => value === undefined || value.segmentId !== instruction.segmentId || !['ACTION', 'SOUND', 'MUSIC'].includes(value.kind)
            || !(decision.sourceEvidence ?? []).some((entry): boolean => entry.unitId === value.id))
          ? [failure(`${occurrence.cueId}: 같은 발생의 보충 근거는 현재 구간의 검증된 소리 원문을 중복 없이 지정하세요.`)] : []),
        ...(cue === undefined || (cue.instructionId === undefined ? source.kind !== 'unit' || cue.unitId !== source.unitId : cue.instructionId !== instruction.id)
          ? [failure(`${occurrence.cueId}: 원문이 같은 기존 효과음 또는 현재 지시의 전용 트랙에 연결하세요.`)] : []),
        ...(new Set(occurrence.informationIds).size !== occurrence.informationIds.length
          || occurrence.informationIds.some((id): boolean => !project.dataset.informationRules.some((rule): boolean => rule.id === id && rule.segmentId === instruction.segmentId))
          || unit?.informationIds.some((id): boolean => !occurrence.informationIds.includes(id))
          || supporting.some((value): boolean => value?.informationIds.some((id): boolean => !occurrence.informationIds.includes(id)) === true)
          ? [failure(`${occurrence.cueId}: 이 발생의 원문 정보 공개 조건을 빠짐없이 연결하세요.`)] : []),
      ];
    }),
  ];
}

/** 여러 원문 발생을 한 자동 트랙에 합친 과거 제안은 배치 완료로 간주하지 않는다. */
export function audioOccurrenceReviewIssues(project: Project, instruction: Instruction, decision: AudioInstructionDecision): Issue[] {
  const invalid: Issue[] = audioOccurrenceStructureIssues(project, instruction, decision);
  if (invalid.length > 0) return invalid.map((value): Issue => ({ ...value, severity: 'conflict' }));
  const combined: boolean = decision.occurrences === undefined && decision.origin === 'automatic' && decision.resolution === 'required'
    && (decision.sourceEvidence?.length ?? 0) > 1 && decision.cueIds.some((id): boolean => project.audioCues.some((cue): boolean => cue.id === id && cue.instructionId === instruction.id));
  return combined ? [issue('AUDIO_INSTRUCTION_OCCURRENCE_REVIEW_REQUIRED', 'conflict', instruction.id, 'occurrences',
    '서로 다른 원문 발생이 한 음향 트랙에 연결되어 있습니다. 발생별 원문·공개 조건·시각을 나누어 계획하세요.', 'source-bound occurrences', null, instruction.sourceRefs)] : [];
}

import { issue } from './errors.js';
import type { AudioInstructionDecision, Instruction, Issue, Project, SourceRef } from './schema.js';

/** 빈칸 표시는 무음 지시도 구체적인 효과음 설명도 아니다. 원문 바이트는 유지한다. */
export function isAudioInstructionPlaceholder(text: string): boolean {
  return ['-', '–', '—'].includes(text.trim());
}

/** 모델의 자유 서술을 음향 원문으로 쓰지 않고 같은 구간의 실제 지문·소리 인용을 검증한다. */
export function audioInstructionEvidenceIssues(project: Project, instruction: Instruction, decision: AudioInstructionDecision): Issue[] {
  const evidence = decision.sourceEvidence ?? [];
  const failure = (message: string): Issue => issue('AUDIO_INSTRUCTION_EVIDENCE_INVALID', 'error', instruction.id, 'sourceEvidence', message, null, null, instruction.sourceRefs);
  return [
    ...(decision.resolution === 'none' && evidence.length > 0 ? [failure('추가 음향 연결이 없는 판정에는 대본 인용 연결을 비우세요.')] : []),
    ...(new Set(evidence.map((entry): string => entry.unitId)).size !== evidence.length ? [failure('같은 원문 단위를 중복 인용할 수 없습니다.')] : []),
    ...evidence.flatMap((entry): Issue[] => {
      const unit = project.dataset.units.find((value): boolean => value.id === entry.unitId);
      if (unit === undefined || unit.segmentId !== instruction.segmentId || !['ACTION', 'SOUND', 'MUSIC'].includes(unit.kind)) return [failure(`${entry.unitId}: 같은 구간의 지문·소리 원문을 선택하세요. 발화나 다른 구간을 음향으로 바꿀 수 없습니다.`)];
      return [
        ...(!unit.text.includes(entry.quote) ? [failure(`${entry.unitId}: 인용한 문구가 실제 원문에 없습니다.`)] : []),
        ...(unit.informationIds.some((id): boolean => !decision.informationIds.includes(id)) ? [failure(`${entry.unitId}: 인용한 원문 정보의 공개 조건을 모두 연결하세요.`)] : []),
      ];
    }),
  ];
}

/** 기존 빈 트랙도 Final에서 숨기며 실제 근거를 추가하거나 추가 트랙 없음으로 재검토하게 한다. */
export function audioInstructionContentIssues(project: Project, instruction: Instruction, decision: AudioInstructionDecision): Issue[] {
  return decision.resolution === 'required' && isAudioInstructionPlaceholder(instruction.text) && (decision.sourceEvidence?.length ?? 0) === 0
    && decision.cueIds.some((id): boolean => project.audioCues.some((cue): boolean => cue.id === id && cue.instructionId === instruction.id))
    ? [issue('AUDIO_INSTRUCTION_CONTENT_REQUIRED', 'conflict', instruction.id, 'sourceEvidence',
      '빈칸 표시로 음향 트랙을 만들 수 없습니다. 실제 소리가 적힌 같은 구간의 대본 인용을 연결하거나 추가 트랙 없음으로 판정하세요.', 'exact source evidence', instruction.text, instruction.sourceRefs)] : [];
}

export function audioInstructionSourceText(instruction: Instruction, decision: AudioInstructionDecision): string {
  const quotes: string[] = (decision.sourceEvidence ?? []).map((entry): string => entry.quote);
  return quotes.length === 0 ? instruction.text : [...new Set([...(isAudioInstructionPlaceholder(instruction.text) ? [] : [instruction.text]), ...quotes])].join('\n');
}

export function audioInstructionSourceRefs(project: Project, instruction: Instruction, decision: AudioInstructionDecision): SourceRef[] {
  return [...instruction.sourceRefs, ...(decision.sourceEvidence ?? []).flatMap((entry): SourceRef[] => project.dataset.units.find((unit): boolean => unit.id === entry.unitId)?.sourceRefs ?? [])];
}

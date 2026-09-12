import type { AudioCue, Instruction, Project, SourceRef } from './schema.js';
import { unitAudioKind } from './unit-media.js';
import { stableJsonStringify } from '../io/stable-json.js';
import { audioInstructionSourceRefs, audioInstructionSourceText } from './audio-instruction-evidence.js';

export type AudioSource = {
  id: string; unitId: string | null; instructionId: string | null; segmentId: string;
  kind: AudioCue['kind']; text: string; speakerId: string | null; informationIds: string[]; sourceRefs: SourceRef[];
};

export function audioInstructionMatches(left: Instruction, right: Instruction): boolean {
  return stableJsonStringify(left) === stableJsonStringify(right);
}

/** 시간 검사는 기존 대본의 유형 오류와 독립적으로 원문 구간을 해석한다. */
export function audioCueTimingSource(project: Project, cue: AudioCue): AudioSource | null {
  const instructionInformation: string[] = (project.audioInstructionDecisions ?? [])
    .filter((decision): boolean => decision.resolution === 'required' && decision.cueIds.includes(cue.id)
      && project.dataset.instructions.some((instruction): boolean => instruction.id === decision.instructionId && audioInstructionMatches(instruction, decision.sourceSnapshot)))
    .flatMap((decision): string[] => decision.informationIds);
  if (cue.instructionId === undefined) {
    const unit = project.dataset.units.find((value): boolean => value.id === cue.unitId);
    if (unit === undefined) return null;
    return { id: unit.id, unitId: unit.id, instructionId: null, segmentId: unit.segmentId, kind: cue.kind, text: unit.text,
      speakerId: unit.speakerId, informationIds: [...new Set([...unit.informationIds, ...instructionInformation])], sourceRefs: unit.sourceRefs };
  }
  if (cue.unitId !== null) return null;
  const instruction = project.dataset.instructions.find((value): boolean => value.id === cue.instructionId);
  if (instruction === undefined || (instruction.kind === 'music' ? cue.kind !== 'music' : instruction.kind !== 'ambience' || cue.kind !== 'sfx')) return null;
  const decisions = (project.audioInstructionDecisions ?? []).filter((value): boolean => value.instructionId === instruction.id);
  const decision = decisions[0];
  if (decisions.length !== 1 || decision === undefined || decision.resolution !== 'required' || !decision.cueIds.includes(cue.id) || !audioInstructionMatches(decision.sourceSnapshot, instruction)) return null;
  return { id: instruction.id, unitId: null, instructionId: instruction.id, segmentId: instruction.segmentId, kind: cue.kind,
    text: audioInstructionSourceText(instruction, decision), speakerId: null, informationIds: [...new Set(instructionInformation)], sourceRefs: audioInstructionSourceRefs(project, instruction, decision) };
}

/** 출력·음원 등록은 시간 근거뿐 아니라 원문과 트랙의 유형 일치도 요구한다. */
export function audioCueSource(project: Project, cue: AudioCue): AudioSource | null {
  const source = audioCueTimingSource(project, cue);
  if (source === null || cue.instructionId !== undefined) return source;
  const unit = project.dataset.units.find((value): boolean => value.id === cue.unitId);
  return unit !== undefined && unitAudioKind(unit) === cue.kind ? source : null;
}

export function audioCuesInSegment(project: Project, segmentId: string): AudioCue[] {
  return project.audioCues.filter((cue): boolean => audioCueTimingSource(project, cue)?.segmentId === segmentId);
}

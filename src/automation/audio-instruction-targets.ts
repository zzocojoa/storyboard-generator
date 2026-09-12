import { audioInstructions } from '../domain/audio-instructions.js';
import { automaticShotProtected } from '../domain/edit-protection.js';
import { isAudioInstructionPlaceholder } from '../domain/audio-instruction-evidence.js';
import type { Instruction, Project } from '../domain/schema.js';

/** 원문에 있는 미판정 지시만 계획한다. 보호된 컷과 이미 검토한 판정은 다시 만들지 않는다. */
export function automaticAudioInstructionTargets(project: Project, segmentId: string): Instruction[] {
  if (project.shots.some((shot): boolean => shot.segmentId === segmentId && automaticShotProtected(project, shot))) return [];
  return audioInstructions(project).filter((instruction): boolean => {
    if (instruction.segmentId !== segmentId) return false;
    const decision = project.audioInstructionDecisions?.find((value): boolean => value.instructionId === instruction.id);
    if (decision === undefined) return true;
    return decision.origin === 'automatic' && decision.reviewStatus === 'proposed' && decision.resolution === 'required'
      && isAudioInstructionPlaceholder(instruction.text) && (decision.sourceEvidence?.length ?? 0) === 0
      && decision.cueIds.length > 0 && decision.cueIds.every((id): boolean => project.audioCues.some((cue): boolean =>
        cue.id === id && cue.instructionId === instruction.id && cue.assetId === null && cue.timingStatus === 'proposed'));
  });
}

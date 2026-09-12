import { audioTimingIssues } from './audio.js';
import { audioCueSource } from './audio-source.js';
import { reviewInformationEmission } from './emission.js';
import { issue } from './errors.js';
import type { AudioCue, Issue, Project } from './schema.js';
import { sourceRevealEvidenceMs } from './source-anchor.js';
import { audioInstructionContentIssues, audioInstructionEvidenceIssues } from './audio-instruction-evidence.js';

/** 음원 실측과 별개로 원문에 연결한 콘티 발화의 최초 계획 시각을 읽는다. */
export function plannedAudioSourceStart(project: Project, cue: AudioCue): number | null {
  const source = audioCueSource(project, cue);
  if (source === null || cue.unitId === null) return null;
  const starts: number[] = project.shots.flatMap((shot): number[] => shot.segmentId !== source.segmentId ? [] : shot.sourceLinks.flatMap((link): number[] => {
    if (link.unitId !== cue.unitId || link.usage !== 'audio-only') return [];
    const start: number | null = sourceRevealEvidenceMs(project, shot, link);
    return start === null ? [] : [start];
  }));
  return starts.length === 0 ? null : Math.min(...starts);
}

/** 콘티에는 원문·배치·공개 순서를 요구하며 실제 음원의 유무·길이는 재생 검사에 맡긴다. */
export function storyboardAudioIssues(project: Project, cue: AudioCue): Issue[] {
  const source = audioCueSource(project, cue);
  if (source === null) return [issue('AUDIO_SOURCE_CONTEXT_MISSING', 'error', cue.id, 'audioSource', '대사·음향 지시의 원문 연결을 확인하세요.', 'valid source', cue.instructionId ?? cue.unitId, [])];
  const plannedStart: number | null = plannedAudioSourceStart(project, cue);
  const instruction = project.dataset.instructions.find((value): boolean => value.id === cue.instructionId);
  const decision = project.audioInstructionDecisions?.find((value): boolean => value.instructionId === cue.instructionId);
  const instructionIssues: Issue[] = instruction === undefined || decision === undefined ? []
    : [...audioInstructionContentIssues(project, instruction, decision), ...audioInstructionEvidenceIssues(project, instruction, decision)];
  const anchorIssues: Issue[] = cue.timingStatus !== 'measured' && cue.timingRelation !== 'j-cut' && cue.unitId !== null && plannedStart !== cue.startMs
    ? [issue('STORYBOARD_AUDIO_TIMING_REQUIRED', 'conflict', cue.id, 'timing', '콘티의 발화·음향 시작과 원문 연결의 최초 시각을 맞추세요. 실제 음원은 선택 사항입니다.', String(cue.startMs), plannedStart === null ? null : String(plannedStart), source.sourceRefs)] : [];
  return [...audioTimingIssues(project, cue), ...anchorIssues, ...instructionIssues,
    ...reviewInformationEmission(project, { entityId: cue.id, channel: 'export', informationIds: source.informationIds, atMs: cue.startMs })];
}

import { audioTimingIssues } from './audio.js';
import { audioCueSource } from './audio-source.js';
import { reviewInformationEmission } from './emission.js';
import { issue } from './errors.js';
import type { AudioCue, Issue, Project, ShotSourceLink } from './schema.js';
import { sourceRevealEvidenceMs } from './source-anchor.js';
import { audioInstructionContentIssues, audioInstructionEvidenceIssues } from './audio-instruction-evidence.js';

type PlannedSourceEvidence = { usage: ShotSourceLink['usage']; atMs: number };

/** 음성 전용 Anchor를 우선하며, 직접 시각 원문을 함께 쓰는 발화는 그 공개 이후의 독립 Cue 시각을 사용한다. */
export function plannedAudioSourceStart(project: Project, cue: AudioCue): number | null {
  const source = audioCueSource(project, cue);
  if (source === null || cue.unitId === null) return null;
  const evidence: PlannedSourceEvidence[] = project.shots.flatMap((shot): PlannedSourceEvidence[] => shot.segmentId !== source.segmentId ? [] : shot.sourceLinks.flatMap((link): PlannedSourceEvidence[] => {
    if (link.unitId !== cue.unitId || link.usage === 'context-only') return [];
    const start: number | null = sourceRevealEvidenceMs(project, shot, link);
    return start === null ? [] : [{ usage: link.usage, atMs: start }];
  }));
  const audioStarts: number[] = evidence.filter((value): boolean => value.usage === 'audio-only').map((value): number => value.atMs);
  if (audioStarts.length > 0) return Math.min(...audioStarts);
  return evidence.some((value): boolean => (value.usage === 'primary-visual' || value.usage === 'continued-visual') && value.atMs <= cue.startMs)
    ? cue.startMs : null;
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
    ? [issue('STORYBOARD_AUDIO_TIMING_REQUIRED', 'conflict', cue.id, 'timing', '음성 전용 원문의 최초 Anchor와 발화 시작을 맞추세요. 같은 원문을 그림에도 쓰면 직접 시각 연결을 확정하고 최초 공개 이후에 발화를 배치하세요. 실제 음원은 선택 사항입니다.', String(cue.startMs), plannedStart === null ? null : String(plannedStart), source.sourceRefs)] : [];
  return [...audioTimingIssues(project, cue), ...anchorIssues, ...instructionIssues,
    ...reviewInformationEmission(project, { entityId: cue.id, channel: 'export', informationIds: source.informationIds, atMs: cue.startMs })];
}

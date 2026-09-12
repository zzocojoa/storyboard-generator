import { audioCuesInSegment } from '../domain/audio-source.js';
import { audioMixValues } from '../domain/audio-mix.js';
import { automaticAudioProtected } from '../domain/edit-protection.js';
import type { AudioCue, Project } from '../domain/schema.js';
import { automaticHash } from './application-evidence.js';

/** 겹치는 음원의 실제 파일·원문·배치·수동 음량에 결속한다. 자동 결과 자체는 재실행 근거가 아니다. */
export function audioMixPlanningHash(project: Project, cue: AudioCue): string {
  return automaticHash({ projectId: project.projectId, cues: project.audioCues
    .filter((other): boolean => other.id === cue.id || other.startMs < cue.endMs && cue.startMs < other.endMs)
    .map((other) => ({ id: other.id, unit: other.instructionId === undefined ? project.dataset.units.find((unit): boolean => unit.id === other.unitId) : project.dataset.instructions.find((instruction): boolean => instruction.id === other.instructionId),
      kind: other.kind, startMs: other.startMs, endMs: other.endMs, timingStatus: other.timingStatus,
      asset: other.assetId === null ? null : project.assets.find((asset): boolean => asset.id === other.assetId),
      manualMix: other.mix?.mode === 'manual' ? audioMixValues(other) : null })) });
}

export function automaticAudioMixTargets(project: Project, segmentId: string): AudioCue[] {
  return audioCuesInSegment(project, segmentId).filter((cue): boolean => cue.assetId !== null && cue.timingStatus === 'measured'
    && cue.mix?.mode !== 'manual' && !automaticAudioProtected(project, cue)
    && cue.mix?.plannedInputHash !== audioMixPlanningHash(project, cue));
}

export function audioMixContext(project: Project, targets: readonly AudioCue[]): AudioCue[] {
  return project.audioCues.filter((cue): boolean => targets.some((target): boolean => cue.id === target.id || cue.startMs < target.endMs && target.startMs < cue.endMs));
}

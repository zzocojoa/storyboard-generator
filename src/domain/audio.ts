import { contractError, issue } from './errors.js';
import type { AudioCue, Issue, Project, Segment, SourceUnit } from './schema.js';

export type AudioTimingContext = {
  unit: SourceUnit;
  sourceSegment: Segment;
  previousSegment: Segment | null;
  nextSegment: Segment | null;
};

export function audioTimingContext(project: Project, cue: AudioCue): AudioTimingContext | null {
  const unit: SourceUnit | undefined = project.dataset.units.find((candidate: SourceUnit): boolean => candidate.id === cue.unitId);
  if (unit === undefined) return null;
  const sourceIndex: number = project.dataset.segments.findIndex((segment: Segment): boolean => segment.id === unit.segmentId);
  const sourceSegment: Segment | undefined = project.dataset.segments[sourceIndex];
  if (sourceSegment === undefined) return null;
  return {
    unit,
    sourceSegment,
    previousSegment: sourceIndex > 0 ? project.dataset.segments[sourceIndex - 1] ?? null : null,
    nextSegment: project.dataset.segments[sourceIndex + 1] ?? null,
  };
}

export function audioOverhangBeforeMs(project: Project, cue: AudioCue): number {
  const context: AudioTimingContext | null = audioTimingContext(project, cue);
  return context === null ? 0 : Math.max(0, context.sourceSegment.startMs - cue.startMs);
}

export function audioOverhangAfterMs(project: Project, cue: AudioCue): number {
  const context: AudioTimingContext | null = audioTimingContext(project, cue);
  return context === null ? 0 : Math.max(0, cue.endMs - context.sourceSegment.endMs);
}

function relationIssue(cue: AudioCue, expected: string, refs: SourceUnit['sourceRefs']): Issue {
  return issue('AUDIO_RELATION_MISMATCH', 'error', cue.id, 'timingRelation',
    `${cue.timingRelation} 관계와 Master Timeline의 시작·종료 시각이 맞지 않습니다.`, expected,
    `${cue.startMs}..${cue.endMs}`, refs);
}

function overhangIssue(cue: AudioCue, expected: string, refs: SourceUnit['sourceRefs']): Issue {
  return issue('AUDIO_OVERHANG_OUT_OF_RANGE', 'error', cue.id, 'timing',
    'J-cut 또는 L-cut은 원본 구간과 바로 인접한 한 구간까지만 걸칠 수 있습니다.', expected,
    `${cue.startMs}..${cue.endMs}`, refs);
}

/** Audio Cue의 명시적 구간 관계와 실제 Master Timeline 범위를 함께 검사한다. */
export function audioTimingIssues(project: Project, cue: AudioCue): Issue[] {
  const context: AudioTimingContext | null = audioTimingContext(project, cue);
  if (context === null) {
    return [issue('AUDIO_SOURCE_CONTEXT_MISSING', 'error', cue.id, 'unitId',
      'Audio Cue의 원본 Unit과 Segment를 찾을 수 없습니다.', 'existing source unit and segment', cue.unitId, [])];
  }
  const { sourceSegment, previousSegment, nextSegment, unit } = context;
  const totalEndMs: number = project.dataset.segments.at(-1)?.endMs ?? 0;
  if (cue.endMs <= cue.startMs || cue.startMs < 0 || cue.endMs > totalEndMs) {
    return [issue('INVALID_AUDIO_INTERVAL', 'error', cue.id, 'timing',
      'Audio Cue는 프로젝트 Master Timeline 안의 비어 있지 않은 범위여야 합니다.', `0..${totalEndMs}`,
      `${cue.startMs}..${cue.endMs}`, unit.sourceRefs)];
  }
  if (cue.timingRelation === 'within-segment') {
    return cue.startMs >= sourceSegment.startMs && cue.endMs <= sourceSegment.endMs
      ? [] : [relationIssue(cue, `${sourceSegment.startMs}..${sourceSegment.endMs}`, unit.sourceRefs)];
  }
  if (cue.timingRelation === 'j-cut') {
    if (previousSegment === null) return [overhangIssue(cue, 'previous adjacent segment', unit.sourceRefs)];
    if (cue.startMs < previousSegment.startMs || cue.endMs > sourceSegment.endMs) return [overhangIssue(cue, `${previousSegment.startMs}..${sourceSegment.endMs}`, unit.sourceRefs)];
    const valid: boolean = cue.startMs < sourceSegment.startMs && cue.endMs > sourceSegment.startMs
      && cue.endMs <= sourceSegment.endMs;
    return valid ? [] : [relationIssue(cue, `${previousSegment.startMs} <= start < ${sourceSegment.startMs} < end <= ${sourceSegment.endMs}`, unit.sourceRefs)];
  }
  if (nextSegment === null) return [overhangIssue(cue, 'next adjacent segment', unit.sourceRefs)];
  if (cue.startMs < sourceSegment.startMs || cue.endMs > nextSegment.endMs) return [overhangIssue(cue, `${sourceSegment.startMs}..${nextSegment.endMs}`, unit.sourceRefs)];
  const valid: boolean = cue.startMs >= sourceSegment.startMs && cue.startMs < sourceSegment.endMs
    && cue.endMs > sourceSegment.endMs;
  return valid ? [] : [relationIssue(cue, `${sourceSegment.startMs} <= start < ${sourceSegment.endMs} < end <= ${nextSegment.endMs}`, unit.sourceRefs)];
}

export function assertAudioTimingRelation(project: Project, cue: AudioCue): void {
  const issues: Issue[] = audioTimingIssues(project, cue);
  if (issues.length === 0) return;
  const code: string = issues.some((value: Issue): boolean => value.code === 'AUDIO_OVERHANG_OUT_OF_RANGE')
    ? 'AUDIO_OVERHANG_OUT_OF_RANGE' : 'INVALID_AUDIO_TIMING_RELATION';
  throw contractError(code, issues.map((value: Issue): string => `${value.code}: ${value.message}`).join('\n'), issues);
}

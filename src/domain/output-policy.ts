import { reviewIssuesForTextCue } from './emission.js';
import { issue } from './errors.js';
import type { Issue, Project, Segment, TextCue } from './schema.js';

export type OutputMaturity = 'draft' | 'final';
export type OutputPolicy = {
  maturity: OutputMaturity;
  channel: 'program-monitor' | 'safe-http' | 'pdf-export' | 'csv-export' | 'readiness';
};
export type TextOutputDecision = {
  cueId: string; policy: OutputPolicy; allowed: boolean; finalSafe: boolean;
  label: 'FINAL' | 'DRAFT' | 'DRAFT · TIMING UNCONFIRMED' | 'BLOCKED'; issues: Issue[];
};

/** 시각 확정은 본문 권한 및 정보 공개 검사와 독립적인 Final 출력 조건이다. */
export function reviewTextOutput(project: Project, cueId: string, policy: OutputPolicy): TextOutputDecision {
  const cue: TextCue | undefined = project.textCues.find((candidate: TextCue): boolean => candidate.id === cueId);
  const issues: Issue[] = reviewIssuesForTextCue(project, cueId);
  if (cue !== undefined) {
    const segment: Segment | undefined = project.dataset.segments.find((candidate: Segment): boolean => candidate.id === cue.segmentId);
    if (segment === undefined || !Number.isSafeInteger(cue.startMs) || !Number.isSafeInteger(cue.endMs)
      || cue.endMs <= cue.startMs || cue.startMs < segment.startMs || cue.endMs > segment.endMs) {
      issues.push(issue('INVALID_TEXT_INTERVAL', 'conflict', cue.id, 'timing', 'Text Cue의 구간 안 시작·종료 시각을 지정하세요.',
        segment === undefined ? 'existing segment' : `${segment.startMs}..${segment.endMs}`, `${cue.startMs}..${cue.endMs}`, []));
    }
    if (policy.maturity === 'final' && cue.timingStatus !== 'confirmed') issues.push(issue(
      'TEXT_TIMING_CONFIRMATION_REQUIRED', 'conflict', cue.id, 'timingStatus',
      `${cue.id}: 시작·종료 시각을 검토한 뒤 Text Timing Confirm을 실행하세요. Placement=${cue.placementId ?? 'none'}, startMs=${cue.startMs}, endMs=${cue.endMs}, timingStatus=${cue.timingStatus}`,
      'confirmed', JSON.stringify({ cueId: cue.id, placementId: cue.placementId, startMs: cue.startMs, endMs: cue.endMs, timingStatus: cue.timingStatus }), []));
  }
  const allowed: boolean = issues.length === 0;
  return { cueId, policy, allowed, finalSafe: allowed && cue?.timingStatus === 'confirmed',
    label: !allowed ? 'BLOCKED' : cue?.timingStatus === 'proposed' ? 'DRAFT · TIMING UNCONFIRMED' : policy.maturity === 'draft' ? 'DRAFT' : 'FINAL', issues };
}

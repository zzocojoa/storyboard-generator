import { issue } from '../domain/errors.js';
import { textReadabilityIssues } from '../domain/text-readability.js';
import type { FinalReadinessReport } from '../domain/final-readiness.js';
import { reviewTextPlaybackWithPolicy } from '../domain/playback.js';
import type { OutputMaturity } from '../domain/output-policy.js';
import type { Issue, Project } from '../domain/schema.js';
import { layoutStoryboardText } from './text-layout.js';
import type { TextLayout } from './text-layout.js';
import type { TextFont } from './text-font.js';
import { isTextFontAvailabilityError, readSelectedTextFont } from './text-font-source.js';
import type { TextFontSource } from './text-font-source.js';

export function projectTextLayoutAt(project: Project, atMs: number, maturity: OutputMaturity, font: TextFont): TextLayout {
  const review = reviewTextPlaybackWithPolicy(project, atMs, { maturity, channel: 'program-monitor' });
  return layoutStoryboardText(review.playable, project.profile.aspectWidth, project.profile.aspectHeight, project.textLayout, font.metrics);
}

/** 본문 권한을 통과한 초안도 검사하여 시각 확정 전에 배치 문제를 해결할 수 있게 한다. */
export function textLayoutTimelineIssues(project: Project, font: TextFont): Issue[] {
  const times: number[] = [...new Set(project.textCues.flatMap((cue): number[] => [cue.startMs, cue.endMs]))].sort((a: number, b: number): number => a - b);
  const issues: Map<string, Issue> = new Map<string, Issue>();
  for (const atMs of times) for (const problem of projectTextLayoutAt(project, atMs, 'draft', font).problems) {
    const key: string = `${problem.code}:${problem.cueId}`;
    if (!issues.has(key)) issues.set(key, issue(problem.code, 'conflict', problem.cueId, 'textLayout',
      `${problem.message} 표시 시점 ${atMs}ms.`, 'visible non-overlapping text', String(atMs), []));
  }
  return [...issues.values()];
}

export function withTextLayoutReadiness(project: Project, report: FinalReadinessReport, font: TextFont): FinalReadinessReport {
  const issues: Issue[] = [...report.issues, ...textLayoutTimelineIssues(project, font), ...textReadabilityIssues(project)];
  return { ...report, finalReady: report.finalReady && issues.length === 0,
    stage: report.finalReady && issues.length > 0 ? 'text-confirmed' : report.stage, issues };
}

/** 글꼴 복원이 필요한 콘티도 열어 수정할 수 있게 원인을 최종 출력 검토에 포함한다. */
export async function withProjectTextReadiness(project: Project, report: FinalReadinessReport, source: TextFontSource): Promise<FinalReadinessReport> {
  try { return withTextLayoutReadiness(project, report, await readSelectedTextFont(project.textTypography, source)); }
  catch (error: unknown) {
    if (!isTextFontAvailabilityError(error)) throw error;
    return { ...report, finalReady: false, stage: report.finalReady ? 'text-confirmed' : report.stage, issues: [...report.issues, ...textReadabilityIssues(project),
      issue(error.code, 'conflict', project.projectId, 'textTypography', error.message, project.textTypography?.fontSha256 ?? 'available configured font', null, [])] };
  }
}

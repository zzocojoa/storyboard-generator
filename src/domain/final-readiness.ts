import { storyboardUnitOrderIssues } from './emission-order.js';
import { storyboardAudioIssues } from './audio-storyboard.js';
import { contractError, issue } from './errors.js';
import { audioInstructionOutputIssues } from './audio-instructions.js';
import { currentVisualReferenceAssets } from './asset-references.js';
import { approvalIssuesForShot } from './mapping.js';
import { reviewTextOutput } from './output-policy.js';
import { reviewAudioPlaybackAt } from './playback.js';
import type { Asset, AudioCue, Issue, Project, Shot, StoryboardFrame, TextCue } from './schema.js';
import { shotVisualCoverageGaps } from './source-policy.js';
import { validateProject } from './validation.js';
import { reviewShotVisualTimeline, reviewVisualOutputAt, uniqueOutputIssues } from './visual-output.js';

export type AssetIntegrityStatuses = Readonly<Record<string, string>>;
export type FinalReadinessReport = {
  projectId: string; revision: number;
  stage: 'generated' | 'reviewed' | 'text-confirmed' | 'visual-timeline-safe' | 'final-ready';
  finalReady: boolean;
  counts: {
    textTotal: number; textConfirmed: number; textProposed: number;
    shotsTotal: number; shotsApproved: number; visualTimelineSafe: number; visualCoverageGapCount: number;
    framesTotal: number; framesAccepted: number; audioTotal: number; audioPlayable: number;
  };
  issues: Issue[];
  optionalAudioIssues: Issue[];
};
export type FinalReadinessEvaluation = { report: FinalReadinessReport; safeVisualShotIds: readonly string[] };

export function assetOutputIntegrityIssues(assetIds: readonly string[], integrity: AssetIntegrityStatuses): Issue[] {
  return [...new Set(assetIds)].flatMap((assetId: string): Issue[] => integrity[assetId] === 'verified' ? [] : [issue(
    integrity[assetId] ?? 'ASSET_INTEGRITY_NOT_CHECKED', 'conflict', assetId, 'assetIntegrity',
    '실제 저장 자산의 존재·해시·디코딩을 확인한 후 Final 출력을 다시 시도하세요.', 'verified', integrity[assetId] ?? 'not-checked', [])]);
}

export function shotOutputAssetIds(project: Project, shot: Shot): string[] {
  return [...new Set([
    ...project.frames.filter((frame: StoryboardFrame): boolean => frame.shotId === shot.id && shot.visualMode === 'sourced')
      .flatMap((frame: StoryboardFrame): string[] => frame.imageAssetId === null ? [] : [frame.imageAssetId]),
    ...shot.propIds, ...shot.continuityBefore.map((value): string => value.assetId), ...shot.continuityAfter.map((value): string => value.assetId),
    ...currentVisualReferenceAssets(project, shot).map((asset: Asset): string => asset.id),
  ])];
}

export function shotFinalVisualIssues(project: Project, shot: Shot, integrity: AssetIntegrityStatuses): Issue[] {
  const heldAssetId: string | null = shot.visualMode === 'hold-previous'
    ? reviewVisualOutputAt(project, shot.startMs, 'readiness').imageAssetId : null;
  return uniqueOutputIssues([...reviewShotVisualTimeline(project, shot, 'readiness'),
    ...assetOutputIntegrityIssues(shotOutputAssetIds(project, shot), integrity),
    ...assetOutputIntegrityIssues(heldAssetId === null ? [] : [heldAssetId], integrity),
  ]);
}

/** 같은 Snapshot의 컷별 시각 검사에서 목록과 전체 Final 판정을 함께 파생한다. */
export function evaluateFinalReadiness(project: Project, integrity: AssetIntegrityStatuses): FinalReadinessEvaluation {
  const visualIssues: Issue[][] = project.shots.map((shot: Shot): Issue[] => shotFinalVisualIssues(project, shot, integrity));
  const textIssues: Issue[] = project.textCues.flatMap((cue: TextCue): Issue[] => reviewTextOutput(project, cue.id, { maturity: 'final', channel: 'readiness' }).issues);
  const audioIssues: Issue[][] = project.audioCues.map((cue: AudioCue): Issue[] => [
    ...(reviewAudioPlaybackAt(project, cue.startMs).blocked.find((entry): boolean => entry.cueId === cue.id)?.issues ?? []),
    ...assetOutputIntegrityIssues(cue.assetId === null ? [] : [cue.assetId], integrity),
  ]);
  const approvalIssues: Issue[] = project.shots.flatMap((shot: Shot): Issue[] => [
    ...approvalIssuesForShot(project, shot.id),
    ...(shot.approvalStatus === 'approved' ? [] : [issue('SHOT_APPROVAL_REQUIRED', 'conflict', shot.id, 'approvalStatus',
      '컷의 구조와 연출을 검토하고 승인하세요.', 'approved', shot.approvalStatus, [])]),
  ]);
  const emptyIssues: Issue[] = project.shots.length > 0 ? [] : [issue('SHOTS_REQUIRED_FOR_FINAL', 'conflict', project.projectId, 'shots', 'Final 출력할 컷을 먼저 생성하세요.', 'one or more shots', '0', [])];
  const issues: Issue[] = uniqueOutputIssues([...emptyIssues, ...validateProject(project, project.dataset).filter((value: Issue): boolean => value.severity === 'error'),
    ...project.dataset.segments.flatMap((segment): Issue[] => storyboardUnitOrderIssues(project, segment.id)),
    ...approvalIssues, ...textIssues, ...visualIssues.flat(), ...project.audioCues.flatMap((cue): Issue[] => storyboardAudioIssues(project, cue)), ...audioInstructionOutputIssues(project)]);
  const frames: StoryboardFrame[] = project.frames.filter((frame: StoryboardFrame): boolean => project.shots.some((shot: Shot): boolean => shot.id === frame.shotId && shot.visualMode === 'sourced'));
  const counts: FinalReadinessReport['counts'] = {
    textTotal: project.textCues.length, textConfirmed: project.textCues.filter((cue: TextCue): boolean => cue.timingStatus === 'confirmed').length,
    textProposed: project.textCues.filter((cue: TextCue): boolean => cue.timingStatus === 'proposed').length,
    shotsTotal: project.shots.length, shotsApproved: project.shots.filter((shot: Shot): boolean => shot.approvalStatus === 'approved').length,
    visualTimelineSafe: visualIssues.filter((values: Issue[]): boolean => values.length === 0).length,
    visualCoverageGapCount: project.shots.reduce((total: number, shot: Shot): number => total + shotVisualCoverageGaps(project, shot).length, 0),
    framesTotal: frames.length, framesAccepted: frames.filter((frame: StoryboardFrame): boolean => frame.visualReview === 'accepted').length,
    audioTotal: project.audioCues.length, audioPlayable: audioIssues.filter((values: Issue[]): boolean => values.length === 0).length,
  };
  const reviewed: boolean = project.shots.length > 0 && approvalIssues.length === 0 && counts.framesAccepted === counts.framesTotal;
  const textConfirmed: boolean = reviewed && textIssues.length === 0;
  const visualSafe: boolean = textConfirmed && counts.visualTimelineSafe === counts.shotsTotal;
  const report: FinalReadinessReport = { projectId: project.projectId, revision: project.revision, finalReady: issues.length === 0, counts, issues, optionalAudioIssues: uniqueOutputIssues(audioIssues.flat()),
    stage: issues.length === 0 ? 'final-ready' : visualSafe ? 'visual-timeline-safe' : textConfirmed ? 'text-confirmed' : reviewed ? 'reviewed' : 'generated' };
  return { report, safeVisualShotIds: project.shots.filter((_shot, index): boolean => visualIssues[index]!.length === 0).map((shot): string => shot.id) };
}

/** 생성 횟수나 저장된 성공 플래그와 별개로 현재 프로젝트와 실제 Asset 검사에서 Final 가능 여부를 파생한다. */
export function reviewFinalReadiness(project: Project, integrity: AssetIntegrityStatuses): FinalReadinessReport {
  return evaluateFinalReadiness(project, integrity).report;
}

export function assertFinalReadiness(report: FinalReadinessReport): void {
  if (!report.finalReady) throw contractError('FINAL_OUTPUT_NOT_READY',
    `${report.projectId} revision ${report.revision}: Final 출력 전 ${report.issues.length}개 차단 항목을 해결하세요.`, report.issues);
}

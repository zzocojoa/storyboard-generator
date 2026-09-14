import { frameInformationIds, reviewInformationEmission } from './emission.js';
import { issue } from './errors.js';
import { reviewFrameBitmap } from './frame-output.js';
import type { FrameOutputChannel, FrameOutputDecision } from './frame-output.js';
import { reviewIssuesForVisualAt, reviewTransitionInformationIssues } from './mapping.js';
import { activeStoryboardFrame } from './playback.js';
import type { Issue, Project, Shot, ShotSourceLink, SourceUnit, StoryboardFrame } from './schema.js';
import { activeVisualSourceLinks, sourceAnchorRange } from './source-anchor.js';
import { shotVisualCoverageIssues, visualModeStructureIssues } from './source-policy.js';
import { frameEvaluationAbsoluteMs } from './time.js';
import { transitionVisualPolicy } from './transition.js';

export type VisualOutputChannel = FrameOutputChannel;
export type FrameBitmapReviewer = (project: Project, frame: StoryboardFrame, channel: FrameOutputChannel) => FrameOutputDecision;
export type VisualOutputAtDecision = {
  shotId: string | null; playheadMs: number; channel: VisualOutputChannel;
  renderMode: 'bitmap' | 'black' | 'hold-previous' | 'blocked';
  frameId: string | null; sourceFrameId: string | null; imageAssetId: string | null;
  activeSourceUnitIds: string[]; issues: Issue[];
};

export function uniqueOutputIssues(issues: readonly Issue[]): Issue[] {
  return issues.filter((value: Issue, index: number): boolean => issues.findIndex((other: Issue): boolean =>
    other.code === value.code && other.entityId === value.entityId && other.field === value.field
    && other.actual === value.actual && other.expected === value.expected) === index);
}

function resolveShotOutput(project: Project, shot: Shot, atMs: number, channel: VisualOutputChannel, visited: ReadonlySet<string>, reviewBitmap: FrameBitmapReviewer): VisualOutputAtDecision {
  const base: VisualOutputAtDecision = { shotId: shot.id, playheadMs: atMs, channel, renderMode: 'blocked', frameId: null,
    sourceFrameId: null, imageAssetId: null, activeSourceUnitIds: [], issues: visualModeStructureIssues(project, shot) };
  if (base.issues.length > 0) return base;
  if (visited.has(shot.id)) return { ...base, issues: [issue('HOLD_PREVIOUS_SOURCE_UNAVAILABLE', 'conflict', shot.id, 'visualMode',
    'Hold의 이전 컷 참조가 순환합니다.', 'acyclic earlier shot', shot.id, [])] };
  if (shot.visualMode === 'black') return { ...base, renderMode: 'black' };
  if (shot.visualMode === 'hold-previous') {
    const index: number = project.shots.findIndex((candidate: Shot): boolean => candidate.id === shot.id);
    const previous: Shot = project.shots[index - 1] as Shot;
    const origin: VisualOutputAtDecision = resolveShotOutput(project, previous, previous.endMs - 1, channel, new Set([...visited, shot.id]), reviewBitmap);
    if (origin.renderMode === 'blocked') return { ...base, issues: [issue('HOLD_PREVIOUS_PREDECESSOR_NOT_SAFE', 'conflict', shot.id, 'visualMode',
      '이전 컷 종료 직전의 실제 출력이 안전하지 않습니다. 이전 컷의 차단 원인을 해결하세요.', 'safe predecessor at endMs - 1', previous.id, []), ...origin.issues] };
    return { ...base, renderMode: 'hold-previous', sourceFrameId: origin.sourceFrameId, imageAssetId: origin.imageAssetId };
  }
  const links: ShotSourceLink[] = activeVisualSourceLinks(project, shot, atMs);
  const activeSourceUnitIds: string[] = links.map((link: ShotSourceLink): string => link.unitId);
  const frame: StoryboardFrame | null = activeStoryboardFrame(project, shot.id, atMs);
  const issues: Issue[] = reviewIssuesForVisualAt(project, shot, atMs);
  if (links.length === 0) issues.push(issue('SHOT_VISUAL_COVERAGE_GAP', 'conflict', shot.id, 'sourceLinks',
    `${atMs}ms에 활성인 직접 시각 Source가 없습니다. 표시 구간을 확정하세요.`, 'active confirmed visual interval', String(atMs), []));
  if (frame === null || frameEvaluationAbsoluteMs(shot, frame) > atMs) issues.push(issue('FRAME_IMAGE_REQUIRED_FOR_OUTPUT', 'conflict', shot.id, 'frames',
    'Playhead 이전의 출력 Frame이 필요합니다.', 'frame at or before playhead', String(atMs), []));
  const frameDecision: FrameOutputDecision | null = frame === null ? null : reviewBitmap(project, frame, channel === 'transition-preview' ? 'program-monitor' : channel);
  issues.push(...(frameDecision?.issues ?? []));
  const informationIds: string[] = [...new Set(links.flatMap((link: ShotSourceLink): string[] =>
    project.dataset.units.find((unit: SourceUnit): boolean => unit.id === link.unitId)?.informationIds ?? []))];
  issues.push(...reviewInformationEmission(project, { entityId: shot.id, channel: 'image', informationIds, atMs }));
  const combined: Issue[] = uniqueOutputIssues(issues);
  return { ...base, activeSourceUnitIds, frameId: frame?.id ?? null, sourceFrameId: frame?.id ?? null,
    imageAssetId: combined.length === 0 ? frameDecision?.imageAssetId ?? null : null, renderMode: combined.length === 0 ? 'bitmap' : 'blocked', issues: combined };
}

/** 실제 Playhead의 반열린 Source 구간을 먼저 증명한 뒤 bitmap 또는 명시적인 무원문 출력을 선택한다. */
export function reviewVisualOutputAt(project: Project, playheadMs: number, channel: VisualOutputChannel): VisualOutputAtDecision {
  return resolveVisualPlaybackAt(project, playheadMs, channel, reviewFrameBitmap);
}

/** Frame 검토 정책을 제외한 시간·Source·Hold·전환 판정은 모든 재생 경로가 공유한다. */
export function resolveVisualPlaybackAt(project: Project, playheadMs: number, channel: VisualOutputChannel, reviewBitmap: FrameBitmapReviewer): VisualOutputAtDecision {
  const shot: Shot | undefined = project.shots.find((candidate: Shot): boolean => candidate.startMs <= playheadMs && playheadMs < candidate.endMs);
  if (!Number.isSafeInteger(playheadMs) || playheadMs < 0 || shot === undefined) return { shotId: null, playheadMs, channel,
    renderMode: 'blocked', frameId: null, sourceFrameId: null, imageAssetId: null, activeSourceUnitIds: [], issues: [issue(
      'INVALID_VISUAL_PLAYHEAD', 'conflict', project.projectId, 'atMs', '프로젝트 안의 0 이상 정수 Playhead를 지정하세요.',
      `0..${project.dataset.segments.at(-1)?.endMs ?? 0} (end exclusive)`, String(playheadMs), [])] };
  if (channel === 'transition-preview') {
    const next: Shot | undefined = project.shots[project.shots.indexOf(shot) + 1];
    const policy = transitionVisualPolicy(shot.transitionOut, shot, next ?? null);
    if (policy.issues.length > 0) return { shotId: shot.id, playheadMs, channel, renderMode: 'blocked', frameId: null, sourceFrameId: null,
      imageAssetId: null, activeSourceUnitIds: [], issues: policy.issues };
    if (next === undefined || policy.incomingRevealMs === null || playheadMs < policy.incomingRevealMs) return { shotId: null, playheadMs, channel,
      renderMode: 'blocked', frameId: null, sourceFrameId: null, imageAssetId: null, activeSourceUnitIds: [], issues: [issue(
        'TRANSITION_PREVIEW_INACTIVE', 'conflict', shot.id, 'transitionOut', '현재 Playhead에는 다음 컷 전환이 없습니다.', 'active adjacent transition', String(playheadMs), [])] };
    const incoming: VisualOutputAtDecision = resolveShotOutput(project, next, next.startMs, channel, new Set<string>(), reviewBitmap);
    const informationIds: string[] = incoming.activeSourceUnitIds.flatMap((unitId: string): string[] => project.dataset.units.find((unit: SourceUnit): boolean => unit.id === unitId)?.informationIds ?? []);
    const issues: Issue[] = uniqueOutputIssues([...incoming.issues, ...reviewTransitionInformationIssues(project, shot), ...reviewInformationEmission(project, {
      entityId: incoming.sourceFrameId ?? next.id, channel: 'image', atMs: policy.incomingRevealMs,
      informationIds: [...informationIds, ...(incoming.sourceFrameId === null ? [] : frameInformationIds(project, incoming.sourceFrameId))],
    })]);
    return { ...incoming, playheadMs, issues, renderMode: issues.length > 0 ? 'blocked' : incoming.renderMode,
      imageAssetId: issues.length > 0 ? null : incoming.imageAssetId };
  }
  return resolveShotOutput(project, shot, playheadMs, channel, new Set<string>(), reviewBitmap);
}

/** 안전성이 바뀔 수 있는 모든 Source·Frame 경계와 마지막 내부 시각에서 전체 컷을 검사한다. */
export function reviewShotVisualTimeline(project: Project, shot: Shot, channel: VisualOutputChannel): Issue[] {
  const times: number[] = [shot.startMs, shot.endMs - 1,
    ...shot.sourceLinks.flatMap((link: ShotSourceLink): number[] => {
      const range = sourceAnchorRange(project, shot, link);
      return range === null ? [] : [range.startMs, range.endMs];
    }),
    ...project.frames.filter((frame: StoryboardFrame): boolean => frame.shotId === shot.id).map((frame: StoryboardFrame): number => frameEvaluationAbsoluteMs(shot, frame)),
    ...project.textCues.flatMap((cue): number[] => [cue.startMs, cue.endMs]),
    ...project.dataset.informationRules.map((rule): number => rule.baseNotBeforeMs),
  ];
  const samples: number[] = [...new Set(times)].filter((time: number): boolean => shot.startMs <= time && time < shot.endMs).sort((a: number, b: number): number => a - b);
  const incoming: Shot | undefined = project.shots[project.shots.findIndex((value: Shot): boolean => value.id === shot.id) + 1];
  const transitionPolicy = transitionVisualPolicy(shot.transitionOut, shot, incoming ?? null);
  const transitionIssues: Issue[] = transitionPolicy.incomingRevealMs !== null && transitionPolicy.incomingRevealMs < shot.endMs
    ? [transitionPolicy.incomingRevealMs, shot.endMs - 1]
      .flatMap((time: number): Issue[] => reviewVisualOutputAt(project, time, 'transition-preview').issues) : [];
  return uniqueOutputIssues([...shotVisualCoverageIssues(project, shot), ...samples.flatMap((time: number): Issue[] => reviewVisualOutputAt(project, time, channel).issues), ...transitionPolicy.issues, ...transitionIssues]);
}

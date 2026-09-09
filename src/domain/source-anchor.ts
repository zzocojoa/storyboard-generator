import type { Project, Shot, ShotSourceLink, StoryboardFrame } from './schema.js';
import { frameEvaluationAbsoluteMs } from './time.js';

export type SourceAnchorRange = { startMs: number; endMs: number };
export type VisualIntervalProposal = {
  shotId: string; unitId: string; frameId: string; status: 'review-required';
  proposedRange: SourceAnchorRange | null; reason: string;
};

export function directVisualLinks(shot: Shot): ShotSourceLink[] {
  return shot.sourceLinks.filter((link: ShotSourceLink): boolean => link.usage === 'primary-visual' || link.usage === 'continued-visual');
}

/** 공개 증거 점은 표시 구간과 구분하며 Frame의 마지막 내부 평가 시각을 유지한다. */
export function sourceRevealEvidenceMs(project: Project, shot: Shot, link: ShotSourceLink): number | null {
  const anchor = link.temporalAnchor;
  if (link.status !== 'confirmed' || anchor.status !== 'confirmed') return null;
  if (anchor.kind === 'shot-offset') {
    return anchor.startOffsetMs < anchor.endOffsetMs && anchor.endOffsetMs <= shot.endMs - shot.startMs
      ? shot.startMs + anchor.startOffsetMs : null;
  }
  const frame: StoryboardFrame | undefined = project.frames.find((candidate: StoryboardFrame): boolean => candidate.id === anchor.frameId && candidate.shotId === shot.id);
  return frame === undefined || frame.offsetMs > shot.endMs - shot.startMs ? null : frameEvaluationAbsoluteMs(shot, frame);
}

/** Frame 점만으로 표시 길이를 만들지 않고 명시적으로 확정된 반열린 구간만 반환한다. */
export function sourceAnchorRange(project: Project, shot: Shot, link: ShotSourceLink): SourceAnchorRange | null {
  const anchor = link.temporalAnchor;
  if (link.status !== 'confirmed' || anchor.kind === 'unresolved' || anchor.kind === 'frame') return null;
  const startMs: number | null = sourceRevealEvidenceMs(project, shot, link);
  const endMs: number = shot.startMs + anchor.endOffsetMs;
  return startMs === null || startMs < shot.startMs || endMs <= startMs || endMs > shot.endMs
    ? null : { startMs, endMs };
}

export function activeVisualSourceLinks(project: Project, shot: Shot, atMs: number): ShotSourceLink[] {
  return directVisualLinks(shot).filter((link: ShotSourceLink): boolean => {
    const range: SourceAnchorRange | null = sourceAnchorRange(project, shot, link);
    return range !== null && range.startMs <= atMs && atMs < range.endMs;
  });
}

/** 기존 Frame 점의 유일한 구간 후보를 제안하되 원본 Anchor나 확정 상태를 변경하지 않는다. */
export function proposedFrameVisualIntervals(project: Project, shot: Shot): VisualIntervalProposal[] {
  return directVisualLinks(shot).flatMap((link: ShotSourceLink): VisualIntervalProposal[] => {
    if (link.temporalAnchor.kind !== 'frame') return [];
    const startMs: number | null = sourceRevealEvidenceMs(project, shot, link);
    const starts: number[] = directVisualLinks(shot).flatMap((candidate: ShotSourceLink): number[] => {
      const time: number | null = sourceRevealEvidenceMs(project, shot, candidate);
      return time === null ? [] : [time];
    });
    const ambiguous: boolean = startMs === null || starts.filter((time: number): boolean => time === startMs).length !== 1;
    const nextStarts: number[] = startMs === null ? [] : starts.filter((time: number): boolean => time > startMs);
    const endMs: number = Math.min(shot.endMs, ...nextStarts);
    return [{ shotId: shot.id, unitId: link.unitId, frameId: link.temporalAnchor.frameId, status: 'review-required',
      proposedRange: ambiguous || startMs === null || startMs >= endMs ? null : { startMs, endMs },
      reason: ambiguous ? 'Frame 또는 공개 시점이 없거나 같은 시각에 여러 Source가 있습니다.' : '표시 종료 후보를 검토하고 frame-range로 명시적으로 확정하세요.',
    }];
  });
}

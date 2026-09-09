import { contractError, issue } from './errors.js';
import type { Issue, Project, Shot, ShotSourceLink, ShotVisualMode, SourceUnit } from './schema.js';
import { directVisualLinks, sourceAnchorRange, sourceRevealEvidenceMs } from './source-anchor.js';
import type { SourceAnchorRange } from './source-anchor.js';

export type SourcePolicyShot = { id: string; visualMode: ShotVisualMode; sourceLinks: readonly ShotSourceLink[] };

/** Source Link의 용도와 선행 Primary 관계를 검사한다. 공개 순서는 시간 정책에서 검사한다. */
export function sourcePolicyIssues(units: readonly SourceUnit[], shots: readonly SourcePolicyShot[]): Issue[] {
  const issues: Issue[] = [];
  const primarySeen: Set<string> = new Set<string>();
  for (const shot of shots) {
    const direct: ShotSourceLink[] = shot.sourceLinks.filter((link: ShotSourceLink): boolean => link.usage === 'primary-visual' || link.usage === 'continued-visual');
    if (shot.visualMode === 'sourced' && direct.length === 0) issues.push(issue('SHOT_VISUAL_SOURCE_REQUIRED', 'conflict', shot.id, 'sourceLinks', 'sourced 컷에는 하나 이상의 직접 시각 원문이 필요합니다.', 'primary-visual or continued-visual', null, []));
    if (shot.visualMode !== 'sourced' && direct.length > 0) issues.push(issue('NON_SOURCED_DIRECT_VISUAL_LINK', 'conflict', shot.id, 'sourceLinks', `${shot.visualMode} 컷에는 직접 시각 원문을 연결할 수 없습니다.`, 'audio-only or context-only', direct.map((link: ShotSourceLink): string => link.unitId).join(', '), []));
    const duplicateIds: string[] = [...new Set(shot.sourceLinks.map((link: ShotSourceLink): string => link.unitId).filter((id: string, index: number, ids: string[]): boolean => ids.indexOf(id) !== index))];
    if (duplicateIds.length > 0) issues.push(issue('DUPLICATE_SHOT_SOURCE_LINK', 'conflict', shot.id, 'sourceLinks', `같은 컷에서 원문 연결을 중복할 수 없습니다: ${duplicateIds.join(', ')}`, 'unique unitId', duplicateIds.join(', '), []));
    for (const link of shot.sourceLinks) {
      const unit: SourceUnit | undefined = units.find((candidate: SourceUnit): boolean => candidate.id === link.unitId);
      if (unit === undefined) continue;
      if ((unit.kind === 'SOUND' || unit.kind === 'MUSIC') && direct.includes(link)) {
        issues.push(issue('NONVISUAL_SOURCE_USAGE', 'conflict', shot.id, 'sourceLinks.usage', `${unit.id}(${unit.kind})는 primary-visual 또는 continued-visual로 사용할 수 없습니다.`, 'audio-only or context-only', link.usage, unit.sourceRefs));
      }
      if (link.usage === 'continued-visual' && !primarySeen.has(unit.id)) {
        issues.push(issue('CONTINUED_SOURCE_WITHOUT_PRIMARY', 'conflict', shot.id, 'sourceLinks.usage', `${unit.id}를 continued-visual로 쓰기 전에 이전 컷의 primary-visual 연결이 필요합니다.`, 'prior primary-visual', link.usage, unit.sourceRefs));
      }
      if (link.usage === 'primary-visual') {
        if (primarySeen.has(unit.id)) issues.push(issue('DUPLICATE_PRIMARY_SOURCE', 'conflict', shot.id, 'sourceLinks.usage', `${unit.id}의 primary-visual 연결은 한 번만 사용할 수 있습니다.`, 'continued-visual after primary', link.usage, unit.sourceRefs));
        primarySeen.add(unit.id);
      }
    }
  }
  return issues;
}

type FirstVisualReveal = { unit: SourceUnit; atMs: number; shotId: string };

/** 확정 Anchor의 최초 공개만 비교하며 미확정 시각과 이후 재등장을 순서 근거로 쓰지 않는다. */
export function firstVisualRevealOrderIssues(project: Project, segmentId: string): Issue[] {
  const events: FirstVisualReveal[] = project.shots.filter((shot: Shot): boolean => shot.segmentId === segmentId)
    .flatMap((shot: Shot): FirstVisualReveal[] => directVisualLinks(shot).flatMap((link: ShotSourceLink): FirstVisualReveal[] => {
      const unit: SourceUnit | undefined = project.dataset.units.find((value: SourceUnit): boolean => value.id === link.unitId && value.segmentId === segmentId);
      const atMs: number | null = sourceRevealEvidenceMs(project, shot, link);
      return unit === undefined || atMs === null ? [] : [{ unit, atMs, shotId: shot.id }];
    }));
  const first: FirstVisualReveal[] = [...new Set(events.map((event: FirstVisualReveal): string => event.unit.id))]
    .map((unitId: string): FirstVisualReveal => events.filter((event: FirstVisualReveal): boolean => event.unit.id === unitId)
      .reduce((earliest: FirstVisualReveal, event: FirstVisualReveal): FirstVisualReveal => event.atMs < earliest.atMs ? event : earliest));
  return first.flatMap((earlier: FirstVisualReveal): Issue[] => first.flatMap((later: FirstVisualReveal): Issue[] => {
    if (earlier.unit.order >= later.unit.order || earlier.atMs <= later.atMs) return [];
    const evidence = { segmentId,
      earlier: { unitId: earlier.unit.id, order: earlier.unit.order, firstRevealMs: earlier.atMs },
      later: { unitId: later.unit.id, order: later.unit.order, firstRevealMs: later.atMs } };
    return [...new Set([earlier.shotId, later.shotId])].map((shotId: string): Issue => issue(
      'SOURCE_FIRST_REVEAL_ORDER_REVERSED', 'conflict', shotId, 'sourceLinks.temporalAnchor',
      `${segmentId}: ${later.unit.id}(${later.unit.order}, ${later.atMs}ms)가 ${earlier.unit.id}(${earlier.unit.order}, ${earlier.atMs}ms)보다 먼저 보입니다. 최초 공개 Anchor를 원문 순서에 맞게 검토하세요.`,
      'earlier.firstRevealMs <= later.firstRevealMs', JSON.stringify(evidence), [...earlier.unit.sourceRefs, ...later.unit.sourceRefs]));
  }));
}

/** 확정된 표시 구간 합집합에서 빈 구간을 계산한다. */
export function shotVisualCoverageGaps(project: Project, shot: Shot): SourceAnchorRange[] {
  if (shot.visualMode !== 'sourced') return [];
  const ranges: SourceAnchorRange[] = directVisualLinks(shot).flatMap((link: ShotSourceLink): SourceAnchorRange[] => {
    const range: SourceAnchorRange | null = sourceAnchorRange(project, shot, link);
    return range === null ? [] : [range];
  }).sort((left: SourceAnchorRange, right: SourceAnchorRange): number => left.startMs - right.startMs || left.endMs - right.endMs);
  const result: { cursor: number; gaps: SourceAnchorRange[] } = ranges.reduce((state: { cursor: number; gaps: SourceAnchorRange[] }, range: SourceAnchorRange) => ({
    cursor: Math.max(state.cursor, range.endMs),
    gaps: range.startMs > state.cursor ? [...state.gaps, { startMs: state.cursor, endMs: range.startMs }] : state.gaps,
  }), { cursor: shot.startMs, gaps: [] });
  return result.cursor < shot.endMs ? [...result.gaps, { startMs: result.cursor, endMs: shot.endMs }] : result.gaps;
}

export function shotVisualCoverageIssues(project: Project, shot: Shot): Issue[] {
  return shotVisualCoverageGaps(project, shot).map((gap: SourceAnchorRange): Issue => issue('SHOT_VISUAL_COVERAGE_GAP', 'conflict', shot.id, 'sourceLinks',
    `${shot.id}: 직접 시각 Source가 ${gap.startMs}..${gap.endMs}ms를 덮지 않습니다. 표시 구간을 확정하거나 visualMode를 명시적으로 변경하세요.`,
    `${shot.startMs}..${shot.endMs}`, JSON.stringify(gap), []));
}

/** 기존 공백의 부분집합만 허용하여 Legacy 수리는 가능하고 신규 공백은 거부한다. */
export function assertVisualCoverageChange(current: Project, next: Project, shotIds: readonly string[]): void {
  const introduced: Issue[] = shotIds.flatMap((shotId: string): Issue[] => {
    const before: Shot | undefined = current.shots.find((shot: Shot): boolean => shot.id === shotId);
    const after: Shot | undefined = next.shots.find((shot: Shot): boolean => shot.id === shotId);
    if (before === undefined || after === undefined) throw contractError('SHOT_NOT_FOUND', `${shotId}: Coverage 비교 대상이 없습니다.`, []);
    const prior: SourceAnchorRange[] = shotVisualCoverageGaps(current, before);
    const expanded: boolean = shotVisualCoverageGaps(next, after).some((gap: SourceAnchorRange): boolean =>
      !prior.some((old: SourceAnchorRange): boolean => old.startMs <= gap.startMs && gap.endMs <= old.endMs));
    return expanded ? shotVisualCoverageIssues(next, after) : [];
  });
  if (introduced.length > 0) throw contractError('SHOT_VISUAL_COVERAGE_GAP', introduced.map((value: Issue): string => value.message).join('\n'), introduced);
}

export function visualModeStructureIssues(project: Project, shot: Shot): Issue[] {
  if (shot.visualMode === 'sourced') return [];
  const issues: Issue[] = directVisualLinks(shot).length === 0 ? [] : [issue('NON_SOURCED_DIRECT_VISUAL_LINK', 'conflict', shot.id, 'sourceLinks',
    `${shot.visualMode} 컷은 직접 시각 원문을 포함할 수 없습니다.`, 'no direct visual links', shot.visualMode, [])];
  if (shot.visualMode === 'hold-previous') {
    const index: number = project.shots.findIndex((candidate: Shot): boolean => candidate.id === shot.id);
    const previous: Shot | undefined = project.shots[index - 1];
    if (previous === undefined || previous.endMs !== shot.startMs || previous.startMs >= shot.startMs) issues.push(issue(
      'HOLD_PREVIOUS_SOURCE_UNAVAILABLE', 'conflict', shot.id, 'visualMode', 'Hold에는 시간상 인접한 이전 컷이 필요합니다.', 'contiguous previous shot', previous?.id ?? null, []));
  }
  return issues;
}

import { contractError, issue } from './errors.js';
import type { Issue, Project, Shot, ShotSourceLink, ShotVisualMode, SourceUnit } from './schema.js';
import { directVisualLinks, sourceAnchorRange } from './source-anchor.js';
import type { SourceAnchorRange } from './source-anchor.js';

export type SourcePolicyShot = { id: string; visualMode: ShotVisualMode; sourceLinks: readonly ShotSourceLink[] };

/** Source Link의 시각 용도와 원문 순서를 하나의 정책으로 검사한다. */
export function sourcePolicyIssues(units: readonly SourceUnit[], shots: readonly SourcePolicyShot[]): Issue[] {
  const issues: Issue[] = [];
  const primarySeen: Set<string> = new Set<string>();
  let latestPrimaryOrder: number = 0;
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
        if (unit.order < latestPrimaryOrder) issues.push(issue('SOURCE_UNIT_ORDER_REVERSED', 'conflict', shot.id, 'sourceLinks', `${unit.id}(${unit.order})가 앞선 primary 원문 순서 ${latestPrimaryOrder} 뒤에 역순 배치됐습니다.`, String(latestPrimaryOrder), String(unit.order), unit.sourceRefs));
        primarySeen.add(unit.id);
        latestPrimaryOrder = Math.max(latestPrimaryOrder, unit.order);
      }
    }
  }
  return issues;
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

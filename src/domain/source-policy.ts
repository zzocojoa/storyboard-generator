import { issue } from './errors.js';
import type { Issue, Project, Shot, ShotSourceLink, ShotVisualMode, SourceUnit } from './schema.js';
import { frameEvaluationAbsoluteMs } from './time.js';

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

/** confirmed 직접 시각 Anchor의 합집합이 sourced 컷의 반열린 전체 구간을 덮는지 검사한다. */
export function shotVisualCoverageIssues(project: Project, shot: Shot): Issue[] {
  if (shot.visualMode !== 'sourced') return [];
  const ranges: { startMs: number; endMs: number; unitId: string }[] = shot.sourceLinks.flatMap((link: ShotSourceLink): { startMs: number; endMs: number; unitId: string }[] => {
    if (link.status !== 'confirmed' || !['primary-visual', 'continued-visual'].includes(link.usage)) return [];
    const anchor = link.temporalAnchor;
    if (anchor.status !== 'confirmed') return [];
    const range = anchor.kind === 'frame'
      ? project.frames.find((frame) => frame.id === anchor.frameId && frame.shotId === shot.id) === undefined ? null : (() => {
        const frame = project.frames.find((candidate) => candidate.id === anchor.frameId && candidate.shotId === shot.id);
        if (frame === undefined) return null;
        const startMs: number = frameEvaluationAbsoluteMs(shot, frame);
        return { startMs, endMs: Math.min(shot.endMs, startMs + 1) };
      })()
      : anchor.kind === 'shot-offset' && anchor.startOffsetMs < anchor.endOffsetMs && anchor.endOffsetMs <= shot.endMs - shot.startMs
        ? { startMs: shot.startMs + anchor.startOffsetMs, endMs: shot.startMs + anchor.endOffsetMs } : null;
    return range === null ? [] : [{ ...range, unitId: link.unitId }];
  }).sort((left, right): number => left.startMs - right.startMs || left.endMs - right.endMs || left.unitId.localeCompare(right.unitId));
  const gaps: { startMs: number; endMs: number }[] = [];
  let cursor: number = shot.startMs;
  for (const range of ranges) {
    if (range.startMs > cursor) gaps.push({ startMs: cursor, endMs: range.startMs });
    cursor = Math.max(cursor, range.endMs);
  }
  if (cursor < shot.endMs) gaps.push({ startMs: cursor, endMs: shot.endMs });
  const actual: string = JSON.stringify(ranges);
  return gaps.map((gap) => issue('SHOT_VISUAL_COVERAGE_GAP', 'conflict', shot.id, 'sourceLinks',
    `${shot.id}: 직접 시각 Source가 ${gap.startMs}..${gap.endMs}ms를 덮지 않습니다. confirmed Anchor를 이어 붙이거나 visualMode를 명시적으로 변경하세요.`,
    `${shot.startMs}..${shot.endMs}`, actual, []));
}

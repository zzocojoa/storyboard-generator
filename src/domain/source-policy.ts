import { issue } from './errors.js';
import type { Issue, ShotSourceLink, SourceUnit } from './schema.js';

export type SourcePolicyShot = { id: string; sourceLinks: readonly ShotSourceLink[] };

/** Source Link의 시각 용도와 원문 순서를 하나의 정책으로 검사한다. */
export function sourcePolicyIssues(units: readonly SourceUnit[], shots: readonly SourcePolicyShot[]): Issue[] {
  const issues: Issue[] = [];
  const primarySeen: Set<string> = new Set<string>();
  let latestPrimaryOrder: number = 0;
  for (const shot of shots) {
    const direct: ShotSourceLink[] = shot.sourceLinks.filter((link: ShotSourceLink): boolean => link.usage === 'primary-visual' || link.usage === 'continued-visual');
    if (direct.length === 0) issues.push(issue('SHOT_VISUAL_SOURCE_REQUIRED', 'conflict', shot.id, 'sourceLinks', '컷에는 하나 이상의 직접 시각 원문이 필요합니다.', 'primary-visual or continued-visual', null, []));
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

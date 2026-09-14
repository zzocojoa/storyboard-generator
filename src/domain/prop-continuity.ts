import { issue } from './errors.js';
import type { Issue, ProductionResource, Project, PropContinuity } from './schema.js';

/** 화면에서 처음 쓰이는 시각이며 작품 속 과거·현재의 서사 시간과 구별한다. */
export function productionResourceFirstUse(project: Project, resourceId: string): number {
  const segmentIds: Set<string> = new Set(project.productionPlan?.segments.filter((segment): boolean => segment.resourceIds.includes(resourceId)).map((segment): string => segment.segmentId));
  return Math.min(...project.dataset.segments.filter((segment): boolean => segmentIds.has(segment.id)).map((segment): number => segment.startMs));
}

/** 같은 소품이라는 명시적 연결만 검사한다. 이름·배열 순서로 동일성을 추측하지 않는다. */
export function propContinuityIssues(project: Project, resource: ProductionResource, continuity: PropContinuity): Issue[] {
  const resources: readonly ProductionResource[] = project.productionPlan?.resources ?? [];
  const base = resources.find((value): boolean => value.id === continuity.resourceId);
  const failure = (message: string): Issue => issue('INVALID_PROP_CONTINUITY', 'error', resource.id, 'propContinuity', message, null, null, resource.sourceRefs);
  if (resource.kind !== 'prop' || base?.kind !== 'prop' || base.id === resource.id) return [failure('같은 프로젝트의 다른 소품 기준을 선택하세요.')];
  const visited: Set<string> = new Set([resource.id]);
  let next: ProductionResource | undefined = base;
  while (next !== undefined) {
    if (visited.has(next.id)) return [failure('소품 기준 연결이 순환합니다. 이전 기준으로 돌아오는 연결을 제거하세요.')];
    visited.add(next.id);
    const id: string | undefined = next.propContinuity?.resourceId;
    next = resources.find((value): boolean => value.id === id);
  }
  const baseUse: number = productionResourceFirstUse(project, base.id);
  const currentUse: number = productionResourceFirstUse(project, resource.id);
  const baseUnits = project.dataset.units.filter((unit): boolean => base.sourceUnitIds.includes(unit.id));
  const currentUnits = project.dataset.units.filter((unit): boolean => resource.sourceUnitIds.includes(unit.id));
  if (!Number.isFinite(baseUse) || baseUse > currentUse || baseUnits.some((unit): boolean => {
    const segment = project.dataset.segments.find((value): boolean => value.id === unit.segmentId);
    return segment === undefined || segment.startMs > currentUse || (segment.startMs === currentUse &&
      (currentUnits.length === 0 || currentUnits.some((current): boolean => current.order < unit.order)));
  })) return [failure('현재 기준보다 늦게 공개되는 소품 상태는 참조할 수 없습니다. 앞선 기준과 원문 공개 순서를 확인하세요.')];
  return [];
}

/** 선택 목록은 연결 가능한 앞선 소품만 제시하며 선택 자체를 자동 확정하지 않는다. */
export function propContinuityCandidates(project: Project, resource: ProductionResource): ProductionResource[] {
  return (project.productionPlan?.resources ?? []).filter((base): boolean => base.referenceAssetId !== null
    && propContinuityIssues(project, resource, { resourceId: base.id, reason: '연결 후보 범위 검사' }).length === 0);
}

/** 원본 변경 영향에 간접 연결된 이전 소품의 근거까지 포함한다. */
export function productionResourceAncestors(project: Project, resource: ProductionResource): ProductionResource[] {
  const resources: readonly ProductionResource[] = project.productionPlan?.resources ?? [];
  const chain: ProductionResource[] = []; const visited: Set<string> = new Set();
  let next: ProductionResource | undefined = resource;
  while (next !== undefined && !visited.has(next.id)) {
    visited.add(next.id); chain.push(next);
    const id: string | undefined = next.propContinuity?.resourceId;
    next = resources.find((value): boolean => value.id === id);
  }
  return chain;
}

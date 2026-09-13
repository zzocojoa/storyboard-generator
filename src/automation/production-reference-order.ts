import { assertNoErrors, contractError } from '../domain/errors.js';
import { propContinuityIssues } from '../domain/prop-continuity.js';
import type { ProductionResource, Project } from '../domain/schema.js';

/** 선택 범위를 넓히지 않고 상태 변형보다 연결된 원형 이미지를 먼저 준비한다. */
export function orderProductionReferences(project: Project, references: readonly ProductionResource[]): ProductionResource[] {
  const ordered: ProductionResource[] = []; const visiting: Set<string> = new Set(); const completed: Set<string> = new Set();
  const visit = (resource: ProductionResource): void => {
    if (completed.has(resource.id)) return;
    if (visiting.has(resource.id)) throw contractError('AUTOMATION_PROP_CONTINUITY', `소품 기준 연결이 순환합니다: ${resource.id}`, []);
    visiting.add(resource.id);
    if (resource.propContinuity !== undefined) {
      assertNoErrors(propContinuityIssues(project, resource, resource.propContinuity), 'AUTOMATION_PROP_CONTINUITY');
      const base = project.productionPlan!.resources.find((value): boolean => value.id === resource.propContinuity!.resourceId)!;
      if (base.referenceAssetId === null) {
        const selected = references.find((value): boolean => value.id === base.id);
        if (selected === undefined) throw contractError('AUTOMATION_PROP_REFERENCE_REQUIRED', `${resource.name}: 선택 범위 밖의 ${base.name} 기준 이미지를 먼저 준비하세요.`, []);
        visit(selected);
      }
    }
    visiting.delete(resource.id); completed.add(resource.id); ordered.push(resource);
  };
  for (const resource of references) visit(resource);
  return ordered;
}

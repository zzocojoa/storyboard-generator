import { contractError } from '../domain/errors.js';
import type { Project } from '../domain/schema.js';
import { sha256Text } from '../importers/integrity.js';
import { stableJsonStringify } from '../io/stable-json.js';
import { ProductionPlanBasisSchema } from './production-schema.js';
import type { ProductionPlanBasis } from './production-schema.js';
import { automaticShotProtected } from './repair-basis.js';

/** 제작 기준이 없는 구간만 선택한다. 이미 저장한 기준과 사용자 선택은 덮어쓰지 않는다. */
export function createProductionPlanBasis(project: Project, segmentIds: readonly string[]): ProductionPlanBasis {
  const basis: ProductionPlanBasis = ProductionPlanBasisSchema.parse({ projectId: project.projectId, revision: project.revision,
    projectHash: sha256Text(stableJsonStringify(project)), segmentIds: [...segmentIds] });
  if (new Set(segmentIds).size !== segmentIds.length || segmentIds.some((id): boolean => !project.dataset.segments.some((segment): boolean => segment.id === id))) {
    throw contractError('AUTOMATION_PRODUCTION_SCOPE', '제작 기준을 만들 구간 ID가 중복되거나 존재하지 않습니다.', []);
  }
  const planned = project.productionPlan?.segments.filter((segment): boolean => segmentIds.includes(segment.segmentId)) ?? [];
  if (planned.length > 0) throw contractError('AUTOMATION_EXISTING_PRODUCTION_PLAN', `이미 저장한 제작 기준을 자동 교체하지 않습니다: ${planned.map((segment): string => segment.segmentId).join(', ')}`, []);
  const protectedShots = project.shots.filter((shot): boolean => segmentIds.includes(shot.segmentId) && automaticShotProtected(project, shot));
  if (protectedShots.length > 0) throw contractError('AUTOMATION_PROTECTED_SHOTS', `확정·잠금 컷과 승인 그림의 제작 기준은 자동 변경할 수 없습니다: ${protectedShots.map((shot): string => shot.id).join(', ')}`, []);
  return basis;
}

export function assertProductionPlanBasis(project: Project, input: ProductionPlanBasis): void {
  const basis: ProductionPlanBasis = ProductionPlanBasisSchema.parse(input);
  if (basis.projectId !== project.projectId || basis.revision !== project.revision || basis.projectHash !== sha256Text(stableJsonStringify(project))) {
    throw contractError('AUTOMATION_STALE_PLAN', `제작 기준 계획 이후 입력이 변경되었습니다: projectId=${basis.projectId}, expectedRevision=${basis.revision}, currentRevision=${project.revision}`, []);
  }
  createProductionPlanBasis(project, basis.segmentIds);
}

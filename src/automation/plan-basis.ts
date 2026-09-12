import { contractError } from '../domain/errors.js';
import type { Project, Shot } from '../domain/schema.js';
import { sha256Text } from '../importers/integrity.js';
import { stableJsonStringify } from '../io/stable-json.js';
import type { SegmentPlanBasis } from './plan-schema.js';
import { SegmentPlanBasisSchema } from './plan-schema.js';

/** 실행자가 선택한 교체 범위와 읽은 전체 프로젝트를 결속한다. */
export function createSegmentPlanBasis(project: Project, segmentId: string, replaceShotIds: readonly string[]): SegmentPlanBasis {
  if (!project.dataset.segments.some((segment): boolean => segment.id === segmentId)) throw contractError('SEGMENT_NOT_FOUND', `자동 계획 대상 구간이 없습니다: ${segmentId}`, []);
  const shots: Shot[] = project.shots.filter((shot): boolean => shot.segmentId === segmentId);
  const selected: Set<string> = new Set(replaceShotIds);
  if (selected.size !== replaceShotIds.length || shots.length !== selected.size || shots.some((shot): boolean => !selected.has(shot.id))) {
    throw contractError('AUTOMATION_REPLACEMENT_SCOPE', `${segmentId}: 구간의 기존 컷 전체가 명시적인 교체 범위에 포함되어야 합니다.`, []);
  }
  const protectedShots: Shot[] = shots.filter((shot): boolean => shot.approvalStatus === 'approved' || shot.lockedFields.length > 0);
  if (protectedShots.length > 0) throw contractError('AUTOMATION_PROTECTED_SHOTS', `확정·잠금 컷은 자동 교체할 수 없습니다: ${protectedShots.map((shot): string => shot.id).join(', ')}`, []);
  return SegmentPlanBasisSchema.parse({ projectId: project.projectId, revision: project.revision, projectHash: sha256Text(stableJsonStringify(project)), segmentId, replaceShotIds: [...replaceShotIds] });
}

export function assertSegmentPlanBasis(project: Project, input: SegmentPlanBasis): void {
  const basis: SegmentPlanBasis = SegmentPlanBasisSchema.parse(input);
  if (basis.projectId !== project.projectId || basis.revision !== project.revision || basis.projectHash !== sha256Text(stableJsonStringify(project))) {
    throw contractError('AUTOMATION_STALE_PLAN', `자동 계획 이후 입력 또는 편집 내용이 변경되었습니다. projectId=${basis.projectId}, expectedRevision=${basis.revision}, currentRevision=${project.revision}`, []);
  }
  createSegmentPlanBasis(project, basis.segmentId, basis.replaceShotIds);
}

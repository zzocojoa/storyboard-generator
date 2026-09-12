import { contractError } from '../domain/errors.js';
import type { Project } from '../domain/schema.js';
import { automaticHash } from './application-evidence.js';
import { createProductionReferenceBasis } from './production-reference.js';
import type { ProductionReferenceBasis } from './production-reference.js';
import { ReferenceRetakeInputSchema, ReferenceRetakeIntentSchema } from './reference-retake-schema.js';
import type { ReferenceRetakeInput, ReferenceRetakeIntent } from './reference-retake-schema.js';

export function referenceRetakeSegments(project: Project, resourceId: string): string[] {
  return (project.productionPlan?.segments ?? []).filter((segment): boolean => segment.resourceIds.includes(resourceId)).map((segment): string => segment.segmentId);
}

/** 선택 기준의 현재 설명·버전·참조와 영향 구간만 고정하고 다른 결과로 확장하지 않는다. */
export function createReferenceRetakeIntent(project: Project, raw: ReferenceRetakeInput): ReferenceRetakeIntent {
  const input = ReferenceRetakeInputSchema.parse(raw);
  const basis = createProductionReferenceBasis(project, input.resourceId);
  const resource = project.productionPlan!.resources.find((value): boolean => value.id === input.resourceId)!;
  if (resource.referenceAssetId === null) throw contractError('AUTOMATION_REFERENCE_RETAKE_TARGET', `${resource.name}: 비교할 기존 기준 이미지가 없습니다. 자동 제작으로 첫 이미지를 생성하세요.`, []);
  const segments = project.productionPlan!.segments.filter((segment): boolean => segment.resourceIds.includes(resource.id));
  return { ...input, kind: 'reference-retake', previousAssetId: resource.referenceAssetId,
    sourceHash: automaticHash({ projectId: project.projectId, resource, profile: project.profile, segments,
      references: basis.referenceAssetIds.map((id) => ({ id, asset: project.assets.find((asset): boolean => asset.id === id) })) }) };
}

export function assertReferenceRetakeIntent(project: Project, raw: ReferenceRetakeIntent): ProductionReferenceBasis {
  const intent = ReferenceRetakeIntentSchema.parse(raw);
  if (automaticHash(createReferenceRetakeIntent(project, { resourceId: intent.resourceId })) !== automaticHash(intent)) {
    throw contractError('AUTOMATION_REFERENCE_RETAKE_STALE', `${intent.resourceId}: 기준 설명·버전·참조 또는 연결 구간이 변경되었습니다. 현재 기준을 다시 확인하고 요청하세요.`, []);
  }
  return createProductionReferenceBasis(project, intent.resourceId);
}

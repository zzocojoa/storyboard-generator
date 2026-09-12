import { issue } from './errors.js';
import type { Asset, Issue, ProductionResource, Project, SourceRef } from './schema.js';

export type VisualLocation = { id: string; name: string; description: string };

/** 원본 장소와 별도로 제안한 촬영 세트를 같은 선택 목록에서 명시적으로 구별한다. */
export function productionLocations(project: Project): VisualLocation[] {
  return [...project.dataset.locations.map((location): VisualLocation => ({ id: location.id, name: location.name, description: location.description })),
    ...(project.productionPlan?.resources ?? []).filter((resource): boolean => resource.kind === 'location' && resource.subjectId === null)
      .map((resource): VisualLocation => ({ id: resource.id, name: `${resource.name} · 제작 제안`, description: resource.description }))];
}

export function productionResourceSubject(resource: ProductionResource): string {
  return resource.subjectId ?? resource.id;
}

/** 선택 구간에 결속된 버전만 반환하며 다른 구간의 최신 의상·장소로 교체하지 않는다. */
export function segmentReferenceAssets(project: Project, segmentId: string): Asset[] {
  const segment = project.productionPlan?.segments.find((value): boolean => value.segmentId === segmentId);
  if (segment === undefined) return [];
  const assetIds: Set<string> = new Set((project.productionPlan?.resources ?? [])
    .filter((resource): boolean => segment.resourceIds.includes(resource.id))
    .flatMap((resource): string[] => resource.referenceAssetId === null ? [] : [resource.referenceAssetId]));
  return project.assets.filter((asset): boolean => assetIds.has(asset.id));
}

/** 제작 근거는 저장된 원본의 실제 locator와 원본 ID까지 동일해야 한다. */
export function productionSourceRefs(project: Project): SourceRef[] {
  return [...project.dataset.people, ...project.dataset.locations, ...project.dataset.scenes, ...project.dataset.segments,
    ...project.dataset.units, ...project.dataset.instructions, ...project.dataset.textPlacements, ...project.dataset.informationRules]
    .flatMap((value): SourceRef[] => value.sourceRefs);
}

export function sameProductionSourceRef(left: SourceRef, right: SourceRef): boolean {
  return left.fileId === right.fileId && left.locator === right.locator && left.originalId === right.originalId;
}

/** 편집용 제작 계획이 원본·구간·생성 이력·시각 자산을 우회해 참조하지 못하게 한다. */
export function productionPlanIssues(project: Project): Issue[] {
  if (project.productionPlan === null) return [];
  const { resources, segments } = project.productionPlan;
  const refs: SourceRef[] = productionSourceRefs(project);
  const failure = (id: string, field: string, message: string): Issue => issue('INVALID_PRODUCTION_PLAN', 'error', id, field, message, null, null, []);
  const duplicates = (ids: readonly string[], field: string): Issue[] => ids.filter((id, index): boolean => ids.indexOf(id) !== index).map((id): Issue => failure(id, field, '제작 계획 식별자가 중복됩니다.'));
  const resourceIssues: Issue[] = resources.flatMap((resource): Issue[] => {
    const active: boolean = segments.some((segment): boolean => segment.resourceIds.includes(resource.id));
    const subjectValid: boolean = resource.kind === 'character' ? project.dataset.people.some((person): boolean => person.id === resource.subjectId)
      : resource.kind === 'location' ? resource.subjectId === null || project.dataset.locations.some((location): boolean => location.id === resource.subjectId) : resource.subjectId === null;
    return [
      ...(subjectValid ? [] : [failure(resource.id, 'subjectId', '제작 기준의 원본 인물·장소 연결이 유효하지 않습니다. 소품은 독립 제작 자원으로 지정하세요.')]),
      ...(project.dataset.people.some((value): boolean => value.id === resource.id) || project.dataset.locations.some((value): boolean => value.id === resource.id) ? [failure(resource.id, 'id', '제작 자원 ID와 원본 ID가 충돌합니다.')] : []),
      ...duplicates(resource.sourceUnitIds, 'sourceUnitIds'),
      ...resource.sourceUnitIds.filter((id): boolean => active && !project.dataset.units.some((unit): boolean => unit.id === id)).map((id): Issue => failure(resource.id, 'sourceUnitIds', `제작 근거 원문이 없습니다: ${id}`)),
      ...resource.sourceRefs.filter((ref): boolean => active && !refs.some((candidate): boolean => sameProductionSourceRef(ref, candidate))).map((ref): Issue => failure(resource.id, 'sourceRefs', `제작 근거 출처가 원문과 다릅니다: ${ref.fileId}:${ref.locator}`)),
      ...(project.generationRecords.some((record): boolean => record.id === resource.generationId) ? [] : [failure(resource.id, 'generationId', '제작 제안의 생성 이력이 없습니다.')]),
    ];
  });
  const segmentIssues: Issue[] = segments.flatMap((plan): Issue[] => {
    const segment = project.dataset.segments.find((value): boolean => value.id === plan.segmentId);
    const assigned = resources.filter((resource): boolean => plan.resourceIds.includes(resource.id));
    return [
      ...(segment === undefined ? [failure(plan.segmentId, 'segmentId', '제작 계획의 구간이 없습니다.')] : []),
      ...duplicates(plan.resourceIds, 'resourceIds'),
      ...plan.resourceIds.filter((id): boolean => !resources.some((resource): boolean => resource.id === id)).map((id): Issue => failure(plan.segmentId, 'resourceIds', `제작 자원이 없습니다: ${id}`)),
      ...(plan.visualLocationId === null || assigned.some((resource): boolean => resource.kind === 'location' && productionResourceSubject(resource) === plan.visualLocationId)
        ? [] : [failure(plan.segmentId, 'visualLocationId', '화면 장소에 해당하는 기준을 이 구간의 resourceIds에 연결하세요.')]),
      ...duplicates(assigned.filter((resource): boolean => resource.kind !== 'prop').map((resource): string => `${resource.kind}:${productionResourceSubject(resource)}`), `${plan.segmentId}.resourceSubjects`),
      ...assigned.flatMap((resource): Issue[] => resource.sourceUnitIds.flatMap((id): Issue[] => {
        const unit = project.dataset.units.find((value): boolean => value.id === id);
        const sourceSegment = project.dataset.segments.find((value): boolean => value.id === unit?.segmentId);
        return segment !== undefined && sourceSegment !== undefined && sourceSegment.startMs > segment.startMs
          ? [failure(plan.segmentId, 'resourceIds', `미래 구간의 상태를 앞 구간 기준으로 사용할 수 없습니다: ${resource.id}, ${id}`)] : [];
      })),
      ...(project.generationRecords.some((record): boolean => record.id === plan.generationId) ? [] : [failure(plan.segmentId, 'generationId', '구간 제작 계획의 생성 이력이 없습니다.')]),
    ];
  });
  return [...duplicates(resources.map((value): string => value.id), 'productionPlan.resources'),
    ...duplicates(segments.map((value): string => value.segmentId), 'productionPlan.segments'), ...resourceIssues, ...segmentIssues];
}

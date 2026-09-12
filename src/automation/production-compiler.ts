import { assertNoErrors, contractError } from '../domain/errors.js';
import { assertGenerationRecordTransition } from '../domain/generation-records.js';
import { productionResourceSubject } from '../domain/production-resources.js';
import { ProjectSchema } from '../domain/schema.js';
import type { GenerationRecord, ProductionResource, ProductionSegment, Project } from '../domain/schema.js';
import { validateProject } from '../domain/validation.js';
import { stableJsonStringify } from '../io/stable-json.js';
import { AutomaticPlanProvenanceSchema } from './plan-compiler.js';
import type { AutomaticPlanProvenance } from './plan-compiler.js';
import { assertProductionPlanBasis } from './production-basis.js';
import { AutomaticProductionPlanSchema } from './production-schema.js';
import type { AutomaticProductionPlan, ProductionPlanBasis } from './production-schema.js';
import { automaticShotProtected } from './repair-basis.js';

export type AutomaticProductionCandidate = { project: Project; plan: AutomaticProductionPlan; basis: ProductionPlanBasis };

function assertProfilePreserved(project: Project, plan: AutomaticProductionPlan): void {
  if (plan.profile.aspectWidth !== project.profile.aspectWidth || plan.profile.aspectHeight !== project.profile.aspectHeight
    || project.profile.medium !== 'unspecified' && project.profile.medium !== plan.profile.medium
    || project.profile.visualStyle !== null && project.profile.visualStyle.trim() !== '' && project.profile.visualStyle !== plan.profile.visualStyle) {
    throw contractError('AUTOMATION_PRODUCTION_PROFILE', '기존 화면비·제작 방식·그림 스타일은 보존하고 빈 제작 기준만 제안하세요.', []);
  }
  if (stableJsonStringify(project.profile) !== stableJsonStringify(plan.profile) && project.shots.some((shot): boolean => automaticShotProtected(project, shot))) {
    throw contractError('AUTOMATION_PROTECTED_PROFILE', '확정·잠금 컷 또는 승인 그림이 있는 프로젝트의 전역 제작 기준은 자동 변경할 수 없습니다. 현재 기준을 먼저 지정하세요.', []);
  }
}

function plannedSegments(project: Project, basis: ProductionPlanBasis, plan: AutomaticProductionPlan, resources: readonly ProductionResource[], generationId: string): ProductionSegment[] {
  const resolveResource = (key: string): ProductionResource => {
    const index: number = plan.resources.findIndex((resource): boolean => resource.key === key);
    const resource = index >= 0 ? resources[index] : project.productionPlan?.resources.find((value): boolean => value.id === key);
    if (resource === undefined) throw contractError('AUTOMATION_PRODUCTION_RESOURCE', `연결할 제작 자원이 없습니다: ${key}`, []);
    return resource;
  };
  const ids = plan.segments.map((segment): string => segment.segmentId);
  if (new Set(ids).size !== ids.length || ids.length !== basis.segmentIds.length || ids.some((id): boolean => !basis.segmentIds.includes(id))) {
    throw contractError('AUTOMATION_PRODUCTION_SCOPE', '요청한 모든 구간의 제작 기준이 정확히 하나씩 필요합니다.', []);
  }
  return plan.segments.map((segment): ProductionSegment => {
    const location = segment.locationResourceKey === null ? null : resolveResource(segment.locationResourceKey);
    if (location !== null && location.kind !== 'location') throw contractError('AUTOMATION_PRODUCTION_RESOURCE', `${segment.segmentId}: 화면 장소는 location 기준이어야 합니다.`, []);
    return { segmentId: segment.segmentId, resourceIds: segment.resourceKeys.map((key): string => resolveResource(key).id),
      visualLocationId: location === null ? null : productionResourceSubject(location), continuityGroup: segment.continuityGroup,
      entryState: segment.entryState, exitState: segment.exitState, reason: segment.reason, generationId };
  });
}

/** 원본과 기존 제작 기준을 보존하며 모델 제안을 검증 가능한 별도 제작 계획으로 만든다. */
export function compileAutomaticProductionPlan(project: Project, basis: ProductionPlanBasis, input: unknown, provenance: AutomaticPlanProvenance): AutomaticProductionCandidate {
  assertProductionPlanBasis(project, basis);
  AutomaticPlanProvenanceSchema.parse(provenance);
  const plan: AutomaticProductionPlan = AutomaticProductionPlanSchema.parse(input);
  assertProfilePreserved(project, plan);
  if (project.generationRecords.some((record): boolean => record.id === provenance.generationId || record.requestId === provenance.generationId)) throw contractError('AUTOMATION_DUPLICATE_GENERATION', `이미 사용한 생성 ID입니다: ${provenance.generationId}`, []);
  const keys: string[] = plan.resources.map((resource): string => resource.key);
  if (new Set(keys).size !== keys.length || keys.some((key): boolean => project.productionPlan?.resources.some((resource): boolean => resource.id === key) ?? false)) {
    throw contractError('AUTOMATION_PRODUCTION_RESOURCE', '새 제작 기준의 key는 중복되거나 기존 자원 ID와 같을 수 없습니다.', []);
  }
  const resources: ProductionResource[] = plan.resources.map(({ key: _key, ...resource }, index): ProductionResource =>
    ({ ...resource, id: `${provenance.generationId}:resource:${index + 1}`, generationId: provenance.generationId }));
  const segments: ProductionSegment[] = plannedSegments(project, basis, plan, resources, provenance.generationId);
  if (resources.some((resource): boolean => !segments.some((segment): boolean => segment.resourceIds.includes(resource.id)))) throw contractError('AUTOMATION_PRODUCTION_RESOURCE', '사용하지 않는 제작 기준 이미지를 생성하지 않습니다. 모든 새 자원을 선택 구간에 연결하세요.', []);
  const record: GenerationRecord = { id: provenance.generationId, provider: 'codex-app', model: provenance.model, modelVersion: null,
    requestId: provenance.generationId, prompt: stableJsonStringify({ input: provenance.prompt, output: plan, turnId: provenance.turnId, basis }),
    templateVersion: 'automatic-production-plan-1.0.0', seed: null, referenceHashes: [basis.projectHash], resultAssetIds: [], shotIds: [],
    createdAt: provenance.createdAt, generatorBuild: provenance.generatorBuild };
  const profileChanged: boolean = stableJsonStringify(project.profile) !== stableJsonStringify(plan.profile);
  const affected: Set<string> = new Set(project.shots.filter((shot): boolean => profileChanged || basis.segmentIds.includes(shot.segmentId)).map((shot): string => shot.id));
  const candidate: Project = ProjectSchema.parse({ ...project, profile: plan.profile,
    productionPlan: { resources: [...project.productionPlan?.resources ?? [], ...resources], segments: [...project.productionPlan?.segments ?? [], ...segments] },
    shots: project.shots.map((shot) => affected.has(shot.id) ? { ...shot, approvalStatus: 'proposed' } : shot),
    frames: project.frames.map((frame) => affected.has(frame.shotId) ? { ...frame, visualReview: 'pending' } : frame),
    generationRecords: [...project.generationRecords, record] });
  assertGenerationRecordTransition(project, candidate);
  assertNoErrors(validateProject(candidate, project.dataset), 'AUTOMATION_PRODUCTION_INVALID');
  return { project: candidate, plan, basis: structuredClone(basis) };
}

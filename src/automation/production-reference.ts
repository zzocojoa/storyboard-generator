import { z } from 'zod';
import type { ImageGenerationEngine, ImageGenerationInput, ImageGenerationResult } from '../codex/image-engine.js';
import { MAX_IMAGE_REFERENCE_SOURCES, validateImageReferencePresentation } from '../codex/image-reference-presentation.js';
import { assertNoErrors, contractError } from '../domain/errors.js';
import { assertGenerationRecordTransition } from '../domain/generation-records.js';
import { inspectImageBytes, MAX_IMAGE_BYTES } from '../domain/media-inspection.js';
import { productionResourceSubject } from '../domain/production-resources.js';
import { propContinuityIssues } from '../domain/prop-continuity.js';
import { HashSchema, IdSchema, ProjectSchema, PropContinuitySchema } from '../domain/schema.js';
import type { Asset, GenerationRecord, ProductionResource, Project, PropContinuity } from '../domain/schema.js';
import { validateProject } from '../domain/validation.js';
import { sha256Text } from '../importers/integrity.js';
import { stableJsonStringify } from '../io/stable-json.js';
import { assertReferenceBudget, verifiedImageReferences } from './image-references.js';
import type { LoadedReference } from './image-references.js';
import type { PlannedAssetWrite } from './plan-audio.js';
import { AutomaticPlanProvenanceSchema } from './plan-compiler.js';
import type { AutomaticPlanProvenance } from './plan-compiler.js';

export type { LoadedReference } from './image-references.js';

export const ProductionReferenceBasisSchema = z.strictObject({ projectId: IdSchema, revision: z.number().int().nonnegative(), projectHash: HashSchema, resourceId: IdSchema, referenceAssetIds: z.array(IdSchema).max(MAX_IMAGE_REFERENCE_SOURCES), propContinuity: PropContinuitySchema.optional() });
export type ProductionReferenceBasis = z.infer<typeof ProductionReferenceBasisSchema>;
export type AutomaticReferenceCandidate = { project: Project; basis: ProductionReferenceBasis; writes: PlannedAssetWrite[] };

function requireResource(project: Project, resourceId: string): ProductionResource {
  const resource = project.productionPlan?.resources.find((value): boolean => value.id === resourceId);
  if (resource === undefined) throw contractError('AUTOMATION_PRODUCTION_RESOURCE', `제작 기준을 찾을 수 없습니다: ${resourceId}`, []);
  return resource;
}

/** 명시한 소품 연결 또는 같은 원본 인물·장소의 앞선 기준만 사용한다. */
function continuityReferenceIds(project: Project, resource: ProductionResource): string[] {
  if (resource.propContinuity !== undefined) {
    assertNoErrors(propContinuityIssues(project, resource, resource.propContinuity), 'AUTOMATION_PROP_CONTINUITY');
    const base = requireResource(project, resource.propContinuity.resourceId);
    if (base.referenceAssetId === null) throw contractError('AUTOMATION_PROP_REFERENCE_REQUIRED', `${resource.name}: 이전 소품 ${base.name}의 기준 이미지를 먼저 생성하세요.`, []);
    return [base.referenceAssetId];
  }
  if (resource.kind === 'prop' || resource.subjectId === null) return [];
  const firstUse = (resourceId: string): number => Math.min(...(project.productionPlan?.segments ?? [])
    .filter((segment): boolean => segment.resourceIds.includes(resourceId))
    .flatMap((segment): number[] => project.dataset.segments.filter((value): boolean => value.id === segment.segmentId).map((value): number => value.startMs)));
  const prior = project.productionPlan?.resources.filter((value): boolean => value.id !== resource.id && value.kind === resource.kind
    && value.subjectId === resource.subjectId && value.referenceAssetId !== null && firstUse(value.id) <= firstUse(resource.id)
    && (resource.kind === 'character' || value.sourceUnitIds.length === 0))
    .sort((left, right): number => firstUse(left.id) - firstUse(right.id))[0];
  return prior?.referenceAssetId === null || prior?.referenceAssetId === undefined ? [] : [prior.referenceAssetId];
}

/** 재생성에서 명시한 연결은 요청에만 보관하며 실제 결과와 함께 한 번에 반영한다. */
export function createPropContinuityReferenceBasis(project: Project, resourceId: string, input: PropContinuity): ProductionReferenceBasis {
  const propContinuity = PropContinuitySchema.parse(input);
  const basis = createProductionReferenceBasis(project, resourceId);
  const resource = requireResource(project, resourceId);
  const referenceAssetIds = continuityReferenceIds(project, { ...resource, propContinuity });
  return { ...basis, propContinuity, referenceAssetIds };
}

export function createProductionReferenceBasis(project: Project, resourceId: string): ProductionReferenceBasis {
  const resource = requireResource(project, resourceId);
  const segmentIds: Set<string> = new Set(project.productionPlan?.segments.filter((segment): boolean => segment.resourceIds.includes(resourceId)).map((segment): string => segment.segmentId));
  if (segmentIds.size === 0) throw contractError('AUTOMATION_INACTIVE_RESOURCE', `현재 구간에 사용하지 않는 과거 기준입니다: ${resourceId}`, []);
  const protectedShots = project.shots.filter((shot): boolean => segmentIds.has(shot.segmentId) && (shot.approvalStatus === 'approved' || shot.lockedFields.length > 0));
  if (protectedShots.length > 0) throw contractError('AUTOMATION_PROTECTED_REFERENCE', `확정·잠금 컷이 사용하는 기준을 자동 교체하지 않습니다: ${protectedShots.map((shot): string => shot.id).join(', ')}`, []);
  return ProductionReferenceBasisSchema.parse({ projectId: project.projectId, revision: project.revision, projectHash: sha256Text(stableJsonStringify(project)), resourceId, referenceAssetIds: continuityReferenceIds(project, resource) });
}

export function assertProductionReferenceBasis(project: Project, basis: ProductionReferenceBasis): void {
  const current: ProductionReferenceBasis = basis.propContinuity === undefined ? createProductionReferenceBasis(project, basis.resourceId)
    : createPropContinuityReferenceBasis(project, basis.resourceId, basis.propContinuity);
  if (stableJsonStringify(current) !== stableJsonStringify(ProductionReferenceBasisSchema.parse(basis))) throw contractError('AUTOMATION_STALE_PLAN', `기준 이미지 요청 이후 입력·선택이 바뀌었습니다: ${basis.resourceId}`, []);
}

async function referenceInput(project: Project, basis: ProductionReferenceBasis, loaded: readonly LoadedReference[]): Promise<ImageGenerationInput> {
  assertProductionReferenceBasis(project, basis);
  const resource = requireResource(project, basis.resourceId);
  const references = await verifiedImageReferences(project, basis.referenceAssetIds, loaded, (asset): string => resource.kind === 'location'
    ? `${asset.id}: 동일 장소의 기본 공간이다. 벽·창문·출입구의 위치와 연결, 고정 가구의 형태·배치를 유지한다. 현재 설명에 명시된 조명·시간대·상태 변화만 적용하며 공간을 새로 설계하거나 좌우 반전하지 않는다. 기본 공간 설명: ${asset.description}`
    : resource.kind === 'prop'
      ? `${asset.id}: 같은 소품의 앞선 기준이다. 판형·비율·색상·재질·표 구획·고정된 구조를 유지한다. 젖음·손상·내용·배치는 현재 설명에서 확인한 상태만 적용한다. 현재 설명에 없는 건조·복원·새 글자·사건을 만들지 않는다. 이름이 비슷한 다른 소품으로 교체하지 않는다.`
      : `${asset.id}: 동일 인물의 얼굴·체형만 유지. 의상·자세·상태는 현재 설명을 적용.`);
  return { prompt: `콘티 제작용 ${resource.kind} 기준 이미지 한 장. 이야기 장면이나 사건을 추가하지 않는다. 글자·로고·정확한 메시지는 그리지 않는다. 인물은 외형과 현재 의상이 잘 보이게, 공간은 비어 있는 세트와 구조가 보이게, 소품은 대상만 명확하게 묘사한다. 사용자 검토 전 제작 제안이다.\n${JSON.stringify({ name: resource.name, description: resource.description, propContinuity: basis.propContinuity ?? resource.propContinuity ?? null, profile: project.profile })}`,
    aspectRatio: { width: project.profile.aspectWidth, height: project.profile.aspectHeight }, references };
}

/** 실제 디코딩·해시·비율을 재검사하고 새 버전만 추가한다. 저장은 호출자가 같은 Basis로 원자 적용한다. */
export async function compileAutomaticReference(inputProject: Project, inputBasis: ProductionReferenceBasis, inputResult: ImageGenerationResult, inputProvenance: AutomaticPlanProvenance): Promise<AutomaticReferenceCandidate> {
  if (inputResult.bytes.length > MAX_IMAGE_BYTES) throw contractError('CODEX_IMAGE_SIZE_INVALID', `기준 이미지가 ${MAX_IMAGE_BYTES} bytes 한도를 초과했습니다.`, []);
  const project: Project = structuredClone(inputProject);
  const basis: ProductionReferenceBasis = structuredClone(inputBasis);
  const provenance: AutomaticPlanProvenance = structuredClone(inputProvenance);
  const result: ImageGenerationResult = { ...inputResult, bytes: Buffer.from(inputResult.bytes), inspection: { ...inputResult.inspection } };
  assertProductionReferenceBasis(project, basis);
  AutomaticPlanProvenanceSchema.parse(provenance);
  if (provenance.model !== result.model || provenance.turnId !== result.turnId) throw contractError('AUTOMATION_REFERENCE_PROVENANCE', '기준 이미지의 실제 모델·Turn과 생성 근거가 다릅니다.', []);
  if (project.generationRecords.some((record): boolean => record.id === provenance.generationId || record.requestId === provenance.generationId)) throw contractError('AUTOMATION_DUPLICATE_GENERATION', `이미 적용한 이미지 요청입니다: ${provenance.generationId}`, []);
  const inspection = await inspectImageBytes(result.bytes, result.inspection.mimeType);
  if (stableJsonStringify(inspection) !== stableJsonStringify(result.inspection)) throw contractError('AUTOMATION_REFERENCE_INSPECTION', '기준 이미지의 바이트와 검사 정보가 다릅니다.', []);
  if (Math.abs(inspection.width * project.profile.aspectHeight - inspection.height * project.profile.aspectWidth) > Math.max(project.profile.aspectWidth, project.profile.aspectHeight)) throw contractError('CODEX_IMAGE_ASPECT_MISMATCH', '기준 이미지 비율이 현재 제작 설정과 다릅니다.', []);
  const resource = requireResource(project, basis.resourceId);
  const assetId: string = `${provenance.generationId}:reference`;
  const subjectId: string = productionResourceSubject(resource);
  const extension: string = inspection.mimeType === 'image/png' ? 'png' : inspection.mimeType === 'image/jpeg' ? 'jpg' : 'webp';
  const path: string = `assets/${sha256Text(assetId)}.${extension}`;
  const version: number = Math.max(0, ...project.assets.filter((asset): boolean => asset.kind === resource.kind && asset.subjectId === subjectId).map((asset): number => asset.version)) + 1;
  const asset: Asset = { id: assetId, kind: resource.kind, subjectId, path, mimeType: inspection.mimeType, sha256: inspection.sha256,
    description: resource.description, durationMs: null, version };
  const segmentIds: Set<string> = new Set(project.productionPlan?.segments.filter((segment): boolean => segment.resourceIds.includes(resource.id)).map((segment): string => segment.segmentId));
  const shotIds: Set<string> = new Set(project.shots.filter((shot): boolean => segmentIds.has(shot.segmentId)).map((shot): string => shot.id));
  const replaceReference = (id: string): string => id === resource.referenceAssetId ? asset.id : id;
  const referencePresentation = validateImageReferencePresentation(result.referencePresentation, basis.referenceAssetIds.map((id): string => project.assets.find((asset): boolean => asset.id === id)!.sha256));
  const record: GenerationRecord = { id: provenance.generationId, provider: 'codex-app', model: result.model, modelVersion: null, requestId: provenance.generationId,
    prompt: stableJsonStringify({ input: provenance.prompt, revisedPrompt: result.revisedPrompt, turnId: result.turnId, itemId: result.itemId, basis, referencePresentation }),
    templateVersion: 'automatic-production-reference-1.2.0', seed: null, referenceHashes: [...new Set([basis.projectHash, ...basis.referenceAssetIds.map((id): string => project.assets.find((value): boolean => value.id === id)!.sha256)])],
    resultAssetIds: [asset.id], shotIds: [...shotIds], createdAt: provenance.createdAt, generatorBuild: provenance.generatorBuild };
  const candidate: Project = ProjectSchema.parse({ ...project, assets: [...project.assets, asset], generationRecords: [...project.generationRecords, record],
    productionPlan: { resources: project.productionPlan!.resources.map((value) => value.id === resource.id ? { ...value, referenceAssetId: asset.id, ...(basis.propContinuity === undefined ? {} : { propContinuity: basis.propContinuity }) } : value), segments: project.productionPlan!.segments },
    shots: project.shots.map((shot) => shotIds.has(shot.id) ? { ...shot, approvalStatus: 'proposed', propIds: shot.propIds.map(replaceReference),
      continuityBefore: shot.continuityBefore.map((state) => ({ ...state, assetId: replaceReference(state.assetId) })),
      continuityAfter: shot.continuityAfter.map((state) => ({ ...state, assetId: replaceReference(state.assetId) })) } : shot),
    frames: project.frames.map((frame) => shotIds.has(frame.shotId) ? { ...frame, visualReview: 'pending' } : frame) });
  assertGenerationRecordTransition(project, candidate);
  assertNoErrors(validateProject(candidate, project.dataset), 'AUTOMATION_REFERENCE_INVALID');
  return { project: candidate, basis, writes: [{ relativePath: path, content: result.bytes }] };
}

export async function generateAutomaticReference(inputProject: Project, inputBasis: ProductionReferenceBasis, inputLoaded: readonly LoadedReference[], inputProvenance: Omit<AutomaticPlanProvenance, 'model' | 'turnId' | 'prompt'>, engine: ImageGenerationEngine, signal: AbortSignal): Promise<AutomaticReferenceCandidate> {
  assertReferenceBudget(inputLoaded);
  const project = structuredClone(inputProject);
  const basis = structuredClone(inputBasis);
  const loaded: LoadedReference[] = inputLoaded.map((value): LoadedReference => ({ assetId: value.assetId, bytes: Buffer.from(value.bytes) }));
  const provenance = AutomaticPlanProvenanceSchema.omit({ model: true, turnId: true, prompt: true }).parse(inputProvenance);
  if (signal.aborted) throw contractError('AUTOMATION_CANCELLED', '기준 이미지 생성이 취소되었습니다.', []);
  const input = await referenceInput(project, basis, loaded);
  if (signal.aborted) throw contractError('AUTOMATION_CANCELLED', '기준 이미지 생성이 취소되었습니다.', []);
  const result = await engine.run(input, signal);
  if (signal.aborted) throw contractError('AUTOMATION_CANCELLED', '기준 이미지 생성이 취소되었습니다. 결과는 반영하지 않았습니다.', []);
  const candidate = await compileAutomaticReference(project, basis, result, { ...provenance, model: result.model, turnId: result.turnId, prompt: input.prompt });
  if (signal.aborted) throw contractError('AUTOMATION_CANCELLED', '기준 이미지 검증 중 취소되었습니다. 결과는 반영하지 않았습니다.', []);
  return candidate;
}

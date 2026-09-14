import { assertNoErrors, contractError, issue } from './errors.js';
import { productionResourceSubject, segmentReferenceAssets } from './production-resources.js';
import type { Asset, Issue, Project, Shot } from './schema.js';

export type AssetReferenceKind = 'frame-image' | 'audio-cue' | 'generation-result' | 'shot-prop'
  | 'continuity-before' | 'continuity-after' | 'production-resource';

export type ProjectAssetReference = {
  relation: AssetReferenceKind;
  entityId: string;
  assetId: string;
  field: string;
  allowedKinds: readonly Asset['kind'][];
  expectedSubjectId: string | null | undefined;
  initialCreateAllowed: false;
};

export const PROJECT_ASSET_REFERENCE_FIELDS: readonly string[] = [
  'frames.imageAssetId',
  'audioCues.assetId',
  'generationRecords.resultAssetIds',
  'shots.propIds',
  'shots.continuityBefore.assetId',
  'shots.continuityAfter.assetId',
  'productionPlan.resources.referenceAssetId',
];

const GENERATION_RESULT_KINDS: readonly Asset['kind'][] = ['image', 'audio', 'character', 'location', 'prop'];
const CONTINUITY_KINDS: readonly Asset['kind'][] = ['character', 'location', 'prop'];

/** 이미지 Context와 현재 출력이 사용하는 인물·공간의 최신 기준 자산을 선택한다. */
export function currentVisualReferenceAssets(project: Project, shot: Shot): Asset[] {
  const visiblePersonIds: string[] = shot.presence.filter((presence): boolean =>
    ['VISIBLE', 'HAND_ONLY', 'SILHOUETTE', 'ARCHIVE_IMAGE'].includes(presence.mode)).map((presence): string => presence.personId);
  const hasPlan: boolean = project.productionPlan?.segments.some((segment): boolean => segment.segmentId === shot.segmentId) ?? false;
  const scoped: Asset[] = hasPlan ? segmentReferenceAssets(project, shot.segmentId) : project.assets;
  const candidates: Asset[] = scoped.filter((asset: Asset): boolean =>
    asset.kind === 'character' && asset.subjectId !== null && visiblePersonIds.includes(asset.subjectId)
    || asset.kind === 'location' && asset.subjectId !== null && asset.subjectId === shot.visualLocationId);
  const explicitIds: Set<string> = new Set(shot.continuityBefore.map((state): string => state.assetId));
  const explicit: Asset[] = project.assets.filter((asset): boolean => explicitIds.has(asset.id) &&
    (asset.kind === 'character' && asset.subjectId !== null && visiblePersonIds.includes(asset.subjectId)
      || asset.kind === 'location' && asset.subjectId === shot.visualLocationId));
  return [...explicit, ...candidates.filter((asset: Asset): boolean => !explicit.some((value): boolean => value.kind === asset.kind && value.subjectId === asset.subjectId) && !candidates.some((candidate: Asset): boolean =>
    candidate.kind === asset.kind && candidate.subjectId === asset.subjectId && candidate.version > asset.version))];
}

function reference(
  relation: AssetReferenceKind, entityId: string, assetId: string, field: string,
  allowedKinds: readonly Asset['kind'][], expectedSubjectId: string | null | undefined,
): ProjectAssetReference {
  return { relation, entityId, assetId, field, allowedKinds, expectedSubjectId, initialCreateAllowed: false };
}

/** 현재 Project Schema의 명시된 Asset 외래 키와 허용 정책을 수집한다. */
export function collectProjectAssetReferences(project: Project): ProjectAssetReference[] {
  const references: ProjectAssetReference[] = [];
  for (const resource of project.productionPlan?.resources ?? []) if (resource.referenceAssetId !== null) {
    references.push(reference('production-resource', resource.id, resource.referenceAssetId,
      `productionPlan.resources.${resource.id}.referenceAssetId`, [resource.kind], resource.kind === 'prop' ? undefined : productionResourceSubject(resource)));
  }
  for (const frame of project.frames) if (frame.imageAssetId !== null) {
    references.push(reference('frame-image', frame.id, frame.imageAssetId, `frames.${frame.id}.imageAssetId`, ['image'], frame.id));
  }
  for (const cue of project.audioCues) if (cue.assetId !== null) {
    references.push(reference('audio-cue', cue.id, cue.assetId, `audioCues.${cue.id}.assetId`, ['audio'], cue.id));
  }
  for (const record of project.generationRecords) for (const [index, assetId] of record.resultAssetIds.entries()) {
    references.push(reference('generation-result', record.id, assetId,
      `generationRecords.${record.id}.resultAssetIds.${index}`, GENERATION_RESULT_KINDS, undefined));
  }
  for (const shot of project.shots) {
    for (const [index, assetId] of shot.propIds.entries()) {
      references.push(reference('shot-prop', shot.id, assetId, `shots.${shot.id}.propIds.${index}`, ['prop'], undefined));
    }
    for (const [index, continuity] of shot.continuityBefore.entries()) {
      references.push(reference('continuity-before', shot.id, continuity.assetId,
        `shots.${shot.id}.continuityBefore.${index}.assetId`, CONTINUITY_KINDS, undefined));
    }
    for (const [index, continuity] of shot.continuityAfter.entries()) {
      references.push(reference('continuity-after', shot.id, continuity.assetId,
        `shots.${shot.id}.continuityAfter.${index}.assetId`, CONTINUITY_KINDS, undefined));
    }
  }
  return references;
}

function referenceMessage(projectId: string, referenceValue: ProjectAssetReference, asset: Asset | undefined, reason: string): string {
  const expectedKind: string = referenceValue.allowedKinds.join('|');
  const actualKind: string = asset?.kind ?? 'missing';
  const expectedSubject: string = referenceValue.expectedSubjectId === undefined ? 'not-applicable' : String(referenceValue.expectedSubjectId);
  const actualSubject: string = asset === undefined ? 'missing' : String(asset.subjectId);
  return `${reason} projectId=${projectId}, entityId=${referenceValue.entityId}, field=${referenceValue.field}, assetId=${referenceValue.assetId}, expectedKind=${expectedKind}, actualKind=${actualKind}, expectedSubject=${expectedSubject}, actualSubject=${actualSubject}`;
}

/** Asset 외래 키의 존재, 종류와 필요한 대상 연결을 구조화 Issue로 반환한다. */
export function assetReferenceIssues(project: Project): Issue[] {
  const assets: ReadonlyMap<string, Asset> = new Map<string, Asset>(project.assets.map((asset: Asset): [string, Asset] => [asset.id, asset]));
  return collectProjectAssetReferences(project).flatMap((referenceValue: ProjectAssetReference): Issue[] => {
    const asset: Asset | undefined = assets.get(referenceValue.assetId);
    if (asset === undefined) return [issue('ASSET_REFERENCE_NOT_FOUND', 'error', referenceValue.entityId, referenceValue.field,
      referenceMessage(project.projectId, referenceValue, asset, 'Asset 참조를 찾을 수 없습니다.'),
      referenceValue.allowedKinds.join('|'), 'missing', [])];
    if (!referenceValue.allowedKinds.includes(asset.kind)) return [issue('ASSET_REFERENCE_KIND_MISMATCH', 'error', referenceValue.entityId, referenceValue.field,
      referenceMessage(project.projectId, referenceValue, asset, 'Asset 참조 종류가 다릅니다.'),
      referenceValue.allowedKinds.join('|'), asset.kind, [])];
    if (referenceValue.expectedSubjectId !== undefined && asset.subjectId !== referenceValue.expectedSubjectId) {
      return [issue('ASSET_REFERENCE_SUBJECT_MISMATCH', 'error', referenceValue.entityId, referenceValue.field,
        referenceMessage(project.projectId, referenceValue, asset, 'Asset 참조 대상이 다릅니다.'),
        String(referenceValue.expectedSubjectId), String(asset.subjectId), [])];
    }
    return [];
  });
}

/** 저장 경계에서 Asset 외래 키 closure를 우회하지 못하게 한다. */
export function assertAssetReferenceClosure(project: Project): void {
  const issues: Issue[] = assetReferenceIssues(project);
  const first: Issue | undefined = issues.find((value: Issue): boolean => value.severity === 'error');
  if (first === undefined) return;
  assertNoErrors(issues, first.code);
}

/** Initial Create가 Asset metadata와 Asset 외래 키를 모두 비운 상태인지 검사한다. */
export function assertAssetFreeInitialProject(project: Project): void {
  const references: ProjectAssetReference[] = collectProjectAssetReferences(project);
  if (project.assets.length === 0 && references.length === 0) return;
  const fields: string = [...new Set(references.map((value: ProjectAssetReference): string => value.field))].join(',') || '없음';
  const assets: ReadonlyMap<string, Asset> = new Map<string, Asset>(project.assets.map((asset: Asset): [string, Asset] => [asset.id, asset]));
  const details: string = references.map((value: ProjectAssetReference): string =>
    referenceMessage(project.projectId, value, assets.get(value.assetId), 'Initial Create Asset 참조는 허용되지 않습니다.')).join(' | ') || 'Asset reference 없음';
  throw contractError('UNSUPPORTED_INITIAL_PROJECT_ASSETS',
    `Initial Create는 Asset-free Project만 지원합니다. projectId=${project.projectId}, assetMetadataCount=${project.assets.length}, assetReferenceCount=${references.length}, referenceFields=${fields}, details=${details}. Asset-free Project를 먼저 생성한 뒤 Revision Update로 신규 Asset ID와 실제 파일을 등록하세요.`, []);
}

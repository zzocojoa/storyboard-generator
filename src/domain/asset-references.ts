import { assertNoErrors, contractError, issue } from './errors.js';
import type { Asset, Issue, Project } from './schema.js';

export type AssetReferenceKind = 'frame-image' | 'audio-cue' | 'generation-result' | 'shot-prop'
  | 'continuity-before' | 'continuity-after';

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
];

const GENERATION_RESULT_KINDS: readonly Asset['kind'][] = ['image', 'audio', 'character', 'location', 'prop'];
const CONTINUITY_KINDS: readonly Asset['kind'][] = ['character', 'location', 'prop'];

function reference(
  relation: AssetReferenceKind, entityId: string, assetId: string, field: string,
  allowedKinds: readonly Asset['kind'][], expectedSubjectId: string | null | undefined,
): ProjectAssetReference {
  return { relation, entityId, assetId, field, allowedKinds, expectedSubjectId, initialCreateAllowed: false };
}

/** 현재 Project Schema의 명시된 Asset 외래 키와 허용 정책을 수집한다. */
export function collectProjectAssetReferences(project: Project): ProjectAssetReference[] {
  const references: ProjectAssetReference[] = [];
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

import type { ImageGenerationReference } from '../codex/image-engine.js';
import { assertImageReferenceBudget } from '../codex/image-reference-presentation.js';
import { contractError } from '../domain/errors.js';
import { inspectImageBytes } from '../domain/media-inspection.js';
import type { Asset, Project } from '../domain/schema.js';

export type LoadedReference = { assetId: string; bytes: Buffer };

/** 복사·디코딩 전에 참조 개수와 바이트 예산을 검사한다. */
export function assertReferenceBudget(loaded: readonly LoadedReference[]): void {
  assertImageReferenceBudget(loaded);
}

/** 선택한 순서·버전의 실제 바이트만 모델에 전달한다. 로드 순서는 참조의 의미를 바꾸지 않는다. */
export async function verifiedImageReferences(project: Project, ids: readonly string[], loaded: readonly LoadedReference[], label: (asset: Asset) => string): Promise<ImageGenerationReference[]> {
  assertReferenceBudget(loaded);
  if (loaded.length !== ids.length || new Set(loaded.map((value): string => value.assetId)).size !== loaded.length || loaded.some((value): boolean => !ids.includes(value.assetId))) {
    throw contractError('AUTOMATION_REFERENCE_INPUT', '요청에 결속된 모든 참조 바이트를 정확히 한 번씩 전달해야 합니다.', []);
  }
  const references: ImageGenerationReference[] = [];
  for (const id of ids) {
    const asset: Asset | undefined = project.assets.find((candidate): boolean => candidate.id === id && ['character', 'location', 'prop'].includes(candidate.kind));
    if (asset === undefined) throw contractError('ASSET_REFERENCE_NOT_FOUND', `시각 기준 자산이 없습니다: ${id}`, []);
    const value: LoadedReference | undefined = loaded.find((candidate): boolean => candidate.assetId === id);
    if (value === undefined) throw contractError('AUTOMATION_REFERENCE_INPUT', `선택한 기준 이미지 바이트가 없습니다: ${id}`, []);
    const inspected = await inspectImageBytes(value.bytes, asset.mimeType);
    if (inspected.sha256 !== asset.sha256) throw contractError('AUTOMATION_REFERENCE_HASH', `선택한 기준 이미지의 실제 해시가 다릅니다: ${id}`, []);
    references.push({ label: label(asset), mimeType: inspected.mimeType, bytes: Buffer.from(value.bytes) });
  }
  return references;
}

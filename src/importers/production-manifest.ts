import { z } from 'zod';
import { contractError } from '../domain/errors.js';
import { HashSchema, IdSchema } from '../domain/schema.js';
import type { Snapshot } from '../domain/schema.js';
import { optionalSnapshot, parseJson, requireSnapshot, sha256SortedJson, sha256Text } from './integrity.js';

const FootprintSchema = z.looseObject({
  schema_family: z.literal('production-footprint'), schema_version: z.literal('1.0.0'), project_id: IdSchema,
  source_artifact_hashes: z.looseObject({ scene_cards: HashSchema, characters: HashSchema }),
});
const ManifestSchema = z.looseObject({
  schema_family: z.literal('production-manifest'), schema_version: z.literal('1.1.0'), project_id: IdSchema,
  source_footprint_sha256: HashSchema,
  deliverables: z.array(z.looseObject({ artifact_name: z.string(), path: z.string(), sha256: HashSchema })),
});

function assertHash(expected: string, actual: string, context: string): void {
  if (expected !== actual) throw contractError('UPSTREAM_HASH_MISMATCH', `${context}: expected=${expected}, actual=${actual}`, []);
}

/** 어댑터에 포함된 상위 산출물의 연결 해시를 검사하며 외부 $schema 경로를 실행하거나 탐색하지 않는다. */
export function verifyProductionManifest(projectId: string, snapshots: readonly Snapshot[]): void {
  const footprintFile: Snapshot | null = optionalSnapshot(snapshots, 'footprint');
  const manifestFile: Snapshot | null = optionalSnapshot(snapshots, 'manifest');
  if (footprintFile !== null) {
    const footprint = FootprintSchema.parse(parseJson(footprintFile.content, footprintFile.path));
    if (footprint.project_id !== projectId) throw contractError('PROJECT_MISMATCH', `${footprintFile.path}: 프로젝트 ID가 다릅니다.`, []);
    for (const mapping of [{ role: 'scene-cards' as const, expected: footprint.source_artifact_hashes.scene_cards }, { role: 'characters' as const, expected: footprint.source_artifact_hashes.characters }]) {
      const source: Snapshot = requireSnapshot(snapshots, mapping.role);
      assertHash(mapping.expected, sha256SortedJson(source.content, source.path), `${footprintFile.path} → ${source.path}`);
    }
  }
  if (manifestFile !== null) {
    const manifest = ManifestSchema.parse(parseJson(manifestFile.content, manifestFile.path));
    if (manifest.project_id !== projectId) throw contractError('PROJECT_MISMATCH', `${manifestFile.path}: 프로젝트 ID가 다릅니다.`, []);
    if (footprintFile === null) throw contractError('MISSING_MANIFEST_FOOTPRINT', `${manifestFile.path}: 연결된 footprint 원본이 필요합니다.`, []);
    assertHash(manifest.source_footprint_sha256, sha256SortedJson(footprintFile.content, footprintFile.path), `${manifestFile.path} → ${footprintFile.path}`);
    for (const deliverable of manifest.deliverables) {
      const source: Snapshot | undefined = snapshots.find((file: Snapshot): boolean => file.path === deliverable.path);
      if (source === undefined) throw contractError('MISSING_MANIFEST_DELIVERABLE', `${manifestFile.path}: 산출물 파일이 없습니다: ${deliverable.path}`, []);
      assertHash(deliverable.sha256, sha256Text(source.content), `${manifestFile.path} → ${source.path}`);
    }
  }
}

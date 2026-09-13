import { z } from 'zod';
import { contractError } from '../domain/errors.js';
import { HashSchema, IdSchema } from '../domain/schema.js';
import { parseJson, sha256SortedJson, sha256Text } from '../importers/integrity.js';
import { inspectDocuments } from './compile.js';
import { IdentityEvidenceSchema, IDENTITY_FILE_MAX_BYTES } from './identity-schema.js';
import type { IdentityEvidence, IdentityMatch } from './identity-schema.js';
import type { DocumentBindings, DocumentSources } from './schema.js';

const CharactersSchema = z.looseObject({ project_id: IdSchema,
  characters: z.array(z.looseObject({ character_id: IdSchema, name: z.string().min(1) })).min(1).max(2000) });
const IdentityFootprintSchema = z.looseObject({ schema_family: z.literal('production-footprint'), schema_version: z.literal('1.0.0'),
  project_id: IdSchema, source_artifact_hashes: z.looseObject({ characters: HashSchema }) });
const IdentityManifestSchema = z.looseObject({ project_id: IdSchema, source_footprint_sha256: HashSchema });

function requireIdentityHash(expected: string, actual: string, context: string): void {
  if (expected !== actual) throw contractError('INVALID_IDENTITY_HASH', `${context}: 원본 버전이 다릅니다. expected=${expected}, actual=${actual}`, []);
}

/** 명시적 인물표를 manifest→footprint→characters 해시 사슬로 현재 문서에 결속한다. */
export function verifyIdentityEvidence(sources: DocumentSources, bindings: DocumentBindings, input: IdentityEvidence): IdentityMatch[] {
  const evidence: IdentityEvidence = IdentityEvidenceSchema.parse(input);
  const preview = inspectDocuments(sources, bindings).preview;
  if (evidence.projectId !== preview.projectId || evidence.sourceFingerprint !== preview.sourceFingerprint) {
    throw contractError('INVALID_IDENTITY_BASIS', '보충 인물표의 프로젝트 또는 8개 문서 버전이 다릅니다. 현재 문서에서 다시 검증하세요.', []);
  }
  for (const [key, snapshot] of Object.entries({ characters: evidence.characters, footprint: evidence.footprint })) {
    if (Buffer.byteLength(snapshot.content) > IDENTITY_FILE_MAX_BYTES) throw contractError('INVALID_IDENTITY_SIZE', `${key}: 보충 파일은 256KB 이하여야 합니다.`, []);
    requireIdentityHash(snapshot.sha256, sha256Text(snapshot.content), key);
  }
  const characters = CharactersSchema.parse(parseJson(evidence.characters.content, '인물 원본'));
  const footprint = IdentityFootprintSchema.parse(parseJson(evidence.footprint.content, '제작 근거'));
  const manifest = IdentityManifestSchema.parse(parseJson(sources.manifest.content, sources.manifest.path));
  if ([characters.project_id, footprint.project_id, manifest.project_id].some((id: string): boolean => id !== preview.projectId)) {
    throw contractError('INVALID_IDENTITY_PROJECT', '인물표·제작 근거·manifest가 같은 프로젝트여야 합니다.', []);
  }
  requireIdentityHash(manifest.source_footprint_sha256, sha256SortedJson(evidence.footprint.content, '제작 근거'), 'manifest → 제작 근거');
  requireIdentityHash(footprint.source_artifact_hashes.characters, sha256SortedJson(evidence.characters.content, '인물 원본'), '제작 근거 → 인물 원본');
  for (const values of [characters.characters.map((item): string => item.name), characters.characters.map((item): string => item.character_id)]) {
    if (new Set(values).size !== values.length) throw contractError('INVALID_IDENTITY_DUPLICATE', '인물표의 이름과 ID는 각각 중복 없이 하나씩 대응해야 합니다.', []);
  }
  const matches: IdentityMatch[] = characters.characters.flatMap((person, index: number): IdentityMatch[] => {
    const choice = preview.people.find((item): boolean => item.key === person.name);
    if (choice === undefined) return [];
    if (!choice.candidates.includes(person.character_id)) throw contractError('INVALID_IDENTITY_CANDIDATE', `${person.name}: ${person.character_id}는 현재 문서의 인물 후보에 없습니다.`, []);
    if (choice.selected !== null && choice.selected !== person.character_id) throw contractError('INVALID_IDENTITY_CONFLICT', `${person.name}: 현재 ${choice.selected}, 원본 ${person.character_id}. 현재 연결을 검토한 뒤 다시 실행하세요.`, []);
    const owner = preview.people.find((item): boolean => item.key !== person.name && item.selected === person.character_id);
    if (owner !== undefined) throw contractError('INVALID_IDENTITY_CONFLICT', `${person.character_id}는 이미 ${owner.key}에 연결되어 있습니다. 해당 연결을 검토하세요.`, []);
    return [{ name: person.name, targetId: person.character_id, currentId: choice.selected, locator: `/characters/${index}` }];
  });
  if (matches.length === 0) throw contractError('INVALID_IDENTITY_NO_MATCH', '이 인물표에 현재 문서의 이름과 일치하는 인물이 없습니다.', []);
  return matches;
}

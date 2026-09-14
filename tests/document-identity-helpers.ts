import { cp, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { documentFingerprint } from '../src/documents/compile.js';
import type { IdentityEvidence } from '../src/documents/identity-schema.js';
import { readDocumentSources } from '../src/documents/io.js';
import type { DocumentSources } from '../src/documents/schema.js';
import { sha256SortedJson, sha256Text } from '../src/importers/integrity.js';

export async function productionIdentityEvidence(sources: DocumentSources): Promise<IdentityEvidence> {
  const characters: string = await readFile('tests/fixtures/production/02_CHARACTER/characters.json', 'utf8');
  const footprint: string = await readFile('tests/fixtures/production/06_SCENE/production_footprint.json', 'utf8');
  return { format: 'production-characters-v1', projectId: 'PRJ-007', sourceFingerprint: documentFingerprint(sources),
    characters: { content: characters, sha256: sha256Text(characters) }, footprint: { content: footprint, sha256: sha256Text(footprint) } };
}

/** 인물 수·ID·배열 순서가 다른 독립 스토리에 해시로 연결된 보충 자료를 만든다. */
export async function syntheticIdentityFiles(root: string): Promise<{ directory: string; charactersPath: string; footprintPath: string }> {
  const directory: string = join(root, 'input'); await cp('tests/fixtures/documents', directory, { recursive: true });
  const charactersPath: string = join(root, 'people.json'); const footprintPath: string = join(root, 'production-proof.json');
  const characters: string = JSON.stringify({ project_id: 'plant-doc-demo', characters: [{ name: '준', character_id: 'helper' }, { name: '민아', character_id: 'host' }] });
  const footprint: string = JSON.stringify({ schema_family: 'production-footprint', schema_version: '1.0.0', project_id: 'plant-doc-demo',
    source_artifact_hashes: { characters: sha256SortedJson(characters, '합성 인물표') } });
  const sources: DocumentSources = await readDocumentSources(directory);
  const manifest: object = JSON.parse(sources.manifest.content) as object;
  await writeFile(join(directory, 'production_manifest.json'), JSON.stringify({ ...manifest, source_footprint_sha256: sha256SortedJson(footprint, '합성 제작 근거') }));
  await writeFile(charactersPath, characters); await writeFile(footprintPath, footprint);
  return { directory, charactersPath, footprintPath };
}

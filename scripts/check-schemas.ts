import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { contractError } from '../src/domain/errors.js';
import { schemaArtifacts } from './schema-artifacts.js';

for (const artifact of schemaArtifacts()) {
  const stored: string = await readFile(resolve('schemas', artifact.name), 'utf8');
  if (stored !== artifact.content) throw contractError('SCHEMA_ARTIFACT_DRIFT', `${artifact.name}: npm run schemas:write로 갱신하세요.`, []);
}
process.stdout.write('소스와 JSON Schema 일치 확인 완료\n');

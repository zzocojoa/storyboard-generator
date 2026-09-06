import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { schemaArtifacts } from './schema-artifacts.js';

await mkdir(resolve('schemas'), { recursive: true });
for (const artifact of schemaArtifacts()) await writeFile(resolve('schemas', artifact.name), artifact.content, 'utf8');
process.stdout.write('JSON Schema 생성 완료\n');

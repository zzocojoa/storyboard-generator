import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { z } from 'zod';
import { hashBuildInputs, runtimeGenerationConfigHash } from '../src/build-fingerprint.js';
import type { BuildInput } from '../src/build-fingerprint.js';
import { generationContractInputs, readBuildGitState, runtimeSourceInputs } from '../src/build-inputs.js';
import type { BuildGitState } from '../src/build-inputs.js';
import { BuildManifestSchema } from '../src/build-schema.js';
import type { BuildManifest } from '../src/build-schema.js';
import { REQUEST_JOURNAL_VERSION, REQUEST_LOCK_VERSION } from '../src/codex/storage-contract.js';
import { ProjectSchema } from '../src/domain/schema.js';
import { stableJsonStringify } from '../src/io/stable-json.js';

const root: string = process.cwd();
const packageInfo = z.object({ version: z.string() }).parse(JSON.parse(await readFile('package.json', 'utf8')) as unknown);
const config = z.object({ codex: z.object({ speechVoice: z.string().min(1) }) }).parse(JSON.parse(await readFile(resolve(process.argv[2] ?? 'storyboard.config.json'), 'utf8')) as unknown);
const runtimeInputs: BuildInput[] = await runtimeSourceInputs(root);
const contractInputs: BuildInput[] = await generationContractInputs(root, runtimeInputs);
const gitState: BuildGitState = readBuildGitState(root);
const manifest: BuildManifest = BuildManifestSchema.parse({ ...gitState, provenanceVersion: 3, commitSha: gitState.headCommitSha, appVersion: packageInfo.version,
  projectSchemaVersion: ProjectSchema.shape.schemaVersion.value, builtAt: new Date().toISOString(), sourceTreeSha256: hashBuildInputs(runtimeInputs),
  generationContractSha256: hashBuildInputs(contractInputs), runtimeGenerationConfigSha256: runtimeGenerationConfigHash(config.codex.speechVoice),
  journalVersion: 3, lockVersion: 3, registryVersion: 1, requestJournalVersion: REQUEST_JOURNAL_VERSION, requestLockVersion: REQUEST_LOCK_VERSION });
await mkdir('.build', { recursive: true });
await writeFile('.build/build-manifest.json', stableJsonStringify(manifest));
process.stdout.write(`${JSON.stringify(manifest)}\n`);

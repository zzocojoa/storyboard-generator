import { readFileSync } from 'node:fs';
import { runtimeGenerationConfigHash } from './build-fingerprint.js';
import { BuildManifestSchema } from './build-schema.js';
import type { BuildManifest } from './build-schema.js';
import type { GeneratorBuildProvenance } from './domain/schema.js';

export { BuildManifestSchema } from './build-schema.js';
export type { BuildManifest } from './build-schema.js';

const runtimeBuild: BuildManifest = BuildManifestSchema.parse(JSON.parse(readFileSync(new URL('../.build/build-manifest.json', import.meta.url), 'utf8')) as unknown);

/** 시작 시 읽은 Build를 고정하여 이후 다른 프로세스의 Build 파일 갱신과 혼합하지 않는다. */
export function readBuildManifest(): BuildManifest {
  return structuredClone(runtimeBuild);
}

export function generatorBuildProvenance(build: BuildManifest): GeneratorBuildProvenance {
  return { provenanceVersion: build.provenanceVersion, headCommitSha: build.headCommitSha, worktreeDirty: build.worktreeDirty, generationInputsDirty: build.generationInputsDirty,
    generationContractSha256: build.generationContractSha256, runtimeGenerationConfigSha256: build.runtimeGenerationConfigSha256,
    commitSha: build.commitSha, appVersion: build.appVersion, projectSchemaVersion: build.projectSchemaVersion,
    builtAt: build.builtAt, sourceTreeSha256: build.sourceTreeSha256 };
}

export function buildForSpeechVoice(speechVoice: string): BuildManifest {
  return { ...readBuildManifest(), runtimeGenerationConfigSha256: runtimeGenerationConfigHash(speechVoice) };
}

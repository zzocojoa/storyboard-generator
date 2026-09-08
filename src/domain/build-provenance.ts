import { GeneratorBuildProvenanceSchema } from './schema.js';

const LegacyGeneratorBuildSchema = GeneratorBuildProvenanceSchema.pick({ commitSha: true, appVersion: true, projectSchemaVersion: true, builtAt: true, sourceTreeSha256: true });

/** 과거 Build의 명시적 값만 복사하고 기록되지 않은 Hash와 Dirty 상태는 null로 남긴다. */
export function migrateGeneratorBuildInput(input: unknown): unknown {
  const legacy = LegacyGeneratorBuildSchema.safeParse(input);
  if (!legacy.success) return input;
  return { ...legacy.data, provenanceVersion: 1, headCommitSha: legacy.data.commitSha,
    worktreeDirty: null, generationInputsDirty: null, generationContractSha256: null, runtimeGenerationConfigSha256: null };
}

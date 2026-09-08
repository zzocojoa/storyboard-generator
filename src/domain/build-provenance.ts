import { z } from 'zod';
import { GeneratorBuildProvenanceSchema } from './schema.js';

const LegacyGeneratorBuildSchema = GeneratorBuildProvenanceSchema.pick({ commitSha: true, appVersion: true, projectSchemaVersion: true, builtAt: true, sourceTreeSha256: true });
const LegacyAvailabilitySchema = GeneratorBuildProvenanceSchema.omit({ gitStateAvailable: true }).extend({ provenanceVersion: z.union([z.literal(1), z.literal(2)]) });

/** 과거 Build의 명시적 값만 복사하고 기록되지 않은 Hash와 Dirty 상태는 null로 남긴다. */
export function migrateGeneratorBuildInput(input: unknown): unknown {
  const unavailable = LegacyAvailabilitySchema.safeParse(input);
  if (unavailable.success) return { ...unavailable.data, gitStateAvailable: null };
  const legacy = LegacyGeneratorBuildSchema.safeParse(input);
  if (!legacy.success) return input;
  return { ...legacy.data, provenanceVersion: 1, gitStateAvailable: null, headCommitSha: legacy.data.commitSha,
    worktreeDirty: null, generationInputsDirty: null, generationContractSha256: null, runtimeGenerationConfigSha256: null };
}

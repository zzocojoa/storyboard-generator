import { z } from 'zod';
import { GeneratorBuildProvenanceSchema } from './domain/schema.js';

export const BuildManifestSchema = GeneratorBuildProvenanceSchema.extend({
  provenanceVersion: z.literal(2), worktreeDirty: z.boolean(), generationInputsDirty: z.boolean(),
  sourceTreeSha256: z.string().regex(/^[a-f0-9]{64}$/u), generationContractSha256: z.string().regex(/^[a-f0-9]{64}$/u),
  runtimeGenerationConfigSha256: z.string().regex(/^[a-f0-9]{64}$/u), builtAt: z.iso.datetime(),
  journalVersion: z.literal(3), lockVersion: z.literal(3), registryVersion: z.literal(1),
});
export type BuildManifest = z.infer<typeof BuildManifestSchema>;

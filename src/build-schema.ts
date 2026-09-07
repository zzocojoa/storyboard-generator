import { z } from 'zod';
import { GeneratorBuildProvenanceSchema } from './domain/schema.js';

export const BuildManifestSchema = GeneratorBuildProvenanceSchema.extend({
  journalVersion: z.literal(3), lockVersion: z.literal(3), registryVersion: z.literal(1),
});
export type BuildManifest = z.infer<typeof BuildManifestSchema>;

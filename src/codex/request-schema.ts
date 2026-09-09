import { z } from 'zod';
import { migrateGeneratorBuildInput } from '../domain/build-provenance.js';
import { GeneratorBuildProvenanceSchema } from '../domain/schema.js';
import { ApplyIntentSchema } from './apply-schema.js';
import { REQUEST_SCHEMA_VERSION } from './storage-contract.js';

export const CodexRequestKindSchema = z.enum(['proposal', 'image', 'speech']);
export const CodexRequestStatusSchema = z.enum(['pending', 'applying', 'completed', 'failed', 'superseded']);
export const CodexRequestSchema = z.strictObject({
  schemaVersion: z.literal(REQUEST_SCHEMA_VERSION).optional(),
  id: z.uuid(), kind: CodexRequestKindSchema, projectId: z.string().min(1), targetId: z.string().min(1),
  generatorBuild: z.preprocess(migrateGeneratorBuildInput, GeneratorBuildProvenanceSchema.nullable().optional()),
  basisHash: z.string().regex(/^[a-f0-9]{64}$/u), status: CodexRequestStatusSchema,
  createdAt: z.iso.datetime(), updatedAt: z.iso.datetime(), resultRevision: z.number().int().nonnegative().nullable(),
  error: z.strictObject({ code: z.string().min(1), message: z.string().min(1) }).nullable(),
  applyIntent: ApplyIntentSchema.optional(),
});

export type CodexRequestKind = z.infer<typeof CodexRequestKindSchema>;
export type CodexRequestStatus = z.infer<typeof CodexRequestStatusSchema>;
export type CodexRequest = z.infer<typeof CodexRequestSchema>;

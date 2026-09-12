import { z } from 'zod';
import { HashSchema, IdSchema } from '../domain/schema.js';

export const AutomaticApplicationIdentitySchema = z.strictObject({
  id: z.uuid(), runId: z.uuid(), jobId: z.uuid(), settingsHash: HashSchema,
});
export const AutomaticApplicationSchema = AutomaticApplicationIdentitySchema.extend({
  version: z.literal(1), projectId: IdSchema, createdAt: z.iso.datetime(),
  basisRevision: z.number().int().nonnegative(), basisProjectHash: HashSchema,
  candidateProjectHash: HashSchema,
  records: z.array(z.strictObject({ id: IdSchema, hash: HashSchema })).min(1),
  assets: z.array(z.strictObject({ id: IdSchema, relativePath: z.string().min(1), hash: HashSchema, size: z.number().int().positive() })),
});
export const AutomaticApplyIntentSchema = z.strictObject({ version: z.literal(1), applicationId: z.uuid(), applicationHash: HashSchema, startedAt: z.iso.datetime() });
export const AutomaticApplyReceiptSchema = z.strictObject({ version: z.literal(1), applicationId: z.uuid(), applicationHash: HashSchema,
  projectId: IdSchema, committedRevision: z.number().int().positive(), resultProjectHash: HashSchema });
export type AutomaticApplicationIdentity = z.infer<typeof AutomaticApplicationIdentitySchema>;
export type AutomaticApplication = z.infer<typeof AutomaticApplicationSchema>;
export type AutomaticApplyIntent = z.infer<typeof AutomaticApplyIntentSchema>;
export type AutomaticApplyReceipt = z.infer<typeof AutomaticApplyReceiptSchema>;

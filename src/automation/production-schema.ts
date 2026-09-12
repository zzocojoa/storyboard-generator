import { z } from 'zod';
import { HashSchema, IdSchema, ProductionResourceSchema, ProfileSchema } from '../domain/schema.js';

export const ProductionPlanBasisSchema = z.strictObject({
  projectId: IdSchema, revision: z.number().int().nonnegative(), projectHash: HashSchema,
  segmentIds: z.array(IdSchema).min(1).max(4096),
});
export const AutomaticProductionResourceSchema = ProductionResourceSchema.omit({ id: true, generationId: true }).extend({ key: IdSchema.max(80) });
export const AutomaticProductionPlanSchema = z.strictObject({
  schemaVersion: z.literal('1.0.0'),
  profile: ProfileSchema.extend({ medium: z.enum(['live-action', 'ai', 'hybrid']), visualStyle: z.string().trim().min(1).max(4000) }),
  profileReason: z.string().trim().min(1).max(4000),
  resources: z.array(AutomaticProductionResourceSchema).max(256),
  segments: z.array(z.strictObject({
    segmentId: IdSchema, resourceKeys: z.array(IdSchema).max(128), locationResourceKey: IdSchema.nullable(),
    continuityGroup: z.string().trim().min(1).max(200), entryState: z.string().max(4000), exitState: z.string().max(4000),
    reason: z.string().trim().min(1).max(4000),
  })).min(1).max(256),
});
export type ProductionPlanBasis = z.infer<typeof ProductionPlanBasisSchema>;
export type AutomaticProductionPlan = z.infer<typeof AutomaticProductionPlanSchema>;

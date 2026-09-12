import { z } from 'zod';
import { HashSchema, IdSchema, PropContinuitySchema } from '../domain/schema.js';

export const ReferenceRetakeInputSchema = z.strictObject({ resourceId: IdSchema, propContinuity: PropContinuitySchema.optional() });
export const ReferenceRetakeIntentSchema = ReferenceRetakeInputSchema.extend({
  kind: z.literal('reference-retake'), previousAssetId: IdSchema, sourceHash: HashSchema,
});
export type ReferenceRetakeInput = z.infer<typeof ReferenceRetakeInputSchema>;
export type ReferenceRetakeIntent = z.infer<typeof ReferenceRetakeIntentSchema>;

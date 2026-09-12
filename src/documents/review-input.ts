import { z } from 'zod';
import { HashSchema } from '../domain/schema.js';
import { DocumentBindingsSchema } from './schema.js';
import { IdentityEvidenceSchema } from './identity-schema.js';
import { ProductionFieldsSchema, ProductionPresetSchema } from './review-model.js';

export const DocumentReviewInputSchema = z.strictObject({ directory: z.string().min(1), sourceFingerprint: HashSchema,
  bindings: DocumentBindingsSchema, production: ProductionFieldsSchema, presetId: z.uuid().nullable(), identityEvidence: IdentityEvidenceSchema.optional() });
export type DocumentReviewInput = z.infer<typeof DocumentReviewInputSchema>;
export const StoredReviewInputSchema = z.strictObject({ input: DocumentReviewInputSchema, preset: ProductionPresetSchema.nullable() });
export type StoredReviewInput = z.infer<typeof StoredReviewInputSchema>;

import { z } from 'zod';
import { HashSchema } from '../domain/schema.js';

export const ProductionFieldSchema = z.enum(['fps', 'sampleRate', 'width', 'height', 'startTimecode']);
export type ProductionField = z.infer<typeof ProductionFieldSchema>;
export const ProductionFieldsSchema = z.strictObject({ fps: z.string(), sampleRate: z.string(), width: z.string(), height: z.string(), startTimecode: z.string() });
export type ProductionFields = z.infer<typeof ProductionFieldsSchema>;
export const ReviewFieldSchema = z.enum(['people', 'scenes', 'units', 'production']);
export const ReviewEvidenceSchema = z.strictObject({ fileId: z.string().min(1), locator: z.string().min(1), quote: z.string().min(1).max(4000) });
export const ReviewSuggestionSchema = z.strictObject({
  field: ReviewFieldSchema, key: z.string().min(1), value: z.string().min(1).nullable(),
  origin: z.enum(['document', 'inference', 'recommendation', 'unresolved']), reason: z.string().min(1).max(4000),
  evidence: z.array(ReviewEvidenceSchema).max(12),
});
export type ReviewSuggestion = z.infer<typeof ReviewSuggestionSchema>;
export type ReviewEvidence = z.infer<typeof ReviewEvidenceSchema>;
export const DocumentReviewResultSchema = z.strictObject({ summary: z.string().min(1).max(4000), suggestions: z.array(ReviewSuggestionSchema).max(2000) });
export type DocumentReviewResult = z.infer<typeof DocumentReviewResultSchema>;
export const ProductionPresetSchema = z.strictObject({ id: z.uuid(), name: z.string().trim().min(1).max(100), fields: ProductionFieldsSchema, createdAt: z.iso.datetime() });
export type ProductionPreset = z.infer<typeof ProductionPresetSchema>;
export const ReviewAuditEntrySchema = z.strictObject({
  field: ReviewFieldSchema, key: z.string().min(1), value: z.string().min(1),
  origin: z.enum(['document', 'inference', 'recommendation', 'preset', 'user']), reason: z.string().min(1).max(4000),
  evidence: z.array(ReviewEvidenceSchema).max(12), confirmed: z.boolean(), reviewId: z.uuid().nullable(), model: z.string().min(1).nullable(),
});
export type ReviewAuditEntry = z.infer<typeof ReviewAuditEntrySchema>;
export const ReviewAuditSchema = z.strictObject({ sourceFingerprint: HashSchema, preset: ProductionPresetSchema.nullable(), entries: z.array(ReviewAuditEntrySchema).max(3000) });
export type ReviewAudit = z.infer<typeof ReviewAuditSchema>;
export const ReviewStateSchema = z.strictObject({
  id: z.uuid(), basisHash: HashSchema, sourceFingerprint: HashSchema, createdAt: z.iso.datetime(), updatedAt: z.iso.datetime(),
  status: z.enum(['running', 'completed', 'failed', 'cancelled', 'stale']),
  model: z.string().nullable(), result: DocumentReviewResultSchema.nullable(),
  error: z.strictObject({ code: z.string(), message: z.string() }).nullable(),
});
export type ReviewState = z.infer<typeof ReviewStateSchema>;
export const ReviewRuntimeStatusSchema = z.strictObject({ configured: z.boolean(), activeRequestId: z.uuid().nullable() });
export type ReviewRuntimeStatus = z.infer<typeof ReviewRuntimeStatusSchema>;

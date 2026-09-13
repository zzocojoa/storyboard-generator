import { z } from 'zod';
import { HashSchema, IdSchema } from '../domain/schema.js';
import type { DocumentBindings } from './schema.js';

export const IDENTITY_FILE_MAX_BYTES: number = 256 * 1024;
const IdentitySnapshotSchema = z.strictObject({ sha256: HashSchema, content: z.string().min(1).max(IDENTITY_FILE_MAX_BYTES) });
export const IdentityEvidenceSchema = z.strictObject({
  format: z.literal('production-characters-v1'), projectId: IdSchema, sourceFingerprint: HashSchema,
  characters: IdentitySnapshotSchema, footprint: IdentitySnapshotSchema,
});
export type IdentityEvidence = z.infer<typeof IdentityEvidenceSchema>;
export const IdentityMatchSchema = z.strictObject({ name: z.string().min(1), targetId: IdSchema, currentId: IdSchema.nullable(), locator: z.string().min(1) });
export type IdentityMatch = z.infer<typeof IdentityMatchSchema>;
export const IdentityPreviewSchema = z.strictObject({ evidence: IdentityEvidenceSchema, matches: z.array(IdentityMatchSchema).min(1) });
export type IdentityPreview = z.infer<typeof IdentityPreviewSchema>;
export const SavedIdentityPreviewSchema = IdentityPreviewSchema.extend({ reviewId: z.uuid() });
export type SavedIdentityPreview = z.infer<typeof SavedIdentityPreviewSchema>;
export type IdentityBasis = { directory: string; sourceFingerprint: string; bindings: DocumentBindings };

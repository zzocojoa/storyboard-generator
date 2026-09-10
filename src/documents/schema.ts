import { z } from 'zod';
import { HashSchema, IdSchema, ProfileSchema, SourceRefSchema, TimebaseSchema } from '../domain/schema.js';
import type { Snapshot, SourceRef, SourceUnit } from '../domain/schema.js';
import { ReviewAuditSchema } from './review-model.js';

export const DOCUMENT_FILES = [
  { key: 'broadcast', name: 'broadcast_readable_script.md', role: 'readable' },
  { key: 'reenactment', name: 'reenactment_character_script.md', role: 'readable' },
  { key: 'edit', name: 'edit_script.md', role: 'edit' },
  { key: 'shooting', name: 'shooting_script.md', role: 'shooting' },
  { key: 'narration', name: 'narration.md', role: 'readable' },
  { key: 'panel', name: 'panel_reaction_script.md', role: 'readable' },
  { key: 'subtitles', name: 'subtitle_script.md', role: 'subtitles' },
  { key: 'manifest', name: 'production_manifest.json', role: 'manifest' },
] as const;
export type DocumentKey = typeof DOCUMENT_FILES[number]['key'];
export type DocumentSources = Record<DocumentKey, Snapshot>;
const BindingSchema = z.strictObject({ key: z.string().min(1), targetId: IdSchema });
export const DocumentBindingsSchema = z.strictObject({
  people: z.array(BindingSchema), scenes: z.array(BindingSchema), units: z.array(BindingSchema),
});
export const DocumentSettingsSchema = z.strictObject({
  formatVersion: z.enum(['1.0.0', '1.1.0']), sourceFingerprint: HashSchema,
  packageVersion: z.string().min(1), timebase: TimebaseSchema, profile: ProfileSchema,
  bindings: DocumentBindingsSchema,
  reviewAudit: ReviewAuditSchema.optional(),
});
export type DocumentBindings = z.infer<typeof DocumentBindingsSchema>;
export type DocumentSettings = z.infer<typeof DocumentSettingsSchema>;
export const MappingChoiceSchema = z.strictObject({
  key: z.string(), label: z.string(), candidates: z.array(IdSchema), selected: IdSchema.nullable(), sourceRefs: z.array(SourceRefSchema),
});
export type MappingChoice = z.infer<typeof MappingChoiceSchema>;
export const CandidateEvidenceSchema = z.strictObject({
  field: z.enum(['people', 'scenes', 'units']), targetId: IdSchema, description: z.string(), sourceRefs: z.array(SourceRefSchema),
});
export type CandidateEvidence = z.infer<typeof CandidateEvidenceSchema>;
export const DocumentPreviewSchema = z.strictObject({
  format: z.literal('production-documents-v1'), projectId: IdSchema, title: z.string(), sourceFingerprint: HashSchema,
  scenes: z.array(MappingChoiceSchema), people: z.array(MappingChoiceSchema), units: z.array(MappingChoiceSchema),
  counts: z.strictObject({ scenes: z.number(), segments: z.number(), units: z.number(), narration: z.number(), panel: z.number() }),
  notices: z.array(z.string()),
  candidateEvidence: z.array(CandidateEvidenceSchema),
});
export type DocumentPreview = z.infer<typeof DocumentPreviewSchema>;
export type DocumentPerson = { name: string; role: string; kind: 'character' | 'panel'; sourceRefs: SourceRef[] };
export type DocumentUnit = {
  id: string; sceneTitle: string; kind: SourceUnit['kind']; speakerName: string | null; text: string; sourceRefs: SourceRef[];
};
export type DocumentScene = { title: string; sourceRefs: SourceRef[]; metadata: { key: string; text: string; sourceRefs: SourceRef[] }[] };
export type ReadableDocument = { title: string; people: DocumentPerson[]; scenes: DocumentScene[]; units: DocumentUnit[] };

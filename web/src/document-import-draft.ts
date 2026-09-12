import { z } from 'zod';
import { DocumentBindingsSchema, DocumentPreviewSchema, DocumentSettingsSchema } from '../../src/documents/schema.js';
import { IdentityEvidenceSchema } from '../../src/documents/identity-schema.js';
import { ProductionFieldsSchema, ProductionPresetSchema, ReviewAuditEntrySchema } from '../../src/documents/review-model.js';
import { stableJsonStringify } from '../../src/io/stable-json.js';

const DraftBindingSchema = DocumentBindingsSchema.shape.people.element.extend({ targetId: z.string() });
const ContentKeySchema = z.string().transform((value, context): string => {
  try { return stableJsonStringify(JSON.parse(value) as unknown); }
  catch { context.addIssue({ code: 'custom', message: '보관한 패키지 입력 기준이 올바른 JSON이 아닙니다.' }); return z.NEVER; }
});
const CreatedPackageSchema = z.strictObject({ handoffPath: z.string(), output: z.string(), version: z.string(), contentKey: ContentKeySchema });
export const DocumentImportDraftSchema = z.strictObject({
  step: z.union([z.literal(1), z.literal(2), z.literal(3)]), furthestStep: z.union([z.literal(1), z.literal(2), z.literal(3)]),
  flowId: z.uuid().nullable(), directory: z.string(), output: z.string(), preview: DocumentPreviewSchema.nullable(), automaticPreview: DocumentPreviewSchema.nullable(),
  bindings: z.strictObject({ people: z.array(DraftBindingSchema), scenes: z.array(DraftBindingSchema), units: z.array(DraftBindingSchema) }),
  production: ProductionFieldsSchema, reviewEntries: z.array(ReviewAuditEntrySchema), identityEvidence: IdentityEvidenceSchema.nullable(),
  preset: ProductionPresetSchema.nullable(), version: z.string(), hold: z.string(), storyboardName: z.string(), createdPackages: z.array(CreatedPackageSchema),
  packageAttempts: z.array(z.strictObject({ directory: z.string(), output: z.string(), settings: DocumentSettingsSchema, contentKey: ContentKeySchema, title: z.string() })),
});
export type DocumentImportDraft = z.infer<typeof DocumentImportDraftSchema>;
export const EMPTY_DOCUMENT_IMPORT: DocumentImportDraft = {
  step: 1, furthestStep: 1, flowId: null, directory: '', output: '', preview: null, automaticPreview: null,
  bindings: { people: [], scenes: [], units: [] },
  production: { fps: '', sampleRate: '', width: '', height: '', startTimecode: '00:00:00:00' },
  reviewEntries: [], identityEvidence: null, preset: null, version: '', hold: '', storyboardName: '', createdPackages: [], packageAttempts: [],
};

export const IndependentStoryboardDraftSchema = z.strictObject({ flowId: z.uuid().nullable(), path: z.string(), name: z.string(), hold: z.string() });
export type IndependentStoryboardDraft = z.infer<typeof IndependentStoryboardDraftSchema>;
export const EMPTY_STORYBOARD_DRAFT: IndependentStoryboardDraft = { flowId: null, path: '', name: '', hold: '' };

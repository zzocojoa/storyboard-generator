import { z } from 'zod';

export const IdSchema = z.string().min(1).max(160).regex(/^[^\u0000-\u001f]+$/u);
export const MillisecondsSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const HashSchema = z.string().regex(/^[a-f0-9]{64}$/u);
export const SourceRefSchema = z.strictObject({
  fileId: IdSchema, locator: z.string().min(1), originalId: IdSchema.nullable(),
});
export const TimebaseSchema = z.strictObject({
  fpsNumerator: z.number().int().positive().max(120000),
  fpsDenominator: z.number().int().positive().max(1001),
  dropFrame: z.boolean(), sampleRate: z.literal([44100, 48000, 96000]),
  startTimecode: z.string().regex(/^\d{2}:\d{2}:\d{2}[:;]\d{2}$/u),
});
export const ProfileSchema = z.strictObject({
  medium: z.enum(['unspecified', 'live-action', 'ai', 'hybrid']),
  aspectWidth: z.number().int().positive().max(16384),
  aspectHeight: z.number().int().positive().max(16384),
  visualStyle: z.string().nullable(),
});
export const FileRoleSchema = z.enum([
  'native-data', 'presentation', 'screenplay', 'reactions', 'characters', 'panel-cast',
  'scene-cards', 'shooting', 'edit', 'subtitles', 'readable', 'manifest', 'footprint', 'reference',
]);
export const FileDescriptorSchema = z.strictObject({
  id: IdSchema, role: FileRoleSchema, path: z.string().min(1), required: z.boolean(),
  hashMode: z.enum(['bytes-sha256', 'sorted-json-sha256']), sha256: HashSchema,
});
export const AuthoritySchema = z.strictObject({
  field: z.enum(['timeline', 'units', 'people', 'scenes', 'screen-text', 'panel-turns']),
  fileIds: z.array(IdSchema).min(1),
});
export const HandoffSchema = z.strictObject({
  contractVersion: z.literal('1.0.0'), adapter: z.enum(['native-v1', 'production-v1']),
  projectId: IdSchema, packageVersion: z.string().min(1), upstreamRevision: z.string().nullable(),
  timebase: TimebaseSchema, profile: ProfileSchema,
  files: z.array(FileDescriptorSchema).min(1), authority: z.array(AuthoritySchema).min(1),
});
export const PackageFileSchema = z.strictObject({ path: z.string().min(1), content: z.string() });
export const PackagePayloadSchema = z.strictObject({ handoff: HandoffSchema, files: z.array(PackageFileSchema) });
export const SnapshotSchema = FileDescriptorSchema.extend({ content: z.string() });
export const PersonSchema = z.strictObject({
  id: IdSchema, name: z.string().min(1), role: z.string(),
  kind: z.enum(['character', 'panel', 'presenter', 'narrator']), visualDescription: z.string().nullable(),
  sourceRefs: z.array(SourceRefSchema).min(1),
});
export const LocationSchema = z.strictObject({
  id: IdSchema, name: z.string().min(1), description: z.string(), sourceRefs: z.array(SourceRefSchema).min(1),
});
export const SceneSchema = z.strictObject({
  id: IdSchema, title: z.string().min(1), storyLocationId: IdSchema.nullable(),
  declaredCastIds: z.array(IdSchema), sourceRefs: z.array(SourceRefSchema).min(1),
});
export const SegmentSchema = z.strictObject({
  id: IdSchema, sceneId: IdSchema, mode: z.string().min(1),
  startMs: MillisecondsSchema, endMs: MillisecondsSchema, timingStatus: z.enum(['fixed', 'proposed']),
  reactionId: IdSchema.nullable(), sourceRefs: z.array(SourceRefSchema).min(1),
});
export const UnitKindSchema = z.enum(['ACTION', 'DIALOGUE', 'NARRATION', 'PANEL', 'SCREEN_TEXT', 'CHAT', 'NOTE', 'SOUND', 'MUSIC']);
export const UnitSchema = z.strictObject({
  id: IdSchema, segmentId: IdSchema, order: z.number().int().positive(), kind: UnitKindSchema,
  text: z.string().min(1), speakerId: IdSchema.nullable(), informationIds: z.array(IdSchema),
  sourceRefs: z.array(SourceRefSchema).min(1),
});
export const InformationRuleSchema = z.strictObject({
  id: IdSchema, segmentId: IdSchema, notBeforeMs: MillisecondsSchema,
  notBeforeUnitId: IdSchema.nullable(), notBeforeUnitOrder: z.number().int().positive().nullable(),
  precision: z.enum(['exact-time', 'unit-order', 'segment-start']), sourceRefs: z.array(SourceRefSchema).min(1),
});
export const InstructionSchema = z.strictObject({
  id: IdSchema, segmentId: IdSchema, kind: z.enum(['shooting', 'edit', 'music', 'ambience']),
  text: z.string().min(1), sourceRefs: z.array(SourceRefSchema).min(1),
});
export const TextPlacementSchema = z.strictObject({
  id: IdSchema, segmentId: IdSchema, startMs: MillisecondsSchema, endMs: MillisecondsSchema.nullable(),
  text: z.string().min(1), unitId: IdSchema.nullable(), sourceRefs: z.array(SourceRefSchema).min(1),
});
export const TextMappingDecisionSchema = z.strictObject({
  id: IdSchema, placementId: IdSchema, canonicalUnitId: IdSchema.nullable(),
  relation: z.enum(['exact', 'abbreviation', 'separate-element', 'replacement']),
  status: z.enum(['unresolved', 'confirmed']), renderCanonicalSeparately: z.boolean(),
  canonicalStartMs: MillisecondsSchema.nullable(), canonicalEndMs: MillisecondsSchema.nullable(),
  note: z.string().nullable(),
});
export const IssueSchema = z.strictObject({
  code: z.string().min(1), severity: z.enum(['error', 'conflict', 'warning']),
  entityId: z.string(), field: z.string(), message: z.string().min(1),
  expected: z.string().nullable(), actual: z.string().nullable(), sourceRefs: z.array(SourceRefSchema),
});
export const DatasetSchema = z.strictObject({
  projectId: IdSchema, title: z.string().min(1), people: z.array(PersonSchema), locations: z.array(LocationSchema),
  scenes: z.array(SceneSchema).min(1), segments: z.array(SegmentSchema).min(1), units: z.array(UnitSchema),
  informationRules: z.array(InformationRuleSchema), instructions: z.array(InstructionSchema),
  textPlacements: z.array(TextPlacementSchema),
});
export const NativeDatasetSchema = z.strictObject({
  schemaVersion: z.literal('1.0.0'), projectId: IdSchema, title: z.string().min(1),
  people: z.array(PersonSchema.omit({ sourceRefs: true })),
  locations: z.array(LocationSchema.omit({ sourceRefs: true })),
  scenes: z.array(SceneSchema.omit({ sourceRefs: true })).min(1),
  segments: z.array(SegmentSchema.omit({ sourceRefs: true })).min(1),
  units: z.array(UnitSchema.omit({ sourceRefs: true })),
  informationRules: z.array(z.strictObject({
    id: IdSchema, notBeforeMs: MillisecondsSchema, segmentId: IdSchema.optional(),
    notBeforeUnitId: IdSchema.nullable().optional(), notBeforeUnitOrder: z.number().int().positive().nullable().optional(),
    precision: z.enum(['exact-time', 'unit-order', 'segment-start']).optional(),
  })),
  instructions: z.array(InstructionSchema.omit({ sourceRefs: true })),
  textPlacements: z.array(TextPlacementSchema.omit({ sourceRefs: true })),
});
export const PresenceSchema = z.strictObject({
  personId: IdSchema,
  mode: z.enum(['VISIBLE', 'HAND_ONLY', 'SILHOUETTE', 'OFFSCREEN_VOICE', 'VOICE_OVER', 'IMPLIED', 'ARCHIVE_IMAGE']),
});
export const ContinuitySchema = z.strictObject({ assetId: IdSchema, state: z.string().min(1) });
export const TransitionSchema = z.strictObject({
  kind: z.enum(['cut', 'dissolve', 'fade', 'wipe', 'match-cut', 'custom']),
  durationMs: MillisecondsSchema,
  note: z.string(),
});
export const LockedFieldSchema = z.enum(['timing', 'sources', 'action', 'camera', 'location', 'presence', 'continuity', 'transition', 'frames']);
export const ShotSourceLinkSchema = z.strictObject({
  unitId: IdSchema,
  usage: z.enum(['primary-visual', 'continued-visual', 'audio-only', 'context-only']),
  status: z.enum(['confirmed', 'mapping-required']),
});
export const ShotSchema = z.strictObject({
  id: IdSchema, segmentId: IdSchema, startMs: MillisecondsSchema, endMs: MillisecondsSchema,
  sourceLinks: z.array(ShotSourceLinkSchema), visualLocationId: IdSchema.nullable(), action: z.string(),
  camera: z.strictObject({ size: z.string(), angle: z.string(), move: z.string() }),
  presence: z.array(PresenceSchema), propIds: z.array(IdSchema),
  continuityBefore: z.array(ContinuitySchema), continuityAfter: z.array(ContinuitySchema),
  cameraAxis: z.string().nullable(), screenDirection: z.string().nullable(), informationIds: z.array(IdSchema),
  transitionOut: TransitionSchema,
  proposalOrigin: z.enum(['manual', 'source-outline', 'model']), approvalStatus: z.enum(['proposed', 'approved']),
  lockedFields: z.array(LockedFieldSchema),
});
export const ShotContentSchema = ShotSchema.pick({ action: true, camera: true, visualLocationId: true, presence: true, propIds: true, continuityBefore: true, continuityAfter: true, cameraAxis: true, screenDirection: true, informationIds: true, transitionOut: true });
export const FrameSchema = z.strictObject({
  id: IdSchema, shotId: IdSchema, offsetMs: MillisecondsSchema, role: z.enum(['start', 'end', 'key']),
  description: z.string(), imageAssetId: IdSchema.nullable(), visualReview: z.enum(['pending', 'accepted', 'rejected']),
});
export const AudioCueSchema = z.strictObject({
  id: IdSchema, unitId: IdSchema, kind: z.enum(['dialogue', 'voiceover', 'panel', 'sfx', 'music']),
  startMs: MillisecondsSchema, endMs: MillisecondsSchema, timingStatus: z.enum(['proposed', 'measured']),
  assetId: IdSchema.nullable(),
});
export const TextCueSchema = z.strictObject({
  id: IdSchema, segmentId: IdSchema, unitId: IdSchema.nullable(), placementId: IdSchema.nullable(),
  text: z.string(), startMs: MillisecondsSchema, endMs: MillisecondsSchema,
  kind: z.enum(['overlay', 'prop-text', 'dialogue-subtitle']), timingStatus: z.enum(['proposed', 'confirmed']),
});
export const AssetSchema = z.strictObject({
  id: IdSchema, kind: z.enum(['image', 'audio', 'character', 'location', 'prop']),
  subjectId: IdSchema.nullable(), path: z.string(), mimeType: z.string().min(1), sha256: HashSchema, description: z.string(),
  durationMs: MillisecondsSchema.nullable(), version: z.number().int().positive(),
});
export const GenerationSchema = z.strictObject({
  id: IdSchema, provider: z.string(), model: z.string(), modelVersion: z.string().nullable(),
  requestId: z.string().nullable(), prompt: z.string(), templateVersion: z.string(), seed: z.number().int().nullable(),
  referenceHashes: z.array(HashSchema), resultAssetIds: z.array(IdSchema), shotIds: z.array(IdSchema), createdAt: z.iso.datetime(),
});
export const ProjectSchema = z.strictObject({
  schemaVersion: z.literal('1.2.0'), projectId: IdSchema, title: z.string().min(1), revision: z.number().int().nonnegative(),
  profile: ProfileSchema,
  handoff: HandoffSchema, sources: z.array(SnapshotSchema), dataset: DatasetSchema, importIssues: z.array(IssueSchema),
  textMappingDecisions: z.array(TextMappingDecisionSchema),
  shots: z.array(ShotSchema), frames: z.array(FrameSchema), audioCues: z.array(AudioCueSchema), textCues: z.array(TextCueSchema),
  assets: z.array(AssetSchema), generationRecords: z.array(GenerationSchema),
});

export type SourceRef = z.infer<typeof SourceRefSchema>;
export type Timebase = z.infer<typeof TimebaseSchema>;
export type Profile = z.infer<typeof ProfileSchema>;
export type FileRole = z.infer<typeof FileRoleSchema>;
export type FileDescriptor = z.infer<typeof FileDescriptorSchema>;
export type Handoff = z.infer<typeof HandoffSchema>;
export type PackageFile = z.infer<typeof PackageFileSchema>;
export type PackagePayload = z.infer<typeof PackagePayloadSchema>;
export type Snapshot = z.infer<typeof SnapshotSchema>;
export type Person = z.infer<typeof PersonSchema>;
export type Location = z.infer<typeof LocationSchema>;
export type Scene = z.infer<typeof SceneSchema>;
export type Segment = z.infer<typeof SegmentSchema>;
export type SourceUnit = z.infer<typeof UnitSchema>;
export type InformationRule = z.infer<typeof InformationRuleSchema>;
export type Instruction = z.infer<typeof InstructionSchema>;
export type TextPlacement = z.infer<typeof TextPlacementSchema>;
export type TextMappingDecision = z.infer<typeof TextMappingDecisionSchema>;
export type Issue = z.infer<typeof IssueSchema>;
export type Dataset = z.infer<typeof DatasetSchema>;
export type NativeDataset = z.infer<typeof NativeDatasetSchema>;
export type Transition = z.infer<typeof TransitionSchema>;
export type Shot = z.infer<typeof ShotSchema>;
export type ShotSourceLink = z.infer<typeof ShotSourceLinkSchema>;
export type ShotContent = z.infer<typeof ShotContentSchema>;
export type LockedField = z.infer<typeof LockedFieldSchema>;
export type StoryboardFrame = z.infer<typeof FrameSchema>;
export type AudioCue = z.infer<typeof AudioCueSchema>;
export type TextCue = z.infer<typeof TextCueSchema>;
export type Asset = z.infer<typeof AssetSchema>;
export type GenerationRecord = z.infer<typeof GenerationSchema>;
export type Project = z.infer<typeof ProjectSchema>;

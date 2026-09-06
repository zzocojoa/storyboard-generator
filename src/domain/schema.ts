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
  id: IdSchema, segmentId: IdSchema, baseNotBeforeMs: MillisecondsSchema,
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
const TextMappingDecisionFieldsSchema = z.strictObject({
  id: IdSchema, placementId: IdSchema, canonicalUnitId: IdSchema.nullable(),
  relation: z.enum(['exact', 'abbreviation', 'separate-element', 'replacement', 'standalone-placement']),
  status: z.enum(['unresolved', 'confirmed']), renderCanonicalSeparately: z.boolean(),
  canonicalStartMs: MillisecondsSchema.nullable(), canonicalEndMs: MillisecondsSchema.nullable(),
  note: z.string().nullable(),
});
export const TextMappingDecisionSchema = TextMappingDecisionFieldsSchema.superRefine((decision, context): void => {
  const hasCanonical: boolean = decision.canonicalUnitId !== null;
  const hasStart: boolean = decision.canonicalStartMs !== null;
  const hasEnd: boolean = decision.canonicalEndMs !== null;
  const hasValidRange: boolean = hasStart && hasEnd && (decision.canonicalEndMs as number) > (decision.canonicalStartMs as number);
  const addIssue = (message: string, path: string): void => context.addIssue({ code: 'custom', message, path: [path] });
  if (decision.relation === 'standalone-placement') {
    if (hasCanonical) addIssue('독립 Placement는 Canonical Unit을 가질 수 없습니다.', 'canonicalUnitId');
    if (decision.renderCanonicalSeparately) addIssue('독립 Placement는 Canonical 문구를 별도로 렌더링할 수 없습니다.', 'renderCanonicalSeparately');
    if (hasStart || hasEnd) addIssue('독립 Placement는 Canonical 시각을 가질 수 없습니다.', 'canonicalStartMs');
    return;
  }
  if (!hasCanonical) addIssue(`${decision.relation} 관계에는 Canonical Unit이 필요합니다.`, 'canonicalUnitId');
  if (decision.relation === 'exact') {
    if (decision.renderCanonicalSeparately) addIssue('정확 일치 관계는 Canonical 문구를 중복 렌더링할 수 없습니다.', 'renderCanonicalSeparately');
    if (hasStart || hasEnd) addIssue('정확 일치 관계는 별도 Canonical 시각을 가질 수 없습니다.', 'canonicalStartMs');
    return;
  }
  if (decision.relation === 'separate-element') {
    if (!decision.renderCanonicalSeparately) addIssue('별도 요소 관계는 Canonical 문구를 별도로 렌더링해야 합니다.', 'renderCanonicalSeparately');
    if (!hasValidRange) addIssue('별도 요소 관계에는 올바른 Canonical 시작·종료 시각이 필요합니다.', 'canonicalStartMs');
    return;
  }
  if (decision.renderCanonicalSeparately && !hasValidRange) addIssue('Canonical 문구를 별도로 렌더링하려면 올바른 시작·종료 시각이 필요합니다.', 'canonicalStartMs');
  if (!decision.renderCanonicalSeparately && (hasStart || hasEnd)) addIssue('별도 렌더링을 사용하지 않으면 Canonical 시각은 비워야 합니다.', 'canonicalStartMs');
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
export const SourceAnchorBasisSchema = z.enum(['manual', 'text-cue', 'audio-cue', 'proposal', 'native-exact', 'estimated', 'migration', 'mapping-change', 'source-move', 'audio-change', 'frame-change']);
export const SourceTemporalAnchorSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('shot-offset'), startOffsetMs: MillisecondsSchema, endOffsetMs: MillisecondsSchema,
    basis: z.enum(['manual', 'text-cue', 'audio-cue', 'proposal', 'native-exact']), status: z.literal('confirmed'),
  }).refine((anchor): boolean => anchor.endOffsetMs > anchor.startOffsetMs, { message: 'Source Anchor 종료 시각은 시작 시각보다 늦어야 합니다.', path: ['endOffsetMs'] }),
  z.strictObject({
    kind: z.literal('frame'), frameId: IdSchema, basis: z.enum(['manual', 'proposal']), status: z.literal('confirmed'),
  }),
  z.strictObject({
    kind: z.literal('unresolved'), basis: z.enum(['estimated', 'migration', 'mapping-change', 'source-move', 'audio-change', 'frame-change']), status: z.literal('review-required'),
  }),
]);
export const ShotSourceLinkSchema = z.strictObject({
  unitId: IdSchema,
  usage: z.enum(['primary-visual', 'continued-visual', 'audio-only', 'context-only']),
  status: z.enum(['confirmed', 'mapping-required']),
  temporalAnchor: SourceTemporalAnchorSchema,
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
export const AudioTimingRelationSchema = z.enum(['within-segment', 'j-cut', 'l-cut']);
export const AudioCueSchema = z.strictObject({
  id: IdSchema, unitId: IdSchema, kind: z.enum(['dialogue', 'voiceover', 'panel', 'sfx', 'music']),
  startMs: MillisecondsSchema, endMs: MillisecondsSchema, timingStatus: z.enum(['proposed', 'measured']),
  timingRelation: AudioTimingRelationSchema, assetId: IdSchema.nullable(),
});
export const TextCueAuthoritySchema = z.enum(['placement', 'mapping-decision', 'source-unit', 'review-required']);
const TextCueFieldsSchema = z.strictObject({
  id: IdSchema, segmentId: IdSchema, unitId: IdSchema.nullable(), placementId: IdSchema.nullable(),
  mappingDecisionId: IdSchema.nullable(), authority: TextCueAuthoritySchema,
  text: z.string(), startMs: MillisecondsSchema, endMs: MillisecondsSchema,
  kind: z.enum(['overlay', 'prop-text', 'dialogue-subtitle']), timingStatus: z.enum(['proposed', 'confirmed']),
});
export const TextCueSchema = TextCueFieldsSchema.superRefine((cue, context): void => {
  const addIssue = (message: string, path: string): void => context.addIssue({ code: 'custom', message, path: [path] });
  if (cue.authority === 'placement') {
    if (cue.placementId === null) addIssue('Placement 권한 Cue에는 placementId가 필요합니다.', 'placementId');
    if (cue.mappingDecisionId !== null) addIssue('Placement 권한 Cue는 mappingDecisionId를 저장하지 않습니다.', 'mappingDecisionId');
  }
  if (cue.authority === 'mapping-decision') {
    if (cue.mappingDecisionId === null) addIssue('Mapping Decision 권한 Cue에는 mappingDecisionId가 필요합니다.', 'mappingDecisionId');
    if (cue.unitId === null) addIssue('Mapping Decision 권한 Cue에는 Canonical Unit이 필요합니다.', 'unitId');
    if (cue.placementId !== null) addIssue('Mapping Decision 권한 Cue는 Placement Cue와 분리되어야 합니다.', 'placementId');
  }
  if (cue.authority === 'source-unit') {
    if (cue.unitId === null) addIssue('Source Unit 권한 Cue에는 unitId가 필요합니다.', 'unitId');
    if (cue.placementId !== null || cue.mappingDecisionId !== null) addIssue('Source Unit 권한 Cue는 다른 시각 권한을 함께 저장하지 않습니다.', 'authority');
  }
  if (cue.authority === 'review-required' && cue.mappingDecisionId !== null) addIssue('검토 필요 Cue는 Mapping Decision 파생 Cue로 확정할 수 없습니다.', 'mappingDecisionId');
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
  schemaVersion: z.literal('1.4.0'), projectId: IdSchema, title: z.string().min(1), revision: z.number().int().nonnegative(),
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
export type SourceTemporalAnchor = z.infer<typeof SourceTemporalAnchorSchema>;
export type ShotContent = z.infer<typeof ShotContentSchema>;
export type LockedField = z.infer<typeof LockedFieldSchema>;
export type StoryboardFrame = z.infer<typeof FrameSchema>;
export type AudioTimingRelation = z.infer<typeof AudioTimingRelationSchema>;
export type AudioCue = z.infer<typeof AudioCueSchema>;
export type TextCueAuthority = z.infer<typeof TextCueAuthoritySchema>;
export type TextCue = z.infer<typeof TextCueSchema>;
export type Asset = z.infer<typeof AssetSchema>;
export type GenerationRecord = z.infer<typeof GenerationSchema>;
export type Project = z.infer<typeof ProjectSchema>;

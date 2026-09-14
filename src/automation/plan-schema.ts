import { z } from 'zod';
import { AudioTimingRelationSchema, ContinuitySchema, HashSchema, IdSchema, MillisecondsSchema, PresenceSchema, ShotVisualModeSchema, TransitionIncomingExposureSchema } from '../domain/schema.js';

const ExplanationSchema = z.string().trim().min(1).max(4000);
const DirectionSchema = z.string().max(8000);
export const AutomaticSourceSchema = z.strictObject({
  unitId: IdSchema, usage: z.enum(['primary-visual', 'continued-visual', 'audio-only', 'context-only']),
  startOffsetMs: MillisecondsSchema, endOffsetMs: MillisecondsSchema, reason: ExplanationSchema,
});
const AutomaticFrameSchema = z.strictObject({
  role: z.enum(['start', 'key', 'end']), offsetMs: MillisecondsSchema, description: ExplanationSchema,
});
export const AutomaticShotSchema = z.strictObject({
  startMs: MillisecondsSchema, endMs: MillisecondsSchema, visualMode: ShotVisualModeSchema,
  sourceLinks: z.array(AutomaticSourceSchema).max(256),
  visualLocationId: IdSchema.nullable(), action: DirectionSchema,
  camera: z.strictObject({ size: DirectionSchema, angle: DirectionSchema, move: DirectionSchema }),
  presence: z.array(PresenceSchema).max(64), propIds: z.array(IdSchema).max(64),
  continuityBefore: z.array(ContinuitySchema).max(64), continuityAfter: z.array(ContinuitySchema).max(64),
  cameraAxis: DirectionSchema.nullable(), screenDirection: DirectionSchema.nullable(),
  transitionOut: z.strictObject({ kind: z.enum(['cut', 'dissolve', 'fade', 'wipe', 'match-cut', 'custom']), durationMs: MillisecondsSchema, note: DirectionSchema, incomingExposure: TransitionIncomingExposureSchema }),
  frames: z.array(AutomaticFrameSchema).min(1).max(32), reason: ExplanationSchema,
});
const AutomaticMappingSchema = z.strictObject({
  decisionId: IdSchema, canonicalUnitId: IdSchema.nullable(),
  relation: z.enum(['exact', 'abbreviation', 'separate-element', 'replacement', 'standalone-placement']),
  renderCanonicalSeparately: z.boolean(), canonicalStartMs: MillisecondsSchema.nullable(), canonicalEndMs: MillisecondsSchema.nullable(),
  reason: ExplanationSchema,
});
const AutomaticPlacementInformationSchema = z.strictObject({
  placementId: IdSchema, status: z.enum(['non-informational', 'informational']),
  informationIds: z.array(IdSchema).max(256), reason: ExplanationSchema,
});
export const AutomaticTextTimingSchema = z.strictObject({
  authority: z.enum(['placement', 'mapping-decision', 'source-unit']), targetId: IdSchema,
  startMs: MillisecondsSchema, endMs: MillisecondsSchema, reason: ExplanationSchema,
});
export const AutomaticAudioTimingSchema = z.strictObject({ cueId: IdSchema, startMs: MillisecondsSchema, endMs: MillisecondsSchema, timingRelation: AudioTimingRelationSchema, reason: ExplanationSchema });
export const AutomaticSegmentPlanSchema = z.strictObject({
  schemaVersion: z.literal('1.0.0'), segmentId: IdSchema, summary: ExplanationSchema,
  shots: z.array(AutomaticShotSchema).min(1).max(64),
  mappings: z.array(AutomaticMappingSchema).max(256),
  placementInformation: z.array(AutomaticPlacementInformationSchema).max(256),
  textTimings: z.array(AutomaticTextTimingSchema).max(512),
  audioTimings: z.array(AutomaticAudioTimingSchema).max(256),
});
export const SegmentPlanBasisSchema = z.strictObject({
  projectId: IdSchema, revision: z.number().int().nonnegative(), projectHash: HashSchema,
  segmentId: IdSchema, replaceShotIds: z.array(IdSchema).max(256),
});
export type AutomaticSegmentPlan = z.infer<typeof AutomaticSegmentPlanSchema>;
export type AutomaticShot = z.infer<typeof AutomaticShotSchema>;
export type AutomaticSource = z.infer<typeof AutomaticSourceSchema>;
export type AutomaticTextTiming = z.infer<typeof AutomaticTextTimingSchema>;
export type SegmentPlanBasis = z.infer<typeof SegmentPlanBasisSchema>;

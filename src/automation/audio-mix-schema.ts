import { z } from 'zod';
import { AudioMixValuesSchema } from '../domain/audio-mix.js';
import { IdSchema } from '../domain/schema.js';

export const AutomaticAudioMixPlanSchema = z.strictObject({
  schemaVersion: z.literal('1.0.0'), segmentId: IdSchema, summary: z.string().trim().min(1).max(4000),
  cues: z.array(AudioMixValuesSchema.extend({ cueId: IdSchema, reason: z.string().trim().min(1).max(4000) })).min(1).max(256),
});
export type AutomaticAudioMixPlan = z.infer<typeof AutomaticAudioMixPlanSchema>;

import { SpeechPronunciationSchema } from '../domain/speech-pronunciation.js';
import { z } from 'zod';
import { HashSchema, IdSchema } from '../domain/schema.js';
import { SpeechVoiceSchema } from '../domain/speech-voice.js';

export const SpeechRetakeInputSchema = z.strictObject({
  cueId: IdSchema, voice: SpeechVoiceSchema, latestEndMs: z.number().int().positive(), pronunciation: SpeechPronunciationSchema.optional(),
});
export const SpeechRetakeIntentSchema = SpeechRetakeInputSchema.extend({
  kind: z.literal('speech-retake'), previousAssetId: IdSchema.nullable(), sourceHash: HashSchema,
});
export type SpeechRetakeInput = z.infer<typeof SpeechRetakeInputSchema>;
export type SpeechRetakeIntent = z.infer<typeof SpeechRetakeIntentSchema>;

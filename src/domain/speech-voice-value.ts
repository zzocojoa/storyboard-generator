import { z } from 'zod';

export const SpeechVoiceSchema = z.strictObject({ name: z.string().trim().min(1).max(200), rateWordsPerMinute: z.number().int().min(80).max(360) });
export type SpeechVoice = z.infer<typeof SpeechVoiceSchema>;

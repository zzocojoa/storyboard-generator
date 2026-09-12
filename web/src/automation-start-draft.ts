import { z } from 'zod';
import { CurrentAutomationSettingsSchema } from '../../src/automation/run-schema.js';
import { StoryboardDensitySchema } from '../../src/automation/density.js';

// 수정 중인 빈 음성과 범위 밖 숫자도 보관한다. 실행 직전에는 공통 실행 스키마를 적용한다.
export const AutomationStartSettingsSchema = CurrentAutomationSettingsSchema.extend({
  model: z.string().nullable(),
  voice: z.strictObject({ name: z.string(), rateWordsPerMinute: z.number() }),
  productionBatchSize: z.number(), maxModelCorrections: z.number(), maxFramesPerSegment: z.number(),
  maxAttemptsPerJob: z.number(), maxImageAttempts: z.number(), maxJobs: z.number(), maxStagedBytes: z.number(), maxActiveMs: z.number(),
  density: StoryboardDensitySchema.extend({ longHoldReviewMs: z.number() }).optional(),
  textLayoutPlanning: z.enum(['automatic', 'preserve']).optional(),
  speakerVoices: z.array(z.strictObject({ speakerId: z.string().nullable(), voice: z.strictObject({ name: z.string(), rateWordsPerMinute: z.number() }) })).optional(),
  audioMixPlanning: z.enum(['automatic', 'preserve']).optional(),
});
export const AutomationStartDraftSchema = z.strictObject({ settings: AutomationStartSettingsSchema, segments: z.array(z.string()) });
export type AutomationStartDraft = z.infer<typeof AutomationStartDraftSchema>;

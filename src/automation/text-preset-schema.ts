import { z } from 'zod';
import { TextLayoutPresetSchema } from '../domain/text-layout-settings.js';
import { TextTypographySchema } from '../domain/text-typography.js';
import { AutomaticCuePresentationSchema } from './text-cue-schema.js';

export const AutomaticTextLayoutPlanSchema = z.strictObject({
  schemaVersion: z.literal('1.0.0'), preset: TextLayoutPresetSchema,
  textTypography: TextTypographySchema.optional(),
  cuePresentations: z.array(AutomaticCuePresentationSchema).optional(),
  reason: z.string().trim().min(1).max(4000),
});
export type AutomaticTextLayoutPlan = z.infer<typeof AutomaticTextLayoutPlanSchema>;

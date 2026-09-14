import { z } from 'zod';

export const IndependentStoryboardInputSchema = z.strictObject({
  handoffPath: z.string().trim().min(1), storyboardId: z.uuid(),
  name: z.string().trim().min(1).max(120), proposedTextHoldMs: z.number().int().positive(),
});
export type IndependentStoryboardInput = z.infer<typeof IndependentStoryboardInputSchema>;

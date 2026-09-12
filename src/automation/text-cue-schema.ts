import { z } from 'zod';
import { TextPresentationSchema } from '../domain/text-presentation.js';
import type { Project } from '../domain/schema.js';

export const AutomaticCuePresentationSchema = z.strictObject({ cueId: z.string().min(1), presentation: TextPresentationSchema.nullable() });
export type AutomaticCuePresentation = z.infer<typeof AutomaticCuePresentationSchema>;

export function currentTextPresentations(project: Project): AutomaticCuePresentation[] {
  return project.textCues.map((cue): AutomaticCuePresentation => ({ cueId: cue.id, presentation: cue.presentation ?? null }));
}

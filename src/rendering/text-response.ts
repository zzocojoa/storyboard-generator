import { z } from 'zod';
import { HashSchema, IdSchema, IssueSchema, MillisecondsSchema } from '../domain/schema.js';

export const TextLayoutResponseSchema = z.strictObject({
  projectId: IdSchema, revision: z.number().int().nonnegative(), atMs: MillisecondsSchema,
  maturity: z.enum(['draft', 'final']), svg: z.string(), fontSha256: HashSchema,
  problems: z.array(z.strictObject({ code: z.enum(['TEXT_LAYOUT_OVERFLOW', 'TEXT_LAYOUT_COLLISION', 'TEXT_FONT_GLYPH_MISSING']), cueId: IdSchema, message: z.string() })),
  visibleTexts: z.array(z.strictObject({ cueId: IdSchema, text: z.string(), timingStatus: z.enum(['proposed', 'confirmed']) })),
  boxes: z.array(z.strictObject({ cueId: IdSchema, kind: z.enum(['overlay', 'prop-text', 'dialogue-subtitle']),
    x: z.number(), y: z.number(), width: z.number().positive(), height: z.number().positive(), fontSize: z.number().positive(), layer: z.number().int().nonnegative(), background: z.enum(['dark', 'light']) })),
});
export type TextLayoutResponse = z.infer<typeof TextLayoutResponseSchema>;

export const TextLayoutPreviewSchema = z.strictObject({
  projectId: IdSchema, revision: z.number().int().nonnegative(), atMs: MillisecondsSchema,
  fontSha256: HashSchema, svg: z.string(), issues: z.array(IssueSchema),
});
export type TextLayoutPreview = z.infer<typeof TextLayoutPreviewSchema>;

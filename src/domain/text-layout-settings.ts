import { z } from 'zod';

const PositionSchema = z.enum(['top', 'center', 'bottom']);
export const TextLayoutPresetSchema = z.strictObject({
  version: z.literal('1.0.0'),
  fontSize: z.number().min(0.02).max(0.12), lineHeight: z.number().min(1.1).max(2),
  safeMargin: z.number().min(0.02).max(0.2), padding: z.number().min(0).max(0.04),
  gap: z.number().min(0).max(0.08), maxLines: z.number().int().min(1).max(12),
  positions: z.strictObject({ overlay: PositionSchema, 'prop-text': PositionSchema, 'dialogue-subtitle': PositionSchema }),
});
export type TextLayoutPreset = z.infer<typeof TextLayoutPresetSchema>;

/** 초기 제작 초안에 사용하는 버전 고정 프리셋이며 원문·표시 시각은 변경하지 않는다. */
export function storyboardTextPreset(): TextLayoutPreset {
  return { version: '1.0.0', fontSize: 0.042, lineHeight: 1.4, safeMargin: 0.07, padding: 0.015, gap: 0.025, maxLines: 4,
    positions: { overlay: 'top', 'prop-text': 'center', 'dialogue-subtitle': 'bottom' } };
}

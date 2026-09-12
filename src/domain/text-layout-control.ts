import { z } from 'zod';

export const TextLayoutControlSchema = z.strictObject({
  version: z.literal('1.0.0'), mode: z.enum(['automatic', 'manual']),
  plannedInputHash: z.string().regex(/^[a-f0-9]{64}$/u).nullable(),
});
export type TextLayoutControl = z.infer<typeof TextLayoutControlSchema>;

/** 초기값과 명시적인 수동 저장을 구별한다. 이전 작품의 설정 권한을 추측하지 않는다. */
export function textLayoutControl(mode: TextLayoutControl['mode']): TextLayoutControl {
  return { version: '1.0.0', mode, plannedInputHash: null };
}

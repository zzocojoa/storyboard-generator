import { currentTextPresentations } from './text-cue-schema.js';
import { z } from 'zod';
import type { Project } from '../domain/schema.js';
import { stableJsonStringify } from '../io/stable-json.js';
import { AutomaticTextLayoutPlanSchema } from './text-preset-schema.js';

const ResultSchema = z.object({ output: AutomaticTextLayoutPlanSchema, fontSha256: z.string().regex(/^[a-f0-9]{64}$/u),
  problems: z.array(z.object({ code: z.string(), cueId: z.string(), message: z.string() })) });
export type TextPresetReview = { status: 'invalid'; message: string } | {
  status: 'recorded'; model: string; reason: string; matchesCurrentPreset: boolean; problems: { code: string; cueId: string; message: string }[];
};

/** 생성 이유와 잔여 검토를 표시한다. 과거 제안을 현재 저장한 설정이나 사람 승인으로 대체하지 않는다. */
export function textPresetReview(project: Project): TextPresetReview | null {
  const record = project.generationRecords.findLast((value): boolean => ['automatic-text-layout-1.0.0', 'automatic-text-layout-1.1.0', 'automatic-text-layout-1.2.0'].includes(value.templateVersion));
  if (record === undefined) return null;
  let payload: unknown;
  try { payload = JSON.parse(record.prompt); }
  catch (error: unknown) {
    if (!(error instanceof SyntaxError)) throw error;
    return { status: 'invalid', message: `${record.id}: 글자 배치 생성 기록의 JSON을 읽을 수 없습니다.` };
  }
  const parsed = ResultSchema.safeParse(payload);
  if (!parsed.success) return { status: 'invalid', message: `${record.id}: 글자 배치 생성 근거가 올바르지 않습니다.` };
  return { status: 'recorded', model: record.model, reason: parsed.data.output.reason, problems: parsed.data.problems,
    matchesCurrentPreset: stableJsonStringify(parsed.data.output.preset) === stableJsonStringify(project.textLayout) && JSON.stringify(parsed.data.output.textTypography ?? null) === JSON.stringify(project.textTypography ?? null)
      && (parsed.data.output.cuePresentations === undefined || parsed.data.output.cuePresentations.length === project.textCues.length
        && new Set(parsed.data.output.cuePresentations.map((row): string => row.cueId)).size === project.textCues.length
        && parsed.data.output.cuePresentations.every((row): boolean => project.textCues.some((cue): boolean => cue.id === row.cueId)))
      && currentTextPresentations(project).every((row): boolean => stableJsonStringify(row.presentation) === stableJsonStringify(parsed.data.output.cuePresentations?.find((entry): boolean => entry.cueId === row.cueId)?.presentation ?? null)) };
}

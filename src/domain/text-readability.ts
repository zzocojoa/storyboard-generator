import { z } from 'zod';
import { issue } from './errors.js';
import type { Issue, Project, TextCue } from './schema.js';

export const TextReadabilityPolicySchema = z.strictObject({
  version: z.literal('1.0.0'), graphemesPerSecond: z.number().min(2).max(40),
  minHoldMs: z.number().int().min(250).max(10000), maxHoldMs: z.number().int().min(1000).max(60000),
}).refine((value): boolean => value.minHoldMs <= value.maxHoldMs, { message: '최소 표시 시간은 최대 표시 시간 이하여야 합니다.', path: ['minHoldMs'] });
export type TextReadabilityPolicy = z.infer<typeof TextReadabilityPolicySchema>;
export type TextReadingInspection = { graphemes: number; actualMs: number; requiredMs: number; maxHoldMs: number; problems: Issue[] };

/** 작품의 확정 기준이 아닌, 수정 가능한 초안 계획용 초기값이다. */
export function storyboardReadingPreset(): TextReadabilityPolicy {
  return { version: '1.0.0', graphemesPerSecond: 12, minHoldMs: 1000, maxHoldMs: 8000 };
}

/** 공백을 제외한 표시 문자 묶음을 세며 원문·줄바꿈·이모지 바이트는 변경하지 않는다. */
export function inspectTextReading(cue: Pick<TextCue, 'id' | 'text' | 'startMs' | 'endMs'>, policy: TextReadabilityPolicy): TextReadingInspection {
  TextReadabilityPolicySchema.parse(policy);
  const graphemes: number = [...new Intl.Segmenter('ko', { granularity: 'grapheme' }).segment(cue.text)].filter(({ segment }): boolean => !/^\s+$/u.test(segment)).length;
  const actualMs: number = cue.endMs - cue.startMs;
  const requiredMs: number = Math.max(policy.minHoldMs, Math.ceil(graphemes * 1000 / policy.graphemesPerSecond));
  const problems: Issue[] = [];
  if (requiredMs > policy.maxHoldMs) problems.push(issue('TEXT_READING_WINDOW_EXCEEDED', 'conflict', cue.id, 'textReadability',
    `${cue.id}: ${graphemes}개 표시 문자에 ${requiredMs}ms가 필요해 최대 ${policy.maxHoldMs}ms를 넘습니다. 원문을 줄이지 말고 읽기 기준과 제작 구간을 검토하세요.`, String(requiredMs), String(policy.maxHoldMs), []));
  else if (actualMs < requiredMs) problems.push(issue('TEXT_READING_TOO_FAST', 'conflict', cue.id, 'textReadability',
    `${cue.id}: ${graphemes}개 표시 문자를 읽기 위한 초안 기준은 ${requiredMs}ms이며 현재 ${actualMs}ms입니다. 종료 시각 또는 읽기 기준을 검토하세요.`, String(requiredMs), String(actualMs), []));
  else if (actualMs > policy.maxHoldMs) problems.push(issue('TEXT_HOLD_TOO_LONG', 'conflict', cue.id, 'textReadability',
    `${cue.id}: 표시 시간이 초안 기준 ${policy.maxHoldMs}ms보다 깁니다. 의도된 유지인지 검토하세요.`, String(policy.maxHoldMs), String(actualMs), []));
  return { graphemes, actualMs, requiredMs, maxHoldMs: policy.maxHoldMs, problems };
}

/** 이미 검토 확정한 시각은 유지하고 미확정 초안의 읽기 기준만 검토한다. */
export function textReadabilityIssues(project: Project): Issue[] {
  return project.textCues.filter((cue): boolean => cue.timingStatus !== 'confirmed').flatMap((cue): Issue[] => inspectTextReading(cue, project.textReadability).problems);
}

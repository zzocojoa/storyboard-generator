import { z } from 'zod';
import { contractError } from './errors.js';
import type { Project, TextCue } from './schema.js';
import type { TextLayoutPreset } from './text-layout-settings.js';

export const TextPresentationValuesSchema = z.strictObject({
  version: z.literal('1.0.0'), x: z.number().min(0).max(1), y: z.number().min(0).max(1), width: z.number().min(0.1).max(1),
  verticalAnchor: z.enum(['top', 'center', 'bottom']), fontSize: z.number().min(0.02).max(0.12),
  alignment: z.enum(['left', 'center', 'right']), layer: z.number().int().min(0).max(99), background: z.enum(['dark', 'light']),
});
export const TextPresentationSchema = TextPresentationValuesSchema.extend({ mode: z.enum(['automatic', 'manual']) });
export type TextPresentationValues = z.infer<typeof TextPresentationValuesSchema>;
export type TextPresentation = z.infer<typeof TextPresentationSchema>;

/** 공통 프리셋의 위치·크기에서 편집을 시작하며 저장 전에는 Cue를 변경하지 않는다. */
export function initialTextPresentation(preset: TextLayoutPreset, kind: TextCue['kind']): TextPresentationValues {
  const anchor = preset.positions[kind];
  return { version: '1.0.0', x: preset.safeMargin, y: anchor === 'top' ? preset.safeMargin : anchor === 'center' ? 0.5 : 1 - preset.safeMargin,
    width: 1 - preset.safeMargin * 2, verticalAnchor: anchor, fontSize: preset.fontSize, alignment: 'center', layer: 0, background: 'dark' };
}

export function updateTextPresentation(project: Project, cueId: string, input: TextPresentationValues): Project {
  const value: TextPresentationValues = TextPresentationValuesSchema.parse(input);
  if (!project.textCues.some((cue): boolean => cue.id === cueId)) throw contractError('TEXT_CUE_NOT_FOUND', `${cueId}: 배치할 글자 트랙을 찾을 수 없습니다.`, []);
  return { ...project, textLayoutControl: { ...project.textLayoutControl, plannedInputHash: null },
    textCues: project.textCues.map((cue): TextCue => cue.id === cueId ? { ...cue, presentation: { ...value, mode: 'manual' } } : cue) };
}

export function resetTextPresentation(project: Project, cueId: string): Project {
  if (!project.textCues.some((cue): boolean => cue.id === cueId)) throw contractError('TEXT_CUE_NOT_FOUND', `${cueId}: 배치를 초기화할 글자 트랙을 찾을 수 없습니다.`, []);
  return { ...project, textLayoutControl: { ...project.textLayoutControl, plannedInputHash: null }, textCues: project.textCues.map((cue): TextCue => {
    if (cue.id !== cueId) return cue;
    const { presentation: _presentation, ...fields } = cue; return fields;
  }) };
}

export function textPresentationColors(background: TextPresentation['background']): { foreground: string; background: string } {
  return background === 'dark' ? { foreground: '#ffffff', background: '#172019' } : { foreground: '#172019', background: '#ffffff' };
}

/** 원본 업데이트의 새 Cue ID에도 같은 명시적 본문 근거의 배치를 보존한다. 중복 근거는 추측하지 않는다. */
export function carrySourceTextPresentation(previous: Project, incoming: TextCue): TextCue {
  const candidates: TextCue[] = previous.textCues.filter((cue): boolean => cue.presentation !== undefined && cue.segmentId === incoming.segmentId
    && cue.authority === incoming.authority && cue.kind === incoming.kind && (incoming.authority === 'placement' ? cue.placementId === incoming.placementId
      : incoming.authority === 'mapping-decision' ? cue.mappingDecisionId === incoming.mappingDecisionId : incoming.authority === 'source-unit' && cue.unitId === incoming.unitId));
  if (candidates.length > 1) throw contractError('SOURCE_UPDATE_TEXT_PRESENTATION_AMBIGUOUS', `${incoming.id}: 같은 본문 근거의 배치가 여러 개입니다. 기존 글자 배치를 확인하세요. candidates=${candidates.map((cue): string => cue.id).join(',')}`, []);
  const presentation = candidates[0]?.presentation;
  return presentation === undefined ? incoming : { ...incoming, presentation };
}

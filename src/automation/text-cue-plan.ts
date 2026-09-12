import { z } from 'zod';
import { contractError } from '../domain/errors.js';
import type { Project, TextCue } from '../domain/schema.js';
import { AutomaticCuePresentationSchema } from './text-cue-schema.js';
import type { AutomaticCuePresentation } from './text-cue-schema.js';
import { stableJsonStringify } from '../io/stable-json.js';
import { automaticShotProtected } from './repair-basis.js';

/** 승인된 출력의 전역 표현은 유지한다. */
export function textLayoutChangeAllowed(project: Project): boolean {
  return !project.shots.some((shot): boolean => automaticShotProtected(project, shot));
}

/** 모든 실제 Cue의 결론을 요구하고 수동 배치·원문·시각은 보존한다. null은 공통 프리셋 선택이다. */
export function compileTextPresentations(project: Project, values: readonly AutomaticCuePresentation[]): TextCue[] {
  const rows: AutomaticCuePresentation[] = z.array(AutomaticCuePresentationSchema).parse(values);
  if (rows.length !== project.textCues.length || new Set(rows.map((row): string => row.cueId)).size !== rows.length
    || rows.some((row): boolean => !project.textCues.some((cue): boolean => cue.id === row.cueId))) {
    throw contractError('AUTOMATION_TEXT_CUE_PRESENTATION_INVALID', '실제 글자 Cue마다 중복 없이 한 개의 배치 결론을 반환하세요. 공통 프리셋을 쓰면 presentation=null로 명시하세요.', []);
  }
  const canChange: boolean = textLayoutChangeAllowed(project);
  return project.textCues.map((cue): TextCue => {
    const selected = rows.find((row): boolean => row.cueId === cue.id)!.presentation;
    if ((!canChange || cue.presentation?.mode === 'manual') && stableJsonStringify(selected) !== stableJsonStringify(cue.presentation ?? null)) {
      throw contractError('AUTOMATION_TEXT_CUE_PRESENTATION_INVALID', `${cue.id}: 직접 저장한 배치 또는 승인된 출력의 기존 배치를 보존하세요.`, []);
    }
    if (canChange && cue.presentation?.mode !== 'manual' && selected !== null && selected.mode !== 'automatic') {
      throw contractError('AUTOMATION_TEXT_CUE_PRESENTATION_INVALID', `${cue.id}: 신규 모델 배치는 mode=automatic이어야 합니다.`, []);
    }
    const { presentation: _previous, ...source } = cue;
    return selected === null ? source : { ...source, presentation: selected };
  });
}

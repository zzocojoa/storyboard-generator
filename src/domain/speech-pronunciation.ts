import { z } from 'zod';
import { contractError } from './errors.js';

export const SpeechPronunciationSchema = z.array(z.strictObject({
  sourceText: z.string().min(1).max(128), occurrence: z.number().int().min(1).max(65536),
  readAs: z.string().min(1).max(128),
})).min(1).max(16);
export type SpeechPronunciation = z.infer<typeof SpeechPronunciationSchema>;
type Replacement = { start: number; end: number; readAs: string };

/** 원문에서 지정한 등장 회차만 치환한다. 보정 결과를 다시 검색하거나 원문을 수정하지 않는다. */
export function speechReadingText(source: string, pronunciation: SpeechPronunciation | undefined): string {
  if (source.trim().length === 0 || new TextEncoder().encode(source).length > 65536) throw contractError('SPEECH_TEXT_SIZE_INVALID', '한 발화는 비어 있지 않은 64KB 이하 원문이어야 합니다.', []);
  if (source.includes('[[')) throw contractError('SPEECH_CONTROL_SEQUENCE_UNSUPPORTED', '원문에 macOS 발화 제어 구문이 있습니다. 해당 발화는 그대로 합성할 수 없습니다.', []);
  if (pronunciation === undefined) return source;
  const changes = SpeechPronunciationSchema.parse(pronunciation);
  const replacements: Replacement[] = changes.map((change): Replacement => {
    if (change.sourceText.trim().length === 0 || change.readAs.trim().length === 0 || change.sourceText === change.readAs) throw contractError('SPEECH_PRONUNCIATION_EMPTY', '보완할 원문 표현과 다른 읽을 표기를 입력하세요. 공백만 지정하거나 표현을 삭제할 수 없습니다.', []);
    if (change.readAs.includes('[[') || /[\u0000-\u001f\u007f]/u.test(change.readAs) || !change.readAs.isWellFormed() || !change.sourceText.isWellFormed()) throw contractError('SPEECH_CONTROL_SEQUENCE_UNSUPPORTED', '읽을 표기는 제어 구문·제어 문자 없는 한 줄의 유효한 문자로 입력하세요.', []);
    let start: number = -1;
    for (let index: number = 0; index < change.occurrence; index += 1) {
      start = source.indexOf(change.sourceText, start < 0 ? 0 : start + change.sourceText.length);
      if (start < 0) throw contractError('SPEECH_PRONUNCIATION_SOURCE_MISSING', `원문에서 “${change.sourceText}”의 ${change.occurrence}번째 등장을 찾지 못했습니다. 원문과 등장 회차를 다시 확인하세요.`, []);
    }
    return { start, end: start + change.sourceText.length, readAs: change.readAs };
  }).sort((left, right): number => left.start - right.start);
  let end: number = 0; let spoken: string = '';
  for (const replacement of replacements) {
    if (replacement.start < end) throw contractError('SPEECH_PRONUNCIATION_OVERLAP', '발음 보완의 원문 범위가 겹칩니다. 같은 부분은 한 번만 지정하세요.', []);
    spoken += source.slice(end, replacement.start) + replacement.readAs; end = replacement.end;
  }
  spoken += source.slice(end);
  if (new TextEncoder().encode(spoken).length > 65536) throw contractError('SPEECH_TEXT_SIZE_INVALID', '발음 보완 후 낭독문이 64KB를 초과합니다. 한 발화의 보완 길이를 줄이세요.', []);
  if (spoken.includes('[[')) throw contractError('SPEECH_CONTROL_SEQUENCE_UNSUPPORTED', '발음 보완을 합친 낭독문에 macOS 발화 제어 구문이 생겼습니다. 읽을 표기를 수정하세요.', []);
  return spoken;
}

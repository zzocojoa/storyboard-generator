import type { ReactElement } from 'react';
import { z } from 'zod';
import { speechReadingText } from '../../src/domain/speech-pronunciation.js';
import type { SpeechPronunciation } from '../../src/domain/speech-pronunciation.js';
import { apiErrorMessage } from './api.js';

export const PronunciationDraftSchema = z.array(z.strictObject({ sourceText: z.string(), occurrence: z.number(), readAs: z.string() })).max(16);
export type PronunciationDraft = z.infer<typeof PronunciationDraftSchema>;

export function pronunciationPreview(source: string, changes: PronunciationDraft): { text: string; error: string } {
  try { return { text: speechReadingText(source, changes.length === 0 ? undefined : changes), error: '' }; }
  catch (cause: unknown) { return { text: '', error: apiErrorMessage(cause) }; }
}

/** 원문과 전체 낭독문을 함께 보여 주고 각 보완의 정확한 등장 회차를 선택한다. */
export function SpeechPronunciationEditor(props: { source: string; value: PronunciationDraft; onChange: (value: PronunciationDraft) => void }): ReactElement {
  const preview = pronunciationPreview(props.source, props.value);
  const update = (index: number, change: SpeechPronunciation[number]): void => { props.onChange(props.value.map((value, position) => position === index ? change : value)); };
  return <section aria-label="발음 보완">
    <h5>발음 보완</h5><p>고유명사·숫자 등 읽는 방법을 바꿀 표현만 지정하세요. 같은 표현이 반복되면 원문에서 몇 번째인지 선택합니다. 대본과 자막에는 원문이 유지됩니다.</p>
    <p>발화 원문</p><blockquote>{props.source}</blockquote>
    {props.value.map((change, index): ReactElement => <fieldset key={index}><legend>발음 보완 {index + 1}</legend>
      <label className="field">원문 표현<input aria-label={`원문 표현 ${index + 1}`} maxLength={128} value={change.sourceText} onChange={(event): void => { update(index, { ...change, sourceText: event.target.value }); }} /></label>
      <label className="field">등장 회차<input aria-label={`등장 회차 ${index + 1}`} type="number" min={1} max={65536} value={change.occurrence} onChange={(event): void => { update(index, { ...change, occurrence: Number(event.target.value) }); }} /></label>
      <label className="field">읽을 표기<input aria-label={`읽을 표기 ${index + 1}`} maxLength={128} value={change.readAs} onChange={(event): void => { update(index, { ...change, readAs: event.target.value }); }} /></label>
      <button onClick={(): void => { props.onChange(props.value.filter((_value, position): boolean => position !== index)); }}>보완 {index + 1} 제거</button>
    </fieldset>)}
    <button disabled={props.value.length >= 16} onClick={(): void => { props.onChange([...props.value, { sourceText: '', occurrence: 1, readAs: '' }]); }}>읽는 방법 추가</button>
    {preview.error !== '' ? <p role="alert">{preview.error}</p> : <div aria-label="합성할 낭독문"><p>합성할 낭독문</p><blockquote>{preview.text}</blockquote></div>}
    <p>이 낭독문으로 아래 자동 생성을 실행한 뒤 새 음원과 이전 버전을 비교하세요. 실제 발음과 의미가 맞는지는 청취 후 확인합니다.</p>
  </section>;
}

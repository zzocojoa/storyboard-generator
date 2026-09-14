import { z } from 'zod';
import { contractError } from '../domain/errors.js';
import { SpeechPronunciationSchema, speechReadingText } from '../domain/speech-pronunciation.js';
import type { SpeechPronunciation } from '../domain/speech-pronunciation.js';
import { sha256Text } from '../importers/integrity.js';
import { stableJsonStringify } from '../io/stable-json.js';

export const SpeechPronunciationEvidenceSchema = z.strictObject({
  replacements: SpeechPronunciationSchema, spokenTextHash: z.string().regex(/^[a-f0-9]{64}$/u),
});
export type SpeechPronunciationEvidence = z.infer<typeof SpeechPronunciationEvidenceSchema>;

export function speechPronunciationEvidence(source: string, pronunciation: SpeechPronunciation | undefined): SpeechPronunciationEvidence | undefined {
  const spoken: string = speechReadingText(source, pronunciation);
  return pronunciation === undefined ? undefined : { replacements: SpeechPronunciationSchema.parse(pronunciation), spokenTextHash: sha256Text(spoken) };
}

/** 결과의 보완 범위와 실제 엔진 입력 근거를 요청에 결속한다. 이전 무보완 결과는 그대로 허용한다. */
export function assertSpeechPronunciation(source: string, requested: SpeechPronunciation | undefined, actual: SpeechPronunciationEvidence | undefined): void {
  const expected = speechPronunciationEvidence(source, requested);
  if (stableJsonStringify(expected ?? null) !== stableJsonStringify(actual === undefined ? null : SpeechPronunciationEvidenceSchema.parse(actual))) throw contractError('SPEECH_PRONUNCIATION_MISMATCH', '요청한 발음 보완과 합성 결과의 낭독 근거가 다릅니다. 기존 음원은 유지합니다.', []);
}

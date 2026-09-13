import { z } from 'zod';
import { issue } from './errors.js';
import { VoiceCastingSchema } from './schema.js';
import type { Issue, Project } from './schema.js';
import { InstalledSpeechVoiceSchema } from './speech-voice.js';
import { stableJsonStringify } from '../io/stable-json.js';

export const VoiceCastingEvidenceSchema = z.strictObject({
  input: z.string(), output: z.json(), turnId: z.string().nullable(),
  casting: VoiceCastingSchema, catalog: z.array(InstalledSpeechVoiceSchema).min(1).max(1024),
});

/** 원본 변경 후에도 과거 배정 근거를 보존한다. 현재 원본과의 재사용 판정은 생성 직전에 수행한다. */
export function voiceCastingIssues(project: Project): Issue[] {
  const casting = project.voiceCasting;
  if (casting === undefined) return [];
  const failure = (message: string): Issue[] => [issue('INVALID_VOICE_CASTING', 'error', casting.generationId, 'voiceCasting', message, null, null, [])];
  const ids = casting.assignments.map((entry): string | null => entry.speakerId);
  if (new Set(ids).size !== ids.length || casting.assignments.some((entry): boolean => new Set(entry.sourceUnitIds).size !== entry.sourceUnitIds.length)) return failure('화자 또는 음성 배정의 원문 근거가 중복됩니다.');
  const record = project.generationRecords.find((entry): boolean => entry.id === casting.generationId);
  if (record === undefined || record.provider !== 'codex-app' || record.templateVersion !== 'automatic-voice-casting-1.0.0'
    || record.requestId !== casting.generationId || !record.referenceHashes.includes(casting.sourceHash)
    || record.resultAssetIds.length !== 0 || record.shotIds.length !== 0) return failure('자동 음성 배정의 생성 기록·원본 근거가 일치하지 않습니다.');
  let parsed: unknown;
  try { parsed = JSON.parse(record.prompt); } catch (error: unknown) {
    if (!(error instanceof SyntaxError)) throw error;
    return failure('자동 음성 배정 기록의 JSON을 읽을 수 없습니다.');
  }
  const evidence = VoiceCastingEvidenceSchema.safeParse(parsed);
  if (!evidence.success || stableJsonStringify(evidence.data.casting) !== stableJsonStringify(casting)) return failure('저장된 음성 배정이 생성 당시 결과와 다릅니다.');
  if (new Set(evidence.data.catalog.map((entry): string => entry.name)).size !== evidence.data.catalog.length
    || casting.assignments.some((entry): boolean => !evidence.data.catalog.some((voice): boolean => voice.name === entry.voice.name && voice.locale === entry.locale))) return failure('음성 이름·언어가 생성 당시 설치 목록과 다릅니다.');
  return [];
}

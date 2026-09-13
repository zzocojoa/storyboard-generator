import { z } from 'zod';
import { contractError } from './errors.js';
import type { Project, SourceUnit } from './schema.js';
import { IdSchema } from './schema.js';
import { unitAudioKind } from './unit-media.js';
import { SpeechVoiceSchema } from './speech-voice-value.js';
import type { SpeechVoice } from './speech-voice-value.js';

export { SpeechVoiceSchema } from './speech-voice-value.js';
export type { SpeechVoice } from './speech-voice-value.js';
export const InstalledSpeechVoiceSchema = z.strictObject({ name: z.string().min(1).max(200), locale: z.string().min(2).max(50), sample: z.string().max(2000) });
export type InstalledSpeechVoice = z.infer<typeof InstalledSpeechVoiceSchema>;
export const SpeakerVoiceSchema = z.strictObject({ speakerId: IdSchema.nullable(), voice: SpeechVoiceSchema });
export const SpeakerVoicesSchema = z.array(SpeakerVoiceSchema).max(1024).superRefine((values, context): void => {
  const ids: (string | null)[] = values.map((value): string | null => value.speakerId);
  if (new Set(ids).size !== ids.length) context.addIssue({ code: 'custom', message: '같은 화자의 음성을 중복 지정할 수 없습니다.' });
});
export type SpeakerVoice = z.infer<typeof SpeakerVoiceSchema>;
export type SpokenSpeaker = { speakerId: string | null; name: string; unitIds: string[] };

/** 실제 발화에 쓰인 화자만 나열한다. 화면 등장·이름 언급을 음성 출연으로 바꾸지 않는다. */
export function spokenSpeakers(project: Project): SpokenSpeaker[] {
  const units: SourceUnit[] = project.dataset.units.filter((unit): boolean => ['dialogue', 'voiceover', 'panel'].includes(unitAudioKind(unit) ?? ''));
  return [...new Set(units.map((unit): string | null => unit.speakerId))].map((speakerId): SpokenSpeaker => ({
    speakerId, name: speakerId === null ? '화자 미지정 발화' : project.dataset.people.find((person): boolean => person.id === speakerId)?.name ?? speakerId,
    unitIds: units.filter((unit): boolean => unit.speakerId === speakerId).map((unit): string => unit.id),
  }));
}

export function assertSpeakerVoices(project: Project, values: readonly SpeakerVoice[]): void {
  SpeakerVoicesSchema.parse(values);
  const speakers: SpokenSpeaker[] = spokenSpeakers(project);
  for (const entry of values) if (!speakers.some((speaker): boolean => speaker.speakerId === entry.speakerId)) {
    throw contractError('AUTOMATION_SPEAKER_NOT_SPOKEN', `현재 프로젝트에 발화가 없는 화자의 음성 설정입니다: speakerId=${entry.speakerId ?? '(미지정)'}. 원문과 인물별 음성 설정을 다시 확인하세요.`, []);
  }
}

/** 명시적인 인물 선택을 우선하고, 지정하지 않은 발화에는 실행의 공통 음성을 사용한다. */
export function voiceForSpeaker(unit: SourceUnit, common: SpeechVoice, values: readonly SpeakerVoice[]): SpeechVoice {
  return SpeechVoiceSchema.parse(values.find((entry): boolean => entry.speakerId === unit.speakerId)?.voice ?? common);
}

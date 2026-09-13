import { z } from 'zod';
import { automaticAudioProtected } from './edit-protection.js';
import { contractError } from './errors.js';
import type { AudioCue, Project } from './schema.js';

export const AudioMixValuesSchema = z.strictObject({
  volumeDb: z.number().min(-30).max(0), fadeInMs: z.number().int().min(0).max(60000), fadeOutMs: z.number().int().min(0).max(60000),
});
export const AudioMixInputSchema = AudioMixValuesSchema.extend({ mode: z.enum(['automatic', 'manual']) });
export const AudioMixSchema = AudioMixInputSchema.extend({
  version: z.literal('1.0.0'), plannedInputHash: z.string().regex(/^[a-f0-9]{64}$/u).nullable(), reason: z.string().trim().min(1).max(4000),
});
export type AudioMix = z.infer<typeof AudioMixSchema>;
export type AudioMixInput = z.infer<typeof AudioMixInputSchema>;
export type AudioMixValues = z.infer<typeof AudioMixValuesSchema>;

/** 미지정된 이전 음원은 원래 음량으로 재생한다. 저장 파일에 추정 설정을 추가하지 않는다. */
export function audioMixValues(cue: Pick<AudioCue, 'mix'>): AudioMixValues {
  return cue.mix === undefined ? { volumeDb: 0, fadeInMs: 0, fadeOutMs: 0 }
    : { volumeDb: cue.mix.volumeDb, fadeInMs: cue.mix.fadeInMs, fadeOutMs: cue.mix.fadeOutMs };
}

/** 음량·페이드만 계산하며 원본 파일의 속도·재생 범위·정보 공개 시각은 바꾸지 않는다. */
export function audioVolumeAt(cue: Pick<AudioCue, 'startMs' | 'endMs' | 'mix'>, atMs: number): number {
  if (atMs < cue.startMs || atMs >= cue.endMs) return 0;
  const mix = audioMixValues(cue);
  const incoming: number = mix.fadeInMs === 0 ? 1 : Math.min(1, (atMs - cue.startMs) / mix.fadeInMs);
  const outgoing: number = mix.fadeOutMs === 0 ? 1 : Math.min(1, (cue.endMs - atMs) / mix.fadeOutMs);
  return Math.pow(10, mix.volumeDb / 20) * Math.min(incoming, outgoing);
}

export function assertAudioMixDuration(cue: Pick<AudioCue, 'id' | 'startMs' | 'endMs'>, values: AudioMixValues): void {
  if (values.fadeInMs + values.fadeOutMs > cue.endMs - cue.startMs) throw contractError('AUDIO_MIX_FADE_RANGE', `${cue.id}: 페이드 합계가 음원 배치 길이 ${cue.endMs - cue.startMs}ms를 초과합니다. 페이드 시간을 줄이세요.`, []);
}

/** 명시적인 믹싱 저장은 한 Cue에만 적용한다. 보호된 컷과 공유하는 음원은 먼저 검토 상태를 해제해야 한다. */
export function updateAudioMix(project: Project, cueId: string, input: AudioMixInput): Project {
  const values = AudioMixInputSchema.parse(input);
  const cue = project.audioCues.find((value): boolean => value.id === cueId);
  if (cue === undefined) throw contractError('AUDIO_CUE_NOT_FOUND', `음량을 저장할 음원 큐가 없습니다: ${cueId}`, []);
  if (automaticAudioProtected(project, cue)) throw contractError('AUDIO_MIX_PROTECTED', `${cueId}: 확정·잠금 컷 또는 승인 그림과 연결된 음원입니다. 기존 검토 상태를 먼저 확인하세요.`, []);
  assertAudioMixDuration(cue, values);
  const mix: AudioMix = { ...values, version: '1.0.0', plannedInputHash: null,
    reason: values.mode === 'manual' ? '제작자가 저장한 음량·페이드입니다.' : '다음 자동 제작에서 실제 음원과 동시 재생을 검토합니다.' };
  return { ...project, audioCues: project.audioCues.map((value): AudioCue => value.id === cueId ? { ...value, mix } : value) };
}

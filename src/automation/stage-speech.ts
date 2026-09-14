import { assertSpeechPronunciation } from '../codex/speech-pronunciation.js';
import type { SpeechPronunciation } from '../domain/speech-pronunciation.js';
import { assertSpeakerVoices, voiceForSpeaker } from '../domain/speech-voice.js';
import { SpeechVoiceSchema } from '../domain/speech-voice.js';
import type { SpeakerVoice } from '../domain/speech-voice.js';
import type { SpeechGenerationEngine, SpeechVoice } from '../codex/speech-engine.js';
import { contractError } from '../domain/errors.js';
import type { AudioCue, Project, SourceUnit } from '../domain/schema.js';
import { inspectStagedSpeech } from './plan-audio.js';
import type { StagedSpeech } from './plan-audio.js';
import type { AutomaticPlanProgress } from './plan-segment.js';

export type SpeechStagingServices = { speech: SpeechGenerationEngine; onProgress: (progress: AutomaticPlanProgress) => Promise<void>; onSpeechReady: (speech: StagedSpeech) => Promise<void> };

function assertActive(signal: AbortSignal): void {
  if (signal.aborted) throw contractError('AUTOMATION_CANCELLED', '가이드 음성 준비가 중단되었습니다. 프로젝트는 변경하지 않았습니다.', []);
}

/** 명시한 미등록 발화만 한 번 준비한다. 계획 보정 전에 측정하고 실행 캐시에 보존한다. */
export async function stageMissingSpeech(project: Project, cueIds: readonly string[], voice: SpeechVoice, speakerVoices: readonly SpeakerVoice[], maxBytes: number, services: SpeechStagingServices, signal: AbortSignal): Promise<StagedSpeech[]> {
  assertSpeakerVoices(project, speakerVoices);
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0 || maxBytes > 512 * 1024 * 1024 || cueIds.length > 0 && maxBytes === 0) throw contractError('AUTOMATION_AUDIO_BUDGET', `가이드 음성을 준비할 바이트 한도가 부족합니다: maxBytes=${maxBytes}`, []);
  if (new Set(cueIds).size !== cueIds.length) throw contractError('AUTOMATION_AUDIO_SCOPE', '가이드 음성 대상 큐가 중복되었습니다.', []);
  const cues: AudioCue[] = cueIds.map((id): AudioCue => {
    const cue: AudioCue | undefined = project.audioCues.find((value): boolean => value.id === id);
    if (cue === undefined || cue.assetId !== null || cue.timingStatus === 'measured' || !['dialogue', 'voiceover', 'panel'].includes(cue.kind)) throw contractError('AUTOMATION_AUDIO_SCOPE', `미등록 발화만 합성할 수 있습니다: ${id}`, []);
    return cue;
  });
  const staged: StagedSpeech[] = [];
  let totalBytes: number = 0;
  for (const cue of cues) {
    assertActive(signal);
    const unit = project.dataset.units.find((value): boolean => value.id === cue.unitId);
    if (unit === undefined) throw contractError('SOURCE_UNIT_NOT_FOUND', `음성 원문을 찾을 수 없습니다: ${cue.unitId}`, []);
    await services.onProgress({ phase: 'speech', completed: staged.length, total: cues.length, attempt: 0, message: `${cue.id}: 가이드 음성 측정` });
    const speech = await stageSelectedSpeech(project, cue, voiceForSpeaker(unit, voice, speakerVoices), undefined, maxBytes - totalBytes, services, signal);
    staged.push(speech); totalBytes += speech.result.bytes.length;
  }
  return staged;
}

/** 선택된 한 발화를 합성·검사·보존한다. 재생성 권한과 배치 검증은 호출자가 담당한다. */
export async function stageSelectedSpeech(project: Project, cue: AudioCue, voice: SpeechVoice, pronunciation: SpeechPronunciation | undefined, maxBytes: number, services: SpeechStagingServices, signal: AbortSignal): Promise<StagedSpeech> {
  assertActive(signal);
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 512 * 1024 * 1024) throw contractError('AUTOMATION_AUDIO_BUDGET', `음성 저장 한도가 부족합니다: maxBytes=${maxBytes}`, []);
  const selectedVoice = SpeechVoiceSchema.parse(voice);
  const unit: SourceUnit | undefined = project.dataset.units.find((value): boolean => value.id === cue.unitId);
  if (unit === undefined) throw contractError('SOURCE_UNIT_NOT_FOUND', `음성 원문을 찾을 수 없습니다: ${cue.unitId}`, []);
  const result = await services.speech.run({ unit: structuredClone(unit), voice: { ...selectedVoice }, sampleRate: project.handoff.timebase.sampleRate, ...(pronunciation === undefined ? {} : { pronunciation: structuredClone(pronunciation) }) }, signal);
  assertActive(signal);
  assertSpeechPronunciation(unit.text, pronunciation, result.pronunciation);
  if (result.voice.name !== selectedVoice.name || result.voice.rateWordsPerMinute !== selectedVoice.rateWordsPerMinute) throw contractError('AUTOMATION_SPEECH_VOICE_MISMATCH', `요청한 화자 음성과 합성 결과의 설정이 다릅니다: cueId=${cue.id}, expected=${selectedVoice.name}/${selectedVoice.rateWordsPerMinute}, actual=${result.voice.name}/${result.voice.rateWordsPerMinute}`, []);
  if (result.bytes.length > maxBytes) throw contractError('AUTOMATION_AUDIO_BUDGET', `임시 음성이 한도 ${maxBytes} bytes를 초과했습니다. 실행 한도를 조정하세요.`, []);
  const speech: StagedSpeech = { cueId: cue.id, result: { ...result, bytes: Buffer.from(result.bytes), voice: { ...result.voice }, inspection: { ...result.inspection }, ...(result.pronunciation === undefined ? {} : { pronunciation: structuredClone(result.pronunciation) }), ...(result.cacheEvidence === undefined ? {} : { cacheEvidence: { ...result.cacheEvidence } }) } };
  inspectStagedSpeech(project, cue, speech);
  await services.onSpeechReady({ ...speech, result: { ...speech.result, bytes: Buffer.from(speech.result.bytes), voice: { ...speech.result.voice }, inspection: { ...speech.result.inspection }, ...(speech.result.pronunciation === undefined ? {} : { pronunciation: structuredClone(speech.result.pronunciation) }), ...(speech.result.cacheEvidence === undefined ? {} : { cacheEvidence: { ...speech.result.cacheEvidence } }) } });
  assertActive(signal);
  return speech;
}

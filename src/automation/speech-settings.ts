import type { Project, SourceUnit } from '../domain/schema.js';
import { contractError, assertNoErrors } from '../domain/errors.js';
import { spokenSpeakers, voiceForSpeaker } from '../domain/speech-voice.js';
import type { SpeakerVoice, SpeechVoice, SpokenSpeaker } from '../domain/speech-voice.js';
import { voiceCastingIssues } from '../domain/voice-casting.js';
import { automaticHash } from './application-evidence.js';
import { sourceRepairScope } from './repair-basis.js';
import { automaticVoicePlanning, automationSpeakerVoices, automationAudioProduction } from './run-schema.js';
import type { AutomationSettings } from './run-schema.js';

/** 선택 구간에서 새로 합성할 발화만 검사한다. 기존 음원·보호된 발화·음성 없는 영상에 설치를 요구하지 않는다. */
export function automaticSpeechUnits(project: Project, segmentIds: readonly string[]): SourceUnit[] {
  const cueIds: Set<string> = new Set(segmentIds.flatMap((id): string[] => sourceRepairScope(project, id).speechCueIds));
  const unitIds: Set<string> = new Set(project.audioCues.filter((cue): boolean => cueIds.has(cue.id)).flatMap((cue): string[] => cue.unitId === null ? [] : [cue.unitId]));
  return project.dataset.units.filter((unit): boolean => unitIds.has(unit.id));
}

export function voiceCastingSourceHash(project: Project): string {
  return automaticHash({ projectId: project.projectId, dataset: project.dataset });
}

/** 동일 원본의 배정만 재사용하고 직접 지정한 음성을 우선한다. */
export function availableAutomationSpeakerVoices(project: Project, settings: AutomationSettings): SpeakerVoice[] {
  if (automationAudioProduction(settings) === 'instructions-only') return [];
  const explicit = automationSpeakerVoices(settings);
  if (!automaticVoicePlanning(settings) || project.voiceCasting === undefined || project.voiceCasting.sourceHash !== voiceCastingSourceHash(project)) return explicit;
  assertNoErrors(voiceCastingIssues(project), 'INVALID_VOICE_CASTING');
  return [...explicit, ...project.voiceCasting.assignments.filter((entry): boolean => !explicit.some((value): boolean => value.speakerId === entry.speakerId))
    .map((entry): SpeakerVoice => ({ speakerId: entry.speakerId, voice: { ...entry.voice } }))];
}

export function missingVoiceCastingSpeakers(project: Project, segmentIds: readonly string[], settings: AutomationSettings): SpokenSpeaker[] {
  if (automationAudioProduction(settings) === 'instructions-only' || !automaticVoicePlanning(settings)) return [];
  const units = automaticSpeechUnits(project, segmentIds); const choices = availableAutomationSpeakerVoices(project, settings);
  return spokenSpeakers(project).filter((speaker): boolean => units.some((unit): boolean => unit.speakerId === speaker.speakerId)
    && !choices.some((choice): boolean => choice.speakerId === speaker.speakerId));
}

/** 자동 배정이 빠진 발화를 공통 음성으로 바꾸지 않고 계획 작업을 요구한다. */
export function resolvedAutomationSpeakerVoices(project: Project, segmentIds: readonly string[], settings: AutomationSettings): SpeakerVoice[] {
  if (automationAudioProduction(settings) === 'instructions-only') return [];
  const missing = missingVoiceCastingSpeakers(project, segmentIds, settings);
  if (missing.length > 0) throw contractError('AUTOMATION_VOICE_CASTING_REQUIRED', `가이드 음성 배정을 먼저 완료하세요: ${missing.map((entry): string => entry.name).join(', ')}`, []);
  return availableAutomationSpeakerVoices(project, settings);
}

/** 아직 배정되지 않은 자동 음성은 계획 작업에서 검사한다. 사용하지 않는 공통 음성은 요구하지 않는다. */
export function requiredAutomationSpeechVoices(project: Project, segmentIds: readonly string[], settings: AutomationSettings): SpeechVoice[] {
  if (automationAudioProduction(settings) === 'instructions-only') return [];
  const choices = availableAutomationSpeakerVoices(project, settings);
  const units = automaticSpeechUnits(project, segmentIds).filter((unit): boolean => !automaticVoicePlanning(settings) || choices.some((entry): boolean => entry.speakerId === unit.speakerId));
  const voices: SpeechVoice[] = units.map((unit): SpeechVoice => voiceForSpeaker(unit, settings.voice, choices));
  return voices.filter((voice, index): boolean => voices.findIndex((other): boolean => other.name === voice.name && other.rateWordsPerMinute === voice.rateWordsPerMinute) === index);
}

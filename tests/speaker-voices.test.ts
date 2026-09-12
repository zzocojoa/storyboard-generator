import { describe, expect, it, vi } from 'vitest';
import { automationDensity, automationSpeakerVoices, AutomationSettingsSchema } from '../src/automation/run-schema.js';
import { stageMissingSpeech } from '../src/automation/stage-speech.js';
import { requiredAutomationSpeechVoices } from '../src/automation/speech-settings.js';
import { parseInstalledSpeechVoices } from '../src/codex/speech-voices.js';
import type { SpeechGenerationInput, SpeechGenerationResult } from '../src/codex/speech-engine.js';
import type { Project, SourceUnit } from '../src/domain/schema.js';
import { assertSpeakerVoices, spokenSpeakers, SpeakerVoicesSchema, voiceForSpeaker } from '../src/domain/speech-voice.js';
import type { SpeakerVoice } from '../src/domain/speech-voice.js';
import { inspectAudioFileBytes } from '../src/domain/media-inspection.js';
import { sha256Text } from '../src/importers/integrity.js';
import { settings } from './automatic-executor-helpers.js';
import { automaticPlanProject, stagedPlanSpeech } from './automatic-plan-helpers.js';
import { pcmWav } from './helpers.js';

const choices: SpeakerVoice[] = [{ speakerId: 'CHAR-01', voice: { name: 'Test Korean', rateWordsPerMinute: 160 } }];
const signal: AbortSignal = new AbortController().signal;

describe('화자별 가이드 음성 계약', (): void => {
  it('speaker_voice_catalog_preserves_exact_localized_names_and_rejects_ambiguous_or_invalid_output', (): void => {
    expect(parseInstalledSpeechVoices('Test Korean    ko_KR  # 안녕하세요.\r\nEddy (한국어(대한민국)) ko_KR # 한글\nTest English en_US # Hello # sample\n')).toEqual([
      { name: 'Test Korean', locale: 'ko_KR', sample: '안녕하세요.' }, { name: 'Eddy (한국어(대한민국))', locale: 'ko_KR', sample: '한글' }, { name: 'Test English', locale: 'en_US', sample: 'Hello # sample' },
    ]);
    for (const invalid of ['', 'Test Korean # language missing', 'bad', 'Valid ko_KR # hello\nbroken']) expect(() => parseInstalledSpeechVoices(invalid)).toThrowError(expect.objectContaining({ code: 'SPEECH_VOICE_LIST_INVALID' }));
    expect(() => parseInstalledSpeechVoices('Same en_US # hello\nSame ko_KR # 안녕')).toThrowError(expect.objectContaining({ code: 'SPEECH_VOICE_LIST_AMBIGUOUS' }));
  });

  it('speaker_voice_selection_uses_only_spoken_source_identity_and_preserves_unassigned_common_voice', async (): Promise<void> => {
    const original = await automaticPlanProject(); const narrator = original.dataset.units.find((unit): boolean => unit.id === '안내-1')!;
    const project: Project = { ...original, dataset: { ...original.dataset, units: [...original.dataset.units,
      { ...narrator, id: 'dialogue-null', kind: 'DIALOGUE', speakerId: null }, { ...narrator, id: 'panel-null', kind: 'PANEL', speakerId: null },
      { ...narrator, id: 'not-spoken', kind: 'CHAT', speakerId: 'mentioned-only' }], people: [...original.dataset.people, { ...original.dataset.people[0]!, id: 'mentioned-only', name: '화면에만 등장' }] } };
    const before = structuredClone(project);
    expect(spokenSpeakers(project)).toEqual([{ speakerId: 'CHAR-01', name: '안내자', unitIds: ['안내-1'] }, { speakerId: null, name: '화자 미지정 발화', unitIds: ['dialogue-null', 'panel-null'] }]);
    assertSpeakerVoices(project, choices);
    expect(voiceForSpeaker(narrator, settings.voice, choices)).toEqual(choices[0]!.voice);
    const unassigned: SourceUnit = { ...narrator, speakerId: null };
    expect(voiceForSpeaker(unassigned, settings.voice, choices)).toEqual(settings.voice);
    expect(voiceForSpeaker(unassigned, settings.voice, [{ speakerId: null, voice: choices[0]!.voice }])).toEqual(choices[0]!.voice);
    expect(() => assertSpeakerVoices(project, [{ ...choices[0]!, speakerId: 'mentioned-only' }])).toThrowError(expect.objectContaining({ code: 'AUTOMATION_SPEAKER_NOT_SPOKEN' }));
    expect(SpeakerVoicesSchema.safeParse([...choices, ...choices]).success).toBe(false);
    expect(SpeakerVoicesSchema.safeParse([{ ...choices[0]!, speakerId: null }, { ...choices[0]!, speakerId: null }]).success).toBe(false);
    expect(project).toEqual(before);
  });

  it('speaker_voice_settings_keep_legacy_run_bytes_and_support_explicit_choices_without_new_defaults', (): void => {
    const before: string = JSON.stringify(settings);
    const legacy = AutomationSettingsSchema.parse(settings);
    expect(JSON.stringify(legacy)).toBe(before); expect(automationSpeakerVoices(legacy)).toEqual([]);
    const selected = AutomationSettingsSchema.parse({ ...settings, speakerVoices: choices });
    expect(automationSpeakerVoices(selected)).toEqual(choices); expect(automationDensity(selected)).toBeNull();
    expect(selected).not.toHaveProperty('audioMixPlanning'); expect(selected).not.toHaveProperty('textLayoutPlanning');
    expect(AutomationSettingsSchema.safeParse({ ...settings, speakerVoices: [...choices, ...choices] }).success).toBe(false);
  });

  it('speaker_voice_preflight_only_requires_missing_unprotected_speech_in_selected_segments', async (): Promise<void> => {
    const project = await automaticPlanProject();
    const selected = { ...settings, speakerVoices: choices, voice: { name: 'Not Installed Common', rateWordsPerMinute: 180 } };
    expect(requiredAutomationSpeechVoices(project, ['demonstration'], selected)).toEqual([choices[0]!.voice]);
    expect(requiredAutomationSpeechVoices(project, project.dataset.segments.filter((segment): boolean => segment.id !== 'demonstration').map((segment): string => segment.id), selected)).toEqual([]);
    const protectedProject: Project = { ...project, shots: project.shots.map((shot) => ({ ...shot, approvalStatus: 'approved' })) };
    expect(requiredAutomationSpeechVoices(protectedProject, ['demonstration'], selected)).toEqual([]);
    const registered: Project = { ...project, audioCues: project.audioCues.map((cue) => cue.kind === 'voiceover' ? { ...cue, assetId: 'existing-audio', timingStatus: 'measured' } : cue) };
    expect(requiredAutomationSpeechVoices(registered, ['demonstration'], selected)).toEqual([]);
  });

  it('speaker_voice_staging_selects_each_source_voice_and_rejects_changed_result_without_publishing', async (): Promise<void> => {
    const original = await automaticPlanProject(); const first = stagedPlanSpeech(original); const unit = original.dataset.units.find((entry): boolean => entry.id === first.result.unitId)!;
    const project: Project = { ...original, dataset: { ...original.dataset, units: [...original.dataset.units, { ...unit, id: 'second-spoken', speakerId: null }] }, audioCues: [...original.audioCues, { ...original.audioCues[0]!, id: 'second-cue', unitId: 'second-spoken' }] };
    const before = structuredClone(project);
    const run = vi.fn(async (input: SpeechGenerationInput): Promise<SpeechGenerationResult> => {
      const bytes: Buffer = pcmWav(2300, input.sampleRate, 1, 16);
      return { unitId: input.unit.id, voice: { ...input.voice }, sourceTextHash: sha256Text(input.unit.text), bytes, inspection: inspectAudioFileBytes(bytes, 'audio/wav') };
    });
    const ready = vi.fn(async (): Promise<void> => {});
    const services = { speech: { run }, onProgress: async (): Promise<void> => {}, onSpeechReady: ready };
    const staged = await stageMissingSpeech(project, [first.cueId, 'second-cue'], settings.voice, choices, 2_000_000, services, signal);
    expect(staged.map((entry) => entry.result.voice)).toEqual([choices[0]!.voice, settings.voice]);
    expect(run.mock.calls.map(([input]) => input.unit.text)).toEqual([unit.text, unit.text]);
    expect(ready).toHaveBeenCalledTimes(2); expect(project).toEqual(before);
    const synthesize = run.getMockImplementation()!; ready.mockClear();
    run.mockImplementationOnce(async (input) => { input.voice.name = 'Unexpected'; return synthesize(input); });
    await expect(stageMissingSpeech(project, [first.cueId], settings.voice, choices, 2_000_000, services, signal)).rejects.toMatchObject({ code: 'AUTOMATION_SPEECH_VOICE_MISMATCH' });
    expect(ready).not.toHaveBeenCalled(); expect(project).toEqual(before);
  });
});

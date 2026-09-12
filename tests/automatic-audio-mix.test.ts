import { expect, it } from 'vitest';
import { z } from 'zod';
import { automaticHash } from '../src/automation/application-evidence.js';
import { audioMixPlanningHash, automaticAudioMixTargets } from '../src/automation/audio-mix-basis.js';
import { audioMixReview } from '../src/automation/audio-mix-review.js';
import { planAutomaticAudioMix } from '../src/automation/plan-audio-mix.js';
import type { AudioMixPlanOptions, AudioMixPlanServices } from '../src/automation/plan-audio-mix.js';
import type { StructuredGenerationEngine } from '../src/codex/structured-engine.js';
import { audioVolumeAt, updateAudioMix } from '../src/domain/audio-mix.js';
import { analyzeAudioFileLevels } from '../src/domain/media-inspection.js';
import type { Project } from '../src/domain/schema.js';
import { parseProject, parseProjectSnapshotEvidence } from '../src/io/project.js';
import { BrowserAudioController } from '../web/src/audio-lifecycle.js';
import type { AudioElementPort } from '../web/src/audio-lifecycle.js';
import { automaticPlanProvenance } from './automatic-plan-helpers.js';
import { audioMixFixture, levelWav } from './automatic-audio-mix-helpers.js';

function options(maxCorrections: number): AudioMixPlanOptions {
  const { model: _model, turnId: _turn, prompt: _prompt, ...provenance } = automaticPlanProvenance(); return { provenance, maxCorrections };
}
function services(files: Map<string, Buffer>, model: StructuredGenerationEngine): AudioMixPlanServices {
  return { model, loadAudio: async (id): Promise<Buffer> => { const bytes = files.get(id); if (bytes === undefined) throw new Error(`검증 파일 누락: ${id}`); return bytes; }, onProgress: async (): Promise<void> => {} };
}
function engine(project: Project, volumeDb: number): StructuredGenerationEngine {
  return { run: async () => ({ model: 'mix-test', turnId: 'mix-turn', result: z.json().parse({ schemaVersion: '1.0.0', segmentId: 'demonstration', summary: '실제 동시 음원 기준',
    cues: automaticAudioMixTargets(project, 'demonstration').map((cue) => ({ cueId: cue.id, volumeDb, fadeInMs: cue.kind === 'sfx' ? 100 : 0, fadeOutMs: cue.kind === 'sfx' ? 100 : 0, reason: '원문 발화와 효과음이 함께 들리는 균형' })) }) }) };
}
function withoutMix(project: Project): object {
  return { ...project, audioCues: project.audioCues.map(({ mix: _mix, ...cue }) => cue), generationRecords: [] };
}

it('audio_mix_pcm_analysis_measures_16_24_bit_stereo_silence_and_rejects_corruption_and_abort', async (): Promise<void> => {
  for (const bits of [16, 24] as const) for (const channels of [1, 2] as const) {
    const bytes = levelWav(0.5, bits, channels); const original = Buffer.from(bytes);
    const levels = await analyzeAudioFileLevels(bytes, 'audio/wav', new AbortController().signal);
    expect(levels.peak).toBe(0.5); expect(levels.peakDbfs).toBeCloseTo(-6.0206, 4); expect(levels.rmsDbfs).toBeCloseTo(-6.0206, 4);
    expect(levels.sampleCount).toBe(48000 * channels); expect(levels.fullScaleSamples).toBe(0); expect(bytes).toEqual(original);
  }
  expect(await analyzeAudioFileLevels(levelWav(0, 16, 1), 'audio/wav', new AbortController().signal)).toMatchObject({ peakDbfs: null, rmsDbfs: null, silent: true });
  await expect(analyzeAudioFileLevels(Buffer.from('bad wav'), 'audio/wav', new AbortController().signal)).rejects.toMatchObject({ code: 'UNSUPPORTED_AUDIO_CONTAINER' });
  const abort = new AbortController(); const job = analyzeAudioFileLevels(levelWav(0.5, 24, 2), 'audio/wav', abort.signal); abort.abort();
  await expect(job).rejects.toMatchObject({ name: 'AbortError' });
});

it('automatic_audio_mix_corrects_actual_overlap_and_preserves_source_timing_assets_and_approvals', async (): Promise<void> => {
  const h = await audioMixFixture(); const before: string = automaticHash(h.project); let calls: number = 0; const prompts: string[] = [];
  const result = await planAutomaticAudioMix(h.project, 'demonstration', options(1), services(h.files, { run: async (input, signal) => {
    prompts.push(input.prompt); calls += 1; return engine(h.project, calls === 1 ? 0 : -6).run(input, signal);
  } }), new AbortController().signal);
  expect(calls).toBe(2); expect(prompts[1]).toContain('AUDIO_MIX_PEAK_BOUND_REVIEW'); expect(prompts[0]).toContain('rmsDbfs');
  expect(result.exceptions).toEqual([]); expect(withoutMix(result.project)).toEqual(withoutMix(h.project)); expect(automaticHash(h.project)).toBe(before);
  expect(result.project.generationRecords.slice(0, -1)).toEqual(h.project.generationRecords);
  expect(automaticAudioMixTargets(result.project, 'demonstration')).toEqual([]);
  expect(audioMixReview(result.project, h.speechId)).toMatchObject({ status: 'recorded', matchesCurrent: true, model: 'mix-test', problems: [] });
  const changed = updateAudioMix(result.project, h.speechId, { mode: 'manual', volumeDb: -4, fadeInMs: 0, fadeOutMs: 0 });
  expect(audioMixReview(changed, h.speechId)).toMatchObject({ matchesCurrent: false });
  expect(audioMixPlanningHash(changed, changed.audioCues.find((cue): boolean => cue.id === h.soundId)!)).not.toBe(result.project.audioCues.find((cue): boolean => cue.id === h.soundId)!.mix!.plannedInputHash);
});

it('automatic_audio_mix_preserves_manual_and_shared_protected_cues_and_bounds_model_scope_errors', async (): Promise<void> => {
  const h = await audioMixFixture(); const manual = updateAudioMix(h.project, h.soundId, { mode: 'manual', volumeDb: -9, fadeInMs: 50, fadeOutMs: 100 });
  expect(automaticAudioMixTargets(manual, 'demonstration').map((cue): string => cue.id)).toEqual([h.speechId]);
  const result = await planAutomaticAudioMix(manual, 'demonstration', options(0), services(h.files, engine(manual, -3)), new AbortController().signal);
  expect(result.project.audioCues.find((cue): boolean => cue.id === h.soundId)).toEqual(manual.audioCues.find((cue): boolean => cue.id === h.soundId));
  const locked: Project = { ...h.project, shots: h.project.shots.map((shot) => shot.segmentId === 'demonstration' ? { ...shot, lockedFields: ['timing'] } : shot) };
  expect(automaticAudioMixTargets(locked, 'demonstration')).toEqual([]);
  expect(() => updateAudioMix(locked, h.speechId, { mode: 'manual', volumeDb: -2, fadeInMs: 0, fadeOutMs: 0 })).toThrowError(expect.objectContaining({ code: 'AUDIO_MIX_PROTECTED' }));
  let calls: number = 0;
  await expect(planAutomaticAudioMix(manual, 'demonstration', options(1), services(h.files, { run: async (input, signal) => { calls += 1; return engine(h.project, -3).run(input, signal); } }), new AbortController().signal)).rejects.toMatchObject({ code: 'AUTOMATION_AUDIO_MIX_SCOPE' });
  expect(calls).toBe(2);
});

it('automatic_audio_mix_rejects_speech_fades_changed_wav_and_cancelled_result_and_keeps_residual_review', async (): Promise<void> => {
  const h = await audioMixFixture();
  const result = await planAutomaticAudioMix(h.project, 'demonstration', options(0), services(h.files, engine(h.project, 0)), new AbortController().signal);
  expect(result.exceptions).toContainEqual(expect.objectContaining({ code: 'AUDIO_MIX_PEAK_BOUND_REVIEW' }));
  await expect(planAutomaticAudioMix(h.project, 'demonstration', options(0), services(h.files, { run: async () => ({ model: 'test', turnId: 'test', result: { schemaVersion: '1.0.0', segmentId: 'demonstration', summary: '검증', cues: [h.speechId, h.soundId].map((cueId) => ({ cueId, volumeDb: -6, fadeInMs: 1, fadeOutMs: 0, reason: '검증' })) } }) }), new AbortController().signal)).rejects.toMatchObject({ code: 'AUTOMATION_SPEECH_FADE' });
  await expect(planAutomaticAudioMix(h.project, 'demonstration', options(0), services(h.files, { run: async (input, signal) => { h.files.set(`mix-${h.speechId}`, levelWav(0.2, 16, 1)); return engine(h.project, -6).run(input, signal); } }), new AbortController().signal)).rejects.toMatchObject({ code: 'ASSET_HASH_MISMATCH' });
  const fresh = await audioMixFixture(); const abort = new AbortController();
  await expect(planAutomaticAudioMix(fresh.project, 'demonstration', options(0), services(fresh.files, { run: async (input, signal) => { const output = await engine(fresh.project, -6).run(input, signal); abort.abort(); return output; } }), abort.signal)).rejects.toMatchObject({ code: 'AUTOMATION_CANCELLED' });
});

it('audio_mix_legacy_read_keeps_original_hash_and_does_not_invent_saved_settings', async (): Promise<void> => {
  const h = await audioMixFixture(); const legacy = { ...h.project, schemaVersion: '1.15.0' }; const before: string = JSON.stringify(legacy);
  const evidence = parseProjectSnapshotEvidence(legacy); expect(evidence.project.schemaVersion).toBe('1.22.0');
  expect(evidence.project.audioCues).toEqual(legacy.audioCues); expect(evidence.projectionHashes).toContain(automaticHash(legacy)); expect(JSON.stringify(legacy)).toBe(before);
  expect(() => parseProject({ ...legacy, audioCues: legacy.audioCues.map((cue) => ({ ...cue, mix: {} })) })).toThrowError(expect.objectContaining({ code: 'UNSUPPORTED_LEGACY_AUDIO_MIX' }));
});

it('audio_mix_browser_lifecycle_applies_gain_and_half_open_fades_without_altering_seek_or_stop', (): void => {
  const cue = { id: 'cue', startMs: 1000, endMs: 3000, mix: { version: '1.0.0' as const, mode: 'manual' as const, volumeDb: -6.020599913279624,
    fadeInMs: 500, fadeOutMs: 500, plannedInputHash: null, reason: '검증' } };
  const element: AudioElementPort = { currentTime: 0, volume: 1, playbackRate: 1, play: async (): Promise<void> => {}, pause: (): void => {} };
  const controller = new BrowserAudioController(() => element, { schedule: (): number => 1, cancel: (): void => {} });
  controller.start('project', cue, 1250, 'url', 1, (error): never => { throw error; });
  expect(element.currentTime).toBe(0.25); expect(element.volume).toBeCloseTo(0.25);
  controller.reconcile('project', 2000, true, 1); expect(element.volume).toBeCloseTo(0.5);
  controller.reconcile('project', 2750, true, 1); expect(element.volume).toBeCloseTo(0.25);
  controller.reconcile('project', 3000, true, 1); expect(controller.activeCount()).toBe(0);
  expect(audioVolumeAt(cue, 3000)).toBe(0); expect(audioVolumeAt({ startMs: 0, endMs: 100 }, 0)).toBe(1);
});

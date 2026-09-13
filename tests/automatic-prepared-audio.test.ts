import { legacyTextProject } from './legacy-text-helpers.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { createSegmentPlanBasis } from '../src/automation/plan-basis.js';
import { compileAutomaticSegmentPlan } from '../src/automation/plan-compiler.js';
import { planSourceRepair } from '../src/automation/plan-repair.js';
import { createSourceRepairBasis } from '../src/automation/repair-basis.js';
import { compileSourceRepair } from '../src/automation/repair-compiler.js';
import { attachAudioAsset, prepareAudioAsset } from '../src/domain/audio-asset.js';
import type { AudioAssetImportInput } from '../src/domain/audio-asset.js';
import { reviewFinalReadiness } from '../src/domain/final-readiness.js';
import { inspectAudioFileBytes } from '../src/domain/media-inspection.js';
import { reviewAudioPlaybackAt } from '../src/domain/playback.js';
import type { Project } from '../src/domain/schema.js';
import { updateAudioCueTiming } from '../src/domain/tracks.js';
import { parseProject } from '../src/io/project.js';
import { manualMissingSpeechProject, missingSpeechPlan } from './automatic-missing-speech-helpers.js';
import { automaticPlanProject, automaticPlanProvenance, demonstrationPlan, existingPlanAudio, stagedPlanSpeech } from './automatic-plan-helpers.js';
import { pcmWav, testAudioNormalizer } from './helpers.js';

const normalizers: ReturnType<typeof testAudioNormalizer>[] = [];
function normalizer(): ReturnType<typeof testAudioNormalizer> { const value = testAudioNormalizer(); normalizers.push(value); return value; }
afterEach(async (): Promise<void> => { await Promise.all(normalizers.splice(0).map(async (value): Promise<void> => value.close())); });
function input(durationMs: number): AudioAssetImportInput { return { originalFileName: '검증 음향.wav', declaredMimeType: 'audio/wav', bytes: pcmWav(durationMs, 44100, 2, 24) }; }
async function prepared(project: Project) { return prepareAudioAsset(project, 'audio-5', 'prepared-external', input(1200), normalizer()); }
function plan(project: Project) {
  const speech = missingSpeechPlan(project, 2300);
  if (speech.schemaVersion !== '1.1.0') throw new Error('검증 발화 계획이 없습니다.');
  return { ...speech, schemaVersion: '1.2.0' as const,
    links: speech.links.map((link) => link.unitId === '효과음' ? { ...link, startOffsetMs: 3000, endOffsetMs: 4200 } : link),
    audioTimings: [...speech.audioTimings, { cueId: 'audio-5', startMs: 8000, endMs: 9200, timingRelation: 'within-segment' as const, reason: '실제 파일 길이로 물소리를 배치한다.' }] };
}

describe('외부 효과음·음악 준비와 자동 배치', (): void => {
  it('automatic_prepared_audio_breaks_upload_gate_cycle_without_marking_timeline_ready', async (): Promise<void> => {
    const project = await manualMissingSpeechProject(); const snapshot = structuredClone(project);
    await expect(attachAudioAsset(project, 'audio-5', 'direct', input(1200), normalizer())).rejects.toMatchObject({ code: 'AUDIO_OUTPUT_GATE_BLOCKED' });
    const guessed: Project = { ...project, audioCues: project.audioCues.map((cue) => cue.id === 'audio-5' ? { ...cue, startMs: 8000, endMs: 8200 } : cue) };
    const result = await prepared(guessed);
    expect(result.project.audioCues.find((cue): boolean => cue.id === 'audio-5')).toMatchObject({ startMs: 5000, endMs: 13500, timingStatus: 'prepared', assetId: 'prepared-external' });
    expect(inspectAudioFileBytes(result.content, 'audio/wav')).toMatchObject({ durationMs: 1200, sampleRate: project.handoff.timebase.sampleRate, codec: 'pcm_s16le' });
    for (const key of ['dataset', 'shots', 'frames', 'textCues', 'generationRecords'] as const) expect(result.project[key]).toEqual(project[key]);
    expect(reviewAudioPlaybackAt(result.project, 5000).playable.some((cue): boolean => cue.id === 'audio-5')).toBe(false);
    expect(reviewFinalReadiness(result.project, {}).optionalAudioIssues).toContainEqual(expect.objectContaining({ code: 'AUDIO_PLACEMENT_REQUIRED', entityId: 'audio-5' }));
    expect(parseProject(result.project)).toEqual(result.project); expect(project).toEqual(snapshot);
    const narrowed = updateAudioCueTiming(result.project, 'audio-5', { startMs: 7000, endMs: 10000, timingRelation: 'within-segment' });
    expect(narrowed.audioCues.find((cue): boolean => cue.id === 'audio-5')).toMatchObject({ timingStatus: 'prepared', assetId: 'prepared-external', startMs: 7000, endMs: 10000 });
  });

  it('automatic_prepared_audio_repair_keeps_external_bytes_and_manual_cuts_while_placing_measured_sound', async (): Promise<void> => {
    const source = await manualMissingSpeechProject(); const ready = await prepared(source); const project = ready.project;
    const files = existingPlanAudio(project, [ready]);
    const result = compileSourceRepair(project, createSourceRepairBasis(project, 'demonstration'), plan(project), files, [stagedPlanSpeech(project)], automaticPlanProvenance(), 64);
    expect(result.project.audioCues.find((cue): boolean => cue.id === 'audio-5')).toMatchObject({ startMs: 8000, endMs: 9200, timingStatus: 'measured', assetId: 'prepared-external' });
    expect(result.project.assets[0]).toEqual(project.assets[0]); expect(result.writes).toHaveLength(1);
    expect(result.project.shots.map(({ sourceLinks: _links, ...shot }) => shot)).toEqual(project.shots.map(({ sourceLinks: _links, ...shot }) => shot));
    expect(result.project.textCues).toEqual(project.textCues); expect(result.project.dataset).toEqual(project.dataset);
    expect(result.project.generationRecords.filter((record): boolean => record.provider === 'macos-speech')).toHaveLength(1);
    expect(result.project.generationRecords[0]!.referenceHashes).toContain(ready.inspection.sha256);
    expect(reviewAudioPlaybackAt(result.project, 8000).playable.map((cue): string => cue.id)).toContain('audio-5');
    expect(result.exceptions.some((issue): boolean => issue.entityId === 'audio-5')).toBe(false);
    expect(reviewFinalReadiness(result.project, {}).issues.length).toBeGreaterThan(0);
  });

  it('automatic_prepared_audio_segment_plan_reuses_file_and_rejects_changed_existing_timings', async (): Promise<void> => {
    const ready = await prepared(await automaticPlanProject()); const project = ready.project;
    const base = demonstrationPlan(project);
    const modelPlan = { ...base, audioTimings: base.audioTimings.map((timing) => timing.cueId === 'audio-5' ? { ...timing, endMs: 9200 } : timing),
      shots: base.shots.map((shot) => ({ ...shot, sourceLinks: shot.sourceLinks.map((link) => link.unitId === '효과음' ? { ...link, endOffsetMs: 4200 } : link) })) };
    const files = existingPlanAudio(project, [ready]);
    const result = compileAutomaticSegmentPlan(project, createSegmentPlanBasis(project, 'demonstration', ['shot-2']), modelPlan, [stagedPlanSpeech(project)], files, automaticPlanProvenance(), 64);
    expect(result.project.audioCues.find((cue): boolean => cue.id === 'audio-5')).toMatchObject({ assetId: 'prepared-external', startMs: 8000, endMs: 9200, timingStatus: 'measured' });
    const storedFiles = existingPlanAudio(result.project, [ready, ...result.writes]);
    const moved = { ...modelPlan, audioTimings: modelPlan.audioTimings.map((timing) => timing.cueId === 'audio-5' ? { ...timing, startMs: 8100, endMs: 9300 } : timing) };
    expect(() => compileAutomaticSegmentPlan(result.project, createSegmentPlanBasis(result.project, 'demonstration', result.project.shots.filter((shot): boolean => shot.segmentId === 'demonstration').map((shot): string => shot.id)), moved, [], storedFiles,
      { ...automaticPlanProvenance(), generationId: 'repeat' }, 64)).toThrowError(expect.objectContaining({ code: 'AUTOMATION_EXISTING_AUDIO' }));
  });

  it('automatic_prepared_audio_rejects_missing_scope_stale_bytes_wrong_duration_and_early_emission', async (): Promise<void> => {
    const ready = await prepared(await manualMissingSpeechProject()); const project = ready.project;
    const basis = createSourceRepairBasis(project, 'demonstration'); const value = plan(project); const files = existingPlanAudio(project, [ready]);
    const run = (candidate: unknown) => compileSourceRepair(project, basis, candidate, files, [stagedPlanSpeech(project)], automaticPlanProvenance(), 64);
    expect(() => run({ ...value, schemaVersion: '1.1.0' })).toThrowError(expect.objectContaining({ code: 'AUTOMATION_REPAIR_AUDIO_VERSION' }));
    expect(() => run({ ...value, audioTimings: value.audioTimings.slice(0, 1) })).toThrowError(expect.objectContaining({ code: 'AUTOMATION_REPAIR_AUDIO_SCOPE' }));
    expect(() => run({ ...value, audioTimings: value.audioTimings.map((timing) => timing.cueId === 'audio-5' ? { ...timing, endMs: 9201 } : timing) })).toThrowError(expect.objectContaining({ code: 'AUTOMATION_PREPARED_AUDIO_DURATION' }));
    expect(() => run({ ...value, audioTimings: value.audioTimings.map((timing) => timing.cueId === 'audio-5' ? { ...timing, startMs: 4999, endMs: 6199 } : timing) })).toThrowError(expect.objectContaining({ code: 'AUTOMATION_PREPARED_AUDIO_WINDOW' }));
    const gated: Project = { ...project, dataset: { ...project.dataset, informationRules: project.dataset.informationRules.map((rule) => rule.id === 'reveal:효과음' ? { ...rule, baseNotBeforeMs: 8000 } : rule) } };
    expect(() => compileSourceRepair(gated, createSourceRepairBasis(gated, 'demonstration'), { ...value, audioTimings: value.audioTimings.map((timing) => timing.cueId === 'audio-5' ? { ...timing, startMs: 7000, endMs: 8200 } : timing) }, files, [stagedPlanSpeech(gated)], automaticPlanProvenance(), 64)).toThrowError(expect.objectContaining({ code: 'AUTOMATION_REPAIR_INVALID' }));
    expect(() => compileSourceRepair(project, basis, value, [{ ...files[0]!, bytes: Buffer.from('changed') }], [stagedPlanSpeech(project)], automaticPlanProvenance(), 64)).toThrow();
    expect(() => compileSourceRepair({ ...project, revision: 1 }, basis, value, files, [stagedPlanSpeech(project)], automaticPlanProvenance(), 64)).toThrowError(expect.objectContaining({ code: 'AUTOMATION_STALE_PLAN' }));
  });

  it('automatic_prepared_audio_preserves_protection_and_old_schema_without_inventing_preparation', async (): Promise<void> => {
    const project = await manualMissingSpeechProject();
    await expect(prepareAudioAsset(project, 'audio-3', 'invalid', input(1200), normalizer())).rejects.toMatchObject({ code: 'AUDIO_PREPARATION_KIND' });
    await expect(prepareAudioAsset(project, 'audio-5', 'long', input(9000), normalizer())).rejects.toMatchObject({ code: 'AUDIO_PREPARATION_TOO_LONG' });
    for (const protectedProject of [
      { ...project, shots: project.shots.map((shot) => shot.id === 'shot-2' ? { ...shot, lockedFields: ['timing' as const] } : shot) },
      { ...project, shots: project.shots.map((shot) => shot.id === 'shot-2' ? { ...shot, approvalStatus: 'approved' as const } : shot) },
      { ...project, frames: project.frames.map((frame) => frame.shotId === 'shot-2' ? { ...frame, visualReview: 'accepted' as const } : frame) },
    ]) await expect(prepared(protectedProject)).rejects.toMatchObject({ code: 'AUDIO_PREPARATION_PROTECTED' });
    const music: Project = { ...project, dataset: { ...project.dataset, units: project.dataset.units.map((unit) => unit.id === '효과음' ? { ...unit, kind: 'MUSIC' } : unit) },
      audioCues: project.audioCues.map((cue) => cue.id === 'audio-5' ? { ...cue, kind: 'music' } : cue) };
    const musicReady = await prepared(music);
    const musicResult = compileSourceRepair(musicReady.project, createSourceRepairBasis(musicReady.project, 'demonstration'), plan(musicReady.project), existingPlanAudio(musicReady.project, [musicReady]), [stagedPlanSpeech(musicReady.project)], automaticPlanProvenance(), 64);
    expect(musicResult.project.audioCues.find((cue): boolean => cue.id === 'audio-5')).toMatchObject({ kind: 'music', timingStatus: 'measured', assetId: 'prepared-external' });
    const legacy = { ...legacyTextProject(project), schemaVersion: '1.11.0' }; const snapshot = structuredClone(legacy);
    expect(parseProject(legacy)).toEqual({ ...project, textLayoutControl: { version: '1.0.0', mode: 'manual', plannedInputHash: null } }); expect(legacy).toEqual(snapshot);
    const ready = await prepared(project);
    expect(() => parseProject({ ...ready.project, schemaVersion: '1.11.0' })).toThrowError(expect.objectContaining({ code: 'UNSUPPORTED_LEGACY_AUDIO_PREPARATION' }));
    const replaced = await prepareAudioAsset(ready.project, 'audio-5', 'prepared-v2', input(1200), normalizer());
    expect(replaced.project.assets.slice(0, 1)).toEqual(ready.project.assets); expect(replaced.project.assets[1]!.version).toBe(2);
  });

  it('automatic_prepared_audio_model_correction_reuses_external_file_without_synthesizing_sound', async (): Promise<void> => {
    const ready = await prepared(await manualMissingSpeechProject()); const project = ready.project; const value = plan(project);
    const { model: _model, turnId: _turn, prompt: _prompt, ...provenance } = automaticPlanProvenance();
    let calls: number = 0;
    const model = { run: vi.fn(async () => ({ model: 'test', turnId: 'prepared-audio', result: z.json().parse(++calls === 1 ? { ...value,
      audioTimings: value.audioTimings.map((timing) => timing.cueId === 'audio-5' ? { ...timing, endMs: 9201 } : timing) } : value) })) };
    const speech = { run: vi.fn(async () => stagedPlanSpeech(project).result) };
    const load = vi.fn(async (): Promise<Buffer> => Buffer.from(ready.content));
    const result = await planSourceRepair(project, createSourceRepairBasis(project, 'demonstration'), { provenance, voice: { name: 'Yuna', rateWordsPerMinute: 180 }, maxCorrections: 1, maxFrames: 64, maxAudioBytes: 5_000_000 },
      { model, speech, loadExistingAudio: load, onProgress: async (): Promise<void> => {}, onSpeechReady: async (): Promise<void> => {} }, new AbortController().signal);
    expect(model.run).toHaveBeenCalledTimes(2); expect(load).toHaveBeenCalledTimes(1); expect(speech.run).toHaveBeenCalledTimes(1);
    expect(result.project.audioCues.find((cue): boolean => cue.id === 'audio-5')!.assetId).toBe('prepared-external');
  });
});

import { z } from 'zod';
import { describe, expect, it, vi } from 'vitest';
import { planSourceRepair } from '../src/automation/plan-repair.js';
import type { SourceRepairOptions, SourceRepairServices } from '../src/automation/plan-repair.js';
import { createSourceRepairBasis, sourceRepairScope } from '../src/automation/repair-basis.js';
import { compileSourceRepair } from '../src/automation/repair-compiler.js';
import { inspectAudioFileBytes } from '../src/domain/media-inspection.js';
import type { Project } from '../src/domain/schema.js';
import { manualMissingSpeechProject, missingSpeechPlan } from './automatic-missing-speech-helpers.js';
import { automaticPlanProvenance, stagedPlanSpeech } from './automatic-plan-helpers.js';

function options(): SourceRepairOptions {
  const { model: _model, turnId: _turnId, prompt: _prompt, ...provenance } = automaticPlanProvenance();
  return { provenance, voice: { name: 'Yuna', rateWordsPerMinute: 180 }, maxCorrections: 1, maxFrames: 64, maxAudioBytes: 5_000_000 };
}

describe('편집 컷의 미등록 가이드 음성', (): void => {
  it('automatic_repair_stages_missing_speech_and_preserves_cut_text_and_external_audio', async (): Promise<void> => {
    const project = await manualMissingSpeechProject(); const before = structuredClone(project);
    const staged = stagedPlanSpeech(project); const basis = createSourceRepairBasis(project, 'demonstration');
    expect(basis.speechCueIds).toEqual([staged.cueId]);
    const result = compileSourceRepair(project, basis, missingSpeechPlan(project, 2300), [], [staged], automaticPlanProvenance(), 64);
    expect(result.project.shots.map(({ sourceLinks: _links, ...shot }) => shot)).toEqual(project.shots.map(({ sourceLinks: _links, ...shot }) => shot));
    for (const key of ['dataset', 'textCues', 'textMappingDecisions', 'profile', 'frames'] as const) expect(result.project[key]).toEqual(project[key]);
    expect(result.project.audioCues.find((cue): boolean => cue.id === staged.cueId)).toMatchObject({ startMs: 5000, endMs: 7300, timingStatus: 'measured', assetId: expect.any(String) });
    expect(result.project.audioCues.filter((cue): boolean => cue.id !== staged.cueId)).toEqual(project.audioCues.filter((cue): boolean => cue.id !== staged.cueId));
    expect(inspectAudioFileBytes(result.writes[0]!.content, 'audio/wav').durationMs).toBe(2300);
    expect(result.project.generationRecords).toHaveLength(2);
    expect(result.project.generationRecords[1]).toMatchObject({ provider: 'macos-speech', resultAssetIds: [result.project.audioCues.find((cue): boolean => cue.id === staged.cueId)!.assetId] });
    expect(result.exceptions).not.toContainEqual(expect.objectContaining({ code: 'AUDIO_NOT_MEASURED', entityId: 'audio-5' }));
    expect(result.exceptions).toContainEqual(expect.objectContaining({ code: 'FRAME_IMAGE_REQUIRED_FOR_OUTPUT' }));
    expect(project).toEqual(before);
    for (const kind of ['SOUND', 'MUSIC', 'CHAT'] as const) {
      const nonSpeech: Project = { ...project, dataset: { ...project.dataset, units: project.dataset.units.map((unit) => unit.id === staged.result.unitId ? { ...unit, kind } : unit) } };
      expect(() => compileSourceRepair(nonSpeech, createSourceRepairBasis(nonSpeech, 'demonstration'), missingSpeechPlan(nonSpeech, 2300), [], [staged], automaticPlanProvenance(), 64)).toThrowError(expect.objectContaining({ code: 'AUTOMATION_SPEECH_KIND' }));
    }
  });

  it('automatic_repair_rejects_missing_duplicate_foreign_speech_timings_and_changed_audio_windows', async (): Promise<void> => {
    const project = await manualMissingSpeechProject(); const staged = stagedPlanSpeech(project);
    const basis = createSourceRepairBasis(project, 'demonstration'); const plan = missingSpeechPlan(project, 2300);
    if (plan.schemaVersion !== '1.1.0') throw new Error('음성 배치 계획이 필요합니다.');
    const timing = plan.audioTimings[0]!;
    for (const audioTimings of [[], [timing, timing], [{ ...timing, cueId: 'audio-5' }]]) {
      expect(() => compileSourceRepair(project, basis, { ...plan, audioTimings }, [], [staged], automaticPlanProvenance(), 64)).toThrowError(expect.objectContaining({ code: 'AUTOMATION_REPAIR_AUDIO_SCOPE' }));
    }
    for (const speech of [[staged, staged], [{ ...staged, cueId: 'foreign' }]]) expect(() => compileSourceRepair(project, basis, plan, [], speech, automaticPlanProvenance(), 64)).toThrowError(expect.objectContaining({ code: 'AUTOMATION_REPAIR_AUDIO_SCOPE' }));
    const storyboard = compileSourceRepair(project, basis, plan, [], [], automaticPlanProvenance(), 64);
    expect(storyboard.writes).toEqual([]);
    expect(storyboard.project.audioCues.find((cue): boolean => cue.id === staged.cueId)).toMatchObject({ assetId: null, timingStatus: 'proposed', startMs: timing.startMs, endMs: timing.endMs });
    for (const changed of [{ ...timing, startMs: 4999, endMs: 7299 }, { ...timing, startMs: 12000, endMs: 14300 }, { ...timing, timingRelation: 'j-cut' }]) {
      expect(() => compileSourceRepair(project, basis, { ...plan, audioTimings: [changed] }, [], [staged], automaticPlanProvenance(), 64)).toThrowError(expect.objectContaining({ code: 'AUTOMATION_REPAIR_AUDIO_WINDOW' }));
    }
    expect(() => compileSourceRepair(project, basis, { ...plan, audioTimings: [{ ...timing, endMs: 7301 }] }, [], [staged], automaticPlanProvenance(), 64)).toThrowError(expect.objectContaining({ code: 'AUTOMATION_SPEECH_DURATION' }));
    expect(() => compileSourceRepair({ ...project, revision: 1 }, basis, plan, [], [staged], automaticPlanProvenance(), 64)).toThrowError(expect.objectContaining({ code: 'AUTOMATION_STALE_PLAN' }));
  });

  it('automatic_repair_prepares_voice_once_across_correction_and_cannot_fit_it_by_stretching', async (): Promise<void> => {
    const project = await manualMissingSpeechProject(); const staged = stagedPlanSpeech(project); const plan = missingSpeechPlan(project, 2300);
    if (plan.schemaVersion !== '1.1.0') throw new Error('음성 배치 계획이 필요합니다.');
    let calls: number = 0;
    const services: SourceRepairServices = {
      speech: { run: vi.fn(async () => staged.result) }, loadExistingAudio: async (): Promise<never> => { throw new Error('등록한 음원이 없습니다.'); },
      onProgress: vi.fn(async (): Promise<void> => {}), onSpeechReady: vi.fn(async (): Promise<void> => {}),
      model: { run: vi.fn(async () => ({ model: 'test', turnId: 'missing-speech', result: z.json().parse(++calls === 1 ? { ...plan, audioTimings: plan.audioTimings.map((timing) => ({ ...timing, endMs: 7301 })) } : plan) })) },
    };
    const result = await planSourceRepair(project, createSourceRepairBasis(project, 'demonstration'), options(), services, new AbortController().signal);
    expect(services.speech.run).toHaveBeenCalledTimes(1); expect(services.model.run).toHaveBeenCalledTimes(2); expect(services.onSpeechReady).toHaveBeenCalledTimes(1); expect(result.writes).toHaveLength(1);
    const short: Project = { ...project, audioCues: project.audioCues.map((cue) => cue.id === staged.cueId ? { ...cue, endMs: 6000 } : cue) };
    calls = 1;
    await expect(planSourceRepair(short, createSourceRepairBasis(short, 'demonstration'), options(), services, new AbortController().signal)).rejects.toMatchObject({ code: 'AUTOMATION_REPAIR_AUDIO_WINDOW' });
  });

  it('automatic_repair_protects_missing_voices_shared_with_approved_or_locked_cuts', async (): Promise<void> => {
    const project = await manualMissingSpeechProject();
    for (const protectedProject of [
      { ...project, shots: project.shots.map((shot) => shot.id === 'shot-2' ? { ...shot, approvalStatus: 'approved' as const } : shot) },
      { ...project, shots: project.shots.map((shot) => shot.id === 'shot-2' ? { ...shot, lockedFields: ['timing' as const] } : shot) },
      { ...project, frames: project.frames.map((frame) => frame.shotId === 'shot-2' ? { ...frame, visualReview: 'accepted' as const } : frame) },
    ]) expect(sourceRepairScope(protectedProject, 'demonstration').speechCueIds).toEqual([]);
    const overlap: Project = { ...project, shots: project.shots.map((shot) => shot.id === 'shot-1' ? { ...shot, endMs: 6000, approvalStatus: 'approved' } : shot) };
    expect(sourceRepairScope(overlap, 'demonstration').speechCueIds).toEqual([]);
  });

  it('automatic_repair_stops_on_bad_voice_bytes_budget_and_cancellation_before_planning', async (): Promise<void> => {
    const project = await manualMissingSpeechProject(); const staged = stagedPlanSpeech(project); const stop = new AbortController();
    const services: SourceRepairServices = { speech: { run: vi.fn(async () => ({ ...staged.result, bytes: Buffer.from('broken WAV') })) },
      model: { run: vi.fn(async (): Promise<never> => { throw new Error('잘못된 음원으로 계획할 수 없습니다.'); }) },
      loadExistingAudio: async (): Promise<never> => { throw new Error('기존 음원이 없습니다.'); }, onProgress: async (): Promise<void> => {}, onSpeechReady: vi.fn(async (): Promise<void> => {}) };
    const basis = createSourceRepairBasis(project, 'demonstration');
    await expect(planSourceRepair(project, basis, options(), services, stop.signal)).rejects.toThrow();
    expect(services.model.run).not.toHaveBeenCalled(); expect(services.onSpeechReady).not.toHaveBeenCalled();
    await expect(planSourceRepair(project, basis, { ...options(), maxAudioBytes: 0 }, services, stop.signal)).rejects.toMatchObject({ code: 'AUTOMATION_AUDIO_BUDGET' });
    stop.abort(); await expect(planSourceRepair(project, basis, options(), services, stop.signal)).rejects.toMatchObject({ code: 'AUTOMATION_CANCELLED' });
    expect(services.speech.run).toHaveBeenCalledTimes(1);
  });
});

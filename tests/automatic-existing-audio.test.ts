import { TEST_TEXT_FONT_PATH } from './helpers.js';
import { z } from 'zod';
import { describe, expect, it, vi } from 'vitest';
import { existingAudioEvidence, validateExistingAudioScope } from '../src/automation/plan-audio.js';
import type { ExistingAudioFile } from '../src/automation/plan-audio.js';
import { createSegmentPlanBasis } from '../src/automation/plan-basis.js';
import { compileAutomaticSegmentPlan } from '../src/automation/plan-compiler.js';
import type { AutomaticCandidate } from '../src/automation/plan-compiler.js';
import { planAutomaticSegment } from '../src/automation/plan-segment.js';
import type { AutomaticPlanOptions, AutomaticPlanServices } from '../src/automation/plan-segment.js';
import type { StructuredGenerationInput } from '../src/codex/structured-engine.js';
import { inspectAudioFileBytes } from '../src/domain/media-inspection.js';
import type { Project } from '../src/domain/schema.js';
import { updateAudioCueTiming } from '../src/domain/tracks.js';
import { automaticPlanProject, automaticPlanProvenance, demonstrationPlan, existingPlanAudio, stagedPlanSpeech } from './automatic-plan-helpers.js';
import { pcmWav } from './helpers.js';

async function prepared(): Promise<AutomaticCandidate> {
  const source = await automaticPlanProject();
  return compileAutomaticSegmentPlan(source, createSegmentPlanBasis(source, 'demonstration', ['shot-2']), demonstrationPlan(source), [stagedPlanSpeech(source)], [], automaticPlanProvenance(), 64);
}

function basis(project: Project) {
  return createSegmentPlanBasis(project, 'demonstration', project.shots.filter((shot): boolean => shot.segmentId === 'demonstration').map((shot): string => shot.id));
}

function options(): AutomaticPlanOptions {
  const { model: _model, turnId: _turn, prompt: _prompt, ...provenance } = automaticPlanProvenance();
  return { density: null, voice: { name: 'Yuna', rateWordsPerMinute: 180 }, maxCorrections: 1, maxFrames: 64, maxStagedAudioBytes: 5_000_000, provenance: { ...provenance, generationId: 'verified-existing-audio' } };
}

function servicesFor(files: readonly ExistingAudioFile[], plan: unknown): AutomaticPlanServices {
  return { textFontPath: TEST_TEXT_FONT_PATH,
    speech: { run: vi.fn(async (): Promise<never> => { throw new Error('기존 음원은 다시 합성하지 않습니다.'); }) },
    model: { run: vi.fn(async () => ({ model: 'test', turnId: 'existing-audio-turn', result: z.json().parse(plan) })) },
    loadExistingAudio: vi.fn(async (assetId: string): Promise<Buffer> => {
      const file = files.find((value): boolean => value.assetId === assetId);
      if (file === undefined) throw new Error(`검증 음원을 찾을 수 없습니다: ${assetId}`);
      return Buffer.from(file.bytes);
    }),
    onProgress: vi.fn(async (): Promise<void> => {}), onSpeechReady: vi.fn(async (): Promise<void> => {}),
  };
}

describe('기존 WAV 실측 재검증', (): void => {
  it('automatic_existing_audio_restores_measurement_after_user_move_without_retiming_or_new_media', async (): Promise<void> => {
    const first = await prepared(); const file = existingPlanAudio(first.project, first.writes)[0]!;
    const moved = updateAudioCueTiming(first.project, file.cueId, { startMs: 6000, endMs: 8300, timingRelation: 'within-segment' });
    expect(moved.audioCues.find((cue): boolean => cue.id === file.cueId)).toMatchObject({ timingStatus: 'proposed', assetId: file.assetId });
    const basePlan = demonstrationPlan(moved); const shot = basePlan.shots[0]!;
    const plan = { ...basePlan, shots: [
      { ...shot, startMs: 5000, endMs: 6000, visualMode: 'black', visualLocationId: null, action: '사용자가 정한 발화 전 검증용 검은 화면.', sourceLinks: [], frames: [{ role: 'start', offsetMs: 0, description: '검은 화면' }] },
      { ...shot, startMs: 6000, sourceLinks: shot.sourceLinks.map((link) => ({ ...link,
        startOffsetMs: link.unitId === '효과음' ? 2000 : 0, endOffsetMs: link.unitId === '안내-1' ? 2300 : link.unitId === '동작' ? 7500 : 2200 })) },
    ], audioTimings: basePlan.audioTimings.map((timing) => timing.cueId === file.cueId ? { ...timing, startMs: 6000, endMs: 8300 } : timing) };
    const snapshot = structuredClone(moved); const services = servicesFor([file], plan);
    const result = await planAutomaticSegment(moved, basis(moved), options(), services, new AbortController().signal);
    expect(result.project.audioCues.find((cue): boolean => cue.id === file.cueId)).toMatchObject({ startMs: 6000, endMs: 8300, timingStatus: 'measured', assetId: file.assetId });
    expect(result.writes).toEqual([]); expect(result.project.assets).toEqual(moved.assets);
    expect(result.project.generationRecords.slice(0, moved.generationRecords.length)).toEqual(moved.generationRecords);
    expect(result.project.generationRecords.filter((record): boolean => record.provider === 'macos-speech')).toHaveLength(1);
    const record = result.project.generationRecords.at(-1)!;
    expect(JSON.parse(record.prompt)).toMatchObject({ existingAudio: [{ cueId: file.cueId, previousTimingStatus: 'proposed', startMs: 6000, endMs: 8300 }] });
    expect(record.referenceHashes).toContain(first.project.assets[0]!.sha256);
    expect(services.speech.run).not.toHaveBeenCalled(); expect(services.onSpeechReady).not.toHaveBeenCalled();
    expect(services.onProgress).toHaveBeenCalledWith(expect.objectContaining({ phase: 'audio-check' }));
    expect(result.project.frames.every((frame): boolean => frame.visualReview === 'pending')).toBe(true);
    expect(result.exceptions).toEqual([]); expect(moved).toEqual(snapshot);
  });

  it('automatic_existing_audio_requires_exact_cue_asset_source_and_actual_file_evidence', async (): Promise<void> => {
    const first = await prepared(); const files = existingPlanAudio(first.project, first.writes); const file = files[0]!;
    for (const input of [[], [...files, ...files], [{ ...file, cueId: 'different-cue' }]]) expect(() => validateExistingAudioScope(first.project, 'demonstration', input)).toThrow();
    expect(() => existingAudioEvidence(first.project, { ...file, assetId: 'different-asset' })).toThrowError(expect.objectContaining({ code: 'AUTOMATION_EXISTING_AUDIO_BINDING' }));
    const foreign: Project = { ...first.project, assets: first.project.assets.map((asset) => ({ ...asset, subjectId: 'another-cue' })) };
    expect(() => existingAudioEvidence(foreign, file)).toThrowError(expect.objectContaining({ code: 'AUTOMATION_EXISTING_AUDIO_BINDING' }));
    const missing: Project = { ...first.project, dataset: { ...first.project.dataset, units: first.project.dataset.units.filter((unit): boolean => unit.id !== '안내-1') } };
    expect(() => existingAudioEvidence(missing, file)).toThrowError(expect.objectContaining({ code: 'AUTOMATION_EXISTING_AUDIO_BINDING' }));
  });

  it('automatic_existing_audio_rejects_corrupt_bytes_metadata_rate_and_duration_before_model', async (): Promise<void> => {
    const first = await prepared(); const file = existingPlanAudio(first.project, first.writes)[0]!; const bytes = Buffer.from(file.bytes); bytes[100] = bytes[100]! ^ 1;
    const variants: { project: Project; file: ExistingAudioFile; code: string }[] = [
      { project: first.project, file: { ...file, bytes }, code: 'ASSET_HASH_MISMATCH' },
      { project: { ...first.project, assets: first.project.assets.map((asset) => ({ ...asset, durationMs: 2301 })) }, file, code: 'AUDIO_ASSET_METADATA_MISMATCH' },
      { project: { ...first.project, handoff: { ...first.project.handoff, timebase: { ...first.project.handoff.timebase, sampleRate: 44100 } } }, file, code: 'AUDIO_ASSET_NORMALIZATION_REQUIRED' },
      { project: { ...first.project, audioCues: first.project.audioCues.map((cue) => cue.id === file.cueId ? { ...cue, endMs: cue.endMs + 1, timingStatus: 'proposed' } : cue) }, file, code: 'AUTOMATION_EXISTING_AUDIO_TIMING' },
    ];
    for (const variant of variants) {
      const snapshot = structuredClone(variant.project); const services = servicesFor([variant.file], demonstrationPlan(variant.project));
      await expect(planAutomaticSegment(variant.project, basis(variant.project), options(), services, new AbortController().signal)).rejects.toMatchObject({ code: variant.code });
      expect(services.model.run).not.toHaveBeenCalled(); expect(services.speech.run).not.toHaveBeenCalled(); expect(variant.project).toEqual(snapshot);
    }
  });

  it('automatic_existing_audio_preserves_user_timing_through_bounded_model_correction', async (): Promise<void> => {
    const first = await prepared(); const files = existingPlanAudio(first.project, first.writes); const plan = demonstrationPlan(first.project);
    const invalid = { ...plan, audioTimings: plan.audioTimings.map((timing) => timing.cueId === files[0]!.cueId ? { ...timing, startMs: timing.startMs + 1, endMs: timing.endMs + 1 } : timing) };
    const services = servicesFor(files, plan); const inputs: StructuredGenerationInput[] = [];
    services.model.run = vi.fn(async (input) => { inputs.push(input); return { model: 'test', turnId: `turn-${inputs.length}`, result: z.json().parse(inputs.length === 1 ? invalid : plan) }; });
    const candidate = await planAutomaticSegment(first.project, basis(first.project), options(), services, new AbortController().signal);
    expect(inputs).toHaveLength(2); expect(inputs[0]!.prompt).toContain('"existingAudio":['); expect(inputs[1]!.prompt).toContain('AUTOMATION_EXISTING_AUDIO');
    expect(candidate.project.audioCues).toEqual(first.project.audioCues); expect(services.speech.run).not.toHaveBeenCalled();
    expect(() => compileAutomaticSegmentPlan(first.project, basis(first.project), plan, [stagedPlanSpeech(first.project)], files, { ...automaticPlanProvenance(), generationId: 'duplicate-speech' }, 64)).toThrowError(expect.objectContaining({ code: 'AUTOMATION_EXISTING_AUDIO' }));
  });

  it('automatic_existing_audio_checks_cancellation_memory_budget_and_missing_measured_asset', async (): Promise<void> => {
    const first = await prepared(); const files = existingPlanAudio(first.project, first.writes); const services = servicesFor(files, demonstrationPlan(first.project));
    await expect(planAutomaticSegment(first.project, basis(first.project), { ...options(), maxStagedAudioBytes: 50 }, services, new AbortController().signal)).rejects.toMatchObject({ code: 'AUTOMATION_AUDIO_BUDGET' });
    const stop = new AbortController(); services.onProgress = async (): Promise<void> => { stop.abort(); };
    await expect(planAutomaticSegment(first.project, basis(first.project), options(), services, stop.signal)).rejects.toMatchObject({ code: 'AUTOMATION_CANCELLED' });
    const unbound: Project = { ...first.project, audioCues: first.project.audioCues.map((cue) => cue.id === files[0]!.cueId ? { ...cue, assetId: null } : cue) };
    await expect(planAutomaticSegment(unbound, basis(unbound), options(), services, new AbortController().signal)).rejects.toMatchObject({ code: 'AUTOMATION_EXISTING_AUDIO_REVIEW' });
    expect(services.model.run).not.toHaveBeenCalled(); expect(services.speech.run).not.toHaveBeenCalled();
  });

  it('automatic_existing_audio_revalidates_real_sfx_without_creating_speech_or_forging_approval', async (): Promise<void> => {
    const first = await prepared(); const cue = first.project.audioCues.find((value): boolean => value.unitId === '효과음')!;
    const bytes = pcmWav(200, first.project.handoff.timebase.sampleRate, 1, 16); const inspected = inspectAudioFileBytes(bytes, 'audio/wav');
    // 이전 저장본에 이미 등록된 실제 효과음을 구성한다. 신규 업로드나 생성 성공을 모사하지 않는다.
    const recorded: Project = { ...first.project, assets: [...first.project.assets, { id: 'recorded-water', kind: 'audio', subjectId: cue.id, path: 'assets/recorded-water.wav', version: 1,
      mimeType: 'audio/wav', sha256: inspected.sha256, durationMs: inspected.durationMs, description: '검증용 물소리 파일', audioMetadata: { sampleRate: inspected.sampleRate, channels: inspected.channels, codec: inspected.codec } }],
      audioCues: first.project.audioCues.map((value) => value.id === cue.id ? { ...value, assetId: 'recorded-water', timingStatus: 'measured' } : value) };
    const pending = updateAudioCueTiming(recorded, cue.id, { startMs: 9000, endMs: 9200, timingRelation: 'within-segment' });
    const plan = demonstrationPlan(pending);
    plan.audioTimings = plan.audioTimings.map((timing) => timing.cueId === cue.id ? { ...timing, startMs: 9000, endMs: 9200 } : timing);
    plan.shots = plan.shots.map((shot) => ({ ...shot, sourceLinks: shot.sourceLinks.map((link) => link.unitId === cue.unitId ? { ...link, startOffsetMs: 4000, endOffsetMs: 4200 } : link) }));
    const files = existingPlanAudio(pending, [...first.writes, { relativePath: 'assets/recorded-water.wav', content: bytes }]);
    const result = compileAutomaticSegmentPlan(pending, basis(pending), plan, [], files, { ...automaticPlanProvenance(), generationId: 'reuse-recorded-sfx' }, 64);
    expect(result.project.audioCues.find((value): boolean => value.id === cue.id)).toMatchObject({ assetId: 'recorded-water', timingStatus: 'measured', startMs: 9000, endMs: 9200 });
    expect(result.exceptions).toEqual([]); expect(result.writes).toEqual([]); expect(result.project.assets).toEqual(pending.assets);
    expect(result.project.generationRecords.filter((record): boolean => record.provider === 'macos-speech')).toHaveLength(1);
    expect(result.project.shots.every((shot): boolean => shot.approvalStatus === 'proposed')).toBe(true);
  });
});

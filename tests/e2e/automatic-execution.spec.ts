import { test, expect } from '@playwright/test';
import { z } from 'zod';
import { join } from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';
import { automaticHash } from '../../src/automation/application-evidence.js';
import { AutomationRunExecutor } from '../../src/automation/run-executor.js';
import { AutomaticSpeechCache } from '../../src/automation/speech-cache.js';
import { executeAutomaticTask } from '../../src/automation/task-executor.js';
import { createSegmentPlanBasis } from '../../src/automation/plan-basis.js';
import { compileAutomaticSegmentPlan } from '../../src/automation/plan-compiler.js';
import type { Project } from '../../src/domain/schema.js';
import { sha256Text } from '../../src/importers/integrity.js';
import { automaticPlanProvenance, demonstrationPlan, stagedPlanSpeech } from '../automatic-plan-helpers.js';
import { createExecutionHarness, initial, settings } from '../automatic-executor-helpers.js';
import { manualRepairInput, repairPlan } from '../automatic-repair-helpers.js';
import { manualMissingSpeechProject, missingSpeechPlan } from '../automatic-missing-speech-helpers.js';

test('automatic_executor_runs_production_references_measured_speech_shots_and_frames_to_pending_review', async (): Promise<void> => {
    const h = await createExecutionHarness(async (): Promise<void> => {});
    try {
      const executor = new AutomationRunExecutor(h.services);
      const result = await executor.run(h.id, new AbortController().signal);
      expect(result.run.status).toBe('review-ready');
      expect(result.run.jobs.map((job): string => job.task.kind)).toEqual(['production', 'reference', 'segment', 'image']);
      expect(result.run.jobs.every((job): boolean => job.attempts.length === 1 && job.attempts[0]!.status === 'completed')).toBe(true);
      const project = await h.services.projects.read(h.source.projectId);
      expect(project.revision).toBe(4); expect(project.dataset).toEqual(h.source.dataset);
      const shot = project.shots.find((value): boolean => value.segmentId === 'demonstration')!;
      const frame = project.frames.find((value): boolean => value.shotId === shot.id)!;
      expect(frame.visualReview).toBe('pending'); expect(frame.imageAssetId).not.toBeNull();
      expect(shot.approvalStatus).toBe('proposed'); expect(shot.sourceLinks.every((link): boolean => link.status === 'confirmed')).toBe(true);
      expect((await h.services.projects.asset(project.projectId, frame.imageAssetId!)).mimeType).toBe('image/png');
      expect(project.audioCues.find((cue): boolean => cue.unitId === '안내-1')?.timingStatus).toBe('measured');
      expect(project.audioCues.find((cue): boolean => cue.unitId === '효과음')?.assetId).toBeNull();
      expect(project.generationRecords.filter((record): boolean => record.provider === 'codex-app')).toHaveLength(4);
      expect(project.generationRecords.filter((record): boolean => record.provider === 'macos-speech')).toHaveLength(1);
      expect(await executor.run(h.id, new AbortController().signal)).toEqual(result);
    } finally { await h.close(); }
  });

test('automatic_executor_resume_reuses_persisted_speech_after_interruption_before_model_planning', async (): Promise<void> => {
  const h = await createExecutionHarness(async (): Promise<void> => {});
  try {
    const stop = new AbortController(); const original = h.engine.speech.run;
    let speechCalls: number = 0;
    let generatedAt: string | undefined;
    h.engine.speech.run = async (input, signal) => { speechCalls += 1; return original(input, signal); };
    h.services.onSpeechReady = async (_run, _attempt, speech): Promise<void> => { generatedAt = speech.result.cacheEvidence?.generatedAt; stop.abort(); };
    const paused = await new AutomationRunExecutor(h.services).run(h.id, stop.signal);
    expect(paused.run.status).toBe('paused'); expect(speechCalls).toBe(1);
    const project = await h.services.projects.read(h.source.projectId);
    expect(project.revision).toBe(2); expect(project.audioCues.every((cue): boolean => cue.assetId === null)).toBe(true);
    const reopened = new AutomaticSpeechCache(join(h.root, 'automatic'), async (): Promise<void> => {}); await reopened.initialize();
    h.services.speechCache = reopened;
    h.services.onSpeechReady = async (_run, _attempt, speech): Promise<void> => { expect(speech.result.cacheEvidence).toMatchObject({ generatedAt, reused: true }); };
    await h.services.runs.append(h.id, paused.sequence, { type: 'resumed', revision: project.revision, projectHash: automaticHash(project), at: new Date().toISOString() });
    const resumed = await new AutomationRunExecutor(h.services).run(h.id, new AbortController().signal);
    expect(resumed.run.status).toBe('review-ready'); expect(speechCalls).toBe(1);
    const current = await h.services.projects.read(h.source.projectId);
    const record = current.generationRecords.find((value): boolean => value.provider === 'macos-speech')!;
    expect(record.createdAt).toBe(generatedAt); expect(JSON.parse(record.prompt).cacheEvidence.reused).toBe(true);
    expect(current.dataset).toEqual(h.source.dataset); expect(current.revision).toBe(4);
  } finally { await h.close(); }
});
test('automatic_executor_corrects_wrong_production_reference_choices_without_regenerating_speech', async (): Promise<void> => {
  const h = await createExecutionHarness(async (): Promise<void> => {});
  try {
    const originalModel = h.engine.model.run; const originalSpeech = h.engine.speech.run;
    let modelCalls: number = 0; let speechCalls: number = 0; let invalidChoice: boolean = true;
    const corrections: string[] = [];
    h.engine.speech.run = async (input, signal) => { speechCalls += 1; return originalSpeech(input, signal); };
    h.services.onProgress = async (_run, _job, progress): Promise<void> => { if (progress.phase === 'correction') corrections.push(progress.message); };
    h.engine.model.run = async (input, signal) => {
      modelCalls += 1; const output = await originalModel(input, signal);
      if (!JSON.stringify(input.outputSchema).includes('"resources"') && invalidChoice) {
        invalidChoice = false;
        const plan = demonstrationPlan(await h.services.projects.read(h.source.projectId));
        plan.shots[0] = { ...plan.shots[0]!, visualLocationId: null };
        return { ...output, result: z.json().parse(plan) };
      }
      return output;
    };
    const result = await new AutomationRunExecutor(h.services).run(h.id, new AbortController().signal);
    expect(result.run.status).toBe('review-ready'); expect(modelCalls).toBe(3); expect(speechCalls).toBe(1);
    expect(corrections.some((message): boolean => message.includes('AUTOMATION_PRODUCTION_REFERENCE_SCOPE'))).toBe(true);
  } finally { await h.close(); }
});

test('automatic_task_revalidates_existing_wav_and_refuses_file_change_during_planning', async (): Promise<void> => {
  const h = await createExecutionHarness(async (): Promise<void> => {});
  try {
    const prepared = compileAutomaticSegmentPlan(h.source, createSegmentPlanBasis(h.source, 'demonstration', ['shot-2']), demonstrationPlan(h.source), [stagedPlanSpeech(h.source)], [], automaticPlanProvenance(), 64);
    const applied = await h.services.projects.update(h.source.projectId, 0, (): Project => prepared.project, prepared.writes);
    const pending = await h.services.projects.update(h.source.projectId, 1, (current): Project => ({ ...current, audioCues: current.audioCues.map((cue) => cue.assetId !== null ? { ...cue, timingStatus: 'proposed' } : cue) }), []);
    const cue = pending.audioCues.find((value): boolean => value.assetId !== null)!;
    const asset = pending.assets.find((value): boolean => value.id === cue.assetId)!;
    const path = join(h.root, 'data', sha256Text(pending.projectId), asset.path);
    const originalBytes = await readFile(path);
    const { model: _model, turnId: _turn, prompt: _prompt, ...provenance } = automaticPlanProvenance();
    const task = { kind: 'segment' as const, segmentId: 'demonstration', replaceShotIds: pending.shots.filter((shot): boolean => shot.segmentId === 'demonstration').map((shot): string => shot.id) };
    const input = { project: pending, task, settings, remainingBytes: 64 * 1024 * 1024, provenance: { ...provenance, generationId: 'reuse-stored-wave' } };
    h.engine.speech.run = async (): Promise<never> => { throw new Error('기존 WAV를 다시 합성하면 안 됩니다.'); };
    const services = { textFontPath: h.services.textFontPath, store: h.services.projects, engines: h.engine, onProgress: async (): Promise<void> => {}, onSpeechReady: async (): Promise<void> => { throw new Error('새 음성 결과가 있으면 안 됩니다.'); } };
    const result = await executeAutomaticTask(input, services, new AbortController().signal);
    expect(result.writes).toEqual([]); expect(result.project.audioCues.find((value): boolean => value.id === cue.id)).toMatchObject({ timingStatus: 'measured', startMs: cue.startMs, endMs: cue.endMs, assetId: cue.assetId });
    const originalModel = h.engine.model.run;
    h.engine.model.run = async (modelInput, signal) => {
      const output = await originalModel(modelInput, signal); const changed = Buffer.from(originalBytes); changed[100] = changed[100]! ^ 1;
      await writeFile(path, changed); return output;
    };
    await expect(executeAutomaticTask(input, services, new AbortController().signal)).rejects.toMatchObject({ code: 'STORED_ASSET_HASH_MISMATCH' });
    expect((await h.services.projects.read(h.source.projectId)).revision).toBe(2);
    await writeFile(path, originalBytes);
    const saved = await h.services.projects.update(pending.projectId, pending.revision, (): Project => result.project, result.writes);
    expect(saved.revision).toBe(3); expect(saved.assets).toEqual(applied.assets);
    expect(saved.generationRecords.slice(0, applied.generationRecords.length)).toEqual(applied.generationRecords);
    expect(await readFile(path)).toEqual(originalBytes); expect(saved.dataset).toEqual(h.source.dataset);
    expect(saved.frames.every((frame): boolean => frame.visualReview === 'pending')).toBe(true);
  } finally { await h.close(); }
});

test('automatic_executor_repairs_manual_sources_and_existing_audio_then_generates_images_without_replacing_cuts', async (): Promise<void> => {
  const h = await createExecutionHarness(async (): Promise<void> => {});
  try {
    const prepared = compileAutomaticSegmentPlan(h.source, createSegmentPlanBasis(h.source, 'demonstration', ['shot-2']), demonstrationPlan(h.source), [stagedPlanSpeech(h.source)], [], automaticPlanProvenance(), 64);
    await h.services.projects.update(h.source.projectId, 0, (): Project => prepared.project, prepared.writes);
    const manual = await h.services.projects.update(h.source.projectId, 1, manualRepairInput, []);
    const previous = await h.services.runs.read(h.id);
    await h.services.runs.append(h.id, previous.sequence, { type: 'cancelled', at: new Date().toISOString() });
    const created = initial(manual); await h.services.runs.create(created, manual);
    const original = h.engine.model.run; let repairs: number = 0;
    h.engine.model.run = async (input, signal) => {
      if (!JSON.stringify(input.outputSchema).includes('"linkIndex"')) return original(input, signal);
      repairs += 1; return { model: 'test-repair', turnId: 'repair-integration', result: z.json().parse(repairPlan(await h.services.projects.read(manual.projectId))) };
    };
    h.engine.speech.run = async (): Promise<never> => { throw new Error('기존 음원을 재합성하지 않습니다.'); };
    const result = await new AutomationRunExecutor(h.services).run(created.id, new AbortController().signal);
    expect(result.run.problem).toBeNull(); expect(result.run.status).toBe('review-ready'); expect(repairs).toBe(1);
    expect(result.run.jobs.map((job): string => job.task.kind)).toEqual(['repair', 'production', 'reference', 'image']);
    const saved = await h.services.projects.read(manual.projectId);
    expect(saved.shots.map(({ sourceLinks: _links, ...shot }) => shot)).toEqual(manual.shots.map(({ sourceLinks: _links, ...shot }) => shot));
    expect(saved.dataset).toEqual(manual.dataset); expect(saved.textCues).toEqual(manual.textCues);
    expect(saved.audioCues.find((cue): boolean => cue.unitId === '안내-1')).toMatchObject({ timingStatus: 'measured', startMs: 5000, endMs: 7300 });
    expect(saved.generationRecords.slice(0, manual.generationRecords.length)).toEqual(manual.generationRecords);
    expect(saved.assets.slice(0, manual.assets.length)).toEqual(manual.assets);
    expect(saved.generationRecords.filter((record): boolean => record.provider === 'macos-speech')).toHaveLength(1);
    const target = saved.shots.find((shot): boolean => shot.segmentId === 'demonstration')!;
    const frame = saved.frames.find((value): boolean => value.shotId === target.id)!;
    expect(frame.visualReview).toBe('pending'); expect(frame.id).toBe(manual.frames.find((value): boolean => value.shotId === target.id)!.id);
    expect(frame.imageAssetId).not.toBeNull(); expect((await h.services.projects.asset(saved.projectId, frame.imageAssetId!)).mimeType).toBe('image/png');
  } finally { await h.close(); }
});

test('automatic_repair_store_refuses_changed_wave_and_user_edits_during_model_execution', async (): Promise<void> => {
  const h = await createExecutionHarness(async (): Promise<void> => {});
  try {
    const prepared = compileAutomaticSegmentPlan(h.source, createSegmentPlanBasis(h.source, 'demonstration', ['shot-2']), demonstrationPlan(h.source), [stagedPlanSpeech(h.source)], [], automaticPlanProvenance(), 64);
    await h.services.projects.update(h.source.projectId, 0, (): Project => prepared.project, prepared.writes);
    const manual = await h.services.projects.update(h.source.projectId, 1, manualRepairInput, []);
    const asset = manual.assets.find((value): boolean => value.kind === 'audio')!;
    const path = join(h.root, 'data', sha256Text(manual.projectId), asset.path); const bytes = await readFile(path);
    const { model: _model, turnId: _turn, prompt: _prompt, ...provenance } = automaticPlanProvenance();
    const input = { project: manual, task: { kind: 'repair' as const, segmentId: 'demonstration' }, settings, remainingBytes: settings.maxStagedBytes, provenance: { ...provenance, generationId: 'repair-store' } };
    const services = { textFontPath: h.services.textFontPath, store: h.services.projects, engines: h.engine, onProgress: async (): Promise<void> => {}, onSpeechReady: async (): Promise<void> => { throw new Error('추가 음성은 만들지 않습니다.'); } };
    const result = { model: 'test-repair', turnId: 'repair-store', result: z.json().parse(repairPlan(manual)) };
    h.engine.model.run = async () => { const changed = Buffer.from(bytes); changed[100] = changed[100]! ^ 1; await writeFile(path, changed); return result; };
    await expect(executeAutomaticTask(input, services, new AbortController().signal)).rejects.toMatchObject({ code: 'STORED_ASSET_HASH_MISMATCH' });
    expect((await h.services.projects.read(manual.projectId)).revision).toBe(2); await writeFile(path, bytes);
    h.engine.model.run = async () => { await h.services.projects.update(manual.projectId, 2, (current): Project => ({ ...current, profile: { ...current.profile, visualStyle: '검토 중 사용자 변경' } }), []); return result; };
    await expect(executeAutomaticTask(input, services, new AbortController().signal)).rejects.toMatchObject({ code: 'AUTOMATION_STALE_PLAN' });
    const current = await h.services.projects.read(manual.projectId);
    expect(current.profile.visualStyle).toBe('검토 중 사용자 변경'); expect(current.shots).toEqual(manual.shots);
    expect(current.generationRecords).toEqual(manual.generationRecords); expect(await readFile(path)).toEqual(bytes);
  } finally { await h.close(); }
});

test('automatic_missing_speech_repair_resumes_cached_voice_and_applies_manual_cut_result_once', async (): Promise<void> => {
  const h = await createExecutionHarness(async (): Promise<void> => {});
  try {
    const input = await manualMissingSpeechProject();
    const manual = await h.services.projects.update(h.source.projectId, 0, (): Project => input, []);
    const previous = await h.services.runs.read(h.id); await h.services.runs.append(h.id, previous.sequence, { type: 'cancelled', at: new Date().toISOString() });
    const created = initial(manual); await h.services.runs.create(created, manual);
    const original = h.engine.model.run; const originalSpeech = h.engine.speech.run; let speechCalls: number = 0; let repairCalls: number = 0;
    h.engine.speech.run = async (input, signal) => { speechCalls += 1; return originalSpeech(input, signal); };
    h.engine.model.run = async (input, signal) => {
      if (!JSON.stringify(input.outputSchema).includes('"linkIndex"')) return original(input, signal);
      repairCalls += 1; return { model: 'test-missing-speech', turnId: 'missing-speech-integration', result: z.json().parse(missingSpeechPlan(await h.services.projects.read(manual.projectId), 2300)) };
    };
    const stop = new AbortController(); let generatedAt: string | undefined;
    h.services.onSpeechReady = async (_run, _attempt, speech): Promise<void> => { generatedAt = speech.result.cacheEvidence?.generatedAt; stop.abort(); };
    const paused = await new AutomationRunExecutor(h.services).run(created.id, stop.signal);
    expect(paused.run.status).toBe('paused'); expect(repairCalls).toBe(0); expect(speechCalls).toBe(1);
    expect(await h.services.projects.read(manual.projectId)).toEqual(manual);
    const reopened = new AutomaticSpeechCache(join(h.root, 'automatic'), async (): Promise<void> => {}); await reopened.initialize(); h.services.speechCache = reopened;
    h.services.onSpeechReady = async (_run, _attempt, speech): Promise<void> => { expect(speech.result.cacheEvidence).toMatchObject({ generatedAt, reused: true }); };
    await h.services.runs.append(created.id, paused.sequence, { type: 'resumed', revision: manual.revision, projectHash: automaticHash(manual), at: new Date().toISOString() });
    const result = await new AutomationRunExecutor(h.services).run(created.id, new AbortController().signal);
    expect(result.run.problem).toBeNull(); expect(result.run.status).toBe('review-ready'); expect(speechCalls).toBe(1); expect(repairCalls).toBe(1);
    expect(result.run.jobs.map((job): string => job.task.kind)).toEqual(['repair', 'production', 'reference', 'image']);
    const saved = await h.services.projects.read(manual.projectId);
    expect(saved.shots.map(({ sourceLinks: _links, ...shot }) => shot)).toEqual(manual.shots.map(({ sourceLinks: _links, ...shot }) => shot));
    expect(saved.dataset).toEqual(manual.dataset); expect(saved.textCues).toEqual(manual.textCues);
    const cue = saved.audioCues.find((value): boolean => value.unitId === '안내-1')!;
    expect(cue).toMatchObject({ startMs: 5000, endMs: 7300, timingStatus: 'measured' });
    expect((await h.services.projects.asset(saved.projectId, cue.assetId!)).asset.durationMs).toBe(2300);
    const records = saved.generationRecords.filter((record): boolean => record.provider === 'macos-speech');
    expect(records).toHaveLength(1); expect(records[0]!.createdAt).toBe(generatedAt); expect(JSON.parse(records[0]!.prompt).cacheEvidence.reused).toBe(true);
    expect(saved.audioCues.find((value): boolean => value.unitId === '효과음')).toEqual(manual.audioCues.find((value): boolean => value.unitId === '효과음'));
    expect(saved.frames.filter((frame): boolean => frame.shotId === 'shot-2')).toContainEqual(expect.objectContaining({ imageAssetId: expect.any(String), visualReview: 'pending' }));
    expect(await new AutomationRunExecutor(h.services).run(created.id, new AbortController().signal)).toEqual(result);
  } finally { await h.close(); }
});

import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { z } from 'zod';
import { automaticHash } from '../src/automation/application-evidence.js';
import { inspectStoryboardDensity, recommendedStoryboardDensity, recordStoryboardDensityReview, StoryboardDensitySchema } from '../src/automation/density.js';
import type { StoryboardDensity } from '../src/automation/density.js';
import { createSegmentPlanBasis } from '../src/automation/plan-basis.js';
import { planAutomaticSegment } from '../src/automation/plan-segment.js';
import type { AutomaticPlanOptions, AutomaticPlanServices } from '../src/automation/plan-segment.js';
import { compilePlannedShots } from '../src/automation/plan-shots.js';
import { automationDensity, AutomationSettingsSchema } from '../src/automation/run-schema.js';
import { createAutomationRun } from '../src/automation/run-state.js';
import { AutomationRunStore } from '../src/automation/run-store.js';
import type { StructuredGenerationInput } from '../src/codex/structured-engine.js';
import type { Project } from '../src/domain/schema.js';
import { initial } from './automatic-executor-helpers.js';
import { automaticPlanProject, automaticPlanProvenance, demonstrationPlan, stagedPlanSpeech } from './automatic-plan-helpers.js';
import { TEST_TEXT_FONT_PATH } from './helpers.js';

function options(density: StoryboardDensity | null): AutomaticPlanOptions {
  const { model: _model, prompt: _prompt, turnId: _turn, ...provenance } = automaticPlanProvenance();
  return { provenance, density, voice: { name: 'Yuna', rateWordsPerMinute: 180 }, maxCorrections: 1, maxFrames: 64, maxStagedAudioBytes: 1000000 };
}
function services(project: Project, model: AutomaticPlanServices['model']): AutomaticPlanServices {
  return { model, speech: { run: vi.fn(async () => stagedPlanSpeech(project).result) }, textFontPath: TEST_TEXT_FONT_PATH,
    loadExistingAudio: async (): Promise<never> => { throw new Error('기존 음원이 없는 검증 자료입니다.'); }, onProgress: async (): Promise<void> => {}, onSpeechReady: async (): Promise<void> => {} };
}

it('automatic_density_counts_actual_reveal_frames_and_excludes_black_hold_images_without_changing_source', async (): Promise<void> => {
  const project = await automaticPlanProject(); const original: string = automaticHash(project); const plan = demonstrationPlan(project);
  const shot = plan.shots[0]!;
  shot.sourceLinks.push({ unitId: '동작', usage: 'continued-visual', startOffsetMs: 3000, endOffsetMs: 8500, reason: '같은 행동의 진행 상태를 다시 보여 준다.' });
  shot.frames.push({ role: 'end', offsetMs: 8500, description: '물을 준 흙 상태.' });
  const compiled = compilePlannedShots(project, plan, 'density-test', 3);
  expect(compiled.frames.map((frame): string => frame.role)).toEqual(['start', 'key', 'end']);
  const candidate: Project = { ...project, shots: [...project.shots.filter((value): boolean => value.segmentId !== plan.segmentId).map((value, index) => ({ ...value, visualMode: index === 0 ? 'black' as const : 'hold-previous' as const })), ...compiled.shots],
    frames: [...project.frames.filter((frame): boolean => frame.shotId !== 'shot-2'), ...compiled.frames] };
  const selected = inspectStoryboardDensity(candidate, [plan.segmentId], { ...recommendedStoryboardDensity(), longHoldReviewMs: 5000 });
  expect(selected).toMatchObject({ shotCount: 1, frameCount: 3, imageFrameCount: 3, excludedImageFrameCount: 0, roles: { start: 1, key: 1, end: 1 }, longHolds: [{ startMs: 8000, endMs: 13500, durationMs: 5500 }] });
  const all = inspectStoryboardDensity(candidate, project.dataset.segments.map((segment): string => segment.id), { ...recommendedStoryboardDensity(), longHoldReviewMs: 5000 });
  expect(all.frameCount).toBe(5); expect(all.imageFrameCount).toBe(3); expect(all.excludedImageFrameCount).toBe(2); expect(all.longHolds).toEqual(selected.longHolds);
  expect(() => compilePlannedShots(project, plan, 'density-test', 2)).toThrow(expect.objectContaining({ code: 'AUTOMATION_FRAME_BUDGET' }));
  expect(automaticHash(project)).toBe(original);
});

it('automatic_density_selected_detail_drives_bounded_correction_and_records_real_counts_without_human_approval', async (): Promise<void> => {
  const project = await automaticPlanProject(); const original: string = automaticHash(project);
  const policy: StoryboardDensity = { version: '1.0.0', detail: 'detailed', longHoldReviewMs: 5000 };
  const first = demonstrationPlan(project); const next = structuredClone(first);
  next.shots[0]!.frames.push({ role: 'key', offsetMs: 4000, description: '물을 기울여 흙 표면이 젖는 중간 상태.' });
  const prompts: StructuredGenerationInput[] = [];
  const model = vi.fn(async (input: StructuredGenerationInput) => { prompts.push(input); return { model: 'density-model', turnId: `density-${prompts.length}`, result: z.json().parse(prompts.length === 1 ? first : next) }; });
  const connected = services(project, { run: model });
  const result = await planAutomaticSegment(project, createSegmentPlanBasis(project, 'demonstration', ['shot-2']), options(policy), connected, new AbortController().signal);
  expect(model).toHaveBeenCalledTimes(2); expect(connected.speech.run).toHaveBeenCalledTimes(1);
  const firstInput = JSON.parse(prompts[0]!.prompt.split('입력 스냅샷:\n')[1]!);
  const corrected = JSON.parse(prompts[1]!.prompt.split('입력 스냅샷:\n')[1]!);
  expect(firstInput.density).toEqual({ policy, previousReview: null }); expect(corrected.correction.code).toBe('AUTOMATION_DENSITY_REVIEW'); expect(corrected.density.previousReview.longHolds).toHaveLength(1);
  const record = result.project.generationRecords.find((value): boolean => value.id === options(policy).provenance.generationId)!;
  expect(JSON.parse(record.prompt).densityReview).toMatchObject({ policy, shotCount: 1, frameCount: 2, imageFrameCount: 2, longHolds: [] });
  expect(result.project.dataset).toEqual(project.dataset); expect(automaticHash(project)).toBe(original);
  expect(result.project.shots.every((shot): boolean => shot.approvalStatus === 'proposed')).toBe(true);
  expect(result.project.frames.every((frame): boolean => frame.visualReview === 'pending')).toBe(true);
});

it('automatic_density_retains_explained_long_holds_after_finite_review_instead_of_forcing_duplicate_frames', async (): Promise<void> => {
  const project = await automaticPlanProject(); const plan = demonstrationPlan(project);
  plan.summary = '물을 천천히 주는 하나의 동작을 같은 그림에서 검토하도록 유지한다.';
  const model = vi.fn(async () => ({ model: 'density-model', turnId: 'intentional-hold', result: z.json().parse(plan) }));
  const policy: StoryboardDensity = { version: '1.0.0', detail: 'concise', longHoldReviewMs: 5000 };
  const result = await planAutomaticSegment(project, createSegmentPlanBasis(project, plan.segmentId, ['shot-2']), options(policy), services(project, { run: model }), new AbortController().signal);
  expect(model).toHaveBeenCalledTimes(2);
  const report = JSON.parse(result.project.generationRecords.find((record): boolean => record.id === options(policy).provenance.generationId)!.prompt).densityReview;
  expect(report).toMatchObject({ shotCount: 1, frameCount: 1, policy, longHolds: [{ durationMs: 8500 }] });
  expect(result.plan.summary).toBe(plan.summary); expect(result.project.frames.filter((frame): boolean => frame.shotId.startsWith(options(policy).provenance.generationId))).toHaveLength(1);
});

it('automatic_density_legacy_settings_preserve_stored_hashes_and_current_settings_bind_selected_policy', async (): Promise<void> => {
  const root = await mkdtemp(join(tmpdir(), 'cutroom-density-history-'));
  try {
    const project = await automaticPlanProject(); const event = initial(project); const runs = new AutomationRunStore(root, async (): Promise<void> => {}); await runs.initialize();
    await runs.create(event, project);
    const path: string = join(root, 'runs', event.id, '000000000.json'); const before = await readFile(path);
    const reader = new AutomationRunStore(root, async (): Promise<void> => {}); await reader.initialize();
    const reopened = await reader.read(event.id);
    expect(automationDensity(reopened.run.settings)).toBeNull(); expect(reopened.run.settings).toEqual(event.settings); expect(await readFile(path)).toEqual(before);
    expect(reopened.run.settingsHash).toBe(automaticHash({ settings: event.settings, generatorBuild: event.generatorBuild }));
    const density: StoryboardDensity = { version: '1.0.0', detail: 'detailed', longHoldReviewMs: 12000 };
    const modern = createAutomationRun({ ...event, id: randomUUID(), settings: { ...event.settings, density } });
    expect(automationDensity(modern.settings)).toEqual(density); expect(modern.settingsHash).not.toBe(reopened.run.settingsHash);
    expect(AutomationSettingsSchema.parse(event.settings)).toEqual(event.settings);
    expect(AutomationSettingsSchema.safeParse({ ...event.settings, density: { ...density, detail: 'unknown' } }).success).toBe(false);
    expect(AutomationSettingsSchema.safeParse({ ...event.settings, density: { ...density, version: '2.0.0' } }).success).toBe(false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

it('automatic_density_missing_scope_invalid_policy_and_past_record_changes_are_explicit_errors', async (): Promise<void> => {
  const project = await automaticPlanProject();
  expect(StoryboardDensitySchema.safeParse({ ...recommendedStoryboardDensity(), longHoldReviewMs: 0 }).success).toBe(false);
  expect(() => inspectStoryboardDensity(project, ['missing'], recommendedStoryboardDensity())).toThrow(expect.objectContaining({ code: 'AUTOMATION_DENSITY_SCOPE' }));
  expect(() => inspectStoryboardDensity(project, ['demonstration', 'demonstration'], recommendedStoryboardDensity())).toThrow(expect.objectContaining({ code: 'AUTOMATION_DENSITY_SCOPE' }));
  const review = inspectStoryboardDensity(project, ['demonstration'], recommendedStoryboardDensity());
  expect(() => recordStoryboardDensityReview(project, project, 'missing', review)).toThrow(expect.objectContaining({ code: 'AUTOMATION_DENSITY_RECORD_MISSING' }));
  const model = { run: async () => ({ model: 'density-model', turnId: 'legacy', result: z.json().parse(demonstrationPlan(project)) }) };
  const legacy = await planAutomaticSegment(project, createSegmentPlanBasis(project, 'demonstration', ['shot-2']), options(null), services(project, model), new AbortController().signal);
  const record = legacy.project.generationRecords.find((value): boolean => value.id === options(null).provenance.generationId)!;
  expect(JSON.parse(record.prompt).densityReview).toBeUndefined();
  expect(() => recordStoryboardDensityReview(legacy.project, legacy.project, record.id, review)).toThrow(expect.objectContaining({ code: 'AUTOMATION_DUPLICATE_GENERATION' }));
});

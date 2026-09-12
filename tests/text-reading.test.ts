import { expect, it, vi } from 'vitest';
import { z } from 'zod';
import { createSegmentPlanBasis } from '../src/automation/plan-basis.js';
import { planAutomaticSegment } from '../src/automation/plan-segment.js';
import type { AutomaticPlanOptions, AutomaticPlanServices } from '../src/automation/plan-segment.js';
import type { StructuredGenerationInput } from '../src/codex/structured-engine.js';
import type { Project } from '../src/domain/schema.js';
import { inspectTextReading, storyboardReadingPreset, textReadabilityIssues, TextReadabilityPolicySchema } from '../src/domain/text-readability.js';
import { parseProject, parseProjectSnapshotEvidence } from '../src/io/project.js';
import { automaticPlanProvenance } from './automatic-plan-helpers.js';
import { TEST_TEXT_FONT_PATH } from './helpers.js';
import { readingPlan, readingProject } from './text-reading-helpers.js';

function options(): AutomaticPlanOptions {
  const { model: _model, prompt: _prompt, turnId: _turn, ...provenance } = automaticPlanProvenance();
  return { density: null, provenance, voice: { name: 'Yuna', rateWordsPerMinute: 180 }, maxCorrections: 1, maxFrames: 64, maxStagedAudioBytes: 1000000 };
}
function services(model: AutomaticPlanServices['model']): AutomaticPlanServices {
  return { model, textFontPath: TEST_TEXT_FONT_PATH, speech: { run: async (): Promise<never> => { throw new Error('제목은 낭독하지 않습니다.'); } },
    loadExistingAudio: async (): Promise<never> => { throw new Error('이 구간에는 음원이 없습니다.'); }, onProgress: async (): Promise<void> => {}, onSpeechReady: async (): Promise<void> => {} };
}

it('text_reading_counts_visible_graphemes_and_distinguishes_short_long_and_impossible_windows', (): void => {
  const cue = { id: '문구', text: '가 나\n👩🏽‍🌾 e\u0301', startMs: 100, endMs: 2100 };
  const policy = { ...storyboardReadingPreset(), graphemesPerSecond: 2, minHoldMs: 1000, maxHoldMs: 3000 };
  expect(inspectTextReading(cue, policy)).toMatchObject({ graphemes: 4, requiredMs: 2000, actualMs: 2000, problems: [] });
  expect(inspectTextReading({ ...cue, endMs: 2099 }, policy).problems[0]?.code).toBe('TEXT_READING_TOO_FAST');
  expect(inspectTextReading({ ...cue, endMs: 3101 }, policy).problems[0]?.code).toBe('TEXT_HOLD_TOO_LONG');
  expect(inspectTextReading(cue, { ...policy, maxHoldMs: 1000 }).problems[0]?.code).toBe('TEXT_READING_WINDOW_EXCEEDED');
  expect(TextReadabilityPolicySchema.safeParse({ ...policy, minHoldMs: 5000 }).success).toBe(false);
  expect(TextReadabilityPolicySchema.safeParse({ ...policy, graphemesPerSecond: 0 }).success).toBe(false);
});

it('text_reading_automatically_extends_unknown_placement_end_and_preserves_fixed_start_source_and_approval', async (): Promise<void> => {
  const project = await readingProject(); const before: string = JSON.stringify(project); const inputs: StructuredGenerationInput[] = [];
  const model = vi.fn(async (input: StructuredGenerationInput) => { inputs.push(input); return { model: 'reading-test', turnId: `reading-${inputs.length}`, result: z.json().parse(readingPlan(inputs.length === 1 ? 500 : 2000)) }; });
  const result = await planAutomaticSegment(project, createSegmentPlanBasis(project, 'SEG-001', ['shot-1']), options(), services({ run: model }), new AbortController().signal);
  expect(model).toHaveBeenCalledTimes(2); expect(inputs[1]!.prompt).toContain('TEXT_READING_TOO_FAST');
  expect(inputs[1]!.prompt).toContain('"canMoveStart":false'); expect(inputs[1]!.prompt).toContain('"canChangeEnd":true');
  expect(result.project.textCues.find((cue) => cue.placementId === 'title-placement')).toMatchObject({ startMs: 0, endMs: 2000, timingStatus: 'proposed', text: '흙부터 확인하세요' });
  expect(result.project.dataset).toEqual(project.dataset); expect(result.project.textReadability).toEqual(project.textReadability);
  expect(textReadabilityIssues(result.project)).toEqual([]); expect(JSON.stringify(project)).toBe(before);
  expect(JSON.parse(result.project.generationRecords.at(-1)!.prompt).textReview).toMatchObject({ version: '1.1.0', readingPolicy: project.textReadability });
});

it('text_reading_keeps_bounded_unresolved_drafts_and_does_not_retry_impossible_or_confirmed_timings', async (): Promise<void> => {
  const project = await readingProject(); const model = vi.fn(async () => ({ model: 'reading-test', turnId: 'unchanged', result: z.json().parse(readingPlan(500)) }));
  const result = await planAutomaticSegment(project, createSegmentPlanBasis(project, 'SEG-001', ['shot-1']), options(), services({ run: model }), new AbortController().signal);
  expect(model).toHaveBeenCalledTimes(2); expect(result.exceptions.some((value) => value.code === 'TEXT_READING_TOO_FAST')).toBe(true);
  const impossible: Project = { ...project, textReadability: { ...project.textReadability, graphemesPerSecond: 2, maxHoldMs: 1000 } };
  model.mockClear();
  const blocked = await planAutomaticSegment(impossible, createSegmentPlanBasis(impossible, 'SEG-001', ['shot-1']), options(), services({ run: model }), new AbortController().signal);
  expect(model).toHaveBeenCalledTimes(1); expect(blocked.exceptions.some((value) => value.code === 'TEXT_READING_WINDOW_EXCEEDED')).toBe(true);
  const confirmed: Project = { ...project, textCues: project.textCues.map((cue) => ({ ...cue, timingStatus: 'confirmed' })) };
  model.mockClear();
  const protectedResult = await planAutomaticSegment(confirmed, createSegmentPlanBasis(confirmed, 'SEG-001', ['shot-1']), options(), services({ run: model }), new AbortController().signal);
  expect(model).toHaveBeenCalledTimes(1);
  expect(protectedResult.project.textCues.toSorted((a, b) => a.id.localeCompare(b.id))).toEqual(confirmed.textCues.toSorted((a, b) => a.id.localeCompare(b.id)));
  expect(textReadabilityIssues(protectedResult.project)).toEqual([]);
});

it('text_reading_reduces_excess_hold_to_policy_without_allowing_flash_or_fixed_start_changes', async (): Promise<void> => {
  const initial = await readingProject(); const project: Project = { ...initial, textReadability: { ...initial.textReadability, maxHoldMs: 2000 } }; let calls: number = 0;
  const model = vi.fn(async () => { calls += 1; return { model: 'reading-test', turnId: String(calls), result: z.json().parse(readingPlan(calls === 1 ? 5000 : 2000)) }; });
  const result = await planAutomaticSegment(project, createSegmentPlanBasis(project, 'SEG-001', ['shot-1']), options(), services({ run: model }), new AbortController().signal);
  expect(model).toHaveBeenCalledTimes(2); expect(result.project.textCues.find((cue) => cue.placementId === 'title-placement')?.endMs).toBe(2000); expect(result.exceptions).toEqual([]);
  calls = 0;
  const flash = vi.fn(async () => { calls += 1; return { model: 'reading-test', turnId: String(calls), result: z.json().parse(readingPlan(calls === 1 ? 500 : 1)) }; });
  await expect(planAutomaticSegment(project, createSegmentPlanBasis(project, 'SEG-001', ['shot-1']), options(), services({ run: flash }), new AbortController().signal)).rejects.toMatchObject({ code: 'AUTOMATION_TEXT_DURATION_REDUCED' });
  calls = 0;
  const moved = vi.fn(async () => { calls += 1; const plan = readingPlan(2000);
    return { model: 'reading-test', turnId: String(calls), result: z.json().parse(calls === 1 ? readingPlan(500) : { ...plan, textTimings: plan.textTimings.map((value) => ({ ...value, startMs: 500 })) }) }; });
  await expect(planAutomaticSegment(project, createSegmentPlanBasis(project, 'SEG-001', ['shot-1']), options(), services({ run: moved }), new AbortController().signal)).rejects.toMatchObject({ code: 'AUTOMATION_CANDIDATE_INVALID' });
});

it('text_reading_migrates_old_snapshot_without_rewriting_original_and_rejects_undeclared_settings', async (): Promise<void> => {
  const project = await readingProject(); const { textReadability: _reading, textLayoutControl: _control, ...previous } = project;
  const legacy = { ...previous, schemaVersion: '1.13.0' }; const bytes: string = JSON.stringify(legacy);
  const evidence = parseProjectSnapshotEvidence(legacy);
  expect(evidence.project).toEqual({ ...project, textLayoutControl: { version: '1.0.0', mode: 'manual', plannedInputHash: null } }); expect(evidence.projectionHashes).toHaveLength(9); expect(JSON.stringify(legacy)).toBe(bytes);
  expect(() => parseProject({ ...legacy, textReadability: { unknown: true } })).toThrowError(expect.objectContaining({ code: 'UNSUPPORTED_LEGACY_TEXT_READABILITY' }));
});

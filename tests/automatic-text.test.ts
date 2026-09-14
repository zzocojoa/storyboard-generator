import { appendFile, copyFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { createSegmentPlanBasis } from '../src/automation/plan-basis.js';
import { planAutomaticSegment } from '../src/automation/plan-segment.js';
import type { AutomaticPlanOptions, AutomaticPlanServices } from '../src/automation/plan-segment.js';
import { assertTextReviewDuration, inspectAutomaticText, recordAutomaticTextReview } from '../src/automation/text-review.js';
import type { StructuredGenerationInput } from '../src/codex/structured-engine.js';
import type { Project } from '../src/domain/schema.js';
import { textLayoutTimelineIssues } from '../src/rendering/project-text.js';
import { readTextFont } from '../src/rendering/text-font.js';
import { automaticPlanProvenance } from './automatic-plan-helpers.js';
import { crowdedTextPlan, crowdedTextProject, separatedTextPlan } from './automatic-text-helpers.js';
import { TEST_TEXT_FONT_PATH } from './helpers.js';

function options(): AutomaticPlanOptions {
  const { model: _model, prompt: _prompt, turnId: _turnId, ...provenance } = automaticPlanProvenance();
  return { density: null, provenance, voice: { name: 'Yuna', rateWordsPerMinute: 180 }, maxCorrections: 1, maxFrames: 64, maxStagedAudioBytes: 1000000 };
}
function services(model: AutomaticPlanServices['model']): AutomaticPlanServices {
  return { textFontPath: TEST_TEXT_FONT_PATH, model,
    speech: { run: async (): Promise<never> => { throw new Error('메모를 낭독하면 안 됩니다.'); } },
    loadExistingAudio: async (): Promise<never> => { throw new Error('이 구간에 기존 음원은 없습니다.'); },
    onProgress: vi.fn(async (): Promise<void> => {}), onSpeechReady: async (): Promise<void> => {} };
}
function basis(project: Project) { return createSegmentPlanBasis(project, 'SEG-001', ['shot-1']); }

describe('자동 계획의 실제 글꼴 배치 검토', (): void => {
  it('automatic_text_corrects_overlapping_draft_timings_with_real_font_without_shortening_or_approval', async (): Promise<void> => {
    const project = await crowdedTextProject(); const original: string = JSON.stringify(project); const inputs: StructuredGenerationInput[] = [];
    const model = vi.fn(async (input: StructuredGenerationInput) => {
      inputs.push(input); return { model: 'layout-test', turnId: `layout-${inputs.length}`, result: z.json().parse(inputs.length === 1 ? crowdedTextPlan() : separatedTextPlan()) };
    });
    const result = await planAutomaticSegment(project, basis(project), options(), services({ run: model }), new AbortController().signal);
    expect(model).toHaveBeenCalledTimes(2); expect(inputs[1]!.prompt).toContain('AUTOMATION_TEXT_LAYOUT_REVIEW');
    expect(inputs[1]!.prompt).toContain('source-unit:note-b'); expect(inputs[1]!.prompt).not.toContain(TEST_TEXT_FONT_PATH);
    const font = await readTextFont(TEST_TEXT_FONT_PATH); const review = inspectAutomaticText(project, result.project, 'SEG-001', font);
    expect(review.issues).toEqual([]); expect(review.cues.map((cue) => cue.endMs - cue.startMs)).toEqual([2000, 2000]);
    expect(result.project.textCues.filter((cue) => cue.segmentId === 'SEG-001').map((cue) => cue.startMs)).toEqual([0, 2500]);
    expect(result.project.textCues.filter((cue) => cue.segmentId === 'SEG-001').every((cue) => cue.timingStatus === 'proposed')).toBe(true);
    expect(result.project.dataset).toEqual(project.dataset); expect(result.project.textLayout).toEqual(project.textLayout);
    const record = result.project.generationRecords.find((value) => value.id === options().provenance.generationId)!;
    expect(JSON.parse(record.prompt)).toMatchObject({ textReview: { fontSha256: font.sha256, issues: [] } });
    expect(record.referenceHashes).toContain(font.sha256); expect(result.writes).toEqual([]); expect(JSON.stringify(project)).toBe(original);
  });

  it('automatic_text_keeps_unresolved_layout_visible_after_bounded_review_and_preserves_confirmed_text', async (): Promise<void> => {
    const project = await crowdedTextProject(); const model = vi.fn(async () => ({ model: 'layout-test', turnId: 'unchanged', result: z.json().parse(crowdedTextPlan()) }));
    const service = services({ run: model }); const result = await planAutomaticSegment(project, basis(project), options(), service, new AbortController().signal);
    expect(model).toHaveBeenCalledTimes(2); expect(result.exceptions.some((value) => value.code === 'TEXT_LAYOUT_OVERFLOW')).toBe(true);
    expect(service.onProgress).toHaveBeenCalledWith(expect.objectContaining({ phase: 'validated', message: expect.stringContaining('글자 배치 검토') }));
    const font = await readTextFont(TEST_TEXT_FONT_PATH);
    expect(textLayoutTimelineIssues(result.project, font)).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'TEXT_LAYOUT_OVERFLOW' })]));
    const confirmed: Project = { ...project, textCues: project.textCues.map((cue) => ({ ...cue, timingStatus: 'confirmed' })) };
    model.mockClear();
    const protectedResult = await planAutomaticSegment(confirmed, basis(confirmed), options(), services({ run: model }), new AbortController().signal);
    expect(model).toHaveBeenCalledTimes(1); expect(protectedResult.project.textCues).toEqual(confirmed.textCues);
    const review = inspectAutomaticText(confirmed, protectedResult.project, 'SEG-001', font);
    expect(review.correctionCueIds).toEqual([]); expect(review.issues.length).toBeGreaterThan(0);
    expect(() => recordAutomaticTextReview(protectedResult.project, protectedResult.project, options().provenance.generationId, review)).toThrowError(expect.objectContaining({ code: 'AUTOMATION_DUPLICATE_GENERATION' }));
  });

  it('automatic_text_rejects_flash_duration_corrections_and_does_not_publish_a_candidate', async (): Promise<void> => {
    const project = await crowdedTextProject(); const before: string = JSON.stringify(project); let calls: number = 0;
    const model = vi.fn(async () => { calls += 1; const plan = separatedTextPlan();
      return { model: 'layout-test', turnId: String(calls), result: z.json().parse(calls === 1 ? crowdedTextPlan() : { ...plan, textTimings: plan.textTimings.map((cue) => ({ ...cue, endMs: cue.startMs + 1 })) }) }; });
    await expect(planAutomaticSegment(project, basis(project), options(), services({ run: model }), new AbortController().signal)).rejects.toMatchObject({ code: 'AUTOMATION_TEXT_DURATION_REDUCED' });
    expect(model).toHaveBeenCalledTimes(2); expect(JSON.stringify(project)).toBe(before);
  });

  it('automatic_text_rejects_changed_or_missing_font_without_fallback', async (): Promise<void> => {
    const root: string = await mkdtemp(join(tmpdir(), 'cutroom-text-font-')); const path: string = join(root, 'font.ttf');
    try {
      await copyFile(TEST_TEXT_FONT_PATH, path); const project = await crowdedTextProject();
      const model = vi.fn(async () => { await appendFile(path, Buffer.from([0])); return { model: 'layout-test', turnId: 'changed', result: z.json().parse(separatedTextPlan()) }; });
      await expect(planAutomaticSegment(project, basis(project), options(), { ...services({ run: model }), textFontPath: path }, new AbortController().signal)).rejects.toMatchObject({ code: 'AUTOMATION_TEXT_FONT_CHANGED' });
      model.mockClear();
      await expect(planAutomaticSegment(project, basis(project), options(), { ...services({ run: model }), textFontPath: join(root, 'missing.ttf') }, new AbortController().signal)).rejects.toMatchObject({ code: 'TEXT_FONT_FILE_UNAVAILABLE' });
      expect(model).not.toHaveBeenCalled();
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('automatic_text_preserves_non_target_timings_and_rejects_body_changes_during_correction', async (): Promise<void> => {
    const outline = await crowdedTextProject();
    const project: Project = { ...outline, textCues: outline.textCues.map((cue) => cue.unitId === 'note-a' ? { ...cue, timingStatus: 'confirmed' } : cue) };
    const result = await planAutomaticSegment(project, basis(project), { ...options(), maxCorrections: 0 }, services({ run: async () => ({ model: 'layout-test', turnId: 'scope', result: z.json().parse(crowdedTextPlan()) }) }), new AbortController().signal);
    const review = inspectAutomaticText(project, result.project, 'SEG-001', await readTextFont(TEST_TEXT_FONT_PATH));
    const fixed = review.cues.find((cue) => !review.correctionCueIds.includes(cue.cueId))!;
    expect(fixed).toBeDefined(); expect(review.correctionCueIds.length).toBeGreaterThan(0);
    const retimed: Project = { ...result.project, textCues: result.project.textCues.map((cue) => cue.id === fixed.cueId ? { ...cue, startMs: cue.startMs + 500, endMs: cue.endMs + 500 } : cue) };
    expect(() => assertTextReviewDuration(retimed, review)).toThrowError(expect.objectContaining({ code: 'AUTOMATION_TEXT_CORRECTION_SCOPE' }));
    const changed: Project = { ...result.project, textCues: result.project.textCues.map((cue) => cue.id === review.correctionCueIds[0] ? { ...cue, text: '축약된 문구' } : cue) };
    expect(() => assertTextReviewDuration(changed, review)).toThrowError(expect.objectContaining({ code: 'AUTOMATION_TEXT_CONTENT_CHANGED' }));
    expect(() => assertTextReviewDuration(result.project, review)).not.toThrow();
  });
});

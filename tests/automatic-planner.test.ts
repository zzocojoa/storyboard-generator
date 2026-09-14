import { TEST_TEXT_FONT_PATH } from './helpers.js';
import { z } from 'zod';
import { describe, expect, it, vi } from 'vitest';
import { automaticSegmentContext } from '../src/automation/plan-context.js';
import { planAutomaticSegment } from '../src/automation/plan-segment.js';
import type { AutomaticPlanOptions, AutomaticPlanProgress, AutomaticPlanServices } from '../src/automation/plan-segment.js';
import { createSegmentPlanBasis } from '../src/automation/plan-basis.js';
import { contractError } from '../src/domain/errors.js';
import type { Asset, Project } from '../src/domain/schema.js';
import type { StructuredGenerationInput } from '../src/codex/structured-engine.js';
import { automaticPlanProject, automaticPlanProvenance, demonstrationPlan, stagedPlanSpeech } from './automatic-plan-helpers.js';

const options = (): AutomaticPlanOptions => {
  const provenance = automaticPlanProvenance();
  return { density: null, voice: { name: 'Yuna', rateWordsPerMinute: 180 }, maxCorrections: 1, maxFrames: 64, maxStagedAudioBytes: 5_000_000,
    provenance: { generationId: provenance.generationId, createdAt: provenance.createdAt, generatorBuild: provenance.generatorBuild } };
};

async function noExistingAudio(assetId: string, _signal: AbortSignal): Promise<Buffer> {
  throw new Error(`기존 음원이 없는 검증 사례에서 파일을 요청했습니다: ${assetId}`);
}

describe('자동 계획 실행 조정', (): void => {
  it('automation_planner_measures_speech_once_and_corrects_coupled_plan_with_bounded_attempts', async (): Promise<void> => {
    const project = await automaticPlanProject(); const plan = demonstrationPlan(project); const staged = stagedPlanSpeech(project);
    const basis = createSegmentPlanBasis(project, 'demonstration', ['shot-2']);
    const speech = vi.fn().mockResolvedValue(staged.result);
    const inputs: StructuredGenerationInput[] = []; const events: AutomaticPlanProgress[] = [];
    const model = vi.fn(async (input: StructuredGenerationInput) => {
      inputs.push(input);
      const result = inputs.length === 1 ? { ...plan, audioTimings: plan.audioTimings.map((timing) => ({ ...timing, endMs: timing.endMs + 1 })) } : plan;
      return { model: 'test-model', turnId: `turn-${inputs.length}`, result: z.json().parse(result) };
    });
    const services: AutomaticPlanServices = { textFontPath: TEST_TEXT_FONT_PATH, loadExistingAudio: noExistingAudio, speech: { run: speech }, model: { run: model }, onSpeechReady: vi.fn(async (): Promise<void> => {}), onProgress: async (event): Promise<void> => { events.push(event); } };
    const candidate = await planAutomaticSegment(project, basis, options(), services, new AbortController().signal);
    expect(speech).toHaveBeenCalledTimes(1); expect(model).toHaveBeenCalledTimes(2);
    expect(inputs[0]?.prompt).toContain('"durationMs":2300');
    expect(inputs[1]?.prompt).toContain('AUTOMATION_SPEECH_DURATION');
    expect(events.map((event): string => event.phase)).toEqual(['speech', 'planning', 'correction', 'planning', 'validated']);
    expect(candidate.writes).toHaveLength(1); expect(project.assets).toEqual([]);
  });

  it('automation_planner_ends_failed_corrections_preserves_last_error_and_does_not_retry_permission_failures', async (): Promise<void> => {
    const project = await automaticPlanProject(); const staged = stagedPlanSpeech(project); const basis = createSegmentPlanBasis(project, 'demonstration', ['shot-2']);
    const model = vi.fn().mockResolvedValue({ model: 'test', turnId: 'turn', result: { unexpected: true } });
    const services: AutomaticPlanServices = { textFontPath: TEST_TEXT_FONT_PATH, loadExistingAudio: noExistingAudio, speech: { run: vi.fn().mockResolvedValue(staged.result) }, model: { run: model }, onProgress: vi.fn(async (): Promise<void> => {}), onSpeechReady: vi.fn(async (): Promise<void> => {}) };
    const selectedOptions = options();
    await expect(planAutomaticSegment(project, basis, selectedOptions, { ...services, onProgress: async (event): Promise<void> => { if (event.phase === 'correction') selectedOptions.maxCorrections = 2; } }, new AbortController().signal)).rejects.toBeInstanceOf(z.ZodError);
    expect(model).toHaveBeenCalledTimes(2);
    const denied = vi.fn().mockRejectedValue(contractError('CODEX_LOGIN_REQUIRED', '로그인이 필요합니다.', []));
    await expect(planAutomaticSegment(project, basis, options(), { ...services, model: { run: denied } }, new AbortController().signal)).rejects.toMatchObject({ code: 'CODEX_LOGIN_REQUIRED' });
    expect(denied).toHaveBeenCalledTimes(1);
  });

  it('automatic_planner_corrects_continuity_with_asset_and_boundary_evidence_without_changing_previous_shots_or_human_review', async (): Promise<void> => {
    const source = await automaticPlanProject();
    const asset: Asset = { id: 'continuity-prop', kind: 'prop', subjectId: null, path: 'assets/continuity.png', mimeType: 'image/png', sha256: '1'.repeat(64), description: '연속성 소품', durationMs: null, version: 1 };
    const project: Project = { ...source, assets: [asset], shots: source.shots.map((shot) => shot.id === 'shot-1' ? { ...shot, continuityAfter: [{ assetId: asset.id, state: '닫힘' }] } : shot) };
    const before: Project = structuredClone(project);
    const plan = demonstrationPlan(project);
    const inputs: StructuredGenerationInput[] = [];
    const model = vi.fn(async (input: StructuredGenerationInput) => {
      inputs.push(input);
      const snapshot = JSON.parse(input.prompt.split('입력 스냅샷:\n')[1] ?? '') as { correction: { message: string } | null };
      if (snapshot.correction !== null) {
        expect(snapshot.correction.message).toContain(asset.id);
        expect(snapshot.correction.message).toMatch(/"expected"\s*:\s*"닫힘"/u);
        expect(snapshot.correction.message).toMatch(/"actual"\s*:\s*"열림"/u);
      }
      return { model: 'test-model', turnId: `continuity-${inputs.length}`, result: z.json().parse({ ...plan, shots: plan.shots.map((shot) => ({ ...shot, continuityBefore: [{ assetId: asset.id, state: snapshot.correction === null ? '열림' : '닫힘' }] })) }) };
    });
    const speech = vi.fn();
    const services: AutomaticPlanServices = { textFontPath: TEST_TEXT_FONT_PATH, loadExistingAudio: noExistingAudio, speech: { run: speech }, model: { run: model }, onSpeechReady: vi.fn(async (): Promise<void> => {}), onProgress: vi.fn(async (): Promise<void> => {}) };
    const candidate = await planAutomaticSegment(project, createSegmentPlanBasis(project, 'demonstration', ['shot-2']), { ...options(), audioProduction: 'instructions-only' }, services, new AbortController().signal);
    expect(model).toHaveBeenCalledTimes(2); expect(speech).not.toHaveBeenCalled();
    expect(candidate.project.shots.find((shot): boolean => shot.segmentId === 'demonstration')?.continuityBefore).toEqual([{ assetId: asset.id, state: '닫힘' }]);
    expect(candidate.project.shots.find((shot): boolean => shot.id === 'shot-1')).toEqual(project.shots.find((shot): boolean => shot.id === 'shot-1'));
    expect(candidate.project.frames.every((frame): boolean => frame.visualReview === 'pending')).toBe(true);
    expect(candidate.writes).toEqual([]); expect(project).toEqual(before);
  });

  it('automation_planner_cancels_before_model_and_checks_staging_budget_without_project_writes', async (): Promise<void> => {
    const project = await automaticPlanProject(); const staged = stagedPlanSpeech(project); const basis = createSegmentPlanBasis(project, 'demonstration', ['shot-2']);
    const controller = new AbortController(); const model = vi.fn();
    const services: AutomaticPlanServices = { textFontPath: TEST_TEXT_FONT_PATH, loadExistingAudio: noExistingAudio, speech: { run: vi.fn().mockResolvedValue(staged.result) }, model: { run: model }, onProgress: vi.fn(async (): Promise<void> => {}), onSpeechReady: async (): Promise<void> => { controller.abort(); } };
    await expect(planAutomaticSegment(project, basis, options(), services, controller.signal)).rejects.toMatchObject({ code: 'AUTOMATION_CANCELLED' });
    expect(model).not.toHaveBeenCalled(); expect(project.assets).toEqual([]);
    await expect(planAutomaticSegment(project, basis, { ...options(), maxStagedAudioBytes: 50 }, { ...services, onSpeechReady: vi.fn(async (): Promise<void> => {}) }, new AbortController().signal)).rejects.toMatchObject({ code: 'AUTOMATION_AUDIO_BUDGET' });
    expect(model).not.toHaveBeenCalled();
    const progressCancel = new AbortController(); const speech = vi.fn();
    await expect(planAutomaticSegment(project, basis, options(), { ...services, speech: { run: speech }, onProgress: async (): Promise<void> => { progressCancel.abort(); } }, progressCancel.signal)).rejects.toMatchObject({ code: 'AUTOMATION_CANCELLED' });
    expect(speech).not.toHaveBeenCalled();
    const invalid = options();
    Object.assign(invalid.provenance.generatorBuild, { unrelatedRuntimeField: 1 });
    await expect(planAutomaticSegment(project, basis, invalid, { ...services, speech: { run: speech } }, new AbortController().signal)).rejects.toBeInstanceOf(z.ZodError);
    expect(speech).not.toHaveBeenCalled();
  });

  it('automation_plan_context_excludes_other_segments_paths_assets_bytes_and_acceptance_commands', async (): Promise<void> => {
    const project = await automaticPlanProject(); const basis = createSegmentPlanBasis(project, 'demonstration', ['shot-2']);
    const context = automaticSegmentContext(project, basis, [stagedPlanSpeech(project)], [], null, 64, { fontSha256: 'a'.repeat(64), previousReview: null }, null);
    const snapshot = JSON.parse(context.prompt.split('입력 스냅샷:\n')[1] ?? '') as { units: { segmentId: string }[]; measuredSpeech: unknown[]; shots: unknown[]; sources?: unknown };
    expect(snapshot.units.every((unit): boolean => unit.segmentId === 'demonstration')).toBe(true);
    expect(snapshot.sources).toBeUndefined();
    expect(context.prompt).not.toContain('흙이 마르면 물을 주세요.');
    expect(context.prompt).not.toContain('"type":"Buffer"');
    expect(context.prompt).not.toContain('/Users/');
    const schema = context.outputSchema as { properties: Record<string, unknown> };
    expect(schema.properties).not.toHaveProperty('approvalStatus');
    expect(schema.properties).not.toHaveProperty('dataset');
  });
});

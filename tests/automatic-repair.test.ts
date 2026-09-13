import { z } from 'zod';
import { describe, expect, it, vi } from 'vitest';
import { automaticHash } from '../src/automation/application-evidence.js';
import { nextAutomaticWork } from '../src/automation/job-graph.js';
import type { AutomaticPlanProvenance } from '../src/automation/plan-compiler.js';
import { planSourceRepair } from '../src/automation/plan-repair.js';
import type { SourceRepairOptions, SourceRepairServices } from '../src/automation/plan-repair.js';
import { createSourceRepairBasis, sourceRepairScope } from '../src/automation/repair-basis.js';
import { compileSourceRepair } from '../src/automation/repair-compiler.js';
import { sourceRepairContext } from '../src/automation/repair-context.js';
import { createAutomationRun, reduceAutomationRun } from '../src/automation/run-state.js';
import type { StructuredGenerationInput } from '../src/codex/structured-engine.js';
import type { Project, ShotSourceLink } from '../src/domain/schema.js';
import { splitShot } from '../src/domain/edit.js';
import { updateAudioCueTiming } from '../src/domain/tracks.js';
import { initial } from './automatic-executor-helpers.js';
import { automaticPlanProvenance } from './automatic-plan-helpers.js';
import { preparedRepair, repairPlan } from './automatic-repair-helpers.js';

function provenance(): AutomaticPlanProvenance { return { ...automaticPlanProvenance(), generationId: 'repair-verified' }; }
function options(): SourceRepairOptions {
  const { model: _model, turnId: _turn, prompt: _prompt, ...value } = provenance();
  return { provenance: value, maxCorrections: 1, maxFrames: 64, maxAudioBytes: 5_000_000, voice: { name: 'Yuna', rateWordsPerMinute: 180 } };
}

describe('기존 컷의 미정 연결 자동 보완', (): void => {
  it('automatic_repair_preserves_manual_cuts_frames_text_assets_and_records_while_restoring_audio', async (): Promise<void> => {
    const h = await preparedRepair(); const before = structuredClone(h.project);
    const basis = createSourceRepairBasis(h.project, 'demonstration');
    const candidate = compileSourceRepair(h.project, basis, repairPlan(h.project), h.files, [], provenance(), 64);
    expect(basis.targets.map((target): string => target.unitId)).toEqual(['안내-1', '동작']);
    expect(candidate.project.shots.map(({ sourceLinks: _links, ...shot }) => shot)).toEqual(before.shots.map(({ sourceLinks: _links, ...shot }) => shot));
    for (const key of ['dataset', 'profile', 'frames', 'textCues', 'textMappingDecisions', 'assets'] as const) expect(candidate.project[key]).toEqual(before[key]);
    expect(candidate.project.audioCues.map(({ timingStatus: _status, ...cue }) => cue)).toEqual(before.audioCues.map(({ timingStatus: _status, ...cue }) => cue));
    expect(candidate.project.audioCues.find((cue): boolean => cue.id === h.files[0]!.cueId)?.timingStatus).toBe('measured');
    expect(candidate.project.audioCues.find((cue): boolean => cue.unitId === '효과음')?.assetId).toBeNull();
    expect(candidate.exceptions).not.toContainEqual(expect.objectContaining({ code: 'AUDIO_NOT_MEASURED', entityId: before.audioCues.find((cue): boolean => cue.unitId === '효과음')!.id }));
    expect(candidate.exceptions).toContainEqual(expect.objectContaining({ code: 'SHOT_APPROVAL_REQUIRED' }));
    expect(candidate.project.generationRecords.slice(0, before.generationRecords.length)).toEqual(before.generationRecords);
    expect(candidate.project.generationRecords.at(-1)).toMatchObject({ templateVersion: 'automatic-source-repair-1.0.0', referenceHashes: expect.arrayContaining([before.assets[0]!.sha256]) });
    expect(JSON.parse(candidate.project.generationRecords.at(-1)!.prompt)).toMatchObject({ existingAudio: [{ previousTimingStatus: 'proposed' }], remainingReview: expect.any(Array) });
    expect(candidate.writes).toEqual([]); expect(h.project).toEqual(before);
  });

  it('automatic_repair_rejects_stale_scope_duplicate_missing_and_confirmed_link_changes', async (): Promise<void> => {
    const h = await preparedRepair(); const basis = createSourceRepairBasis(h.project, 'demonstration'); const plan = repairPlan(h.project);
    const confirmed = h.project.shots.find((shot): boolean => shot.segmentId === 'demonstration')!.sourceLinks[2]!;
    const variants = [
      { ...plan, links: [] }, { ...plan, links: [...plan.links, plan.links[0]!] },
      { ...plan, links: [...plan.links, { ...plan.links[0]!, unitId: confirmed.unitId, linkIndex: 2 }] },
      { ...plan, links: plan.links.map((link) => ({ ...link, shotId: 'other-shot' })) }, { ...plan, segmentId: 'other-segment' },
      { ...plan, links: plan.links.map((link) => link.unitId === '안내-1' ? { ...link, usage: 'context-only' } : link) },
    ];
    for (const input of variants) expect(() => compileSourceRepair(h.project, basis, input, h.files, [], provenance(), 64)).toThrowError(expect.objectContaining({ code: 'AUTOMATION_REPAIR_SCOPE' }));
    expect(() => compileSourceRepair({ ...h.project, revision: 1 }, basis, plan, h.files, [], provenance(), 64)).toThrowError(expect.objectContaining({ code: 'AUTOMATION_STALE_PLAN' }));
    expect(() => compileSourceRepair(h.project, basis, { ...plan, audioTimings: [] }, h.files, [], provenance(), 64)).toThrowError(z.ZodError);
    expect(() => compileSourceRepair(h.project, { ...basis, targets: [] }, plan, h.files, [], provenance(), 64)).toThrowError(expect.objectContaining({ code: 'AUTOMATION_REPAIR_SCOPE' }));
  });

  it('automatic_repair_preserves_approved_locked_and_accepted_targets_and_shared_audio', async (): Promise<void> => {
    const h = await preparedRepair(); const shot = h.project.shots.find((value): boolean => value.segmentId === 'demonstration')!;
    const variants: Project[] = [
      { ...h.project, shots: h.project.shots.map((value) => value.id === shot.id ? { ...value, approvalStatus: 'approved' } : value) },
      { ...h.project, shots: h.project.shots.map((value) => value.id === shot.id ? { ...value, lockedFields: ['camera'] } : value) },
      { ...h.project, frames: h.project.frames.map((frame) => frame.shotId === shot.id ? { ...frame, visualReview: 'accepted' } : frame) },
    ];
    for (const project of variants) {
      expect(sourceRepairScope(project, 'demonstration')).toEqual({ targets: [], audioCueIds: [], speechCueIds: [], soundCueIds: [] });
      expect(() => createSourceRepairBasis(project, 'demonstration')).toThrowError(expect.objectContaining({ code: 'AUTOMATION_NO_REPAIR' }));
    }
    const split = splitShot(h.project, shot.id, 6000, 'repair-neighbor', 'repair-neighbor-frame');
    const shared: Project = { ...split, shots: split.shots.map((value) => value.id === shot.id ? { ...value, lockedFields: ['camera'] } : value) };
    expect(shared.shots.filter((value): boolean => value.sourceLinks.some((link): boolean => link.unitId === '안내-1'))).toHaveLength(2);
    const scope = sourceRepairScope(shared, 'demonstration');
    expect(scope.targets.length).toBeGreaterThan(0); expect(scope.audioCueIds).toEqual([]);
    expect(scope.targets.every((target): boolean => target.shotId === 'repair-neighbor')).toBe(true);
  });

  it('automatic_repair_adds_only_missing_reveal_frames_with_a_finite_frame_budget', async (): Promise<void> => {
    const h = await preparedRepair(); const shot = h.project.shots.find((value): boolean => value.segmentId === 'demonstration')!;
    const unit = h.project.dataset.units.find((value): boolean => value.id === '동작')!;
    const link: ShotSourceLink = { unitId: '흙-확인', usage: 'primary-visual', status: 'mapping-required', temporalAnchor: { kind: 'unresolved', basis: 'estimated', status: 'review-required' } };
    const project: Project = { ...h.project, dataset: { ...h.project.dataset, units: [...h.project.dataset.units, { ...unit, id: link.unitId, order: 5, text: '물을 머금은 흙을 확인한다.', informationIds: [] }] },
      shots: h.project.shots.map((value) => value.id === shot.id ? { ...value, sourceLinks: [...value.sourceLinks, link] } : value) };
    const plan = repairPlan(project); plan.links.push({ shotId: shot.id, linkIndex: 3, unitId: link.unitId, usage: 'primary-visual', startOffsetMs: 4000, endOffsetMs: 8500, reason: '물소리 이후 젖은 흙의 원문 행동을 보여준다.' });
    const basis = createSourceRepairBasis(project, 'demonstration');
    const result = compileSourceRepair(project, basis, plan, h.files, [], provenance(), 64);
    expect(result.project.frames.slice(0, project.frames.length)).toEqual(project.frames);
    expect(result.project.frames.at(-1)).toMatchObject({ shotId: shot.id, offsetMs: 4000, role: 'key', visualReview: 'pending', imageAssetId: null });
    expect(() => compileSourceRepair(project, basis, plan, h.files, [], provenance(), 1)).toThrowError(expect.objectContaining({ code: 'AUTOMATION_FRAME_BUDGET' }));
  });

  it('automatic_repair_corrects_mapping_conflicts_but_does_not_retry_corruption_or_cancellation', async (): Promise<void> => {
    const h = await preparedRepair(); const basis = createSourceRepairBasis(h.project, 'demonstration'); const plan = repairPlan(h.project);
    const inputs: StructuredGenerationInput[] = [];
    const services: SourceRepairServices = { speech: { run: async (): Promise<never> => { throw new Error('기존 음원의 재합성은 허용하지 않습니다.'); } }, onSpeechReady: async (): Promise<void> => {}, loadExistingAudio: vi.fn(async (): Promise<Buffer> => Buffer.from(h.files[0]!.bytes)), onProgress: vi.fn(async (): Promise<void> => {}),
      model: { run: vi.fn(async (input) => { inputs.push(input); return { model: 'test', turnId: `repair-${inputs.length}`, result: z.json().parse(inputs.length === 1 ? { ...plan, links: plan.links.map((link) => link.unitId === '동작' ? { ...link, startOffsetMs: 2000 } : link) } : plan) }; }) } };
    const result = await planSourceRepair(h.project, basis, options(), services, new AbortController().signal);
    expect(inputs).toHaveLength(2); expect(inputs[1]!.prompt).toContain('AUTOMATION_REPAIR_INVALID'); expect(result.writes).toEqual([]);
    expect(services.loadExistingAudio).toHaveBeenCalledTimes(1);
    const corrupt = Buffer.from(h.files[0]!.bytes); corrupt[100] = corrupt[100]! ^ 1;
    services.loadExistingAudio = async (): Promise<Buffer> => corrupt;
    await expect(planSourceRepair(h.project, basis, options(), services, new AbortController().signal)).rejects.toMatchObject({ code: 'ASSET_HASH_MISMATCH' });
    expect(inputs).toHaveLength(2);
    services.loadExistingAudio = async (): Promise<Buffer> => Buffer.from(h.files[0]!.bytes);
    const stop = new AbortController(); services.onProgress = async (): Promise<void> => { stop.abort(); };
    await expect(planSourceRepair(h.project, basis, options(), services, stop.signal)).rejects.toMatchObject({ code: 'AUTOMATION_CANCELLED' });
    expect(inputs).toHaveLength(2);
  });

  it('automatic_repair_job_uses_preserved_cut_scope_and_rejects_foreign_run_segments', async (): Promise<void> => {
    const h = await preparedRepair(); const run = createAutomationRun(initial(h.project));
    const work = nextAutomaticWork(run, h.project);
    expect(work.kind).toBe('register'); if (work.kind !== 'register') throw new Error('미정 연결 작업이 없습니다.');
    expect(work.jobs.map((job) => job.task)).toEqual([{ kind: 'repair', segmentId: 'demonstration' }]);
    expect(nextAutomaticWork(run, h.project)).toEqual(work);
    expect(() => reduceAutomationRun(run, { type: 'jobs-added', jobs: work.jobs.map((job) => ({ ...job, task: { kind: 'repair', segmentId: 'foreign' } })), at: run.updatedAt })).toThrow();
    const context = sourceRepairContext(h.project, createSourceRepairBasis(h.project, 'demonstration'), h.files, [], null, 64);
    expect(context.prompt).not.toContain('"path":"assets/'); expect(context.prompt).toContain('"existingAudio":[');
    expect(context.prompt).toContain(automaticHash(h.project));
  });

  it('automatic_repair_keeps_conflicting_user_audio_and_cut_times_and_stops_after_finite_correction', async (): Promise<void> => {
    const h = await preparedRepair(); const cue = h.project.audioCues.find((value): boolean => value.id === h.files[0]!.cueId)!;
    const project = updateAudioCueTiming(h.project, cue.id, { startMs: 6000, endMs: 8300, timingRelation: 'within-segment' });
    const before = structuredClone(project); const plan = repairPlan(project);
    plan.links = plan.links.map((link) => link.unitId === '안내-1' ? { ...link, startOffsetMs: 1000, endOffsetMs: 3300 } : link);
    const services: SourceRepairServices = { speech: { run: async (): Promise<never> => { throw new Error('기존 음원의 재합성은 허용하지 않습니다.'); } }, onSpeechReady: async (): Promise<void> => {}, loadExistingAudio: async (): Promise<Buffer> => Buffer.from(h.files[0]!.bytes), onProgress: async (): Promise<void> => {},
      model: { run: vi.fn(async () => ({ model: 'test', turnId: 'fixed-time-conflict', result: z.json().parse(plan) })) } };
    await expect(planSourceRepair(project, createSourceRepairBasis(project, 'demonstration'), options(), services, new AbortController().signal)).rejects.toMatchObject({ code: 'AUTOMATION_REPAIR_INVALID' });
    expect(services.model.run).toHaveBeenCalledTimes(2); expect(project).toEqual(before);
    expect(project.audioCues.find((value): boolean => value.id === cue.id)).toMatchObject({ startMs: 6000, endMs: 8300, timingStatus: 'proposed' });
  });
});

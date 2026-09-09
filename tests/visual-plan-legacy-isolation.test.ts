import { describe, expect, it } from 'vitest';
import { approveShot, reviewShotVisualPlan, reviewShotVisualPlanChange, updateShotVisualPlan } from '../src/domain/edit.js';
import type { ShotVisualPlanInput } from '../src/domain/edit.js';
import { reviewFinalReadiness } from '../src/domain/final-readiness.js';
import type { Project, Shot, ShotSourceLink, StoryboardFrame } from '../src/domain/schema.js';
import { validateProject } from '../src/domain/validation.js';
import { readyVisualFixture } from './readiness-fixtures.js';

async function legacySegment(): Promise<Project> {
  const { project } = await readyVisualFixture(); const main: Shot = project.shots[1]!;
  const ranges: readonly { id: string; startMs: number; endMs: number }[] = [
    { id: main.id, startMs: 5000, endMs: 8000 }, { id: 'legacy-a', startMs: 8000, endMs: 11000 }, { id: 'legacy-b', startMs: 11000, endMs: 13500 },
  ];
  const shots: Shot[] = ranges.map((range): Shot => ({ ...main, ...range,
    sourceLinks: main.sourceLinks.map((link: ShotSourceLink): ShotSourceLink => link.unitId === '동작' ? { ...link,
      temporalAnchor: { kind: 'shot-offset', startOffsetMs: 0, endOffsetMs: range.endMs - range.startMs, basis: 'manual', status: 'confirmed' },
    } : link),
  }));
  const startFrame: StoryboardFrame = project.frames.find((frame: StoryboardFrame): boolean => frame.shotId === main.id)!;
  return { ...project, shots: [project.shots[0]!, ...shots, project.shots[2]!], frames: [...project.frames,
    ...ranges.slice(1).map((range): StoryboardFrame => ({ ...startFrame, id: `frame-${range.id}`, shotId: range.id, imageAssetId: null, visualReview: 'pending' })),
  ] };
}
function repairedPlan(project: Project, shotId: string): ShotVisualPlanInput {
  const shot: Shot = project.shots.find((candidate: Shot): boolean => candidate.id === shotId)!;
  return { visualMode: shot.visualMode, sourceLinks: shot.sourceLinks.map((link: ShotSourceLink): ShotSourceLink => link.unitId === '동작' ? { ...link, usage: 'continued-visual' } : link) };
}
function narrationAt(project: Project, offsetMs: number): ShotVisualPlanInput {
  const shot: Shot = project.shots.find((candidate: Shot): boolean => candidate.id === 'shot-2')!;
  return { visualMode: 'sourced', sourceLinks: shot.sourceLinks.map((link: ShotSourceLink): ShotSourceLink => link.unitId === '안내-1' ? {
    ...link, usage: 'primary-visual', temporalAnchor: { kind: 'shot-offset', startOffsetMs: offsetMs, endOffsetMs: shot.endMs - shot.startMs, basis: 'manual', status: 'confirmed' },
  } : link) };
}
async function delayedNarration(): Promise<Project> {
  const { project } = await readyVisualFixture();
  const plan: ShotVisualPlanInput = narrationAt(project, 2000);
  return { ...project, shots: project.shots.map((shot: Shot): Shot => shot.id === 'shot-2' ? { ...shot, ...plan } : shot) };
}

describe('Atomic Visual Plan의 Legacy Segment 오류 격리', (): void => {
  it('visual_plan_ignores_unchanged_unrelated_segment_issue', async (): Promise<void> => {
    const project: Project = await legacySegment();
    const next: Project = updateShotVisualPlan(project, 'legacy-a', repairedPlan(project, 'legacy-a'));
    expect(validateProject(next, next.dataset)).toContainEqual(expect.objectContaining({ code: 'DUPLICATE_PRIMARY_SOURCE', entityId: 'legacy-b' }));
    expect(next.shots.find((shot: Shot): boolean => shot.id === 'legacy-a')!.sourceLinks.find((link: ShotSourceLink): boolean => link.unitId === '동작')!.usage).toBe('continued-visual');
  });
  it('visual_plan_can_repair_two_invalid_shots_sequentially', async (): Promise<void> => {
    const project: Project = await legacySegment();
    const first: Project = updateShotVisualPlan(project, 'legacy-a', repairedPlan(project, 'legacy-a'));
    const second: Project = updateShotVisualPlan(first, 'legacy-b', repairedPlan(first, 'legacy-b'));
    expect(validateProject(second, second.dataset).filter((issue): boolean => issue.code === 'DUPLICATE_PRIMARY_SOURCE')).toEqual([]);
    expect(second.assets).toEqual(project.assets); expect(second.generationRecords).toEqual(project.generationRecords);
  });
  it('visual_plan_reports_unchanged_unrelated_issue_as_nonblocking', async (): Promise<void> => {
    const project: Project = await legacySegment(); const review = reviewShotVisualPlanChange(project, 'legacy-a', repairedPlan(project, 'legacy-a'));
    expect(review.blockingIssues).toEqual([]);
    expect(review.existingUnrelatedIssues).toContainEqual(expect.objectContaining({ code: 'DUPLICATE_PRIMARY_SOURCE', entityId: 'legacy-b' }));
  });
  it('visual_plan_may_reduce_existing_segment_issue', async (): Promise<void> => {
    const project: Project = await delayedNarration(); const plan: ShotVisualPlanInput = narrationAt(project, 1000);
    const review = reviewShotVisualPlanChange(project, 'shot-2', plan);
    expect(review.blockingIssues).toEqual([]);
    expect(review.existingUnrelatedIssues).toContainEqual(expect.objectContaining({ code: 'SOURCE_FIRST_REVEAL_ORDER_REVERSED' }));
    const next: Project = updateShotVisualPlan(project, 'shot-2', plan);
    expect(reviewFinalReadiness(next, {}).issues).toContainEqual(expect.objectContaining({ code: 'SOURCE_FIRST_REVEAL_ORDER_REVERSED' }));
  });
  it('visual_plan_rejects_new_segment_first_reveal_issue', async (): Promise<void> => {
    const { project } = await readyVisualFixture(); const plan: ShotVisualPlanInput = narrationAt(project, 1000);
    expect((): Project => updateShotVisualPlan(project, 'shot-2', plan)).toThrow(/SOURCE_FIRST_REVEAL_ORDER_REVERSED/);
  });
  it('visual_plan_rejects_worsened_segment_first_reveal_issue', async (): Promise<void> => {
    const project: Project = await delayedNarration(); const plan: ShotVisualPlanInput = narrationAt(project, 3000);
    expect((): Project => updateShotVisualPlan(project, 'shot-2', plan)).toThrow(/SOURCE_FIRST_REVEAL_ORDER_REVERSED/);
  });
  it('visual_plan_rejects_new_source_policy_issue_only', async (): Promise<void> => {
    const project: Project = await legacySegment(); const repaired: ShotVisualPlanInput = repairedPlan(project, 'legacy-a');
    const invalid: ShotVisualPlanInput = { ...repaired, sourceLinks: repaired.sourceLinks.map((link: ShotSourceLink): ShotSourceLink => link.unitId === '효과음' ? {
      ...link, usage: 'primary-visual', temporalAnchor: { kind: 'shot-offset', startOffsetMs: 0, endOffsetMs: 3000, basis: 'manual', status: 'confirmed' },
    } : link) };
    const review = reviewShotVisualPlanChange(project, 'legacy-a', invalid);
    expect(review.blockingIssues).toContainEqual(expect.objectContaining({ code: 'NONVISUAL_SOURCE_USAGE', entityId: 'legacy-a' }));
    expect(review.blockingIssues).not.toContainEqual(expect.objectContaining({ code: 'DUPLICATE_PRIMARY_SOURCE', entityId: 'legacy-b' }));
    expect(review.existingUnrelatedIssues).toContainEqual(expect.objectContaining({ code: 'DUPLICATE_PRIMARY_SOURCE', entityId: 'legacy-b' }));
    expect((): Project => updateShotVisualPlan(project, 'legacy-a', invalid)).toThrow(/NONVISUAL_SOURCE_USAGE/);
  });
  it('visual_plan_preview_and_save_share_change_policy', async (): Promise<void> => {
    const project: Project = await legacySegment(); const plan: ShotVisualPlanInput = repairedPlan(project, 'legacy-a');
    expect(reviewShotVisualPlan(project, 'legacy-a', plan)).toEqual([]);
    expect((): Project => updateShotVisualPlan(project, 'legacy-a', plan)).not.toThrow();
  });
  it('visual_plan_failure_leaves_project_byte_equivalent', async (): Promise<void> => {
    const project: Project = await legacySegment(); const before: string = JSON.stringify(project);
    expect((): Project => updateShotVisualPlan(project, 'legacy-a', { visualMode: 'sourced', sourceLinks: [] })).toThrow();
    expect(JSON.stringify(project)).toBe(before);
  });
  it('approval_still_blocks_legacy_segment_issue', async (): Promise<void> => {
    const project: Project = await legacySegment();
    const next: Project = updateShotVisualPlan(project, 'legacy-a', repairedPlan(project, 'legacy-a'));
    expect((): Project => approveShot(next, 'legacy-a')).toThrow(/DUPLICATE_PRIMARY_SOURCE/);
  });
  it('final_readiness_still_blocks_legacy_segment_issue', async (): Promise<void> => {
    const project: Project = await legacySegment();
    expect(reviewFinalReadiness(project, {}).issues).toContainEqual(expect.objectContaining({ code: 'DUPLICATE_PRIMARY_SOURCE', entityId: 'legacy-b' }));
  });
});

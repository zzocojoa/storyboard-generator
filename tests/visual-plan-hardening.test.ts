import { describe, expect, it } from 'vitest';
import { approveShot, shotContent, updateShotContent, updateShotVisualPlan } from '../src/domain/edit.js';
import { reviewFinalReadiness } from '../src/domain/final-readiness.js';
import { moveShotSourceLink, updateShotSourceLinks } from '../src/domain/mapping.js';
import type { Project, Shot, ShotSourceLink } from '../src/domain/schema.js';
import { firstVisualRevealOrderIssues } from '../src/domain/source-policy.js';
import { validateProject } from '../src/domain/validation.js';
import { applySegmentProposal } from '../src/proposal/model.js';
import type { SegmentProposal } from '../src/proposal/model.js';
import { nonSourcedShot, readinessOutline, readyVisualFixture } from './readiness-fixtures.js';

function reversedAnchors(project: Project): Project {
  return { ...project, shots: project.shots.map((shot: Shot): Shot => shot.id !== 'shot-2' ? shot : {
    ...shot, sourceLinks: shot.sourceLinks.map((link: ShotSourceLink): ShotSourceLink => link.unitId !== '안내-1' ? link : {
      ...link, usage: 'primary-visual', temporalAnchor: { kind: 'shot-offset', startOffsetMs: 4000, endOffsetMs: 8500, basis: 'manual', status: 'confirmed' },
    }),
  }) };
}

function orderedAnchors(project: Project): Project {
  const reversed: Project = reversedAnchors(project);
  return { ...reversed, shots: reversed.shots.map((shot: Shot): Shot => shot.id !== 'shot-2' ? shot : {
    ...shot, sourceLinks: shot.sourceLinks.map((link: ShotSourceLink): ShotSourceLink => link.unitId !== '안내-1' ? link : {
      ...link, temporalAnchor: { kind: 'shot-offset', startOffsetMs: 0, endOffsetMs: 8500, basis: 'manual', status: 'confirmed' },
    }),
  }) };
}

function repeatedProposal(): SegmentProposal {
  const shot = (sourceLinks: SegmentProposal['shots'][number]['sourceLinks']): SegmentProposal['shots'][number] => ({
    sourceLinks, durationWeight: 1, action: '순서 검증', visualLocationId: null, camera: { size: 'MS', angle: 'eye', move: 'static' },
    presence: [], propIds: [], cameraAxis: null, screenDirection: null, informationIds: [],
    transitionOut: { kind: 'cut', durationMs: 0, note: '' }, frameDescription: '순서 검증 프레임',
  });
  return { shots: [
    shot([{ unitId: '안내-1', usage: 'primary-visual' }, { unitId: '동작', usage: 'primary-visual' }]),
    shot([{ unitId: '동작', usage: 'continued-visual' }]),
    shot([{ unitId: '안내-1', usage: 'continued-visual' }, { unitId: '효과음', usage: 'audio-only' }]),
  ] };
}

describe('원자적 시각 계획과 시간순 공개', (): void => {
  it('legacy_mode_only_update_returns_actionable_error', async (): Promise<void> => {
    const project: Project = await readinessOutline();
    const shot: Shot = project.shots[0] as Shot;
    expect((): Project => updateShotContent(project, shot.id, { ...shotContent(shot), visualMode: 'black' }))
      .toThrow(expect.objectContaining({ code: 'VISUAL_PLAN_ATOMIC_UPDATE_REQUIRED' }));
  });

  it('validation_uses_temporal_first_reveal_order', async (): Promise<void> => {
    const project: Project = reversedAnchors(await readinessOutline());
    expect(validateProject(project, project.dataset)).toContainEqual(expect.objectContaining({
      code: 'SOURCE_FIRST_REVEAL_ORDER_REVERSED', entityId: 'shot-2',
    }));
  });

  it('sourced_to_black_is_applied_atomically', async (): Promise<void> => {
    const project: Project = await readinessOutline();
    const shot: Shot = nonSourcedShot(project.shots[0] as Shot, 'black');
    const next: Project = updateShotVisualPlan(project, shot.id, { visualMode: shot.visualMode, sourceLinks: shot.sourceLinks });
    expect(next.shots[0]).toMatchObject({ visualMode: 'black', sourceLinks: shot.sourceLinks });
    expect(next.dataset).toEqual(project.dataset);
    expect(project.shots[0]?.visualMode).toBe('sourced');
  });

  it('sourced_to_hold_previous_is_applied_atomically', async (): Promise<void> => {
    const project: Project = await readinessOutline();
    const shot: Shot = nonSourcedShot(project.shots[1] as Shot, 'hold-previous');
    expect(updateShotVisualPlan(project, shot.id, { visualMode: shot.visualMode, sourceLinks: shot.sourceLinks }).shots[1]?.visualMode).toBe('hold-previous');
  });

  it('black_to_sourced_adds_visual_sources_atomically', async (): Promise<void> => {
    const project: Project = await readinessOutline();
    const shot: Shot = project.shots[0] as Shot;
    const black: Project = updateShotVisualPlan(project, shot.id, { visualMode: 'black', sourceLinks: nonSourcedShot(shot, 'black').sourceLinks });
    expect(updateShotVisualPlan(black, shot.id, { visualMode: 'sourced', sourceLinks: shot.sourceLinks }).shots[0]?.sourceLinks).toEqual(shot.sourceLinks);
  });

  it('hold_previous_to_sourced_adds_visual_sources_atomically', async (): Promise<void> => {
    const project: Project = await readinessOutline();
    const shot: Shot = project.shots[1] as Shot;
    const hold: Project = updateShotVisualPlan(project, shot.id, { visualMode: 'hold-previous', sourceLinks: nonSourcedShot(shot, 'hold-previous').sourceLinks });
    expect(updateShotVisualPlan(hold, shot.id, { visualMode: 'sourced', sourceLinks: shot.sourceLinks }).shots[1]?.sourceLinks).toEqual(shot.sourceLinks);
  });

  it('visual_plan_rejects_direct_sources_for_black', async (): Promise<void> => {
    const project: Project = await readinessOutline();
    expect((): Project => updateShotVisualPlan(project, 'shot-1', { visualMode: 'black', sourceLinks: project.shots[0]!.sourceLinks }))
      .toThrow(/NON_SOURCED_DIRECT_VISUAL_LINK/);
  });

  it('visual_plan_rejects_direct_sources_for_hold', async (): Promise<void> => {
    const project: Project = await readinessOutline();
    expect((): Project => updateShotVisualPlan(project, 'shot-2', { visualMode: 'hold-previous', sourceLinks: project.shots[1]!.sourceLinks }))
      .toThrow(/NON_SOURCED_DIRECT_VISUAL_LINK/);
  });

  it('visual_plan_rejects_sourced_coverage_gap', async (): Promise<void> => {
    const project: Project = await readinessOutline();
    expect((): Project => updateShotVisualPlan(project, 'shot-1', { visualMode: 'sourced', sourceLinks: [] })).toThrow(/SHOT_VISUAL_COVERAGE_GAP/);
  });

  it('visual_plan_respects_sources_and_frames_locks', async (): Promise<void> => {
    const project: Project = await readinessOutline();
    for (const field of ['sources', 'frames'] as const) {
      const locked: Project = { ...project, shots: project.shots.map((shot: Shot): Shot => ({ ...shot, lockedFields: [field] })) };
      expect((): Project => updateShotVisualPlan(locked, 'shot-1', { visualMode: 'black', sourceLinks: [] })).toThrow(/잠금 해제/);
      expect(locked.shots[0]?.lockedFields).toEqual([field]);
    }
  });

  it('failed_visual_plan_change_leaves_project_unchanged', async (): Promise<void> => {
    const { project } = await readyVisualFixture();
    const before: string = JSON.stringify(project);
    expect((): Project => updateShotVisualPlan(project, 'shot-1', { visualMode: 'hold-previous', sourceLinks: [] })).toThrow(/HOLD_PREVIOUS_SOURCE_UNAVAILABLE/);
    expect(JSON.stringify(project)).toBe(before);
  });

  it('visual_plan_change_invalidates_approval_and_frames', async (): Promise<void> => {
    const { project } = await readyVisualFixture();
    const approved: Project = { ...project, shots: project.shots.map((shot: Shot): Shot => ({ ...shot, approvalStatus: 'approved' })) };
    const next: Project = updateShotVisualPlan(approved, 'shot-1', { visualMode: 'black', sourceLinks: nonSourcedShot(approved.shots[0]!, 'black').sourceLinks });
    expect(next.shots[0]?.approvalStatus).toBe('proposed');
    expect(next.frames.filter((frame): boolean => frame.shotId === 'shot-1').every((frame): boolean => frame.visualReview === 'pending')).toBe(true);
    expect(next.frames.map((frame): string | null => frame.imageAssetId)).toEqual(project.frames.map((frame): string | null => frame.imageAssetId));
    expect(next.assets).toEqual(project.assets);
    expect(next.generationRecords).toEqual(project.generationRecords);
  });

  it('manual_anchor_change_cannot_reverse_first_visual_reveal', async (): Promise<void> => {
    const project: Project = orderedAnchors(await readinessOutline());
    const reversed: Shot = reversedAnchors(project).shots[1] as Shot;
    expect((): Project => updateShotSourceLinks(project, reversed.id, { links: reversed.sourceLinks })).toThrow(/SOURCE_FIRST_REVEAL_ORDER_REVERSED/);
    expect((): Project => updateShotVisualPlan(project, reversed.id, { visualMode: 'sourced', sourceLinks: reversed.sourceLinks })).toThrow(/SOURCE_FIRST_REVEAL_ORDER_REVERSED/);
  });

  it('manual_source_move_cannot_reverse_first_visual_reveal', async (): Promise<void> => {
    const project: Project = applySegmentProposal(await readinessOutline(), 'demonstration', repeatedProposal(), 'move');
    expect((): Project => moveShotSourceLink(project, 'move:shot:1', { unitId: '안내-1', targetShotId: 'move:shot:2', usage: 'primary-visual' }))
      .toThrow(/SOURCE_FIRST_REVEAL_ORDER_REVERSED/);
  });

  it('approval_blocks_temporal_source_order_reversal', async (): Promise<void> => {
    const project: Project = reversedAnchors(await readinessOutline());
    expect((): Project => approveShot(project, 'shot-2')).toThrow(/SOURCE_FIRST_REVEAL_ORDER_REVERSED/);
  });

  it('final_readiness_blocks_temporal_source_order_reversal', async (): Promise<void> => {
    const project: Project = reversedAnchors(await readinessOutline());
    const report = reviewFinalReadiness(project, {});
    expect(report.finalReady).toBe(false);
    expect(report.issues).toContainEqual(expect.objectContaining({ code: 'SOURCE_FIRST_REVEAL_ORDER_REVERSED' }));
  });

  it('proposal_and_manual_edit_share_first_reveal_policy', async (): Promise<void> => {
    const project: Project = await readinessOutline();
    const proposal: SegmentProposal = repeatedProposal();
    const reversed: SegmentProposal = { shots: [{ ...proposal.shots[0]!, sourceLinks: [
      { unitId: '안내-1', usage: 'primary-visual', anchor: { startPermille: 500, endPermille: 1000 } },
      { unitId: '동작', usage: 'primary-visual' }, { unitId: '효과음', usage: 'audio-only' },
    ] }] };
    expect((): Project => applySegmentProposal(project, 'demonstration', reversed, 'reversed'))
      .toThrow(expect.objectContaining({ issues: expect.arrayContaining([expect.objectContaining({ code: 'SOURCE_FIRST_REVEAL_ORDER_REVERSED' })]) }));
    expect(firstVisualRevealOrderIssues(reversedAnchors(project), 'demonstration')[0]?.sourceRefs.length).toBeGreaterThan(0);
  });

  it('continued_visual_reappearance_does_not_reset_manual_order', async (): Promise<void> => {
    const project: Project = applySegmentProposal(await readinessOutline(), 'demonstration', repeatedProposal(), 'continued');
    const shot: Shot = project.shots.find((value: Shot): boolean => value.id === 'continued:shot:3') as Shot;
    expect(updateShotSourceLinks(project, shot.id, { links: shot.sourceLinks }).shots).toEqual(project.shots.map((value: Shot): Shot => value.id === shot.id ? { ...value, proposalOrigin: 'manual' } : value));
    expect(firstVisualRevealOrderIssues(project, 'demonstration')).toEqual([]);
  });

  it('simultaneous_first_reveal_is_not_reversed', async (): Promise<void> => {
    const project: Project = orderedAnchors(await readinessOutline());
    const reversedArrays: Project = { ...project, shots: project.shots.map((shot: Shot): Shot => ({ ...shot, sourceLinks: [...shot.sourceLinks].reverse() })) };
    expect(firstVisualRevealOrderIssues(reversedArrays, 'demonstration')).toEqual([]);
    expect(validateProject(reversedArrays, project.dataset).filter((value): boolean => value.code.includes('ORDER_REVERSED'))).toEqual([]);
  });

  it('unresolved_anchor_is_not_treated_as_zero_time', async (): Promise<void> => {
    const project: Project = reversedAnchors(await readinessOutline());
    const unresolved: Project = { ...project, shots: project.shots.map((shot: Shot): Shot => ({ ...shot,
      sourceLinks: shot.sourceLinks.map((link: ShotSourceLink): ShotSourceLink => link.unitId !== '동작' ? link : {
        ...link, temporalAnchor: { kind: 'unresolved', basis: 'estimated', status: 'review-required' },
      }),
    })) };
    expect(firstVisualRevealOrderIssues(unresolved, 'demonstration')).toEqual([]);
    expect((): Project => approveShot(unresolved, 'shot-2')).toThrow(/SOURCE_TEMPORAL_ANCHOR_REQUIRED/);
  });
});

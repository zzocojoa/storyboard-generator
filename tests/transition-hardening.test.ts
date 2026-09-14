import { legacyTextProject } from './legacy-text-helpers.js';
import { describe, expect, it } from 'vitest';
import { approveShot } from '../src/domain/edit.js';
import { reviewFinalReadiness } from '../src/domain/final-readiness.js';
import { reviewFrameOutput } from '../src/domain/frame-output.js';
import type { Project, Shot, Transition } from '../src/domain/schema.js';
import { transitionVisualPolicy } from '../src/domain/transition.js';
import { reviewShotVisualTimeline, reviewVisualOutputAt } from '../src/domain/visual-output.js';
import { parseProject } from '../src/io/project.js';
import { applySegmentProposal } from '../src/proposal/model.js';
import { finalFixture, readyVisualFixture } from './readiness-fixtures.js';

function withTransition(project: Project, transition: Transition): Project {
  return { ...project, shots: project.shots.map((shot: Shot, index: number): Shot => index === 0 ? { ...shot, transitionOut: transition } : shot) };
}

async function assertEarlyExposure(kind: 'dissolve' | 'wipe' | 'match-cut'): Promise<void> {
  const { project } = await readyVisualFixture();
  const changed: Project = withTransition(project, { kind, durationMs: 500, note: '' });
  expect(transitionVisualPolicy(changed.shots[0]!.transitionOut, changed.shots[0]!, changed.shots[1]!)).toMatchObject({ incomingRevealMs: 4500, incomingExposure: 'from-transition-start', issues: [] });
  expect(reviewVisualOutputAt(changed, 4499, 'transition-preview').imageAssetId).toBeNull();
  expect(reviewVisualOutputAt(changed, 4500, 'transition-preview').imageAssetId).toBe('image:frame-2');
}

describe('전환의 실제 Incoming 노출', (): void => {
  it('cut_has_no_early_incoming_exposure', async (): Promise<void> => {
    const { project } = await readyVisualFixture();
    expect(transitionVisualPolicy(project.shots[0]!.transitionOut, project.shots[0]!, project.shots[1]!)).toMatchObject({ incomingExposure: 'none', incomingRevealMs: null });
    expect(reviewVisualOutputAt(project, 4999, 'transition-preview').imageAssetId).toBeNull();
    expect(reviewVisualOutputAt(project, 5000, 'program-monitor').imageAssetId).toBe('image:frame-2');
  });
  it('fade_to_black_has_no_early_incoming_exposure', async (): Promise<void> => {
    const { project } = await readyVisualFixture();
    const changed: Project = withTransition(project, { kind: 'fade', durationMs: 500, note: '' });
    const decision = reviewVisualOutputAt(changed, 4750, 'transition-preview');
    expect(decision.imageAssetId).toBeNull();
    expect(decision.issues).toContainEqual(expect.objectContaining({ code: 'TRANSITION_PREVIEW_INACTIVE' }));
  });

  it('custom_transition_requires_explicit_visual_policy', async (): Promise<void> => {
    const { project } = await readyVisualFixture();
    const changed: Project = withTransition(project, { kind: 'custom', durationMs: 500, note: '검은 화면 뒤 다음 장면' });
    expect((): Project => approveShot(changed, 'shot-1')).toThrow(/TRANSITION_VISUAL_POLICY_REVIEW_REQUIRED/);
    const shot: Shot = changed.shots[0]!;
    expect((): Project => applySegmentProposal(changed, shot.segmentId, { shots: [{
      sourceLinks: shot.sourceLinks.map((link) => ({ unitId: link.unitId, usage: link.usage })), durationWeight: 1, action: shot.action,
      visualLocationId: shot.visualLocationId, camera: { size: 'MS', angle: 'eye', move: 'static' }, presence: shot.presence, propIds: shot.propIds, cameraAxis: shot.cameraAxis,
      screenDirection: shot.screenDirection, informationIds: shot.informationIds, transitionOut: shot.transitionOut, frameDescription: '전환 검증',
    }] }, 'custom')).toThrow(expect.objectContaining({ issues: expect.arrayContaining([expect.objectContaining({ code: 'TRANSITION_VISUAL_POLICY_REVIEW_REQUIRED' })]) }));
    const explicit: Project = withTransition(project, { ...shot.transitionOut, incomingExposure: 'none' });
    expect(approveShot(explicit, shot.id).shots[0]?.approvalStatus).toBe('approved');
  });

  it('dissolve_exposes_incoming_from_transition_start', async (): Promise<void> => { await assertEarlyExposure('dissolve'); });
  it('wipe_exposes_incoming_from_transition_start', async (): Promise<void> => { await assertEarlyExposure('wipe'); });
  it('match_cut_exposes_incoming_from_transition_start', async (): Promise<void> => { await assertEarlyExposure('match-cut'); });

  it('fade_through_black_exposes_incoming_after_midpoint', async (): Promise<void> => {
    const { project } = await readyVisualFixture();
    const changed: Project = withTransition(project, { kind: 'fade', durationMs: 500, note: '', incomingExposure: 'after-black-midpoint' });
    expect(transitionVisualPolicy(changed.shots[0]!.transitionOut, changed.shots[0]!, changed.shots[1]!).incomingRevealMs).toBe(4750);
    expect(reviewVisualOutputAt(changed, 4749, 'transition-preview').imageAssetId).toBeNull();
    expect(reviewVisualOutputAt(changed, 4750, 'transition-preview').imageAssetId).toBe('image:frame-2');
    expect(reviewFrameOutput(changed, 'frame-2', 'transition-preview').imageAssetId).toBe('image:frame-2');
  });

  it('transition_preview_and_final_readiness_share_policy', async (): Promise<void> => {
    const { project, integrity } = await finalFixture();
    for (const kind of ['cut', 'fade', 'dissolve', 'wipe', 'match-cut', 'custom'] as const) {
      const changed: Project = withTransition(project, { kind, durationMs: kind === 'cut' ? 0 : 500, note: '전환 계획' });
      const report = reviewFinalReadiness(changed, integrity);
      const preview = reviewVisualOutputAt(changed, 4750, 'transition-preview');
      expect(report.finalReady).toBe(kind !== 'custom');
      expect(preview.imageAssetId !== null).toBe(['dissolve', 'wipe', 'match-cut'].includes(kind));
      expect(reviewShotVisualTimeline(changed, changed.shots[0]!, 'readiness').length === 0).toBe(kind !== 'custom');
    }
  });

  it('transition_information_gate_uses_actual_incoming_reveal_time', async (): Promise<void> => {
    const { project, integrity } = await finalFixture();
    const unit = project.dataset.units.find((value): boolean => value.id === '동작')!;
    const gated: Project = { ...project, dataset: { ...project.dataset,
      units: project.dataset.units.map((value) => value.id === unit.id ? { ...value, informationIds: ['incoming'] } : value),
      informationRules: [{ id: 'incoming', segmentId: unit.segmentId, baseNotBeforeMs: 5000, notBeforeUnitId: unit.id,
        notBeforeUnitOrder: unit.order, precision: 'exact-time', sourceRefs: unit.sourceRefs }],
    }, shots: project.shots.map((shot: Shot): Shot => shot.id === 'shot-2' ? { ...shot, informationIds: ['incoming'] } : shot) };
    const changed: Project = withTransition(gated, { kind: 'fade', durationMs: 500, note: '', incomingExposure: 'after-black-midpoint' });
    const preview = reviewVisualOutputAt(changed, 4999, 'transition-preview');
    expect(preview.renderMode).toBe('blocked');
    expect(preview.issues).toContainEqual(expect.objectContaining({ code: 'EARLY_INFORMATION_REVEAL', actual: '4750' }));
    expect(reviewFinalReadiness(changed, integrity).issues).toContainEqual(expect.objectContaining({ code: 'EARLY_INFORMATION_REVEAL', actual: '4750' }));
    expect((): Project => approveShot(changed, 'shot-1')).toThrow(/EARLY_INFORMATION_REVEAL/);
  });

  it('legacy_transition_migration_preserves_fade_and_custom_meaning', async (): Promise<void> => {
    const { project } = await readyVisualFixture();
    const input = { ...legacyTextProject(project), schemaVersion: '1.7.0', shots: project.shots.map((shot: Shot, index: number): Shot => ({ ...shot,
      transitionOut: index === 0 ? { kind: 'fade', durationMs: 500, note: '기존 페이드' } : index === 1 ? { kind: 'custom', durationMs: 500, note: '미정 효과' } : shot.transitionOut,
    })) };
    const before: string = JSON.stringify(input);
    const migrated: Project = parseProject(input);
    expect(migrated.shots[0]?.transitionOut).toEqual({ kind: 'fade', durationMs: 500, note: '기존 페이드', incomingExposure: 'none' });
    expect(migrated.shots[1]?.transitionOut.incomingExposure).toBe('review-required');
    expect(migrated.assets).toEqual(project.assets);
    expect(migrated.frames).toEqual(project.frames);
    expect(migrated.dataset).toEqual(project.dataset);
    expect(JSON.stringify(input)).toBe(before);
    expect(parseProject(migrated)).toEqual(migrated);
  });
});

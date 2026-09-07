import { describe, expect, it } from 'vitest';
import type { Project } from '../src/domain/schema.js';
import { applySegmentProposal } from '../src/proposal/model.js';
import type { SegmentProposal } from '../src/proposal/model.js';
import { readinessOutline } from './readiness-fixtures.js';

type ProposedShot = SegmentProposal['shots'][number];
function proposedShot(links: ProposedShot['sourceLinks'], weight: number): ProposedShot {
  return { sourceLinks: links, durationWeight: weight, action: '검토 장면', visualLocationId: null,
    camera: { size: 'MS', angle: 'eye', move: 'static' }, presence: [], propIds: [], cameraAxis: null, screenDirection: null,
    informationIds: [], transitionOut: { kind: 'cut', durationMs: 0, note: '' }, frameDescription: '시작 장면' };
}
function shortProposal(points: readonly number[]): SegmentProposal {
  return { shots: [
    { ...proposedShot([{ unitId: 'UNIT-001', usage: 'primary-visual' }], 1), frames: points.map((atPermille: number) => ({ atPermille, role: 'key', description: `의미 ${atPermille}` })) },
    proposedShot([{ unitId: 'UNIT-001', usage: 'continued-visual' }, { unitId: '제목', usage: 'primary-visual' }], 999),
  ] };
}
function orderedProposal(): SegmentProposal {
  return { shots: [
    proposedShot([{ unitId: '안내-1', usage: 'primary-visual' }], 1),
    proposedShot([{ unitId: '동작', usage: 'primary-visual' }], 1),
    proposedShot([{ unitId: '안내-1', usage: 'continued-visual' }, { unitId: '효과음', usage: 'audio-only' }], 1),
  ] };
}

describe('명시 Frame 충돌과 최초 Source 공개', (): void => {
  it('distinct_permille_frames_cannot_collapse_silently', async (): Promise<void> => {
    const project: Project = await readinessOutline(); expect(() => applySegmentProposal(project, 'SEG-001', shortProposal([201, 202]), 'collision')).toThrowError(expect.objectContaining({ code: 'PROPOSAL_FRAME_OFFSET_COLLISION' }));
  });
  it('two_explicit_frames_at_same_millisecond_are_rejected', async (): Promise<void> => {
    const project: Project = await readinessOutline(); expect(() => applySegmentProposal(project, 'SEG-001', shortProposal([401, 499]), 'collision')).toThrowError(expect.objectContaining({ code: 'PROPOSAL_FRAME_OFFSET_COLLISION' }));
  });
  it('short_shot_frame_plan_preserves_semantic_points', async (): Promise<void> => {
    const project: Project = await readinessOutline(); const next: Project = applySegmentProposal(project, 'SEG-001', shortProposal([200, 600, 800]), 'short');
    expect(next.frames.filter((frame): boolean => frame.shotId === 'short:shot:1').map((frame) => [frame.offsetMs, frame.description])).toEqual([[0, '시작 장면'], [1, '의미 200'], [3, '의미 600'], [4, '의미 800']]);
  });
  it('explicit_frame_may_replace_derived_anchor_frame', async (): Promise<void> => {
    const project: Project = await readinessOutline(); const shot: ProposedShot = { ...proposedShot([
      { unitId: '안내-1', usage: 'primary-visual', anchor: { startPermille: 0, endPermille: 500 } },
      { unitId: '동작', usage: 'primary-visual', anchor: { startPermille: 500, endPermille: 1000 } },
      { unitId: '효과음', usage: 'audio-only' },
    ], 1), frames: [{ atPermille: 500, role: 'key', description: '명시 프레임 우선' }] };
    const next: Project = applySegmentProposal(project, 'demonstration', { shots: [shot] }, 'explicit');
    expect(next.frames.filter((frame): boolean => frame.shotId === 'explicit:shot:1' && frame.offsetMs === 4250)).toEqual([expect.objectContaining({ description: '명시 프레임 우선' })]);
  });
  it('continued_visual_after_later_primary_is_allowed', async (): Promise<void> => {
    const project: Project = await readinessOutline(); const next: Project = applySegmentProposal(project, 'demonstration', orderedProposal(), 'continued');
    expect(next.shots.find((shot): boolean => shot.id === 'continued:shot:3')?.sourceLinks[0]).toMatchObject({ unitId: '안내-1', usage: 'continued-visual' });
  });
  it('source_order_uses_first_reveal_per_unit', async (): Promise<void> => {
    const project: Project = await readinessOutline(); const proposal: SegmentProposal = orderedProposal();
    const next: Project = applySegmentProposal(project, 'demonstration', { shots: [...proposal.shots, proposedShot([{ unitId: '동작', usage: 'continued-visual' }], 1)] }, 'first');
    expect(next.shots.filter((shot): boolean => shot.segmentId === 'demonstration')).toHaveLength(4);
  });
  it('continued_visual_does_not_reset_unit_order', async (): Promise<void> => {
    const project: Project = await readinessOutline(); const proposal: SegmentProposal = orderedProposal();
    const next: Project = applySegmentProposal(project, 'demonstration', { shots: [...proposal.shots, proposedShot([{ unitId: '안내-1', usage: 'continued-visual' }], 1)] }, 'repeat');
    expect(next.dataset).toEqual(project.dataset); expect(next.audioCues).toEqual(project.audioCues);
  });
  it('first_visual_reveal_order_reversal_is_rejected', async (): Promise<void> => {
    const project: Project = await readinessOutline(); const proposal: SegmentProposal = orderedProposal();
    expect(() => applySegmentProposal(project, 'demonstration', { shots: [proposal.shots[1]!, proposal.shots[0]!, proposal.shots[2]!] }, 'reverse')).toThrowError(expect.objectContaining({ code: 'PROPOSAL_SOURCE_ORDER_REVERSED' }));
  });
});

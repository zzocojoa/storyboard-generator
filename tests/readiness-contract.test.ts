import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { approveShot, splitShot } from '../src/domain/edit.js';
import { reviewFinalReadiness } from '../src/domain/final-readiness.js';
import { updateStoryboardFrame } from '../src/domain/frame.js';
import { moveShotSourceLink, updateShotSourceLinks } from '../src/domain/mapping.js';
import { reviewTextOutput } from '../src/domain/output-policy.js';
import { reviewTextPlaybackWithPolicy } from '../src/domain/playback.js';
import type { Asset, Project, Shot, ShotSourceLink, StoryboardFrame, TextCue } from '../src/domain/schema.js';
import { activeVisualSourceLinks, proposedFrameVisualIntervals, sourceAnchorRange } from '../src/domain/source-anchor.js';
import { shotVisualCoverageGaps } from '../src/domain/source-policy.js';
import { confirmTextCueTiming } from '../src/domain/tracks.js';
import { reviewVisualOutputAt } from '../src/domain/visual-output.js';
import { exportShotCsvForPolicy } from '../src/exporters/csv.js';
import { exportProjectPdfForPolicy } from '../src/exporters/pdf.js';
import { parseProject } from '../src/io/project.js';
import { buildFrameImageContext } from '../src/proposal/context.js';
import { finalFixture, nonSourcedShot, readyVisualFixture, withFirstGap } from './readiness-fixtures.js';

const font: string = resolve('assets/fonts/NanumGothic-Regular.ttf');
function proposed(project: Project): Project { return { ...project, textCues: project.textCues.map((cue: TextCue): TextCue => ({ ...cue, timingStatus: 'proposed' })) }; }
function firstFrame(project: Project): StoryboardFrame { return project.frames[0] as StoryboardFrame; }
function firstShot(project: Project): Shot { return project.shots[0] as Shot; }
function held(project: Project): Project { return { ...project, shots: project.shots.map((shot: Shot, index: number): Shot => index === 1 ? nonSourcedShot(shot, 'hold-previous') : shot) }; }
function pointAnchored(project: Project): Project {
  const frame: StoryboardFrame = firstFrame(project);
  return { ...project, shots: project.shots.map((shot: Shot, index: number): Shot => index === 0 ? { ...shot, sourceLinks: [{ ...(shot.sourceLinks[0] as ShotSourceLink),
    temporalAnchor: { kind: 'frame', frameId: frame.id, basis: 'manual', status: 'confirmed' } }] } : shot) };
}
function rangeAnchored(project: Project): Project {
  const frame: StoryboardFrame = firstFrame(project);
  return { ...project, shots: project.shots.map((shot: Shot, index: number): Shot => index === 0 ? { ...shot, sourceLinks: [{ ...(shot.sourceLinks[0] as ShotSourceLink),
    temporalAnchor: { kind: 'frame-range', frameId: frame.id, endOffsetMs: 5000, basis: 'manual', status: 'confirmed' } }] } : shot) };
}

describe('Draft와 Final Text', (): void => {
  it('proposed_text_is_allowed_in_draft_preview', async (): Promise<void> => {
    const { project } = await finalFixture(); const draft: Project = proposed(project);
    expect(reviewTextPlaybackWithPolicy(draft, 0, { maturity: 'draft', channel: 'program-monitor' }).playable[0]?.timingStatus).toBe('proposed');
    expect(reviewTextOutput(draft, draft.textCues[0]!.id, { maturity: 'draft', channel: 'program-monitor' }).finalSafe).toBe(false);
  });
  it('proposed_text_is_blocked_in_final_output', async (): Promise<void> => {
    const { project } = await finalFixture(); const draft: Project = proposed(project);
    const decision = reviewTextOutput(draft, draft.textCues[0]!.id, { maturity: 'final', channel: 'program-monitor' });
    expect(decision.allowed).toBe(false); expect(decision.issues[0]).toMatchObject({ code: 'TEXT_TIMING_CONFIRMATION_REQUIRED', entityId: draft.textCues[0]!.id });
  });
  it('confirmed_text_is_safe_in_final_output', async (): Promise<void> => {
    const { project } = await finalFixture(); expect(reviewTextOutput(project, project.textCues[0]!.id, { maturity: 'final', channel: 'program-monitor' })).toMatchObject({ allowed: true, finalSafe: true });
  });
  it('final_pdf_rejects_unconfirmed_text', async (): Promise<void> => {
    const { project, integrity } = await finalFixture();
    await expect(exportProjectPdfForPolicy(proposed(project), font, async (): Promise<Buffer> => { throw new Error('차단된 PDF는 자산을 읽으면 안 됩니다.'); }, { maturity: 'final', channel: 'pdf-export' }, integrity)).rejects.toMatchObject({ code: 'FINAL_OUTPUT_NOT_READY' });
  });
  it('final_csv_marks_unconfirmed_text_as_blocked', async (): Promise<void> => {
    const { project, integrity } = await finalFixture(); const csv: string = exportShotCsvForPolicy(proposed(project), integrity, { maturity: 'final', channel: 'csv-export' });
    expect(csv).toContain('TEXT_TIMING_CONFIRMATION_REQUIRED'); expect(csv).toContain('blocked');
  });
  it('project_final_readiness_requires_confirmed_text', async (): Promise<void> => {
    const { project, integrity } = await finalFixture(); expect(reviewFinalReadiness(project, integrity).finalReady).toBe(true);
    const report = reviewFinalReadiness(proposed(project), integrity); expect(report.finalReady).toBe(false); expect(report.counts.textProposed).toBe(2);
  });
  it('draft_export_marks_proposed_text_as_draft', async (): Promise<void> => {
    const { project, integrity } = await finalFixture(); expect(exportShotCsvForPolicy(proposed(project), integrity, { maturity: 'draft', channel: 'csv-export' })).toContain('DRAFT · TIMING UNCONFIRMED');
  });
  it('final_export_succeeds_after_text_confirmation', async (): Promise<void> => {
    const { project, media, integrity } = await finalFixture(); const confirmed: Project = project.textCues.reduce((current: Project, cue: TextCue): Project => confirmTextCueTiming(current, cue.id), proposed(project));
    expect(reviewFinalReadiness(confirmed, integrity).finalReady).toBe(true);
    const pdf: Buffer = await exportProjectPdfForPolicy(confirmed, font, async (id: string): Promise<Buffer> => media.get(id) as Buffer, { maturity: 'final', channel: 'pdf-export' }, integrity);
    expect(pdf.subarray(0, 4).toString()).toBe('%PDF');
    expect(exportShotCsvForPolicy(confirmed, integrity, { maturity: 'final', channel: 'csv-export' })).toContain('FINAL');
  });
});

describe('실제 Playhead와 편집', (): void => {
  it('manual_source_edit_may_reduce_existing_visual_coverage_gap', async (): Promise<void> => {
    const { project } = await readyVisualFixture(); const gap: Project = withFirstGap(project, 1000); const smaller: Project = withFirstGap(project, 3000);
    const changed: Project = updateShotSourceLinks(gap, firstShot(gap).id, { links: firstShot(smaller).sourceLinks });
    expect(shotVisualCoverageGaps(changed, firstShot(changed))).toEqual([{ startMs: 3000, endMs: 5000 }]);
  });
  it('manual_anchor_move_invalidates_visual_coverage', async (): Promise<void> => {
    const { project } = await readyVisualFixture();
    const key: StoryboardFrame = { ...firstFrame(project), id: 'anchored-key', offsetMs: 1000, role: 'key', imageAssetId: null };
    const anchored: Project = { ...project, frames: [...project.frames, key], shots: project.shots.map((shot: Shot, index: number): Shot => index === 0 ? { ...shot, sourceLinks: [{ ...shot.sourceLinks[0]!, temporalAnchor: { kind: 'frame-range', frameId: key.id, endOffsetMs: 5000, basis: 'manual', status: 'confirmed' } }] } : shot) };
    const moved: Project = updateStoryboardFrame(anchored, key.id, { offsetMs: 2000, role: 'key', description: '검토 필요' });
    expect(shotVisualCoverageGaps(moved, firstShot(moved))).toEqual([{ startMs: 0, endMs: 5000 }]);
    expect(moved.frames.find((frame: StoryboardFrame): boolean => frame.id === key.id)?.visualReview).toBe('pending');
  });
  it('source_move_checks_both_source_and_target_coverage', async (): Promise<void> => {
    const { project } = await readyVisualFixture(); const split: Project = splitShot(project, 'shot-2', 9000, 'target', 'target-frame');
    const changed: Project = { ...split, shots: split.shots.map((shot: Shot): Shot => shot.id === 'target' ? { ...shot, sourceLinks: shot.sourceLinks.filter((link: ShotSourceLink): boolean => link.unitId !== '동작') } : shot) };
    expect((): Project => moveShotSourceLink(changed, 'shot-2', { unitId: '동작', targetShotId: 'target', usage: 'primary-visual' })).toThrowError(expect.objectContaining({ code: 'SHOT_VISUAL_COVERAGE_GAP' }));
    expect(firstShot(changed).id).toBe('shot-1');
  });
  it('program_monitor_blocks_visual_gap_at_actual_playhead', async (): Promise<void> => {
    const { project } = await readyVisualFixture(); const gap: Project = withFirstGap(project, 1000);
    expect(reviewVisualOutputAt(gap, 999, 'program-monitor').renderMode).toBe('bitmap');
    expect(reviewVisualOutputAt(gap, 1000, 'program-monitor').issues).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'SHOT_VISUAL_COVERAGE_GAP' })]));
  });
  it('readiness_excludes_sourced_visual_gap', async (): Promise<void> => {
    const { project, integrity } = await finalFixture(); const report = reviewFinalReadiness(withFirstGap(project, 1000), integrity);
    expect(report.counts.visualTimelineSafe).toBe(2); expect(report.counts.visualCoverageGapCount).toBe(1); expect(report.finalReady).toBe(false);
  });
  it('final_readiness_blocks_transition_revealing_incoming_information_early', async (): Promise<void> => {
    const { project, integrity } = await finalFixture(); const unit = project.dataset.units.find((value): boolean => value.id === '동작')!;
    const gated: Project = { ...project, dataset: { ...project.dataset,
      units: project.dataset.units.map((value) => value.id === unit.id ? { ...value, informationIds: ['incoming-info'] } : value),
      informationRules: [{ id: 'incoming-info', segmentId: unit.segmentId, baseNotBeforeMs: 5000, notBeforeUnitId: unit.id,
        notBeforeUnitOrder: unit.order, precision: 'exact-time', sourceRefs: unit.sourceRefs }],
    }, shots: project.shots.map((shot): Shot => shot.id === 'shot-2' ? { ...shot, informationIds: ['incoming-info'] } : shot) };
    expect(reviewFinalReadiness(gated, integrity).finalReady).toBe(true);
    const transition: Project = { ...gated, shots: gated.shots.map((shot): Shot => shot.id === 'shot-1'
      ? { ...shot, transitionOut: { kind: 'dissolve', durationMs: 500, note: '조기 공개 검증' } } : shot) };
    expect(reviewVisualOutputAt(transition, 4500, 'program-monitor').renderMode).toBe('bitmap');
    expect(reviewVisualOutputAt(transition, 4500, 'transition-preview').renderMode).toBe('blocked');
    expect(reviewFinalReadiness(transition, integrity).finalReady).toBe(false);
  });
  it('final_readiness_uses_current_reference_version_and_preserves_historical_integrity', async (): Promise<void> => {
    const { project, integrity } = await finalFixture(); const sourceRefs = project.dataset.units[0]!.sourceRefs;
    const old: Asset = { ...project.assets[0]!, id: 'old-location', path: 'assets/old-location.png', kind: 'location', subjectId: 'garden' };
    const current: Asset = { ...old, id: 'current-location', path: 'assets/current-location.png', version: 2 };
    const referenced: Project = { ...project, assets: [...project.assets, old, current],
      dataset: { ...project.dataset, locations: [{ id: 'garden', name: '정원', description: '최신 기준', sourceRefs }] },
      shots: project.shots.map((shot): Shot => ({ ...shot, visualLocationId: 'garden' })) };
    const statuses: Record<string, string> = { ...integrity, [old.id]: 'STORED_ASSET_HASH_MISMATCH', [current.id]: 'verified' };
    expect(buildFrameImageContext(referenced, firstFrame(referenced).id).visualReferences.map((asset): string => asset.id)).toEqual([current.id]);
    expect(reviewFinalReadiness(referenced, statuses).finalReady).toBe(true);
    expect(reviewFinalReadiness(referenced, { ...statuses, [current.id]: 'STORED_ASSET_HASH_MISMATCH' }).finalReady).toBe(false);
    expect(referenced.assets).toContainEqual(old);
  });
  it('pdf_marks_sourced_visual_gap_as_blocked', async (): Promise<void> => {
    const { project, integrity } = await finalFixture(); const ids: string[] = [];
    await exportProjectPdfForPolicy(withFirstGap(project, 1000), font, async (id: string): Promise<Buffer> => { ids.push(id); return (await readyVisualFixture()).bytes; }, { maturity: 'draft', channel: 'pdf-export' }, integrity);
    expect(ids).not.toContain(firstFrame(project).imageAssetId);
  });
  it('csv_marks_sourced_visual_gap_as_blocked', async (): Promise<void> => {
    const { project, integrity } = await finalFixture(); const csv: string = exportShotCsvForPolicy(withFirstGap(project, 1000), integrity, { maturity: 'draft', channel: 'csv-export' });
    expect(csv).toContain('SHOT_VISUAL_COVERAGE_GAP'); expect(csv).toContain('blocked');
  });
});

describe('Hold 종료 직전 안전성', (): void => {
  it('first_shot_hold_previous_cannot_be_approved', async (): Promise<void> => {
    const { project } = await readyVisualFixture(); const changed: Project = { ...project, shots: project.shots.map((shot: Shot, index: number): Shot => index === 0 ? nonSourcedShot(shot, 'hold-previous') : shot) };
    expect((): Project => approveShot(changed, firstShot(changed).id)).toThrowError(expect.objectContaining({ code: 'SHOT_APPROVAL_BLOCKED' }));
  });
  it('noncontiguous_hold_previous_cannot_be_approved', async (): Promise<void> => {
    const { project } = await readyVisualFixture(); const changed: Project = held(project);
    const gap: Project = { ...changed, shots: changed.shots.map((shot: Shot, index: number): Shot => index === 1 ? { ...shot, startMs: shot.startMs + 1 } : shot) };
    expect((): Project => approveShot(gap, gap.shots[1]!.id)).toThrow();
  });
  it('hold_previous_requires_safe_source_for_final_output', async (): Promise<void> => {
    const { project, integrity } = await finalFixture(); const report = reviewFinalReadiness(held(project), { ...integrity, [firstFrame(project).imageAssetId as string]: 'STORED_ASSET_HASH_MISMATCH' });
    expect(report.finalReady).toBe(false); expect(report.counts.visualTimelineSafe).toBe(1);
  });
  it('hold_previous_pending_predecessor_is_not_output_ready', async (): Promise<void> => {
    const { project } = await readyVisualFixture(); const pending: Project = { ...held(project), frames: project.frames.map((frame: StoryboardFrame, index: number): StoryboardFrame => index === 0 ? { ...frame, visualReview: 'pending' } : frame) };
    expect(reviewVisualOutputAt(pending, 5000, 'readiness').renderMode).toBe('blocked');
  });
  it('hold_previous_rejected_predecessor_is_not_output_ready', async (): Promise<void> => {
    const { project } = await readyVisualFixture(); const rejected: Project = { ...held(project), frames: project.frames.map((frame: StoryboardFrame, index: number): StoryboardFrame => index === 0 ? { ...frame, visualReview: 'rejected' } : frame) };
    expect(reviewVisualOutputAt(rejected, 5000, 'readiness').issues).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'FRAME_OUTPUT_REJECTED' })]));
  });
  it('hold_previous_may_resolve_black_predecessor', async (): Promise<void> => {
    const { project } = await readyVisualFixture(); const black: Project = { ...held(project), shots: held(project).shots.map((shot: Shot, index: number): Shot => index === 0 ? nonSourcedShot(shot, 'black') : shot) };
    expect(reviewVisualOutputAt(black, 5000, 'readiness')).toMatchObject({ renderMode: 'hold-previous', imageAssetId: null, issues: [] });
  });
  it('chained_hold_previous_resolves_to_safe_origin', async (): Promise<void> => {
    const { project } = await readyVisualFixture(); const chain: Project = { ...project, shots: project.shots.map((shot: Shot, index: number): Shot => index > 0 ? nonSourcedShot(shot, 'hold-previous') : shot) };
    expect(reviewVisualOutputAt(chain, 14000, 'program-monitor')).toMatchObject({ renderMode: 'hold-previous', sourceFrameId: firstFrame(project).id, imageAssetId: firstFrame(project).imageAssetId });
  });
});

describe('Frame 공개 점과 표시 구간', (): void => {
  it('frame_anchor_visual_range_persists_to_declared_end', async (): Promise<void> => {
    const { project } = await readyVisualFixture(); const ranged: Project = rangeAnchored(project); const shot: Shot = firstShot(ranged);
    expect(sourceAnchorRange(ranged, shot, shot.sourceLinks[0]!)).toEqual({ startMs: 0, endMs: 5000 });
    expect(activeVisualSourceLinks(ranged, shot, 4999)).toHaveLength(1); expect(activeVisualSourceLinks(ranged, shot, 5000)).toHaveLength(0);
  });
  it('coverage_uses_visual_interval_not_reveal_point', async (): Promise<void> => {
    const { project } = await readyVisualFixture(); const point: Project = pointAnchored(project); const range: Project = rangeAnchored(project);
    expect(shotVisualCoverageGaps(point, firstShot(point))).toHaveLength(1); expect(shotVisualCoverageGaps(range, firstShot(range))).toEqual([]);
  });
  it('later_frame_context_keeps_active_frame_anchored_source', async (): Promise<void> => {
    const { project } = await readyVisualFixture(); const ranged: Project = rangeAnchored(project);
    const later: StoryboardFrame = { ...firstFrame(project), id: 'later', offsetMs: 3000, role: 'key', imageAssetId: null, visualReview: 'pending' };
    const context = buildFrameImageContext({ ...ranged, frames: [...ranged.frames, later] }, later.id);
    expect(context.sourceUnits.map((unit): string => unit.id)).toEqual([firstShot(ranged).sourceLinks[0]!.unitId]);
  });
  it('ambiguous_frame_anchor_interval_requires_review', async (): Promise<void> => {
    const { project } = await readyVisualFixture(); const point: Project = pointAnchored(project); const shot: Shot = firstShot(point);
    const ambiguous: Shot = { ...shot, sourceLinks: [...shot.sourceLinks, { ...shot.sourceLinks[0]!, unitId: '제목' }] };
    expect(proposedFrameVisualIntervals(point, ambiguous).every((proposal): boolean => proposal.status === 'review-required' && proposal.proposedRange === null)).toBe(true);
    expect(proposedFrameVisualIntervals(point, shot)[0]?.proposedRange).toEqual({ startMs: 0, endMs: 5000 });
  });
  it('legacy_frame_anchor_migration_preserves_source_and_timing', async (): Promise<void> => {
    const { project } = await readyVisualFixture(); const point: Project = pointAnchored(project); const migrated: Project = parseProject({ ...point, schemaVersion: '1.6.0' });
    expect(migrated.shots).toEqual(point.shots); expect(migrated.frames).toEqual(point.frames); expect(migrated.dataset).toEqual(point.dataset); expect(parseProject(migrated)).toEqual(migrated);
  });
  it('migrated_unresolved_frame_anchor_blocks_output', async (): Promise<void> => {
    const { project } = await readyVisualFixture(); const migrated: Project = parseProject({ ...pointAnchored(project), schemaVersion: '1.6.0' });
    expect(reviewVisualOutputAt(migrated, 0, 'program-monitor').issues).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'SOURCE_VISUAL_INTERVAL_REQUIRED' })]));
  });
});

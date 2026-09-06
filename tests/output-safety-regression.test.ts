import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { updateShotContent } from '../src/domain/edit.js';
import { resolveTextCueMapping, reviewIssuesForTextCue, textCueInformationIds } from '../src/domain/emission.js';
import { frameOutputPlaceholderText, reviewFrameOutput } from '../src/domain/frame-output.js';
import { updateProjectProfile, updateStoryboardFrame } from '../src/domain/frame.js';
import { reconcileTextCues, updateShotSourceLinks, updateTextMappingDecision } from '../src/domain/mapping.js';
import { addReferenceAsset } from '../src/domain/media.js';
import { playableTextCuesAt } from '../src/domain/playback.js';
import type { Asset, Project, Shot, SourceUnit, StoryboardFrame, TextCue, TextMappingDecision, TextPlacement } from '../src/domain/schema.js';
import { deleteReviewTextCue, resolveTextCueAuthority } from '../src/domain/text.js';
import { exportShotCsv } from '../src/exporters/csv.js';
import { exportProjectJson } from '../src/exporters/json.js';
import { exportProjectPdf } from '../src/exporters/pdf.js';
import { importPackage } from '../src/importers/import-package.js';
import { createSourceOutline } from '../src/proposal/outline.js';
import { nativePackage, png } from './helpers.js';

async function outline(): Promise<Project> {
  return createSourceOutline(importPackage(await nativePackage()), { proposedTextHoldMs: 2000 });
}

type PlacementFixture = { project: Project; placement: TextPlacement; decision: TextMappingDecision; cue: TextCue; unit: SourceUnit };

async function placementFixture(): Promise<PlacementFixture> {
  const base: Project = await outline();
  const decision: TextMappingDecision = base.textMappingDecisions.find((candidate: TextMappingDecision): boolean => candidate.canonicalUnitId !== null) as TextMappingDecision;
  const placement: TextPlacement = base.dataset.textPlacements.find((candidate: TextPlacement): boolean => candidate.id === decision.placementId) as TextPlacement;
  const cue: TextCue = base.textCues.find((candidate: TextCue): boolean => candidate.placementId === placement.id) as TextCue;
  const unit: SourceUnit = base.dataset.units.find((candidate: SourceUnit): boolean => candidate.id === decision.canonicalUnitId) as SourceUnit;
  const project: Project = { ...base, dataset: { ...base.dataset,
    units: base.dataset.units.map((candidate: SourceUnit): SourceUnit => candidate.id === unit.id ? { ...candidate, informationIds: ['TEST-INFO'] } : candidate),
    informationRules: [...base.dataset.informationRules, { id: 'TEST-INFO', segmentId: placement.segmentId, baseNotBeforeMs: placement.startMs,
      notBeforeUnitId: unit.id, notBeforeUnitOrder: unit.order, precision: 'exact-time', sourceRefs: unit.sourceRefs }],
  } };
  return { project, placement, decision, cue, unit: { ...unit, informationIds: ['TEST-INFO'] } };
}

function decisionProject(fixture: PlacementFixture, relation: TextMappingDecision['relation'], status: TextMappingDecision['status']): Project {
  const canonicalUnitId: string | null = relation === 'standalone-placement' ? null : fixture.unit.id;
  const decision: TextMappingDecision = { ...fixture.decision, canonicalUnitId, relation, status,
    renderCanonicalSeparately: relation === 'separate-element', canonicalStartMs: relation === 'separate-element' ? fixture.placement.startMs : null,
    canonicalEndMs: relation === 'separate-element' ? fixture.placement.startMs + 500 : null };
  return { ...fixture.project,
    textMappingDecisions: fixture.project.textMappingDecisions.map((candidate: TextMappingDecision): TextMappingDecision => candidate.id === decision.id ? decision : candidate),
    textPlacementInformationDecisions: ['separate-element', 'standalone-placement'].includes(relation)
      ? [{ id: `placement-info:${fixture.placement.id}`, placementId: fixture.placement.id, status: 'non-informational', informationIds: [], note: null }] : [],
    textCues: fixture.project.textCues.map((candidate: TextCue): TextCue => candidate.id === fixture.cue.id ? { ...candidate,
      unitId: status === 'confirmed' && ['exact', 'abbreviation', 'replacement'].includes(relation) ? canonicalUnitId : null } : candidate),
  };
}

function reviewCue(project: Project, unit: SourceUnit, id: string): TextCue {
  const segment = project.dataset.segments.find((candidate): boolean => candidate.id === unit.segmentId);
  if (segment === undefined) throw new Error('검증용 Segment가 없습니다.');
  return { id, segmentId: unit.segmentId, unitId: null, placementId: null, mappingDecisionId: null, authority: 'review-required',
    text: '이전 저장값', startMs: segment.startMs, endMs: Math.min(segment.endMs, segment.startMs + 500), kind: 'overlay', timingStatus: 'proposed' };
}

async function acceptedFrameFixture(): Promise<{ project: Project; shot: Shot; frame: StoryboardFrame; asset: Asset }> {
  const base: Project = await outline();
  const shot: Shot = base.shots[0] as Shot;
  const frame: StoryboardFrame = base.frames.find((candidate: StoryboardFrame): boolean => candidate.shotId === shot.id) as StoryboardFrame;
  const asset: Asset = { id: `${frame.id}:accepted-image`, kind: 'image', subjectId: frame.id, path: 'assets/accepted.png', mimeType: 'image/png',
    sha256: '9'.repeat(64), description: '승인 이미지', durationMs: null, version: 1 };
  const project: Project = { ...base, assets: [...base.assets, asset], frames: base.frames.map((candidate: StoryboardFrame): StoryboardFrame => candidate.id === frame.id
    ? { ...candidate, imageAssetId: asset.id, visualReview: 'accepted' } : candidate) };
  return { project, shot, frame: project.frames.find((candidate: StoryboardFrame): boolean => candidate.id === frame.id) as StoryboardFrame, asset };
}

describe('Placement Text 출력 안전성', (): void => {
  it('unresolved_placement_mapping_is_not_playable', async (): Promise<void> => {
    const fixture: PlacementFixture = await placementFixture();
    const project: Project = decisionProject(fixture, 'abbreviation', 'unresolved');
    expect(playableTextCuesAt(project, fixture.cue.startMs).map((cue: TextCue): string => cue.id)).not.toContain(fixture.cue.id);
  });

  it('unresolved_placement_mapping_returns_review_issue', async (): Promise<void> => {
    const fixture: PlacementFixture = await placementFixture();
    expect(reviewIssuesForTextCue(decisionProject(fixture, 'abbreviation', 'unresolved'), fixture.cue.id)).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'TEXT_MAPPING_REVIEW_REQUIRED' })]));
  });

  it('unresolved_abbreviation_does_not_bypass_gate', async (): Promise<void> => {
    const fixture: PlacementFixture = await placementFixture();
    const project: Project = decisionProject(fixture, 'abbreviation', 'unresolved');
    expect(textCueInformationIds(project, fixture.cue)).toEqual([]);
    expect(reviewIssuesForTextCue(project, fixture.cue.id).length).toBeGreaterThan(0);
  });

  it.each(['exact', 'abbreviation', 'replacement'] as const)('confirmed_%s_placement_inherits_canonical_information', async (relation): Promise<void> => {
    const fixture: PlacementFixture = await placementFixture();
    expect(textCueInformationIds(decisionProject(fixture, relation, 'confirmed'), fixture.cue)).toEqual(['TEST-INFO']);
  });

  it('separate_element_placement_does_not_claim_canonical_information', async (): Promise<void> => {
    const fixture: PlacementFixture = await placementFixture();
    const project: Project = decisionProject(fixture, 'separate-element', 'confirmed');
    expect(resolveTextCueMapping(project, fixture.cue).inheritedInformationIds).toEqual([]);
  });

  it('separate_element_canonical_cue_uses_canonical_information', async (): Promise<void> => {
    const fixture: PlacementFixture = await placementFixture();
    const project: Project = decisionProject(fixture, 'separate-element', 'confirmed');
    const cues: TextCue[] = reconcileTextCues(project, project.textMappingDecisions, 2000);
    const canonical: TextCue = cues.find((cue: TextCue): boolean => cue.mappingDecisionId === fixture.decision.id) as TextCue;
    expect(textCueInformationIds({ ...project, textCues: cues }, canonical)).toEqual(['TEST-INFO']);
  });

  it('confirmed_standalone_placement_is_playable_without_canonical_information', async (): Promise<void> => {
    const fixture: PlacementFixture = await placementFixture();
    const project: Project = decisionProject(fixture, 'standalone-placement', 'confirmed');
    expect(textCueInformationIds(project, fixture.cue)).toEqual([]);
    expect(playableTextCuesAt(project, fixture.cue.startMs).map((cue: TextCue): string => cue.id)).toContain(fixture.cue.id);
  });

  it('missing_mapping_decision_blocks_placement_output', async (): Promise<void> => {
    const fixture: PlacementFixture = await placementFixture();
    const project: Project = { ...fixture.project, textMappingDecisions: fixture.project.textMappingDecisions.filter((decision: TextMappingDecision): boolean => decision.id !== fixture.decision.id) };
    expect(reviewIssuesForTextCue(project, fixture.cue.id)).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'TEXT_MAPPING_DECISION_MISSING' })]));
  });

  it('duplicate_mapping_decision_blocks_placement_output', async (): Promise<void> => {
    const fixture: PlacementFixture = await placementFixture();
    const project: Project = { ...fixture.project, textMappingDecisions: [...fixture.project.textMappingDecisions, { ...fixture.decision, id: `${fixture.decision.id}:duplicate` }] };
    expect(reviewIssuesForTextCue(project, fixture.cue.id)).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'TEXT_MAPPING_DECISION_AMBIGUOUS' })]));
  });
});

describe('Text Cue 권한 복구', (): void => {
  it('review_required_text_can_resolve_to_source_unit', async (): Promise<void> => {
    const project: Project = await outline();
    const unit: SourceUnit = project.dataset.units.find((candidate: SourceUnit): boolean => candidate.kind === 'NARRATION') as SourceUnit;
    const cue: TextCue = reviewCue(project, unit, 'review-source');
    const resolved: Project = resolveTextCueAuthority({ ...project, textCues: [...project.textCues, cue] }, cue.id,
      { authority: 'source-unit', unitId: unit.id, startMs: cue.startMs, endMs: cue.endMs, kind: 'dialogue-subtitle' });
    expect(resolved.textCues.find((candidate: TextCue): boolean => candidate.id === cue.id)).toEqual(expect.objectContaining({ authority: 'source-unit', unitId: unit.id, text: unit.text }));
  });

  it('review_required_text_can_resolve_to_placement', async (): Promise<void> => {
    const fixture: PlacementFixture = await placementFixture();
    const cue: TextCue = reviewCue(fixture.project, fixture.unit, fixture.cue.id);
    const prepared: Project = { ...fixture.project, textCues: fixture.project.textCues.map((candidate: TextCue): TextCue => candidate.id === fixture.cue.id ? cue : candidate) };
    const resolved: Project = resolveTextCueAuthority(prepared, cue.id, { authority: 'placement', placementId: fixture.placement.id });
    expect(resolved.textCues.find((candidate: TextCue): boolean => candidate.id === cue.id)).toEqual(expect.objectContaining({ authority: 'placement', placementId: fixture.placement.id, text: fixture.placement.text }));
  });

  it('review_required_text_can_resolve_to_mapping_decision', async (): Promise<void> => {
    const fixture: PlacementFixture = await placementFixture();
    const mapped: Project = updateTextMappingDecision(fixture.project, fixture.decision.id, { canonicalUnitId: fixture.unit.id, relation: 'separate-element', status: 'confirmed',
      renderCanonicalSeparately: true, canonicalStartMs: fixture.placement.startMs, canonicalEndMs: fixture.placement.startMs + 500, note: '검증' });
    const canonical: TextCue = mapped.textCues.find((candidate: TextCue): boolean => candidate.mappingDecisionId === fixture.decision.id) as TextCue;
    const prepared: Project = { ...mapped, textCues: mapped.textCues.map((candidate: TextCue): TextCue => candidate.id === canonical.id
      ? { ...candidate, authority: 'review-required', unitId: null, mappingDecisionId: null, text: '이전 저장값' } : candidate) };
    const resolved: Project = resolveTextCueAuthority(prepared, canonical.id, { authority: 'mapping-decision', mappingDecisionId: fixture.decision.id });
    expect(resolved.textCues.find((candidate: TextCue): boolean => candidate.id === canonical.id)).toEqual(expect.objectContaining({ authority: 'mapping-decision', mappingDecisionId: fixture.decision.id, text: fixture.unit.text }));
  });

  it('authority_resolution_preserves_exact_source_text', async (): Promise<void> => {
    const project: Project = await outline();
    const unit: SourceUnit = project.dataset.units.find((candidate: SourceUnit): boolean => candidate.kind === 'NARRATION') as SourceUnit;
    const cue: TextCue = reviewCue(project, unit, 'review-source-text');
    const resolved: Project = resolveTextCueAuthority({ ...project, textCues: [...project.textCues, cue] }, cue.id,
      { authority: 'source-unit', unitId: unit.id, startMs: cue.startMs, endMs: cue.endMs, kind: 'dialogue-subtitle' });
    expect(resolved.textCues.find((candidate: TextCue): boolean => candidate.id === cue.id)?.text).toBe(unit.text);
  });

  it('authority_resolution_rejects_cross_segment_source', async (): Promise<void> => {
    const project: Project = await outline();
    const first: SourceUnit = project.dataset.units[0] as SourceUnit;
    const other: SourceUnit = project.dataset.units.find((unit: SourceUnit): boolean => unit.segmentId !== first.segmentId) as SourceUnit;
    const cue: TextCue = reviewCue(project, first, 'review-cross-segment');
    expect(() => resolveTextCueAuthority({ ...project, textCues: [...project.textCues, cue] }, cue.id,
      { authority: 'source-unit', unitId: other.id, startMs: cue.startMs, endMs: cue.endMs, kind: cue.kind })).toThrowError(expect.objectContaining({ code: 'TEXT_CUE_SOURCE_SEGMENT_MISMATCH' }));
  });

  it('deletable_review_text_can_be_removed', async (): Promise<void> => {
    const project: Project = await outline();
    const cue: TextCue = reviewCue(project, project.dataset.units[0] as SourceUnit, 'review-delete');
    expect(deleteReviewTextCue({ ...project, textCues: [...project.textCues, cue] }, cue.id).textCues.some((candidate: TextCue): boolean => candidate.id === cue.id)).toBe(false);
  });

  it('required_placement_text_cannot_be_deleted', async (): Promise<void> => {
    const fixture: PlacementFixture = await placementFixture();
    expect(() => deleteReviewTextCue(fixture.project, fixture.cue.id)).toThrowError(expect.objectContaining({ code: 'REQUIRED_PLACEMENT_TEXT_CANNOT_BE_DELETED' }));
  });
});

describe('Canonical Cue identity', (): void => {
  async function duplicateCanonical(): Promise<{ project: Project; first: TextMappingDecision; second: TextMappingDecision }> {
    const fixture: PlacementFixture = await placementFixture();
    const first: TextMappingDecision = { ...fixture.decision, id: 'mapping-a', relation: 'abbreviation', status: 'confirmed', renderCanonicalSeparately: true,
      canonicalStartMs: fixture.placement.startMs, canonicalEndMs: fixture.placement.startMs + 300 };
    const second: TextMappingDecision = { ...first, id: 'mapping-b', canonicalStartMs: fixture.placement.startMs + 400, canonicalEndMs: fixture.placement.startMs + 700 };
    const project: Project = { ...fixture.project, textCues: fixture.project.textCues.filter((cue: TextCue): boolean => cue.authority !== 'mapping-decision') };
    return { project, first, second };
  }

  it('canonical_cue_is_keyed_by_mapping_decision_id', async (): Promise<void> => {
    const { project, first, second } = await duplicateCanonical();
    const cues: TextCue[] = reconcileTextCues(project, [first, second], 2000);
    expect(cues.filter((cue: TextCue): boolean => cue.authority === 'mapping-decision').map((cue: TextCue): string | null => cue.mappingDecisionId)).toEqual(['mapping-a', 'mapping-b']);
  });

  it('two_decisions_for_same_unit_create_distinct_cues', async (): Promise<void> => {
    const { project, first, second } = await duplicateCanonical();
    const cues: TextCue[] = reconcileTextCues(project, [first, second], 2000).filter((cue: TextCue): boolean => cue.authority === 'mapping-decision');
    expect(new Set(cues.map((cue: TextCue): string => cue.id)).size).toBe(2);
  });

  it('updating_one_mapping_does_not_move_other_mapping_cue', async (): Promise<void> => {
    const { project, first, second } = await duplicateCanonical();
    const cues: TextCue[] = reconcileTextCues(project, [first, second], 2000);
    const moved: TextMappingDecision = { ...first, canonicalStartMs: (first.canonicalStartMs as number) + 50, canonicalEndMs: (first.canonicalEndMs as number) + 50 };
    const next: TextCue[] = reconcileTextCues({ ...project, textCues: cues }, [moved, second], 2000);
    expect(next.find((cue: TextCue): boolean => cue.mappingDecisionId === second.id)?.startMs).toBe(second.canonicalStartMs);
  });
});

describe('Frame 안전 출력', (): void => {
  it('stale_frame_image_is_not_rendered_after_frame_move', async (): Promise<void> => {
    const fixture = await acceptedFrameFixture();
    const changed: Project = updateStoryboardFrame(fixture.project, fixture.frame.id, { offsetMs: fixture.frame.offsetMs, role: fixture.frame.role, description: `${fixture.frame.description} 변경` });
    expect(reviewFrameOutput(changed, fixture.frame.id, 'program-monitor').renderBitmap).toBe(false);
  });

  it('stale_frame_image_is_not_rendered_after_mapping_change', async (): Promise<void> => {
    const fixture: PlacementFixture = await placementFixture();
    const shot: Shot = fixture.project.shots.find((candidate: Shot): boolean => candidate.segmentId === fixture.placement.segmentId) as Shot;
    const frame: StoryboardFrame = fixture.project.frames.find((candidate: StoryboardFrame): boolean => candidate.shotId === shot.id) as StoryboardFrame;
    const asset: Asset = { id: 'mapping-frame-image', kind: 'image', subjectId: frame.id, path: 'assets/mapping.png', mimeType: 'image/png', sha256: '8'.repeat(64), description: '검증', durationMs: null, version: 1 };
    const prepared: Project = { ...fixture.project, assets: [...fixture.project.assets, asset], frames: fixture.project.frames.map((candidate: StoryboardFrame): StoryboardFrame => candidate.id === frame.id ? { ...candidate, imageAssetId: asset.id, visualReview: 'accepted' } : candidate) };
    const changed: Project = updateTextMappingDecision(prepared, fixture.decision.id, { canonicalUnitId: fixture.decision.canonicalUnitId, relation: fixture.decision.relation,
      status: fixture.decision.status, renderCanonicalSeparately: fixture.decision.renderCanonicalSeparately, canonicalStartMs: fixture.decision.canonicalStartMs,
      canonicalEndMs: fixture.decision.canonicalEndMs, note: 'Mapping 변경' });
    expect(reviewFrameOutput(changed, frame.id, 'program-monitor').renderBitmap).toBe(false);
  });

  it('stale_frame_image_is_not_rendered_after_source_link_change', async (): Promise<void> => {
    const fixture = await acceptedFrameFixture();
    const changed: Project = updateShotSourceLinks(fixture.project, fixture.shot.id, { links: fixture.shot.sourceLinks });
    expect(reviewFrameOutput(changed, fixture.frame.id, 'program-monitor').renderBitmap).toBe(false);
  });

  it.each([['stale_frame_image_is_not_rendered_after_shot_action_change', 'action'], ['stale_frame_image_is_not_rendered_after_camera_change', 'camera']] as const)('%s', async (_name, field): Promise<void> => {
    const fixture = await acceptedFrameFixture();
    const content = { action: fixture.shot.action, camera: fixture.shot.camera, visualLocationId: fixture.shot.visualLocationId, presence: fixture.shot.presence,
      propIds: fixture.shot.propIds, continuityBefore: fixture.shot.continuityBefore, continuityAfter: fixture.shot.continuityAfter, cameraAxis: fixture.shot.cameraAxis,
      screenDirection: fixture.shot.screenDirection, informationIds: fixture.shot.informationIds, transitionOut: fixture.shot.transitionOut };
    const changed: Project = updateShotContent(fixture.project, fixture.shot.id, field === 'action' ? { ...content, action: `${content.action} 변경` }
      : { ...content, camera: { ...content.camera, angle: `${content.camera.angle} 변경` } });
    expect(reviewFrameOutput(changed, fixture.frame.id, 'program-monitor').renderBitmap).toBe(false);
  });

  it('pending_frame_bitmap_is_hidden_from_program_monitor', async (): Promise<void> => {
    const fixture = await acceptedFrameFixture();
    const project: Project = { ...fixture.project, frames: fixture.project.frames.map((frame: StoryboardFrame): StoryboardFrame => frame.id === fixture.frame.id ? { ...frame, visualReview: 'pending' } : frame) };
    expect(reviewFrameOutput(project, fixture.frame.id, 'program-monitor')).toEqual(expect.objectContaining({ renderBitmap: false, imageAssetId: fixture.asset.id }));
  });

  it('rejected_frame_bitmap_is_hidden_from_program_monitor', async (): Promise<void> => {
    const fixture = await acceptedFrameFixture();
    const project: Project = { ...fixture.project, frames: fixture.project.frames.map((frame: StoryboardFrame): StoryboardFrame => frame.id === fixture.frame.id ? { ...frame, visualReview: 'rejected' } : frame) };
    expect(reviewFrameOutput(project, fixture.frame.id, 'program-monitor').issues).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'FRAME_OUTPUT_REJECTED' })]));
  });

  it('accepted_current_frame_bitmap_is_rendered', async (): Promise<void> => {
    const fixture = await acceptedFrameFixture();
    expect(reviewFrameOutput(fixture.project, fixture.frame.id, 'program-monitor')).toEqual(expect.objectContaining({ renderBitmap: true, imageAssetId: fixture.asset.id }));
  });

  it('blocked_next_transition_frame_is_not_rendered', async (): Promise<void> => {
    const fixture = await acceptedFrameFixture();
    const project: Project = { ...fixture.project, frames: fixture.project.frames.map((frame: StoryboardFrame): StoryboardFrame => frame.id === fixture.frame.id ? { ...frame, visualReview: 'pending' } : frame) };
    expect(reviewFrameOutput(project, fixture.frame.id, 'transition-preview').renderBitmap).toBe(false);
  });

  it('blocked_frame_bitmap_is_omitted_from_pdf', async (): Promise<void> => {
    const fixture = await acceptedFrameFixture();
    const project: Project = { ...fixture.project, frames: fixture.project.frames.map((frame: StoryboardFrame): StoryboardFrame => frame.id === fixture.frame.id ? { ...frame, visualReview: 'pending' } : frame) };
    let loaded: boolean = false;
    await exportProjectPdf(project, resolve('assets/fonts/NanumGothic-Regular.ttf'), async (): Promise<Buffer> => { loaded = true; return Buffer.alloc(1); });
    expect(loaded).toBe(false);
  });

  it('blocked_pdf_frame_uses_placeholder_and_issue_code', async (): Promise<void> => {
    const fixture = await acceptedFrameFixture();
    const project: Project = { ...fixture.project, frames: fixture.project.frames.map((frame: StoryboardFrame): StoryboardFrame => frame.id === fixture.frame.id ? { ...frame, visualReview: 'pending' } : frame) };
    const decision = reviewFrameOutput(project, fixture.frame.id, 'pdf-export');
    expect(frameOutputPlaceholderText(decision, fixture.frame.description)).toContain('FRAME_OUTPUT_REVIEW_REQUIRED');
  });

  it('json_export_preserves_stale_asset_for_audit', async (): Promise<void> => {
    const fixture = await acceptedFrameFixture();
    const project: Project = { ...fixture.project, frames: fixture.project.frames.map((frame: StoryboardFrame): StoryboardFrame => frame.id === fixture.frame.id ? { ...frame, visualReview: 'pending' } : frame) };
    const exported: string = exportProjectJson(project);
    expect(exported).toContain(fixture.asset.id);
    expect(exported).toContain(fixture.frame.id);
  });

  it('csv_marks_stale_frame_output_as_blocked', async (): Promise<void> => {
    const fixture = await acceptedFrameFixture();
    const project: Project = { ...fixture.project, frames: fixture.project.frames.map((frame: StoryboardFrame): StoryboardFrame => frame.id === fixture.frame.id ? { ...frame, visualReview: 'pending' } : frame) };
    const csv: string = exportShotCsv(project);
    expect(csv).toContain('FRAME_OUTPUT_REVIEW_REQUIRED');
    expect(csv).toContain('historicalImageAssetId');
  });

  it('profile_change_invalidates_every_accepted_frame_and_shot', async (): Promise<void> => {
    const fixture = await acceptedFrameFixture();
    const changed: Project = updateProjectProfile(fixture.project, { ...fixture.project.profile, visualStyle: '새 시각 스타일' });
    expect(changed.frames.every((frame: StoryboardFrame): boolean => frame.visualReview === 'pending')).toBe(true);
    expect(changed.shots.every((shot: Shot): boolean => shot.approvalStatus === 'proposed')).toBe(true);
  });

  it('reference_asset_change_invalidates_affected_frames_and_shots', async (): Promise<void> => {
    const base: Project = await outline();
    const originalShot: Shot = base.shots[0] as Shot;
    const personId: string = base.dataset.people[0]?.id ?? '';
    const shot: Shot = { ...originalShot, presence: [{ personId, mode: 'VISIBLE' }] };
    const frame: StoryboardFrame = base.frames.find((candidate: StoryboardFrame): boolean => candidate.shotId === shot.id) as StoryboardFrame;
    const image: Asset = { id: 'reference-stale-frame-image', kind: 'image', subjectId: frame.id, path: 'assets/reference-frame.png', mimeType: 'image/png',
      sha256: '7'.repeat(64), description: '검증', durationMs: null, version: 1 };
    const prepared: Project = { ...base, assets: [image], shots: base.shots.map((candidate: Shot): Shot => candidate.id === shot.id ? { ...shot, approvalStatus: 'approved' } : candidate),
      frames: base.frames.map((candidate: StoryboardFrame): StoryboardFrame => candidate.id === frame.id ? { ...candidate, imageAssetId: image.id, visualReview: 'accepted' } : candidate) };
    const changed: Project = (await addReferenceAsset(prepared, { id: 'new-character-reference', kind: 'character', subjectId: personId,
      description: '새 인물 기준', mimeType: 'image/png', bytes: await png(1, 1) })).project;
    expect(changed.frames.find((candidate: StoryboardFrame): boolean => candidate.id === frame.id)?.visualReview).toBe('pending');
    expect(changed.shots.find((candidate: Shot): boolean => candidate.id === shot.id)?.approvalStatus).toBe('proposed');
  });
});

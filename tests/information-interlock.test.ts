import { describe, expect, it } from 'vitest';
import { mergeShots, reorderShots, splitShot } from '../src/domain/edit.js';
import {
  approvalIssuesForShot, canonicalCandidate, createInitialTextMappingDecisions, effectiveInformationGate,
  moveShotSourceLink, updateTextMappingDecision,
} from '../src/domain/mapping.js';
import {
  DatasetSchema, NativeDatasetSchema, TextMappingDecisionSchema,
} from '../src/domain/schema.js';
import type {
  Asset, AudioCue, Dataset, NativeDataset, Project, Shot, ShotSourceLink, StoryboardFrame, TextMappingDecision,
} from '../src/domain/schema.js';
import { updateAudioCueTiming } from '../src/domain/tracks.js';
import { importPackage } from '../src/importers/import-package.js';
import { parseProject } from '../src/io/project.js';
import { buildFrameImageContext } from '../src/proposal/context.js';
import { applySegmentProposal } from '../src/proposal/model.js';
import { createSourceOutline } from '../src/proposal/outline.js';
import { nativeData, nativePackage, productionPackage, withNativeData } from './helpers.js';

async function nativeOutline(): Promise<Project> {
  return createSourceOutline(importPackage(await nativePackage()), { proposedTextHoldMs: 2000 });
}

async function productionOutline(): Promise<Project> {
  return createSourceOutline(importPackage(await productionPackage()), { proposedTextHoldMs: 3000 });
}

function segmentShot(project: Project, segmentId: string): Shot {
  const shot: Shot | undefined = project.shots.find((candidate: Shot): boolean => candidate.segmentId === segmentId);
  if (shot === undefined) throw new Error(`${segmentId}: 검증용 컷이 없습니다.`);
  return shot;
}

async function temporalMappingOutline(): Promise<Project> {
  const payload = await nativePackage();
  const data: NativeDataset = nativeData(payload);
  const changed: NativeDataset = NativeDatasetSchema.parse({ ...data,
    units: [...data.units.map((unit) => unit.id === '동작' ? { ...unit, informationIds: [] } : unit),
      { id: 'gate-a', segmentId: 'demonstration', order: 4, kind: 'SCREEN_TEXT', text: '첫 공개 문구', speakerId: null, informationIds: ['info:gate'] },
      { id: 'gate-b', segmentId: 'demonstration', order: 5, kind: 'SCREEN_TEXT', text: '두 번째 공개 문구', speakerId: null, informationIds: ['info:gate'] }],
    informationRules: [{ id: 'info:gate', segmentId: 'demonstration', notBeforeMs: 5000, notBeforeUnitId: 'gate-a', notBeforeUnitOrder: 4, precision: 'unit-order' }],
    textPlacements: [...data.textPlacements,
      { id: 'gate-placement-a', segmentId: 'demonstration', startMs: 6000, endMs: 7000, text: '첫 공개 문구', unitId: 'gate-a' },
      { id: 'gate-placement-b', segmentId: 'demonstration', startMs: 8000, endMs: 9000, text: '두 번째 공개 문구', unitId: 'gate-b' }],
  });
  return createSourceOutline(importPackage(withNativeData(payload, changed)), { proposedTextHoldMs: 2000 });
}

describe('정보 공개 시점 안전장치 결함 재현', (): void => {
  it('unit_order_gate_blocks_segment_start_frame', async (): Promise<void> => {
    const project: Project = await productionOutline();
    const rule = project.dataset.informationRules.find((candidate): boolean => candidate.id === 'fact:FACT-10');
    const segment = project.dataset.segments.find((candidate): boolean => candidate.id === 'SEG-024');
    if (rule === undefined || segment === undefined) throw new Error('검증용 공개 규칙이 없습니다.');
    const changed: Project = { ...project, textMappingDecisions: [], audioCues: [], dataset: { ...project.dataset,
      informationRules: project.dataset.informationRules.map((candidate) => candidate.id === rule.id ? { ...candidate, baseNotBeforeMs: segment.startMs, precision: 'unit-order' } : candidate),
    } };
    expect(effectiveInformationGate(changed, rule.id).reviewRequired).toBe(true);
  });

  it('measured_audio_cannot_advance_base_gate', async (): Promise<void> => {
    const project: Project = await productionOutline();
    const rule = project.dataset.informationRules.find((candidate): boolean => candidate.id === 'fact:FACT-10');
    if (rule === undefined || rule.notBeforeUnitId === null) throw new Error('검증용 공개 규칙이 없습니다.');
    const asset: Asset = { id: 'early-audio-asset', kind: 'audio', subjectId: 'early-audio', path: 'assets/early.wav', mimeType: 'audio/wav', sha256: '1'.repeat(64), description: '검증 음성', durationMs: 1000, version: 1 };
    const cue: AudioCue = { id: 'early-audio', unitId: rule.notBeforeUnitId, kind: 'dialogue', startMs: rule.baseNotBeforeMs - 1000, endMs: rule.baseNotBeforeMs, timingStatus: 'measured', assetId: asset.id };
    const changed: Project = { ...project, textMappingDecisions: [], audioCues: [cue], assets: [asset] };
    expect(effectiveInformationGate(changed, rule.id).effectiveNotBeforeMs).toBeGreaterThanOrEqual(rule.baseNotBeforeMs);
  });

  it('derived_gate_is_not_persisted_as_source', async (): Promise<void> => {
    const project: Project = importPackage(await productionPackage());
    const rule = project.dataset.informationRules.find((candidate): boolean => candidate.id === 'fact:FACT-10');
    const segment = project.dataset.segments.find((candidate): boolean => candidate.id === 'SEG-024');
    if (rule === undefined || segment === undefined) throw new Error('검증용 공개 규칙이 없습니다.');
    expect(rule.baseNotBeforeMs).toBe(segment.startMs);
  });

  it('continuous_shot_can_reveal_at_key_frame', async (): Promise<void> => {
    const project: Project = await productionOutline();
    const shot: Shot = segmentShot(project, 'SEG-024');
    const changed = { ...project, textMappingDecisions: project.textMappingDecisions.map((decision) => ({ ...decision, status: 'confirmed' as const })),
      shots: project.shots.map((candidate): Shot => candidate.id === shot.id ? { ...candidate, sourceLinks: [{ unitId: 'UNIT-064', usage: 'primary-visual', status: 'confirmed', temporalAnchor: { kind: 'shot-offset', startOffsetMs: 68000, endOffsetMs: 70000, basis: 'manual', status: 'confirmed' } } as unknown as ShotSourceLink], informationIds: ['fact:FACT-10'] } : candidate),
    } as Project;
    expect(approvalIssuesForShot(changed, shot.id).filter((item): boolean => item.code === 'EARLY_INFORMATION_REVEAL')).toEqual([]);
  });

  it('text_mapping_relation_invariants', (): void => {
    const invalid = { id: 'mapping', placementId: 'placement', canonicalUnitId: null, relation: 'exact', status: 'confirmed', renderCanonicalSeparately: true, canonicalStartMs: 10, canonicalEndMs: 20, note: null };
    expect(TextMappingDecisionSchema.safeParse(invalid).success).toBe(false);
  });

  it('duplicate_exact_text_remains_unresolved', async (): Promise<void> => {
    const project: Project = importPackage(await nativePackage());
    const original = project.dataset.units.find((unit): boolean => unit.id === '제목');
    if (original === undefined) throw new Error('검증용 원문 단위가 없습니다.');
    const dataset: Dataset = DatasetSchema.parse({ ...project.dataset,
      units: [...project.dataset.units, { ...original, id: '제목-복제', order: original.order + 1 }],
      textPlacements: project.dataset.textPlacements.map((placement) => placement.id === 'title-placement' ? { ...placement, unitId: null } : placement),
    });
    const decision = createInitialTextMappingDecisions(dataset).find((candidate): boolean => candidate.placementId === 'title-placement');
    expect(decision).toEqual(expect.objectContaining({ canonicalUnitId: null, status: 'unresolved' }));
  });

  it('proposal_rejects_all_nonvisual_usage', async (): Promise<void> => {
    const project: Project = await nativeOutline();
    expect(() => applySegmentProposal(project, 'demonstration', { shots: [{
      sourceLinks: [
        { unitId: '안내-1', usage: 'context-only' }, { unitId: '동작', usage: 'context-only' }, { unitId: '효과음', usage: 'context-only' },
      ], durationWeight: 1, action: '화분 관리', visualLocationId: null,
      camera: { size: 'CU', angle: 'eye', move: 'static' }, presence: [], propIds: [], cameraAxis: null, screenDirection: null,
      informationIds: [], transitionOut: { kind: 'cut', durationMs: 0, note: '' }, frameDescription: '화분 관리',
    }] }, 'all-context')).toThrowError(expect.objectContaining({ code: 'PROPOSAL_VISUAL_SOURCE_REQUIRED' }));
    const shot: Shot = segmentShot(project, 'demonstration');
    const allNonvisual: Project = { ...project, shots: project.shots.map((candidate: Shot): Shot => candidate.id === shot.id
      ? { ...candidate, sourceLinks: candidate.sourceLinks.map((link: ShotSourceLink): ShotSourceLink => ({ ...link, usage: 'context-only' })) }
      : candidate) };
    expect(approvalIssuesForShot(allNonvisual, shot.id)).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'SHOT_VISUAL_SOURCE_REQUIRED' })]));
  });

  it('unresolved_mapping_is_not_split_evidence', async (): Promise<void> => {
    const project: Project = await productionOutline();
    const shot: Shot = segmentShot(project, 'SEG-024');
    const split: Project = splitShot(project, shot.id, 1100000, 'split-unresolved', 'split-unresolved-frame');
    const links: ShotSourceLink[] = split.shots.flatMap((candidate): ShotSourceLink[] => candidate.sourceLinks.filter((link): boolean => link.unitId === 'UNIT-061'));
    expect(links.every((link: ShotSourceLink): boolean => link.status === 'mapping-required')).toBe(true);
  });

  it('frame_generation_checks_all_mapping_conflicts', async (): Promise<void> => {
    const project: Project = await nativeOutline();
    const shot: Shot = segmentShot(project, 'SEG-001');
    const frame: StoryboardFrame = project.frames.find((candidate): boolean => candidate.shotId === shot.id) as StoryboardFrame;
    const changed = { ...project, textMappingDecisions: project.textMappingDecisions.map((decision) => decision.placementId === 'title-placement'
      ? { ...decision, canonicalUnitId: null, relation: 'exact' as const, status: 'confirmed' as const, renderCanonicalSeparately: false, canonicalStartMs: null, canonicalEndMs: null }
      : decision) } as Project;
    expect(() => buildFrameImageContext(changed, frame.id)).toThrowError(expect.objectContaining({ code: 'FRAME_GENERATION_BLOCKED' }));
  });

  it('unknown_information_rule_returns_review_issue', async (): Promise<void> => {
    const project: Project = await nativeOutline();
    const shot: Shot = segmentShot(project, 'SEG-001');
    const changed: Project = { ...project, shots: project.shots.map((candidate): Shot => candidate.id === shot.id ? { ...candidate, informationIds: ['unknown-information'] } : candidate) };
    expect(approvalIssuesForShot(changed, shot.id)).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'UNRESOLVED_INFORMATION_RULE' })]));
  });

  it('unit_order_gate_requires_temporal_anchor', async (): Promise<void> => {
    const project: Project = await temporalMappingOutline();
    const changed: Project = { ...project, textMappingDecisions: [], shots: [], frames: [], audioCues: [] };
    expect(effectiveInformationGate(changed, 'info:gate')).toEqual(expect.objectContaining({
      effectiveNotBeforeMs: 5000, reviewRequired: true,
      reviewReasons: expect.arrayContaining(['UNIT_ORDER_TEMPORAL_ANCHOR_REQUIRED:gate-a']),
    }));
  });

  it('audio_gate_requires_same_rule_segment', async (): Promise<void> => {
    const project: Project = await temporalMappingOutline();
    const cue: AudioCue = { id: 'foreign-audio', unitId: 'gate-a', kind: 'dialogue', startMs: 0, endMs: 1000, timingStatus: 'measured', assetId: 'foreign-audio-asset' };
    const asset: Asset = { id: 'foreign-audio-asset', kind: 'audio', subjectId: cue.id, path: 'assets/foreign.wav', mimeType: 'audio/wav', sha256: '2'.repeat(64), description: '다른 구간 음성', durationMs: 1000, version: 1 };
    const changed: Project = { ...project, textMappingDecisions: [], shots: [], frames: [], audioCues: [cue], assets: [asset] };
    const gate = effectiveInformationGate(changed, 'info:gate');
    expect(gate.evidenceId).not.toBe(cue.id);
    expect(gate.reviewRequired).toBe(true);
  });

  it('measured_audio_move_invalidates_review', async (): Promise<void> => {
    const project: Project = await nativeOutline();
    const cue: AudioCue = project.audioCues.find((candidate: AudioCue): boolean => candidate.unitId === '안내-1') as AudioCue;
    const measuredCue: AudioCue = { ...cue, endMs: cue.endMs - 200, timingStatus: 'measured', assetId: 'measured-asset' };
    const asset: Asset = { id: 'measured-asset', kind: 'audio', subjectId: cue.id, path: 'assets/measured.wav', mimeType: 'audio/wav', sha256: '3'.repeat(64), description: '측정 음성', durationMs: measuredCue.endMs - measuredCue.startMs, version: 1 };
    const shot: Shot = segmentShot(project, 'demonstration');
    const prepared: Project = { ...project, assets: [asset], audioCues: project.audioCues.map((candidate: AudioCue): AudioCue => candidate.id === cue.id ? measuredCue : candidate),
      shots: project.shots.map((candidate: Shot): Shot => candidate.id === shot.id ? { ...candidate, approvalStatus: 'approved', sourceLinks: candidate.sourceLinks.map((link: ShotSourceLink): ShotSourceLink => link.unitId === cue.unitId ? { ...link, status: 'confirmed', temporalAnchor: { kind: 'shot-offset', startOffsetMs: 0, endOffsetMs: measuredCue.endMs - measuredCue.startMs, basis: 'audio-cue', status: 'confirmed' } } : link) } : candidate) };
    const moved: Project = updateAudioCueTiming(prepared, cue.id, { startMs: measuredCue.startMs + 100, endMs: measuredCue.endMs + 100 });
    const movedLink: ShotSourceLink = segmentShot(moved, 'demonstration').sourceLinks.find((link: ShotSourceLink): boolean => link.unitId === cue.unitId) as ShotSourceLink;
    expect(moved.audioCues.find((candidate: AudioCue): boolean => candidate.id === cue.id)?.timingStatus).toBe('proposed');
    expect(segmentShot(moved, 'demonstration').approvalStatus).toBe('proposed');
    expect(movedLink.temporalAnchor).toEqual({ kind: 'unresolved', basis: 'audio-change', status: 'review-required' });
  });

  it('explicit_native_exact_time_is_not_overwritten', async (): Promise<void> => {
    const payload = await nativePackage();
    const data: NativeDataset = nativeData(payload);
    const changed: NativeDataset = NativeDatasetSchema.parse({ ...data,
      units: data.units.map((unit) => unit.id === '동작' ? { ...unit, informationIds: ['info:exact'] } : unit),
      informationRules: [{ id: 'info:exact', segmentId: 'demonstration', notBeforeMs: 7000, notBeforeUnitId: '동작', notBeforeUnitOrder: 2, precision: 'exact-time' }],
    });
    const project: Project = createSourceOutline(importPackage(withNativeData(payload, changed)), { proposedTextHoldMs: 2000 });
    expect(project.dataset.informationRules[0]?.baseNotBeforeMs).toBe(7000);
    expect(effectiveInformationGate(project, 'info:exact').effectiveNotBeforeMs).toBeGreaterThanOrEqual(7000);
  });

  it('mapping_change_recomputes_effective_gate', async (): Promise<void> => {
    const project: Project = await temporalMappingOutline();
    expect(effectiveInformationGate(project, 'info:gate').effectiveNotBeforeMs).toBe(6000);
    const decision: TextMappingDecision = project.textMappingDecisions.find((candidate: TextMappingDecision): boolean => candidate.placementId === 'gate-placement-a') as TextMappingDecision;
    const changed: Project = updateTextMappingDecision(project, decision.id, { canonicalUnitId: null, relation: 'standalone-placement', status: 'confirmed', renderCanonicalSeparately: false, canonicalStartMs: null, canonicalEndMs: null, note: '독립 문구로 확인' });
    expect(effectiveInformationGate(changed, 'info:gate').effectiveNotBeforeMs).toBe(8000);
  });

  it('effective_gate_never_precedes_base_gate', async (): Promise<void> => {
    const project: Project = await temporalMappingOutline();
    const decision: TextMappingDecision = project.textMappingDecisions.find((candidate: TextMappingDecision): boolean => candidate.placementId === 'gate-placement-a') as TextMappingDecision;
    const earlier = { ...project,
      dataset: { ...project.dataset, textPlacements: project.dataset.textPlacements.map((placement) => placement.id === decision.placementId ? { ...placement, startMs: 4000, endMs: 4500 } : placement) },
    } as Project;
    expect(effectiveInformationGate(earlier, 'info:gate')).toEqual(expect.objectContaining({ effectiveNotBeforeMs: 8000, reviewRequired: true }));
  });

  it('standalone_placement_does_not_claim_canonical_unit', async (): Promise<void> => {
    const project: Project = importPackage(await nativePackage());
    const placement = { ...project.dataset.textPlacements[0] as NonNullable<typeof project.dataset.textPlacements[0]>, id: 'standalone', unitId: null, text: '연결되지 않은 제작 고지' };
    const dataset: Dataset = DatasetSchema.parse({ ...project.dataset, textPlacements: [placement] });
    expect(createInitialTextMappingDecisions(dataset)[0]).toEqual(expect.objectContaining({ canonicalUnitId: null, relation: 'standalone-placement', status: 'unresolved' }));
  });

  it('placement_unit_id_has_candidate_priority', async (): Promise<void> => {
    const project: Project = importPackage(await nativePackage());
    const placement = { ...project.dataset.textPlacements[0] as NonNullable<typeof project.dataset.textPlacements[0]>, text: '흙이 마르면 물을 주세요.', unitId: '제목' };
    expect(canonicalCandidate(project.dataset, placement)?.id).toBe('제목');
  });

  it('canonical_candidate_restricts_unit_kinds', async (): Promise<void> => {
    const project: Project = importPackage(await nativePackage());
    const action = project.dataset.units.find((unit): boolean => unit.id === '동작');
    if (action === undefined) throw new Error('검증용 ACTION 원문이 없습니다.');
    const placement = { id: 'action-placement', segmentId: action.segmentId, startMs: 6000, endMs: 7000, text: action.text, unitId: action.id, sourceRefs: action.sourceRefs };
    expect(canonicalCandidate(project.dataset, placement)).toBeNull();
  });

  it('continued_visual_requires_prior_primary', async (): Promise<void> => {
    const project: Project = await nativeOutline();
    expect(() => applySegmentProposal(project, 'demonstration', { shots: [{ sourceLinks: [
      { unitId: '안내-1', usage: 'audio-only' }, { unitId: '동작', usage: 'continued-visual' }, { unitId: '효과음', usage: 'audio-only' },
    ], durationWeight: 1, action: '화분', visualLocationId: null, camera: { size: 'CU', angle: 'eye', move: 'static' }, presence: [], propIds: [], cameraAxis: null, screenDirection: null, informationIds: [], transitionOut: { kind: 'cut', durationMs: 0, note: '' }, frameDescription: '화분' }] }, 'continued-without-primary')).toThrowError(expect.objectContaining({ code: 'PROPOSAL_SOURCE_POLICY', issues: expect.arrayContaining([expect.objectContaining({ code: 'CONTINUED_SOURCE_WITHOUT_PRIMARY' })]) }));
  });

  it('sound_and_music_cannot_be_primary_visual', async (): Promise<void> => {
    const project: Project = await nativeOutline();
    expect(() => applySegmentProposal(project, 'demonstration', { shots: [{ sourceLinks: [
      { unitId: '안내-1', usage: 'audio-only' }, { unitId: '동작', usage: 'primary-visual' }, { unitId: '효과음', usage: 'primary-visual' },
    ], durationWeight: 1, action: '화분', visualLocationId: null, camera: { size: 'CU', angle: 'eye', move: 'static' }, presence: [], propIds: [], cameraAxis: null, screenDirection: null, informationIds: [], transitionOut: { kind: 'cut', durationMs: 0, note: '' }, frameDescription: '화분' }] }, 'sound-primary')).toThrowError(expect.objectContaining({ code: 'PROPOSAL_SOURCE_POLICY', issues: expect.arrayContaining([expect.objectContaining({ code: 'NONVISUAL_SOURCE_USAGE' })]) }));
  });

  it('mapping_change_invalidates_derived_source_anchor', async (): Promise<void> => {
    const project: Project = await nativeOutline();
    const decision: TextMappingDecision = project.textMappingDecisions.find((candidate: TextMappingDecision): boolean => candidate.placementId === 'title-placement') as TextMappingDecision;
    const changed: Project = updateTextMappingDecision(project, decision.id, { canonicalUnitId: null, relation: 'standalone-placement', status: 'confirmed', renderCanonicalSeparately: false, canonicalStartMs: null, canonicalEndMs: null, note: '독립 타이틀' });
    const link: ShotSourceLink = segmentShot(changed, 'SEG-001').sourceLinks.find((candidate: ShotSourceLink): boolean => candidate.unitId === '제목') as ShotSourceLink;
    expect(link).toEqual(expect.objectContaining({ status: 'mapping-required', temporalAnchor: { kind: 'unresolved', basis: 'mapping-change', status: 'review-required' } }));
  });

  it('information_without_source_is_rejected_for_frame', async (): Promise<void> => {
    const project: Project = await productionOutline();
    const shot: Shot = segmentShot(project, 'SEG-024');
    const frame: StoryboardFrame = project.frames.find((candidate: StoryboardFrame): boolean => candidate.shotId === shot.id) as StoryboardFrame;
    const unitLink: ShotSourceLink = { unitId: 'UNIT-060', usage: 'primary-visual', status: 'confirmed', temporalAnchor: { kind: 'shot-offset', startOffsetMs: 0, endOffsetMs: 1, basis: 'manual', status: 'confirmed' } };
    const changed: Project = { ...project, shots: project.shots.map((candidate: Shot): Shot => candidate.id === shot.id ? { ...candidate, sourceLinks: [unitLink], informationIds: ['fact:FACT-10'] } : candidate) };
    expect(() => buildFrameImageContext(changed, frame.id)).toThrowError(expect.objectContaining({ code: 'FRAME_GENERATION_BLOCKED', issues: expect.arrayContaining([expect.objectContaining({ code: 'INFORMATION_WITHOUT_SOURCE_LINK' })]) }));
  });

  it('source_anchor_survives_split_merge_reorder', async (): Promise<void> => {
    const project: Project = await nativeOutline();
    const split: Project = splitShot(project, 'shot-2', 8000, 'anchor-split', 'anchor-split-frame');
    const reordered: Project = reorderShots(split, 'demonstration', ['anchor-split', 'shot-2']);
    const merged: Project = mergeShots(reordered, 'anchor-split', 'shot-2');
    const link: ShotSourceLink = merged.shots.find((shot: Shot): boolean => shot.id === 'anchor-split')?.sourceLinks.find((candidate: ShotSourceLink): boolean => candidate.unitId === '동작') as ShotSourceLink;
    expect(link.status).toBe('confirmed');
    expect(link.temporalAnchor.kind).toBe('shot-offset');
  });

  it('source_move_rebases_or_invalidates_anchor', async (): Promise<void> => {
    const project: Project = await nativeOutline();
    const split: Project = splitShot(project, 'shot-2', 8000, 'move-target', 'move-target-frame');
    const source: Shot = split.shots.find((shot: Shot): boolean => shot.sourceLinks.some((link: ShotSourceLink): boolean => link.unitId === '안내-1')) as Shot;
    const target: Shot = split.shots.find((shot: Shot): boolean => shot.segmentId === 'demonstration' && shot.id !== source.id) as Shot;
    const moved: Project = moveShotSourceLink(split, source.id, { unitId: '안내-1', targetShotId: target.id, usage: 'audio-only' });
    const link: ShotSourceLink = moved.shots.find((shot: Shot): boolean => shot.id === target.id)?.sourceLinks.find((candidate: ShotSourceLink): boolean => candidate.unitId === '안내-1') as ShotSourceLink;
    expect(link.temporalAnchor).toEqual({ kind: 'unresolved', basis: 'source-move', status: 'review-required' });
  });

  it('migration_1_2_to_1_3_is_conservative', async (): Promise<void> => {
    const project: Project = await nativeOutline();
    const legacy = JSON.parse(JSON.stringify(project)) as { schemaVersion: string; shots: Array<{ approvalStatus: string; sourceLinks: Array<Record<string, unknown>> }> };
    legacy.schemaVersion = '1.2.0';
    legacy.shots[0]!.approvalStatus = 'approved';
    for (const shot of legacy.shots) for (const link of shot.sourceLinks) delete link.temporalAnchor;
    const migrated: Project = parseProject(legacy);
    expect(migrated.schemaVersion).toBe('1.3.0');
    expect(migrated.shots.every((shot: Shot): boolean => shot.approvalStatus === 'proposed' && shot.sourceLinks.every((link: ShotSourceLink): boolean => link.status === 'mapping-required' && link.temporalAnchor.kind === 'unresolved' && link.temporalAnchor.basis === 'migration'))).toBe(true);
  });

  it('migration_preserves_original_content', async (): Promise<void> => {
    const project: Project = await nativeOutline();
    const asset: Asset = { id: 'preserved-asset', kind: 'prop', subjectId: null, path: 'assets/preserved.png', mimeType: 'image/png', sha256: '4'.repeat(64), description: '보존 자산', durationMs: null, version: 1 };
    const enriched: Project = { ...project, assets: [asset], generationRecords: [{ id: 'preserved-generation', provider: 'codex-app', model: 'codex-imagegen', modelVersion: null, requestId: null, prompt: '보존', templateVersion: '1.0.0', seed: null, referenceHashes: [], resultAssetIds: [asset.id], shotIds: [], createdAt: '2026-09-06T00:00:00.000Z' }] };
    const legacy = JSON.parse(JSON.stringify(enriched)) as { schemaVersion: string; shots: Array<{ sourceLinks: Array<Record<string, unknown>> }> };
    legacy.schemaVersion = '1.2.0';
    for (const shot of legacy.shots) for (const link of shot.sourceLinks) delete link.temporalAnchor;
    const migrated: Project = parseProject(legacy);
    expect(migrated.sources).toEqual(enriched.sources);
    expect(migrated.assets).toEqual(enriched.assets);
    expect(migrated.generationRecords).toEqual(enriched.generationRecords);
    expect(migrated.shots.map((shot: Shot): string => shot.action)).toEqual(enriched.shots.map((shot: Shot): string => shot.action));
  });
});

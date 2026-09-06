import { describe, expect, it } from 'vitest';
import { audioOverhangAfterMs, audioOverhangBeforeMs, audioTimingIssues } from '../src/domain/audio.js';
import { addStoryboardFrame } from '../src/domain/frame.js';
import { effectiveInformationGate, sourceAnchorRange, updateTextMappingDecision } from '../src/domain/mapping.js';
import { applyGeneratedSpeech } from '../src/domain/media.js';
import { activeStoryboardFrame, playableAudioCuesAt, playableTextCuesAt, reviewAudioPlaybackAt, reviewTextPlaybackAt } from '../src/domain/playback.js';
import type { Asset, AudioCue, NativeDataset, Project, Shot, StoryboardFrame, TextCue, TextMappingDecision } from '../src/domain/schema.js';
import { frameDisplayAbsoluteMs, frameEvaluationAbsoluteMs } from '../src/domain/time.js';
import { updateAudioCueTiming, updateTextCueTiming } from '../src/domain/tracks.js';
import { codexRequestBasis } from '../src/codex/work.js';
import { exportShotCsv } from '../src/exporters/csv.js';
import { importPackage } from '../src/importers/import-package.js';
import { migrateProjectInput, parseProject } from '../src/io/project.js';
import { buildFrameImageContext } from '../src/proposal/context.js';
import { createSourceOutline } from '../src/proposal/outline.js';
import { nativeData, nativePackage, testAudioNormalizer, withNativeData } from './helpers.js';

function wav(durationMs: number): Buffer {
  const sampleRate: number = 8000;
  const dataLength: number = Math.round(sampleRate * durationMs / 1000) * 2;
  const bytes: Buffer = Buffer.alloc(44 + dataLength);
  bytes.write('RIFF', 0); bytes.writeUInt32LE(36 + dataLength, 4); bytes.write('WAVE', 8); bytes.write('fmt ', 12);
  bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22); bytes.writeUInt32LE(sampleRate, 24);
  bytes.writeUInt32LE(sampleRate * 2, 28); bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34); bytes.write('data', 36); bytes.writeUInt32LE(dataLength, 40);
  return bytes;
}

async function outline(): Promise<Project> {
  return createSourceOutline(importPackage(await nativePackage()), { proposedTextHoldMs: 2000 });
}

async function informationOutline(): Promise<Project> {
  const payload = await nativePackage();
  const data: NativeDataset = nativeData(payload);
  const changed: NativeDataset = {
    ...data,
    units: data.units.map((unit) => unit.id === '안내-1' ? { ...unit, informationIds: ['INFO-1'] } : unit),
    informationRules: [{ id: 'INFO-1', notBeforeMs: 7000, segmentId: 'demonstration', notBeforeUnitId: '안내-1', notBeforeUnitOrder: 1, precision: 'exact-time' }],
  };
  return createSourceOutline(importPackage(withNativeData(payload, changed)), { proposedTextHoldMs: 2000 });
}

function measured(project: Project, cue: AudioCue, startMs: number, endMs: number, relation: AudioCue['timingRelation']): Project {
  const asset: Asset = {
    id: `${cue.id}:asset`, kind: 'audio', subjectId: cue.id, path: `assets/${cue.id}.wav`, mimeType: 'audio/wav',
    sha256: '0'.repeat(64), description: '검증용 음성', durationMs: endMs - startMs, version: 1,
  };
  return {
    ...project,
    assets: [...project.assets.filter((candidate: Asset): boolean => candidate.id !== asset.id), asset],
    audioCues: project.audioCues.map((candidate: AudioCue): AudioCue => candidate.id === cue.id
      ? { ...candidate, startMs, endMs, timingRelation: relation, timingStatus: 'measured', assetId: asset.id } : candidate),
  };
}

function frameProject(project: Project, shot: Shot, frameId: string): Project {
  return addStoryboardFrame(project, shot.id, frameId, { offsetMs: shot.endMs - shot.startMs, role: 'end', description: '컷의 마지막 상태' });
}

function legacy13(project: Project): { [key: string]: unknown } {
  const legacy = JSON.parse(JSON.stringify(project)) as { schemaVersion: string; audioCues: { [key: string]: unknown }[]; textCues: { [key: string]: unknown }[] };
  legacy.schemaVersion = '1.3.0';
  legacy.audioCues.forEach((cue): void => { delete cue.timingRelation; });
  legacy.textCues.forEach((cue): void => { delete cue.authority; delete cue.mappingDecisionId; });
  return legacy;
}

describe('Text output interlock', (): void => {
  it('text_cue_cannot_precede_effective_gate', async (): Promise<void> => {
    const project: Project = await informationOutline();
    const sourceCue: TextCue = { id: 'info-text', segmentId: 'demonstration', unitId: '안내-1', placementId: null,
      mappingDecisionId: null, authority: 'source-unit', text: project.dataset.units.find((unit) => unit.id === '안내-1')?.text ?? '',
      startMs: 7500, endMs: 9000, kind: 'dialogue-subtitle', timingStatus: 'confirmed' };
    const changed: Project = { ...project, textCues: [...project.textCues, sourceCue] };
    expect(() => updateTextCueTiming(changed, sourceCue.id, { startMs: 6500, endMs: 8000, kind: sourceCue.kind })).toThrowError(expect.objectContaining({ code: 'TEXT_OUTPUT_GATE_BLOCKED' }));
  });

  it('canonical_text_cue_is_mapping_decision_derived', async (): Promise<void> => {
    const project: Project = await outline();
    const decision: TextMappingDecision = project.textMappingDecisions[0] as TextMappingDecision;
    const changed: Project = updateTextMappingDecision(project, decision.id, { canonicalUnitId: decision.canonicalUnitId,
      relation: 'separate-element', status: 'confirmed', renderCanonicalSeparately: true,
      canonicalStartMs: 1000, canonicalEndMs: 1800, note: '별도 렌더링 검증' });
    expect(changed.textCues.find((cue: TextCue): boolean => cue.mappingDecisionId === decision.id)).toEqual(expect.objectContaining({ authority: 'mapping-decision', unitId: decision.canonicalUnitId }));
  });

  it('canonical_text_cue_direct_timing_edit_is_rejected', async (): Promise<void> => {
    const project: Project = await outline();
    const decision: TextMappingDecision = project.textMappingDecisions[0] as TextMappingDecision;
    const changed: Project = updateTextMappingDecision(project, decision.id, { canonicalUnitId: decision.canonicalUnitId,
      relation: 'separate-element', status: 'confirmed', renderCanonicalSeparately: true,
      canonicalStartMs: 1000, canonicalEndMs: 1800, note: '별도 렌더링 검증' });
    const cue: TextCue = changed.textCues.find((candidate: TextCue): boolean => candidate.mappingDecisionId === decision.id) as TextCue;
    expect(() => updateTextCueTiming(changed, cue.id, { startMs: 900, endMs: 1800, kind: cue.kind })).toThrowError(expect.objectContaining({ code: 'DERIVED_TEXT_CUE_READ_ONLY' }));
  });

  it.each([
    ['moving_text_cue_invalidates_text_based_anchor', 'anchor'],
    ['moving_text_cue_invalidates_shot_approval', 'approval'],
    ['moving_text_cue_invalidates_frame_review', 'frame'],
  ] as const)('%s', async (_name, assertion): Promise<void> => {
    const project: Project = await informationOutline();
    const unit = project.dataset.units.find((candidate) => candidate.id === '안내-1');
    const shot: Shot = project.shots.find((candidate: Shot): boolean => candidate.segmentId === 'demonstration') as Shot;
    const cue: TextCue = { id: 'moving-info-text', segmentId: 'demonstration', unitId: unit?.id ?? null, placementId: null,
      mappingDecisionId: null, authority: 'source-unit', text: unit?.text ?? '', startMs: 7500, endMs: 9000, kind: 'dialogue-subtitle', timingStatus: 'confirmed' };
    const prepared: Project = { ...project, textCues: [...project.textCues, cue],
      shots: project.shots.map((candidate: Shot): Shot => candidate.id === shot.id ? { ...candidate, approvalStatus: 'approved',
        sourceLinks: candidate.sourceLinks.map((link) => link.unitId === cue.unitId ? { ...link, status: 'confirmed', temporalAnchor: { kind: 'shot-offset', startOffsetMs: 2500, endOffsetMs: 4000, basis: 'text-cue', status: 'confirmed' } } : link) } : candidate),
      frames: project.frames.map((frame: StoryboardFrame): StoryboardFrame => frame.shotId === shot.id ? { ...frame, visualReview: 'accepted', imageAssetId: 'frame-image' } : frame),
      assets: [...project.assets, { id: 'frame-image', kind: 'image', subjectId: project.frames.find((frame) => frame.shotId === shot.id)?.id ?? null, path: 'assets/frame.png', mimeType: 'image/png', sha256: '1'.repeat(64), description: '검증', durationMs: null, version: 1 }],
    };
    const moved: Project = updateTextCueTiming(prepared, cue.id, { startMs: 7600, endMs: 9100, kind: cue.kind });
    const movedShot: Shot = moved.shots.find((candidate: Shot): boolean => candidate.id === shot.id) as Shot;
    if (assertion === 'anchor') expect(movedShot.sourceLinks.find((link) => link.unitId === cue.unitId)?.temporalAnchor.status).toBe('review-required');
    if (assertion === 'approval') expect(movedShot.approvalStatus).toBe('proposed');
    if (assertion === 'frame') expect(moved.frames.find((frame) => frame.shotId === shot.id)?.visualReview).toBe('pending');
  });

  it('playback_does_not_render_early_text', async (): Promise<void> => {
    const project: Project = await informationOutline();
    const unit = project.dataset.units.find((candidate) => candidate.id === '안내-1');
    const cue: TextCue = { id: 'early-text', segmentId: 'demonstration', unitId: unit?.id ?? null, placementId: null,
      mappingDecisionId: null, authority: 'source-unit', text: unit?.text ?? '', startMs: 6000, endMs: 8000, kind: 'dialogue-subtitle', timingStatus: 'confirmed' };
    const changed: Project = { ...project, textCues: [...project.textCues, cue] };
    expect(playableTextCuesAt(changed, 6500).map((candidate: TextCue): string => candidate.id)).not.toContain(cue.id);
    expect(reviewTextPlaybackAt(changed, 6500).blocked.find((entry) => entry.cueId === cue.id)?.issues).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'EARLY_INFORMATION_EMISSION' })]));
  });

  it('playback_does_not_render_review_required_text', async (): Promise<void> => {
    const project: Project = await outline();
    const cue: TextCue = { id: 'review-text', segmentId: 'demonstration', unitId: null, placementId: null,
      mappingDecisionId: null, authority: 'review-required', text: '권한 검토 필요', startMs: 6000, endMs: 8000, kind: 'overlay', timingStatus: 'proposed' };
    const changed: Project = { ...project, textCues: [...project.textCues, cue] };
    expect(playableTextCuesAt(changed, 6500)).not.toContainEqual(cue);
    expect(reviewTextPlaybackAt(changed, 6500).blocked.find((entry) => entry.cueId === cue.id)?.issues).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'TEXT_CUE_AUTHORITY_REVIEW_REQUIRED' })]));
    expect(exportShotCsv(changed)).not.toContain(cue.text);
  });

  it('safe_text_cue_is_rendered_after_gate', async (): Promise<void> => {
    const project: Project = await informationOutline();
    const unit = project.dataset.units.find((candidate) => candidate.id === '안내-1');
    const cue: TextCue = { id: 'safe-text', segmentId: 'demonstration', unitId: unit?.id ?? null, placementId: null,
      mappingDecisionId: null, authority: 'source-unit', text: unit?.text ?? '', startMs: 7000, endMs: 8000, kind: 'overlay', timingStatus: 'confirmed' };
    const changed: Project = { ...project, textCues: [...project.textCues, cue] };
    expect(playableTextCuesAt(changed, 7500).map((candidate: TextCue): string => candidate.id)).toContain(cue.id);
  });
});

describe('Audio output interlock', (): void => {
  it('proposed_audio_asset_is_not_playable', async (): Promise<void> => {
    const project: Project = await outline();
    const cue: AudioCue = project.audioCues[0] as AudioCue;
    const changed: Project = measured(project, cue, cue.startMs, cue.endMs, 'within-segment');
    const proposed: Project = { ...changed, audioCues: changed.audioCues.map((candidate: AudioCue): AudioCue => candidate.id === cue.id ? { ...candidate, timingStatus: 'proposed' } : candidate) };
    expect(playableAudioCuesAt(proposed, cue.startMs)).toEqual([]);
  });

  it('measured_audio_requires_valid_asset', async (): Promise<void> => {
    const project: Project = await outline();
    const cue: AudioCue = project.audioCues[0] as AudioCue;
    const invalid: Project = { ...project, audioCues: project.audioCues.map((candidate: AudioCue): AudioCue => candidate.id === cue.id ? { ...candidate, timingStatus: 'measured', assetId: 'missing' } : candidate) };
    expect(reviewAudioPlaybackAt(invalid, cue.startMs).blocked.find((entry) => entry.cueId === cue.id)?.issues).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'AUDIO_ASSET_INVALID' })]));
  });

  it('audio_playback_cannot_precede_effective_gate', async (): Promise<void> => {
    const project: Project = await informationOutline();
    const cue: AudioCue = project.audioCues.find((candidate: AudioCue): boolean => candidate.unitId === '안내-1') as AudioCue;
    const changed: Project = measured(project, cue, 6000, 6500, 'within-segment');
    expect(playableAudioCuesAt(changed, 6200)).toEqual([]);
    expect(reviewAudioPlaybackAt(changed, 6200).blocked[0]?.issues).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'EARLY_INFORMATION_EMISSION' })]));
  });

  it('speech_generation_cannot_precede_effective_gate', async (): Promise<void> => {
    const project: Project = await informationOutline();
    const cue: AudioCue = project.audioCues.find((candidate: AudioCue): boolean => candidate.unitId === '안내-1') as AudioCue;
    const changed: Project = { ...project, audioCues: project.audioCues.map((candidate: AudioCue): AudioCue => candidate.id === cue.id
      ? { ...candidate, startMs: 6000, endMs: 6500, timingRelation: 'within-segment' } : candidate) };
    expect(() => codexRequestBasis(changed, 'speech', cue.id)).toThrowError(expect.objectContaining({ code: 'AUDIO_OUTPUT_GATE_BLOCKED' }));
  });

  it('audio_relation_change_invalidates_measured_state', async (): Promise<void> => {
    const project: Project = await outline();
    const cue: AudioCue = project.audioCues.find((candidate: AudioCue): boolean => candidate.unitId === '안내-1') as AudioCue;
    const changed: Project = measured(project, cue, 5000, 6000, 'within-segment');
    const moved: Project = updateAudioCueTiming(changed, cue.id, { startMs: 4000, endMs: 6000, timingRelation: 'j-cut' });
    expect(moved.audioCues.find((candidate: AudioCue): boolean => candidate.id === cue.id)?.timingStatus).toBe('proposed');
  });

  it('audio_timing_change_invalidates_audio_anchor', async (): Promise<void> => {
    const project: Project = await outline();
    const cue: AudioCue = project.audioCues.find((candidate: AudioCue): boolean => candidate.unitId === '안내-1') as AudioCue;
    const shot: Shot = project.shots.find((candidate: Shot): boolean => candidate.segmentId === 'demonstration') as Shot;
    const prepared: Project = { ...project, shots: project.shots.map((candidate: Shot): Shot => candidate.id === shot.id ? { ...candidate,
      sourceLinks: candidate.sourceLinks.map((link) => link.unitId === cue.unitId ? { ...link, temporalAnchor: { kind: 'shot-offset', startOffsetMs: 0, endOffsetMs: 1000, basis: 'audio-cue', status: 'confirmed' } } : link) } : candidate) };
    const moved: Project = updateAudioCueTiming(prepared, cue.id, { startMs: cue.startMs + 1, endMs: cue.endMs, timingRelation: cue.timingRelation });
    expect(moved.shots.find((candidate: Shot): boolean => candidate.id === shot.id)?.sourceLinks.find((link) => link.unitId === cue.unitId)?.temporalAnchor.status).toBe('review-required');
  });

  it('safe_measured_audio_is_playable', async (): Promise<void> => {
    const project: Project = await outline();
    const cue: AudioCue = project.audioCues.find((candidate: AudioCue): boolean => candidate.unitId === '안내-1') as AudioCue;
    const changed: Project = measured(project, cue, 5000, 6000, 'within-segment');
    expect(playableAudioCuesAt(changed, 5500).map((candidate: AudioCue): string => candidate.id)).toContain(cue.id);
  });
});

describe('End frame evaluation', (): void => {
  it('end_frame_can_generate_from_last_active_source', async (): Promise<void> => {
    const project: Project = await outline();
    const shot: Shot = project.shots[0] as Shot;
    const changed: Project = frameProject(project, shot, 'end-frame-generation');
    expect(buildFrameImageContext(changed, 'end-frame-generation').sourceUnits.length).toBeGreaterThan(0);
  });

  it('end_frame_uses_last_inside_instant', async (): Promise<void> => {
    const project: Project = await outline();
    const shot: Shot = project.shots[0] as Shot;
    const changed: Project = frameProject(project, shot, 'end-frame-time');
    const frame: StoryboardFrame = changed.frames.find((candidate: StoryboardFrame): boolean => candidate.id === 'end-frame-time') as StoryboardFrame;
    expect(frameDisplayAbsoluteMs(shot, frame)).toBe(shot.endMs);
    expect(frameEvaluationAbsoluteMs(shot, frame)).toBe(shot.endMs - 1);
  });

  it('end_frame_does_not_reveal_next_shot_information', async (): Promise<void> => {
    const project: Project = await outline();
    const shot: Shot = project.shots[0] as Shot;
    const nextShot: Shot = project.shots[1] as Shot;
    const changed: Project = frameProject(project, shot, 'end-frame-boundary');
    const context = buildFrameImageContext(changed, 'end-frame-boundary');
    expect(context.sourceUnits.map((unit) => unit.id)).not.toEqual(expect.arrayContaining(nextShot.sourceLinks.map((link) => link.unitId)));
  });

  it('frame_anchor_can_reference_end_frame', async (): Promise<void> => {
    const project: Project = await outline();
    const shot: Shot = project.shots[0] as Shot;
    const changed: Project = frameProject(project, shot, 'end-frame-anchor');
    const sourceLink = shot.sourceLinks[0];
    if (sourceLink === undefined) throw new Error('검증용 Source Link가 없습니다.');
    const link = { ...sourceLink, temporalAnchor: { kind: 'frame' as const, frameId: 'end-frame-anchor', basis: 'manual' as const, status: 'confirmed' as const } };
    expect(sourceAnchorRange(changed, shot, link)).toEqual({ startMs: shot.endMs - 1, endMs: shot.endMs });
  });

  it('intermediate_end_frame_is_selected_at_last_shot_sample', async (): Promise<void> => {
    const project: Project = await outline();
    const shot: Shot = project.shots[0] as Shot;
    const changed: Project = frameProject(project, shot, 'intermediate-end-frame');
    expect(activeStoryboardFrame(changed, shot.id, shot.endMs - 1)?.id).toBe('intermediate-end-frame');
  });

  it('final_end_frame_is_visible_at_project_end', async (): Promise<void> => {
    const project: Project = await outline();
    const shot: Shot = project.shots.at(-1) as Shot;
    const changed: Project = frameProject(project, shot, 'final-end-frame');
    expect(activeStoryboardFrame(changed, shot.id, shot.endMs)?.id).toBe('final-end-frame');
  });
});

describe('J-cut and L-cut contract', (): void => {
  it('within_segment_audio_must_stay_inside_source_segment', async (): Promise<void> => {
    const project: Project = await outline();
    const cue: AudioCue = project.audioCues.find((candidate: AudioCue): boolean => candidate.unitId === '안내-1') as AudioCue;
    expect(audioTimingIssues(project, { ...cue, startMs: 4000, endMs: 6000, timingRelation: 'within-segment' })).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'AUDIO_RELATION_MISMATCH' })]));
  });

  it('j_cut_is_allowed_with_previous_segment', async (): Promise<void> => {
    const project: Project = await outline();
    const cue: AudioCue = project.audioCues.find((candidate: AudioCue): boolean => candidate.unitId === '안내-1') as AudioCue;
    expect(audioTimingIssues(project, { ...cue, startMs: 4000, endMs: 6000, timingRelation: 'j-cut' })).toEqual([]);
    expect(audioOverhangBeforeMs(project, { ...cue, startMs: 4000, endMs: 6000, timingRelation: 'j-cut' })).toBe(1000);
  });

  it('l_cut_is_allowed_with_next_segment', async (): Promise<void> => {
    const project: Project = await outline();
    const cue: AudioCue = project.audioCues.find((candidate: AudioCue): boolean => candidate.unitId === '안내-1') as AudioCue;
    expect(audioTimingIssues(project, { ...cue, startMs: 13000, endMs: 14000, timingRelation: 'l-cut' })).toEqual([]);
    expect(audioOverhangAfterMs(project, { ...cue, startMs: 13000, endMs: 14000, timingRelation: 'l-cut' })).toBe(500);
  });

  it('unmarked_cross_segment_audio_is_rejected', async (): Promise<void> => {
    const project: Project = await outline();
    const cue: AudioCue = project.audioCues.find((candidate: AudioCue): boolean => candidate.unitId === '안내-1') as AudioCue;
    expect(() => updateAudioCueTiming(project, cue.id, { startMs: 4000, endMs: 6000, timingRelation: 'within-segment' })).toThrowError(expect.objectContaining({ code: 'INVALID_AUDIO_TIMING_RELATION' }));
  });

  it('first_segment_cannot_have_j_cut', async (): Promise<void> => {
    const project: Project = await outline();
    const cue: AudioCue = { ...(project.audioCues[0] as AudioCue), unitId: '제목', startMs: 0, endMs: 1000, timingRelation: 'j-cut' };
    expect(audioTimingIssues(project, cue)).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'AUDIO_OVERHANG_OUT_OF_RANGE' })]));
  });

  it('last_segment_cannot_have_l_cut', async (): Promise<void> => {
    const project: Project = await outline();
    const cue: AudioCue = { ...(project.audioCues[0] as AudioCue), unitId: '요약', startMs: 16000, endMs: 17500, timingRelation: 'l-cut' };
    expect(audioTimingIssues(project, cue)).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'AUDIO_OVERHANG_OUT_OF_RANGE' })]));
  });

  it('j_cut_cannot_cross_multiple_segments', async (): Promise<void> => {
    const project: Project = await outline();
    const cue: AudioCue = { ...(project.audioCues[0] as AudioCue), unitId: '요약', startMs: 4000, endMs: 14000, timingRelation: 'j-cut' };
    expect(audioTimingIssues(project, cue)).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'AUDIO_OVERHANG_OUT_OF_RANGE' })]));
  });

  it('l_cut_cannot_cross_multiple_segments', async (): Promise<void> => {
    const project: Project = await outline();
    const cue: AudioCue = { ...(project.audioCues[0] as AudioCue), unitId: '제목', startMs: 4000, endMs: 14000, timingRelation: 'l-cut' };
    expect(audioTimingIssues(project, cue)).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'AUDIO_OVERHANG_OUT_OF_RANGE' })]));
  });

  it.each([
    ['j_cut_is_not_gate_evidence', 'j-cut', 4000, 7500],
    ['l_cut_is_not_gate_evidence', 'l-cut', 7000, 14000],
  ] as const)('%s', async (_name, relation, startMs, endMs): Promise<void> => {
    const project: Project = await informationOutline();
    const cue: AudioCue = project.audioCues.find((candidate: AudioCue): boolean => candidate.unitId === '안내-1') as AudioCue;
    const changed: Project = measured(project, cue, startMs, endMs, relation);
    expect(effectiveInformationGate(changed, 'INFO-1').evidenceType).not.toBe('measured-audio');
  });

  it('revealing_j_cut_before_gate_is_not_playable', async (): Promise<void> => {
    const project: Project = await informationOutline();
    const cue: AudioCue = project.audioCues.find((candidate: AudioCue): boolean => candidate.unitId === '안내-1') as AudioCue;
    const changed: Project = measured(project, cue, 4000, 7500, 'j-cut');
    expect(playableAudioCuesAt(changed, 4500)).toEqual([]);
  });

  it('safe_j_cut_is_playable', async (): Promise<void> => {
    const project: Project = await outline();
    const cue: AudioCue = project.audioCues.find((candidate: AudioCue): boolean => candidate.unitId === '안내-1') as AudioCue;
    const changed: Project = measured(project, cue, 4000, 6000, 'j-cut');
    expect(playableAudioCuesAt(changed, 4500).map((candidate: AudioCue): string => candidate.id)).toContain(cue.id);
  });

  it('generated_speech_respects_audio_relation', async (): Promise<void> => {
    const project: Project = await outline();
    const cue: AudioCue = project.audioCues.find((candidate: AudioCue): boolean => candidate.unitId === '안내-1') as AudioCue;
    const prepared: Project = { ...project, audioCues: project.audioCues.map((candidate: AudioCue): AudioCue => candidate.id === cue.id ? { ...candidate, startMs: 4000, endMs: 6000, timingRelation: 'j-cut' } : candidate) };
    const mutation = await applyGeneratedSpeech(prepared, cue.id, 'j-cut-speech', '2026-09-06T00:00:00.000Z', { bytes: wav(1500), provider: 'codex-app', prompt: '가이드', model: 'macos-say:test', requestId: 'request', mimeType: 'audio/wav' }, testAudioNormalizer());
    expect(mutation.project.audioCues.find((candidate: AudioCue): boolean => candidate.id === cue.id)).toEqual(expect.objectContaining({ startMs: 4000, endMs: 5500, timingRelation: 'j-cut', timingStatus: 'measured' }));
  });
});

describe('1.3 to 1.4 migration', (): void => {
  it('migration_1_3_to_1_4_defaults_audio_to_within_segment', async (): Promise<void> => {
    const migrated: Project = parseProject(legacy13(await outline()));
    expect(migrated.schemaVersion).toBe('1.5.0');
    expect(migrated.audioCues.every((cue: AudioCue): boolean => cue.timingRelation === 'within-segment')).toBe(true);
  });

  it('migration_infers_text_cue_authority_conservatively', async (): Promise<void> => {
    const project: Project = await outline();
    const legacy = legacy13(project);
    const cues = legacy.textCues as { [key: string]: unknown }[];
    cues.push({ id: 'ambiguous', segmentId: 'SEG-001', unitId: null, placementId: null, text: '모호한 큐', startMs: 100, endMs: 200, kind: 'overlay', timingStatus: 'proposed' });
    const migrated: Project = parseProject(legacy);
    expect(migrated.textCues.find((cue: TextCue): boolean => cue.id === 'ambiguous')?.authority).toBe('review-required');
  });

  it('migration_preserves_assets_and_generation_records', async (): Promise<void> => {
    const project: Project = await outline();
    const frame: StoryboardFrame = project.frames[0] as StoryboardFrame;
    const asset: Asset = { id: 'preserved-image', kind: 'image', subjectId: frame.id, path: 'assets/preserved.png', mimeType: 'image/png', sha256: '2'.repeat(64), description: '보존', durationMs: null, version: 1 };
    const prepared: Project = { ...project, assets: [asset], generationRecords: [{ id: 'preserved-generation', provider: 'codex-app', model: 'imagegen', modelVersion: null,
      requestId: 'request', prompt: '보존', templateVersion: '1', seed: null, referenceHashes: [], resultAssetIds: [asset.id], shotIds: [frame.shotId], createdAt: '2026-09-06T00:00:00.000Z' }] };
    const migrated: Project = parseProject(legacy13(prepared));
    expect(migrated.assets).toEqual(prepared.assets);
    expect(migrated.generationRecords).toEqual(prepared.generationRecords);
  });

  it('migration_preserves_end_frame_offset', async (): Promise<void> => {
    const project: Project = await outline();
    const shot: Shot = project.shots[0] as Shot;
    const prepared: Project = frameProject(project, shot, 'legacy-end-frame');
    const migrated: Project = parseProject(legacy13(prepared));
    expect(migrated.frames.find((frame: StoryboardFrame): boolean => frame.id === 'legacy-end-frame')?.offsetMs).toBe(shot.endMs - shot.startMs);
  });

  it('migration_does_not_persist_frame_evaluation_time', async (): Promise<void> => {
    const legacy = legacy13(await outline()) as { frames: { [key: string]: unknown }[] };
    legacy.frames.forEach((frame): void => { frame.evaluationAbsoluteMs = 123; });
    const migrated = migrateProjectInput(legacy) as { frames: { [key: string]: unknown }[] };
    expect(migrated.frames.every((frame): boolean => !('evaluationAbsoluteMs' in frame))).toBe(true);
  });
});

import { describe, expect, it } from 'vitest';
import { audioTimingIssues } from '../src/domain/audio.js';
import { approveShot } from '../src/domain/edit.js';
import { textCueInformationIds } from '../src/domain/emission.js';
import { effectiveInformationGate, updateTextMappingDecision } from '../src/domain/mapping.js';
import { playableAudioCuesAt, playableTextCuesAt } from '../src/domain/playback.js';
import type { Asset, AudioCue, Project, Shot, SourceUnit, StoryboardFrame, TextCue, TextMappingDecision } from '../src/domain/schema.js';
import { updateAudioCueTiming } from '../src/domain/tracks.js';
import { exportProjectJson } from '../src/exporters/json.js';
import { validateDataset, validateProject } from '../src/domain/validation.js';
import { importPackage } from '../src/importers/import-package.js';
import { parseJson, requireSnapshot } from '../src/importers/integrity.js';
import { ReactionsSchema, ScreenplaySchema } from '../src/importers/production-schema.js';
import { buildFrameImageContext } from '../src/proposal/context.js';
import { createSourceOutline } from '../src/proposal/outline.js';
import { parseProject } from '../src/io/project.js';
import { productionPackage } from './helpers.js';

async function goldenProject(): Promise<Project> {
  return createSourceOutline(importPackage(await productionPackage()), { proposedTextHoldMs: 3000 });
}

function confirmSegmentMappings(project: Project, segmentId: string): Project {
  const decisions: TextMappingDecision[] = project.textMappingDecisions.filter((decision: TextMappingDecision): boolean => {
    const placementSegmentId: string | undefined = project.dataset.textPlacements.find((placement): boolean => placement.id === decision.placementId)?.segmentId;
    return placementSegmentId === segmentId;
  });
  const mapped: Project = decisions.reduce((current: Project, decision: TextMappingDecision): Project => decision.status === 'confirmed' ? current : updateTextMappingDecision(current, decision.id, {
    canonicalUnitId: decision.canonicalUnitId, relation: decision.relation, status: 'confirmed', renderCanonicalSeparately: false,
    canonicalStartMs: null, canonicalEndMs: null, note: 'Golden fixture Mapping 확인',
  }), project);
  return { ...mapped, shots: mapped.shots.map((shot: Shot): Shot => ({ ...shot, sourceLinks: shot.sourceLinks.map((link) => {
    if (link.temporalAnchor.status === 'confirmed' || !['primary-visual', 'continued-visual'].includes(link.usage)) return link;
    const unit: SourceUnit | undefined = mapped.dataset.units.find((candidate: SourceUnit): boolean => candidate.id === link.unitId);
    const times: number[] = unit?.informationIds.flatMap((informationId: string): number[] => mapped.dataset.informationRules
      .filter((rule): boolean => rule.id === informationId && rule.segmentId === shot.segmentId)
      .map((rule): number => effectiveInformationGate(mapped, rule.id).effectiveNotBeforeMs)) ?? [];
    if (times.length === 0) return link;
    const startMs: number = Math.max(...times);
    return { ...link, status: 'confirmed' as const, temporalAnchor: { kind: 'shot-offset' as const,
      startOffsetMs: startMs - shot.startMs, endOffsetMs: Math.min(shot.endMs - shot.startMs, startMs - shot.startMs + 1),
      basis: 'manual' as const, status: 'confirmed' as const } };
  }) })) };
}

function contextAt(project: Project, unitId: string, absoluteMs: number): ReturnType<typeof buildFrameImageContext> {
  const shot: Shot = project.shots.find((candidate: Shot): boolean => candidate.segmentId === 'SEG-024') as Shot;
  const frame: StoryboardFrame = { id: `golden-frame-${unitId}`, shotId: shot.id, offsetMs: absoluteMs - shot.startMs, role: 'key', description: unitId, imageAssetId: null, visualReview: 'pending' };
  const changed: Project = { ...project,
    shots: project.shots.map((candidate: Shot): Shot => candidate.id === shot.id ? { ...candidate, sourceLinks: [{ unitId, usage: 'primary-visual', status: 'confirmed', temporalAnchor: { kind: 'frame', frameId: frame.id, basis: 'manual', status: 'confirmed' } }], informationIds: [] } : candidate),
    frames: [...project.frames.filter((candidate: StoryboardFrame): boolean => candidate.id !== frame.id), frame],
  };
  return buildFrameImageContext(changed, frame.id);
}

function withMeasuredCue(project: Project, cue: AudioCue, startMs: number, endMs: number, timingRelation: AudioCue['timingRelation']): Project {
  const asset: Asset = { id: `${cue.id}:golden-audio`, kind: 'audio', subjectId: cue.id, path: `assets/${cue.id}.wav`, mimeType: 'audio/wav',
    sha256: '3'.repeat(64), description: 'Golden 검증 음성', durationMs: endMs - startMs, version: 1 };
  return { ...project, assets: [...project.assets, asset], audioCues: project.audioCues.map((candidate: AudioCue): AudioCue => candidate.id === cue.id
    ? { ...candidate, startMs, endMs, timingRelation, timingStatus: 'measured', assetId: asset.id } : candidate) };
}

describe('PRJ-007 Golden Acceptance', (): void => {
  it('원본 구조·문자열·전체 시간과 참조 무결성을 보존한다', async (): Promise<void> => {
    const project: Project = await goldenProject();
    const screenplay = ScreenplaySchema.parse(parseJson(requireSnapshot(project.sources, 'screenplay').content, 'screenplay'));
    const reactions = ReactionsSchema.parse(parseJson(requireSnapshot(project.sources, 'reactions').content, 'reactions'));
    const originalUnits = screenplay.scenes.flatMap((scene) => scene.units);
    expect(project.dataset.scenes).toHaveLength(12);
    expect(project.dataset.segments).toHaveLength(32);
    expect(originalUnits).toHaveLength(79);
    expect(reactions.reaction_segments.flatMap((reaction) => reaction.turns)).toHaveLength(16);
    expect(project.dataset.segments.at(-1)?.endMs).toBe(1500000);
    expect(validateDataset(project.dataset, project.sources).filter((issue): boolean => ['TIMELINE_GAP_OR_OVERLAP', 'INVALID_INTERVAL'].includes(issue.code))).toEqual([]);
    expect(originalUnits.filter((unit) => project.dataset.units.find((candidate: SourceUnit): boolean => candidate.id === unit.unit_id)?.text !== unit.text)).toEqual([]);
    expect(project.shots.some((shot: Shot): boolean => shot.sourceLinks.some((link): boolean => project.dataset.units.find((unit: SourceUnit): boolean => unit.id === link.unitId)?.segmentId !== shot.segmentId))).toBe(false);
    expect(validateProject(project, project.dataset).filter((issue): boolean => issue.code === 'SOURCE_UNIT_ORDER_REVERSED')).toEqual([]);
  });

  it('SEG-024 축약 자막과 공개 Gate가 18:08·18:28·19:08 순서를 유지한다', async (): Promise<void> => {
    const project: Project = await goldenProject();
    const gates = Object.fromEntries(project.dataset.informationRules.filter((rule) => rule.segmentId === 'SEG-024').map((rule) => [rule.id, effectiveInformationGate(project, rule.id).effectiveNotBeforeMs]));
    expect(gates['fact:FACT-03']).toBe(1088000);
    expect(gates['fact:FACT-02']).toBe(1108000);
    expect(gates['fact:FACT-09']).toBe(1108000);
    expect(gates['fact:FACT-10']).toBe(1148000);
    expect(project.textCues.some((cue) => cue.unitId === 'UNIT-061' && cue.text === project.dataset.units.find((unit) => unit.id === 'UNIT-061')?.text && cue.startMs === 1080000)).toBe(false);
    const shot: Shot = project.shots.find((candidate: Shot): boolean => candidate.segmentId === 'SEG-024') as Shot;
    expect(() => approveShot(project, shot.id)).toThrowError(expect.objectContaining({ code: 'SHOT_APPROVAL_BLOCKED' }));
  });

  it('SEG-024의 각 정보는 실제 Cue 시각의 프레임에서만 Image Context에 들어간다', async (): Promise<void> => {
    const project: Project = confirmSegmentMappings(await goldenProject(), 'SEG-024');
    expect(contextAt(project, 'UNIT-060', 1088000).allowedInformationIds).toEqual(expect.arrayContaining(['fact:FACT-03']));
    expect(contextAt(project, 'UNIT-061', 1108000).allowedInformationIds).toEqual(expect.arrayContaining(['fact:FACT-02', 'fact:FACT-09']));
    expect(contextAt(project, 'UNIT-064', 1148000).allowedInformationIds).toEqual(expect.arrayContaining(['fact:FACT-10']));
    expect(() => contextAt(project, 'UNIT-064', 1088000)).toThrowError(expect.objectContaining({ code: 'FRAME_GENERATION_BLOCKED', issues: expect.arrayContaining([expect.objectContaining({ code: 'EARLY_INFORMATION_REVEAL' })]) }));
  });

  it('seg024_later_information_is_rejected_from_earlier_shot', async (): Promise<void> => {
    const project: Project = confirmSegmentMappings(await goldenProject(), 'SEG-024');
    const shot: Shot = project.shots.find((candidate: Shot): boolean => candidate.segmentId === 'SEG-024') as Shot;
    const changed: Project = { ...project, shots: project.shots.map((candidate: Shot): Shot => candidate.id === shot.id
      ? { ...candidate, sourceLinks: [{ unitId: 'UNIT-064', usage: 'primary-visual', status: 'confirmed', temporalAnchor: { kind: 'shot-offset', startOffsetMs: 0, endOffsetMs: 1, basis: 'manual', status: 'confirmed' } }], informationIds: [] }
      : candidate) };
    expect(() => approveShot(changed, shot.id)).toThrowError(expect.objectContaining({
      code: 'SHOT_APPROVAL_BLOCKED', issues: expect.arrayContaining([expect.objectContaining({ code: 'EARLY_INFORMATION_REVEAL' })]),
    }));
  });

  it('seg024_text_output_respects_three_stage_gate', async (): Promise<void> => {
    const mapped: Project = confirmSegmentMappings(await goldenProject(), 'SEG-024');
    const fact10Unit: SourceUnit = mapped.dataset.units.find((unit: SourceUnit): boolean => unit.id === 'UNIT-064') as SourceUnit;
    const fact10Cue: TextCue = { id: 'seg024-fact10-text-output', segmentId: fact10Unit.segmentId, unitId: fact10Unit.id,
      placementId: null, mappingDecisionId: null, authority: 'source-unit', text: fact10Unit.text, startMs: 1148000,
      endMs: 1151000, kind: 'overlay', timingStatus: 'confirmed' };
    const project: Project = { ...mapped, textCues: [...mapped.textCues, fact10Cue] };
    const gates: ReadonlyArray<{ informationId: string; atMs: number }> = [
      { informationId: 'fact:FACT-03', atMs: 1088000 },
      { informationId: 'fact:FACT-02', atMs: 1108000 },
      { informationId: 'fact:FACT-09', atMs: 1108000 },
      { informationId: 'fact:FACT-10', atMs: 1148000 },
    ];
    for (const gate of gates) {
      const earlyIds: string[] = playableTextCuesAt(project, gate.atMs - 1).flatMap((cue: TextCue): string[] => textCueInformationIds(project, cue));
      const availableIds: string[] = playableTextCuesAt(project, gate.atMs).flatMap((cue: TextCue): string[] => textCueInformationIds(project, cue));
      expect(earlyIds).not.toContain(gate.informationId);
      expect(availableIds).toContain(gate.informationId);
    }
  });

  it('seg024_audio_output_checks_only_available_source_cues', async (): Promise<void> => {
    const project: Project = confirmSegmentMappings(await goldenProject(), 'SEG-024');
    const earlyCue: AudioCue = project.audioCues.find((cue: AudioCue): boolean => cue.unitId === 'UNIT-062') as AudioCue;
    const safeCue: AudioCue = project.audioCues.find((cue: AudioCue): boolean => cue.unitId === 'UNIT-065') as AudioCue;
    const earlyMeasured: Project = withMeasuredCue(project, earlyCue, 1080000, 1081000, 'within-segment');
    expect(playableAudioCuesAt(earlyMeasured, 1080500).map((cue: AudioCue): string => cue.id)).not.toContain(earlyCue.id);
    const safeMeasured: Project = withMeasuredCue(project, safeCue, 1148000, 1149000, 'within-segment');
    expect(playableAudioCuesAt(safeMeasured, 1148500).map((cue: AudioCue): string => cue.id)).toContain(safeCue.id);
  });

  it('seg018_instruction_requests_intercom_sound_j_cut', async (): Promise<void> => {
    const project: Project = await goldenProject();
    const instruction = project.dataset.instructions.find((candidate): boolean => candidate.segmentId === 'SEG-018' && candidate.kind === 'edit');
    expect(instruction?.text).toContain('호출음 J컷');
    expect(instruction?.sourceRefs.some((ref): boolean => ref.originalId === 'SEG-018' && ref.locator.startsWith('line:'))).toBe(true);
  });

  it('seg018_shooting_instruction_requests_leading_intercom_sound', async (): Promise<void> => {
    const project: Project = await goldenProject();
    const instruction = project.dataset.instructions.find((candidate): boolean => candidate.segmentId === 'SEG-018' && candidate.kind === 'shooting');
    expect(instruction?.text).toContain('인터폰 호출음을 선행');
    expect(instruction?.sourceRefs.some((ref): boolean => ref.originalId === 'SEG-018' && ref.locator.startsWith('line:'))).toBe(true);
  });

  it('unit045_is_sound_in_seg019', async (): Promise<void> => {
    const project: Project = await goldenProject();
    expect(project.dataset.units.find((unit: SourceUnit): boolean => unit.id === 'UNIT-045')).toEqual(expect.objectContaining({ kind: 'SOUND', segmentId: 'SEG-019' }));
  });

  it('seg018_to_seg019_boundary_is_850000ms', async (): Promise<void> => {
    const project: Project = await goldenProject();
    expect(project.dataset.segments.find((segment): boolean => segment.id === 'SEG-018')?.endMs).toBe(850000);
    expect(project.dataset.segments.find((segment): boolean => segment.id === 'SEG-019')?.startMs).toBe(850000);
  });

  it('unit045_j_cut_can_be_saved', async (): Promise<void> => {
    const project: Project = await goldenProject();
    const cue: AudioCue = project.audioCues.find((candidate: AudioCue): boolean => candidate.unitId === 'UNIT-045') as AudioCue;
    const edited: Project = updateAudioCueTiming(project, cue.id, { startMs: 849000, endMs: 851000, timingRelation: 'j-cut' });
    expect(edited.audioCues.find((candidate: AudioCue): boolean => candidate.id === cue.id)).toEqual(expect.objectContaining({ unitId: 'UNIT-045', startMs: 849000, endMs: 851000, timingRelation: 'j-cut' }));
  });

  it('unit045_j_cut_is_playable_before_seg019_boundary', async (): Promise<void> => {
    const project: Project = await goldenProject();
    const cue: AudioCue = project.audioCues.find((candidate: AudioCue): boolean => candidate.unitId === 'UNIT-045') as AudioCue;
    const edited: Project = updateAudioCueTiming(project, cue.id, { startMs: 849000, endMs: 851000, timingRelation: 'j-cut' });
    const measured: Project = withMeasuredCue(edited, edited.audioCues.find((candidate: AudioCue): boolean => candidate.id === cue.id) as AudioCue, 849000, 851000, 'j-cut');
    expect(playableAudioCuesAt(measured, 849500).map((candidate: AudioCue): string => candidate.id)).toContain(cue.id);
  });

  it('unit045_j_cut_round_trip_preserves_relation', async (): Promise<void> => {
    const project: Project = await goldenProject();
    const cue: AudioCue = project.audioCues.find((candidate: AudioCue): boolean => candidate.unitId === 'UNIT-045') as AudioCue;
    const edited: Project = updateAudioCueTiming(project, cue.id, { startMs: 849000, endMs: 851000, timingRelation: 'j-cut' });
    const reopened: Project = parseProject(JSON.parse(exportProjectJson(edited)));
    expect(reopened.audioCues.find((candidate: AudioCue): boolean => candidate.unitId === 'UNIT-045')).toEqual(expect.objectContaining({ startMs: 849000, endMs: 851000, timingRelation: 'j-cut' }));
  });

  it('unit045_j_cut_does_not_change_information_gates', async (): Promise<void> => {
    const project: Project = await goldenProject();
    const cue: AudioCue = project.audioCues.find((candidate: AudioCue): boolean => candidate.unitId === 'UNIT-045') as AudioCue;
    const before = project.dataset.informationRules.map((rule) => effectiveInformationGate(project, rule.id));
    const edited: Project = updateAudioCueTiming(project, cue.id, { startMs: 849000, endMs: 851000, timingRelation: 'j-cut' });
    const changed: Project = withMeasuredCue(edited, edited.audioCues.find((candidate: AudioCue): boolean => candidate.id === cue.id) as AudioCue, 849000, 851000, 'j-cut');
    const after = changed.dataset.informationRules.map((rule) => effectiveInformationGate(changed, rule.id));
    expect(after).toEqual(before);
  });

  it('unit045_cross_segment_timing_without_j_cut_is_rejected', async (): Promise<void> => {
    const project: Project = await goldenProject();
    const cue: AudioCue = project.audioCues.find((candidate: AudioCue): boolean => candidate.unitId === 'UNIT-045') as AudioCue;
    expect(audioTimingIssues(project, { ...cue, startMs: 849000, endMs: 851000, timingRelation: 'within-segment' }))
      .toEqual(expect.arrayContaining([expect.objectContaining({ code: 'AUDIO_RELATION_MISMATCH' })]));
  });

  it('unit044_narration_is_not_used_as_intercom_sound_fidelity_target', async (): Promise<void> => {
    const project: Project = await goldenProject();
    expect(project.dataset.units.find((unit: SourceUnit): boolean => unit.id === 'UNIT-044')).toEqual(expect.objectContaining({ kind: 'NARRATION', segmentId: 'SEG-018' }));
    expect(project.audioCues.find((cue: AudioCue): boolean => cue.unitId === 'UNIT-044')?.kind).toBe('voiceover');
  });

  it('confirming_seg024_mappings_does_not_modify_other_segments', async (): Promise<void> => {
    const project: Project = await goldenProject();
    const before: TextMappingDecision[] = project.textMappingDecisions.filter((decision: TextMappingDecision): boolean =>
      project.dataset.textPlacements.find((placement): boolean => placement.id === decision.placementId)?.segmentId !== 'SEG-024');
    const mapped: Project = confirmSegmentMappings(project, 'SEG-024');
    expect(mapped.textMappingDecisions.filter((decision: TextMappingDecision): boolean =>
      mapped.dataset.textPlacements.find((placement): boolean => placement.id === decision.placementId)?.segmentId !== 'SEG-024')).toEqual(before);
  });

  it('golden_helper_only_updates_explicit_target_decisions', async (): Promise<void> => {
    const project: Project = await goldenProject();
    const mapped: Project = confirmSegmentMappings(project, 'SEG-024');
    const changedIds: string[] = mapped.textMappingDecisions.filter((decision: TextMappingDecision, index: number): boolean =>
      JSON.stringify(decision) !== JSON.stringify(project.textMappingDecisions[index])).map((decision: TextMappingDecision): string => decision.id);
    const targetIds: Set<string> = new Set(project.textMappingDecisions.filter((decision: TextMappingDecision): boolean =>
      project.dataset.textPlacements.find((placement): boolean => placement.id === decision.placementId)?.segmentId === 'SEG-024').map((decision: TextMappingDecision): string => decision.id));
    expect(changedIds.every((id: string): boolean => targetIds.has(id))).toBe(true);
  });

  it('audio_golden_does_not_claim_unsupported_gate_coverage', async (): Promise<void> => {
    const project: Project = confirmSegmentMappings(await goldenProject(), 'SEG-024');
    const cue: AudioCue = project.audioCues.find((candidate: AudioCue): boolean => candidate.unitId === 'UNIT-065') as AudioCue;
    const measured: Project = withMeasuredCue(project, cue, 1148000, 1149000, 'within-segment');
    const claimedStages: number[] = [1088000, 1108000, 1148000].filter((atMs: number): boolean =>
      playableAudioCuesAt(measured, atMs).some((candidate: AudioCue): boolean => candidate.id === cue.id));
    expect(claimedStages).toEqual([1148000]);
  });
});

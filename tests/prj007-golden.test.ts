import { describe, expect, it } from 'vitest';
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
    return placementSegmentId === segmentId || decision.status === 'unresolved';
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

  it('seg024_audio_output_respects_three_stage_gate', async (): Promise<void> => {
    const project: Project = confirmSegmentMappings(await goldenProject(), 'SEG-024');
    const earlyCue: AudioCue = project.audioCues.find((cue: AudioCue): boolean => cue.unitId === 'UNIT-062') as AudioCue;
    const safeCue: AudioCue = project.audioCues.find((cue: AudioCue): boolean => cue.unitId === 'UNIT-065') as AudioCue;
    const earlyMeasured: Project = withMeasuredCue(project, earlyCue, 1080000, 1081000, 'within-segment');
    expect(playableAudioCuesAt(earlyMeasured, 1080500).map((cue: AudioCue): string => cue.id)).not.toContain(earlyCue.id);
    const safeMeasured: Project = withMeasuredCue(project, safeCue, 1148000, 1149000, 'within-segment');
    expect(playableAudioCuesAt(safeMeasured, 1148500).map((cue: AudioCue): string => cue.id)).toContain(safeCue.id);
  });

  it('seg018_j_cut_can_be_saved_and_played', async (): Promise<void> => {
    const project: Project = await goldenProject();
    const cue: AudioCue = project.audioCues.find((candidate: AudioCue): boolean => candidate.unitId === 'UNIT-044') as AudioCue;
    const edited: Project = updateAudioCueTiming(project, cue.id, { startMs: 829000, endMs: 831000, timingRelation: 'j-cut' });
    const measured: Project = withMeasuredCue(edited, edited.audioCues.find((candidate: AudioCue): boolean => candidate.id === cue.id) as AudioCue, 829000, 831000, 'j-cut');
    expect(playableAudioCuesAt(measured, 829500).map((candidate: AudioCue): string => candidate.id)).toContain(cue.id);
    const reopened: Project = parseProject(JSON.parse(exportProjectJson(measured)));
    expect(reopened.audioCues.find((candidate: AudioCue): boolean => candidate.id === cue.id)?.timingRelation).toBe('j-cut');
  });

  it('seg018_j_cut_does_not_advance_gate', async (): Promise<void> => {
    const project: Project = await goldenProject();
    const cue: AudioCue = project.audioCues.find((candidate: AudioCue): boolean => candidate.unitId === 'UNIT-044') as AudioCue;
    const before = project.dataset.informationRules.map((rule) => effectiveInformationGate(project, rule.id));
    const edited: Project = updateAudioCueTiming(project, cue.id, { startMs: 829000, endMs: 831000, timingRelation: 'j-cut' });
    const changed: Project = withMeasuredCue(edited, edited.audioCues.find((candidate: AudioCue): boolean => candidate.id === cue.id) as AudioCue, 829000, 831000, 'j-cut');
    const after = changed.dataset.informationRules.map((rule) => effectiveInformationGate(changed, rule.id));
    expect(after).toEqual(before);
  });
});

import { describe, expect, it } from 'vitest';
import { approveShot } from '../src/domain/edit.js';
import { effectiveInformationGate, updateTextMappingDecision } from '../src/domain/mapping.js';
import type { Project, Shot, SourceUnit, StoryboardFrame, TextMappingDecision } from '../src/domain/schema.js';
import { validateDataset, validateProject } from '../src/domain/validation.js';
import { importPackage } from '../src/importers/import-package.js';
import { parseJson, requireSnapshot } from '../src/importers/integrity.js';
import { ReactionsSchema, ScreenplaySchema } from '../src/importers/production-schema.js';
import { buildFrameImageContext } from '../src/proposal/context.js';
import { createSourceOutline } from '../src/proposal/outline.js';
import { productionPackage } from './helpers.js';

async function goldenProject(): Promise<Project> {
  return createSourceOutline(importPackage(await productionPackage()), { proposedTextHoldMs: 3000 });
}

function confirmSegmentMappings(project: Project, segmentId: string): Project {
  const decisions: TextMappingDecision[] = project.textMappingDecisions.filter((decision: TextMappingDecision): boolean => project.dataset.textPlacements.find((placement): boolean => placement.id === decision.placementId)?.segmentId === segmentId);
  return decisions.reduce((current: Project, decision: TextMappingDecision): Project => decision.status === 'confirmed' ? current : updateTextMappingDecision(current, decision.id, {
    canonicalUnitId: decision.canonicalUnitId, relation: decision.relation, status: 'confirmed', renderCanonicalSeparately: false,
    canonicalStartMs: null, canonicalEndMs: null, note: 'Golden fixture Mapping 확인',
  }), project);
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
});

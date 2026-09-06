import { describe, expect, it } from 'vitest';
import { approveShot, mergeShots, reorderShots, splitShot } from '../src/domain/edit.js';
import {
  approvalIssuesForShot, updateShotSourceLinks, updateTextMappingDecision,
} from '../src/domain/mapping.js';
import type { Project, Shot, ShotSourceLink, TextMappingDecision } from '../src/domain/schema.js';
import { applySourceUpdate } from '../src/domain/source-update.js';
import { importPackage } from '../src/importers/import-package.js';
import { parseProject } from '../src/io/project.js';
import { buildImageContext } from '../src/proposal/context.js';
import { applySegmentProposal } from '../src/proposal/model.js';
import { createSourceOutline } from '../src/proposal/outline.js';
import { nativeData, nativePackage, productionPackage, withNativeData } from './helpers.js';

async function productionOutline(): Promise<Project> {
  return createSourceOutline(importPackage(await productionPackage()), { proposedTextHoldMs: 3000 });
}

async function nativeOutline(): Promise<Project> {
  return createSourceOutline(importPackage(await nativePackage()), { proposedTextHoldMs: 2000 });
}

function segmentDecision(project: Project, segmentId: string, canonicalUnitId: string): TextMappingDecision {
  const decision: TextMappingDecision | undefined = project.textMappingDecisions.find((candidate: TextMappingDecision): boolean => candidate.canonicalUnitId === canonicalUnitId
    && project.dataset.textPlacements.find((placement): boolean => placement.id === candidate.placementId)?.segmentId === segmentId);
  if (decision === undefined) throw new Error(`${segmentId}: ${canonicalUnitId} Mapping Decision이 없습니다.`);
  return decision;
}

function confirmAbbreviation(project: Project, decision: TextMappingDecision): Project {
  return updateTextMappingDecision(project, decision.id, {
    canonicalUnitId: decision.canonicalUnitId, relation: 'abbreviation', status: 'confirmed',
    renderCanonicalSeparately: false, canonicalStartMs: null, canonicalEndMs: null, note: '축약 자막 확인',
  });
}

describe('자막 Mapping 결정', (): void => {
  it('unresolved_text_mapping_blocks_shot_approval', async (): Promise<void> => {
    const project: Project = await productionOutline();
    const shot: Shot | undefined = project.shots.find((candidate: Shot): boolean => candidate.segmentId === 'SEG-024');
    if (shot === undefined) throw new Error('SEG-024 컷이 없습니다.');
    expect(() => approveShot(project, shot.id)).toThrowError(expect.objectContaining({ code: 'SHOT_APPROVAL_BLOCKED', issues: expect.arrayContaining([expect.objectContaining({ code: 'UNRESOLVED_TEXT_MAPPING' })]) }));
  });

  it('confirmed_abbreviation_uses_single_rendered_text_cue', async (): Promise<void> => {
    const project: Project = await productionOutline();
    const decision: TextMappingDecision = segmentDecision(project, 'SEG-024', 'UNIT-061');
    const confirmed: Project = confirmAbbreviation(project, decision);
    const cues = confirmed.textCues.filter((cue): boolean => cue.placementId === decision.placementId || cue.unitId === 'UNIT-061');
    expect(cues).toHaveLength(1);
    expect(cues[0]?.text).toBe('복구 문서 — 동일 원문 / 사진 설명 사후 추가 / 삭제 시도 기록');
    expect(cues.some((cue): boolean => cue.text === confirmed.dataset.units.find((unit) => unit.id === 'UNIT-061')?.text)).toBe(false);
  });

  it('separate_element_requires_explicit_second_timing', async (): Promise<void> => {
    const project: Project = await productionOutline();
    const decision: TextMappingDecision = segmentDecision(project, 'SEG-024', 'UNIT-061');
    const changed = { ...project, textMappingDecisions: project.textMappingDecisions.map((candidate: TextMappingDecision): TextMappingDecision => candidate.id === decision.id ? {
      ...candidate, canonicalUnitId: 'UNIT-061', relation: 'separate-element', status: 'confirmed', renderCanonicalSeparately: true,
      canonicalStartMs: null, canonicalEndMs: null, note: '별도 요소',
    } : candidate) } as Project;
    const shot: Shot = changed.shots.find((candidate: Shot): boolean => candidate.segmentId === 'SEG-024') as Shot;
    expect(approvalIssuesForShot(changed, shot.id)).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'INVALID_TEXT_MAPPING_STATE' })]));
  });
});

describe('Shot Source Link', (): void => {
  it('proposal_rejects_reversed_source_unit_order', async (): Promise<void> => {
    const project: Project = await nativeOutline();
    expect(() => applySegmentProposal(project, 'demonstration', { shots: [
      { sourceLinks: [{ unitId: '효과음', usage: 'primary-visual' }], durationWeight: 1, action: '후반', visualLocationId: null, camera: { size: 'CU', angle: 'eye', move: 'static' }, presence: [], propIds: [], cameraAxis: null, screenDirection: null, informationIds: [], transitionOut: { kind: 'cut', durationMs: 0, note: '' }, frameDescription: '후반' },
      { sourceLinks: [{ unitId: '안내-1', usage: 'primary-visual' }, { unitId: '동작', usage: 'primary-visual' }], durationWeight: 1, action: '전반', visualLocationId: null, camera: { size: 'CU', angle: 'eye', move: 'static' }, presence: [], propIds: [], cameraAxis: null, screenDirection: null, informationIds: [], transitionOut: { kind: 'cut', durationMs: 0, note: '' }, frameDescription: '전반' },
    ] }, 'reverse')).toThrowError(expect.objectContaining({ code: 'PROPOSAL_SOURCE_ORDER_REVERSED' }));
  });

  it('manual_split_rebases_confirmed_source_anchor', async (): Promise<void> => {
    const project: Project = await nativeOutline();
    const split: Project = splitShot(project, 'shot-2', 8000, 'split-shot', 'split-frame');
    const actionLinks: ShotSourceLink[] = split.shots.flatMap((shot: Shot): ShotSourceLink[] => shot.sourceLinks.filter((link: ShotSourceLink): boolean => link.unitId === '동작'));
    expect(actionLinks).toHaveLength(2);
    expect(actionLinks.every((link: ShotSourceLink): boolean => link.status === 'confirmed' && link.temporalAnchor.kind === 'shot-offset')).toBe(true);
  });

  it('image_context_rejects_mapping_required_source', async (): Promise<void> => {
    const project: Project = await nativeOutline();
    const split: Project = splitShot(project, 'shot-2', 8000, 'split-shot', 'split-frame');
    const shot: Shot = split.shots.find((candidate: Shot): boolean => candidate.sourceLinks.some((link: ShotSourceLink): boolean => link.unitId === '동작')) as Shot;
    expect(() => buildImageContext(split, shot.id)).toThrowError(expect.objectContaining({ code: 'FRAME_GENERATION_BLOCKED' }));
  });

  it('source_links_survive_split_merge_and_reorder', async (): Promise<void> => {
    const project: Project = await nativeOutline();
    const split: Project = splitShot(project, 'shot-2', 8000, 'split-shot', 'split-frame');
    const before: ShotSourceLink[] = split.shots.filter((shot: Shot): boolean => shot.segmentId === 'demonstration').flatMap((shot: Shot): ShotSourceLink[] => shot.sourceLinks);
    const reordered: Project = reorderShots(split, 'demonstration', ['split-shot', 'shot-2']);
    expect(reordered.shots.filter((shot: Shot): boolean => shot.segmentId === 'demonstration').flatMap((shot: Shot): ShotSourceLink[] => shot.sourceLinks)).toEqual([...split.shots.find((shot: Shot): boolean => shot.id === 'split-shot')?.sourceLinks ?? [], ...split.shots.find((shot: Shot): boolean => shot.id === 'shot-2')?.sourceLinks ?? []]);
    const merged: Project = mergeShots(split, 'shot-2', 'split-shot');
    const mergedLinks: ShotSourceLink[] = merged.shots.find((shot: Shot): boolean => shot.id === 'shot-2')?.sourceLinks ?? [];
    expect(new Set(mergedLinks.map((link: ShotSourceLink): string => link.unitId))).toEqual(new Set(before.map((link: ShotSourceLink): string => link.unitId)));
    expect(mergedLinks.find((link: ShotSourceLink): boolean => link.unitId === '동작')?.status).toBe('confirmed');
  });

  it('수동 Source Mapping 수정이 원문을 바꾸지 않는다', async (): Promise<void> => {
    const project: Project = await nativeOutline();
    const shot: Shot = project.shots.find((candidate: Shot): boolean => candidate.id === 'shot-2') as Shot;
    const before: string = JSON.stringify(project.dataset);
    const links: ShotSourceLink[] = shot.sourceLinks.map((link: ShotSourceLink): ShotSourceLink => link.unitId === '동작' ? { ...link, usage: 'primary-visual', status: 'confirmed', temporalAnchor: { kind: 'shot-offset', startOffsetMs: 0, endOffsetMs: shot.endMs - shot.startMs, basis: 'manual', status: 'confirmed' } } : link);
    const changed: Project = updateShotSourceLinks(project, shot.id, { links });
    expect(changed.shots.find((candidate: Shot): boolean => candidate.id === shot.id)?.sourceLinks).toEqual(links);
    expect(JSON.stringify(changed.dataset)).toBe(before);
  });
});

describe('Migration과 Source Update', (): void => {
  it('old_1_1_project_migrates_to_source_links', async (): Promise<void> => {
    const project: Project = await nativeOutline();
    const legacy = JSON.parse(JSON.stringify(project)) as { schemaVersion: string; shots: { sourceLinks: ShotSourceLink[]; sourceUnitIds?: string[] }[]; textMappingDecisions?: unknown; dataset: { informationRules: { id: string; segmentId: string; baseNotBeforeMs: number; notBeforeMs?: number; sourceRefs: unknown[] }[]; segments: { id: string; startMs: number }[] } };
    legacy.schemaVersion = '1.1.0';
    delete legacy.textMappingDecisions;
    legacy.dataset.informationRules = legacy.dataset.informationRules.map((rule) => ({ id: rule.id, segmentId: rule.segmentId, baseNotBeforeMs: rule.baseNotBeforeMs, notBeforeMs: legacy.dataset.segments.find((segment) => segment.id === rule.segmentId)?.startMs ?? rule.baseNotBeforeMs, sourceRefs: [rule.sourceRefs[0]] }));
    for (const rule of legacy.dataset.informationRules) { delete (rule as { segmentId?: string }).segmentId; }
    for (const shot of legacy.shots) { shot.sourceUnitIds = shot.sourceLinks.map((link: ShotSourceLink): string => link.unitId); delete (shot as { sourceLinks?: ShotSourceLink[] }).sourceLinks; }
    const migrated: Project = parseProject(legacy);
    expect(migrated.schemaVersion).toBe('1.3.0');
    expect(migrated.shots.every((shot: Shot): boolean => shot.sourceLinks.length > 0)).toBe(true);
  });

  it('migration_does_not_silently_confirm_ambiguous_mapping', async (): Promise<void> => {
    const project: Project = await productionOutline();
    const legacy = JSON.parse(JSON.stringify(project)) as { schemaVersion: string; shots: { sourceLinks: ShotSourceLink[]; sourceUnitIds?: string[] }[]; textMappingDecisions?: unknown; dataset: { informationRules: { id: string; segmentId: string; baseNotBeforeMs: number; notBeforeMs?: number; sourceRefs: unknown[] }[]; segments: { id: string; startMs: number }[] } };
    legacy.schemaVersion = '1.1.0';
    delete legacy.textMappingDecisions;
    legacy.dataset.informationRules = legacy.dataset.informationRules.map((rule) => ({ id: rule.id, segmentId: rule.segmentId, baseNotBeforeMs: rule.baseNotBeforeMs, notBeforeMs: legacy.dataset.segments.find((segment) => segment.id === rule.segmentId)?.startMs ?? rule.baseNotBeforeMs, sourceRefs: [rule.sourceRefs[0]] }));
    for (const rule of legacy.dataset.informationRules) { delete (rule as { segmentId?: string }).segmentId; }
    for (const shot of legacy.shots) { shot.sourceUnitIds = shot.sourceLinks.map((link: ShotSourceLink): string => link.unitId); delete (shot as { sourceLinks?: ShotSourceLink[] }).sourceLinks; }
    const migrated: Project = parseProject(legacy);
    expect(segmentDecision(migrated, 'SEG-024', 'UNIT-061').status).toBe('unresolved');
    expect(migrated.shots.every((shot: Shot): boolean => shot.sourceLinks.every((link: ShotSourceLink): boolean => link.status === 'mapping-required'))).toBe(true);
  });

  it('source_update_invalidates_stale_mapping_decisions', async (): Promise<void> => {
    const payload = await nativePackage();
    const data = nativeData(payload);
    const current: Project = createSourceOutline(importPackage(payload), { proposedTextHoldMs: 2000 });
    const changedData = { ...data,
      units: data.units.map((unit) => unit.id === '제목' ? { ...unit, text: '흙 상태를 먼저 확인하세요' } : unit),
      textPlacements: data.textPlacements.map((placement) => placement.id === 'title-placement' ? { ...placement, text: '흙 상태를 먼저 확인하세요' } : placement),
    };
    const incoming: Project = createSourceOutline(importPackage(withNativeData(payload, changedData)), { proposedTextHoldMs: 2000 });
    const updated: Project = applySourceUpdate(current, incoming, 'mapping-update');
    expect(updated.textMappingDecisions.find((decision: TextMappingDecision): boolean => decision.placementId === 'title-placement')?.status).toBe('unresolved');
  });
});

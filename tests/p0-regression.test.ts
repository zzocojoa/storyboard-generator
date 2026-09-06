import { describe, expect, it } from 'vitest';
import { splitShot } from '../src/domain/edit.js';
import type { Project, StoryboardFrame } from '../src/domain/schema.js';
import { importPackage } from '../src/importers/import-package.js';
import { buildFrameImageContext } from '../src/proposal/context.js';
import { createSourceOutline } from '../src/proposal/outline.js';
import { productionPackage } from './helpers.js';

async function productionOutline(): Promise<Project> {
  return createSourceOutline(importPackage(await productionPackage()), { proposedTextHoldMs: 3000 });
}

describe('P0 원문과 공개 시점 회귀', (): void => {
  it('abbreviated_text_does_not_render_canonical_text_early', async (): Promise<void> => {
    const project: Project = await productionOutline();
    const canonical = project.textCues.find((cue): boolean => cue.unitId === 'UNIT-061');
    expect(canonical?.startMs).not.toBe(1080000);
  });

  it('split_does_not_copy_all_source_units_to_both_shots', async (): Promise<void> => {
    const project: Project = await productionOutline();
    const original = project.shots.find((shot): boolean => shot.segmentId === 'SEG-024');
    if (original === undefined) throw new Error('SEG-024 검증용 컷이 없습니다.');
    const split: Project = splitShot(project, original.id, 1120000, 'split:shot', 'split:frame');
    const first = split.shots.find((shot): boolean => shot.id === original.id);
    const second = split.shots.find((shot): boolean => shot.id === 'split:shot');
    expect(first?.sourceLinks).not.toEqual(second?.sourceLinks);
  });

  it('frame_context_uses_absolute_frame_time', async (): Promise<void> => {
    const project: Project = await productionOutline();
    const shot = project.shots.find((candidate): boolean => candidate.segmentId === 'SEG-024');
    if (shot === undefined) throw new Error('SEG-024 검증용 컷이 없습니다.');
    const unitId: string = shot.sourceLinks.find((link): boolean => project.dataset.units.find((unit): boolean => unit.id === link.unitId)?.informationIds.includes('fact:FACT-10') === true)?.unitId ?? '';
    const frame: StoryboardFrame = { id: 'late-frame', shotId: shot.id, offsetMs: 70000, role: 'key', description: '후반 정보 프레임', imageAssetId: null, visualReview: 'pending' };
    const changed: Project = {
      ...project,
      dataset: { ...project.dataset, informationRules: project.dataset.informationRules.map((rule) => rule.id === 'fact:FACT-10' ? { ...rule, baseNotBeforeMs: 1140000 } : rule) },
      textMappingDecisions: project.textMappingDecisions.map((decision) => ({ ...decision, status: 'confirmed' })),
      shots: project.shots.map((candidate) => candidate.id === shot.id ? { ...candidate, sourceLinks: [{ unitId, usage: 'primary-visual', status: 'confirmed', temporalAnchor: { kind: 'frame', frameId: frame.id, basis: 'manual', status: 'confirmed' } }], informationIds: ['fact:FACT-10'] } : candidate),
      frames: [...project.frames, frame],
    };
    expect(buildFrameImageContext(changed, frame.id).allowedInformationIds).toContain('fact:FACT-10');
  });
});

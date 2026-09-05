import { describe, expect, it } from 'vitest';
import { importPackage } from '../src/importers/import-package.js';
import { buildImageContext, buildSegmentContext } from '../src/proposal/context.js';
import { createSourceOutline } from '../src/proposal/outline.js';
import { productionPackage } from './helpers.js';

describe('생성 요청의 정보 경계', (): void => {
  it('후반 원문·전체 파일·인물 비밀을 현재 구간의 생성 입력에 전달하지 않는다', async (): Promise<void> => {
    const original = createSourceOutline(importPackage(await productionPackage()), { proposedTextHoldMs: 3000 });
    const project = { ...original, dataset: { ...original.dataset, people: original.dataset.people.map((person) => ({ ...person, role: 'SECRET_SENTINEL' })) } };
    const context = buildSegmentContext(project, 'SEG-006');
    const serialized: string = JSON.stringify(context);
    expect(serialized).not.toContain('SECRET_SENTINEL');
    expect(serialized).not.toContain('UNIT-067');
    expect(serialized).not.toContain('source_footprint_sha256');
    expect(context.sourceUnits.every((unit): boolean => project.dataset.units.find((value): boolean => value.id === unit.id)?.segmentId === 'SEG-006')).toBe(true);
    const image = buildImageContext(project, 'shot-6');
    expect(image.people).toEqual([]);
    expect(image.textOverlayUnitIds).toContain('UNIT-017');
    expect(image.sourceUnits.some((unit): boolean => unit.kind === 'SCREEN_TEXT')).toBe(false);
  });

  it('후반 원문을 앞선 컷에 연결하거나 정보 ID 목록을 비워도 공개 검사를 우회할 수 없다', async (): Promise<void> => {
    const project = createSourceOutline(importPackage(await productionPackage()), { proposedTextHoldMs: 3000 });
    const foreign = { ...project, shots: project.shots.map((shot) => shot.id === 'shot-1' ? { ...shot, sourceUnitIds: ['UNIT-067'], informationIds: [] } : shot) };
    expect(() => buildImageContext(foreign, 'shot-1')).toThrowError(expect.objectContaining({ code: 'INVALID_PROMPT_SOURCE' }));
    const later = project.dataset.informationRules.find((rule): boolean => rule.notBeforeMs > 0);
    if (later === undefined) throw new Error('공개 규칙이 없습니다.');
    const forged = { ...project, dataset: { ...project.dataset, units: project.dataset.units.map((unit) => unit.id === 'UNIT-001' ? { ...unit, informationIds: [later.id] } : unit) } };
    expect(() => buildImageContext(forged, 'shot-1')).toThrowError(expect.objectContaining({ code: 'FORBIDDEN_PROMPT_INFORMATION' }));
  });
});

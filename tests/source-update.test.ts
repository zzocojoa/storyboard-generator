import { describe, expect, it } from 'vitest';
import { approveShot, requireShot, shotContent, updateShotContent } from '../src/domain/edit.js';
import type { Project } from '../src/domain/schema.js';
import { applySourceUpdate, sourceImpact } from '../src/domain/source-update.js';
import { importPackage } from '../src/importers/import-package.js';
import { createSourceOutline } from '../src/proposal/outline.js';
import { nativeData, nativePackage, withNativeData } from './helpers.js';

async function versions(): Promise<{ current: Project; incoming: Project }> {
  const payload = await nativePackage();
  const data = nativeData(payload);
  const changed = { ...data, units: data.units.map((unit) => unit.id === 'UNIT-001' ? { ...unit, text: '화분과 마른 흙 표면을 보여준다.' } : unit) };
  return {
    current: createSourceOutline(importPackage(payload), { proposedTextHoldMs: 2000 }),
    incoming: createSourceOutline(importPackage(withNativeData(payload, changed)), { proposedTextHoldMs: 2000 }),
  };
}

describe('원본 변경 영향', (): void => {
  it('바뀐 원문이 닿는 구간과 컷을 찾고 잠금 상태를 보고한다', async (): Promise<void> => {
    const { current, incoming } = await versions();
    const impact = sourceImpact(approveShot(current, 'shot-1'), incoming);
    expect(impact.changedSourceFileIds).toEqual(['native-source']);
    expect(impact.changedEntityIds).toContain('unit:UNIT-001');
    expect(impact.impactedSegmentIds).toContain('SEG-001');
    expect(impact.lockedShotIds).toEqual(['shot-1']);
    expect(impact.canApply).toBe(false);
  });

  it('영향 없는 사용자 컷은 보존하고 바뀐 구간만 새 원본 뼈대로 교체한다', async (): Promise<void> => {
    const { current, incoming } = await versions();
    const second = requireShot(current, 'shot-2');
    const edited = updateShotContent(current, second.id, { ...shotContent(second), camera: { size: 'CU', angle: 'eye-level', move: 'static' } });
    const updated = applySourceUpdate(edited, incoming, 'update-2');
    expect(requireShot(updated, 'shot-2').camera.size).toBe('CU');
    expect(updated.shots.find((shot) => shot.segmentId === 'SEG-001')).toEqual(expect.objectContaining({ id: 'update-2:shot:1', action: '화분과 마른 흙 표면을 보여준다.' }));
    expect(updated.dataset.units.find((unit) => unit.id === 'UNIT-001')?.text).toBe('화분과 마른 흙 표면을 보여준다.');
    expect(current.dataset.units.find((unit) => unit.id === 'UNIT-001')?.text).toBe('화분과 흙 표면을 보여준다.');
  });
});

import type { Project } from '../src/domain/schema.js';
import { importPackage } from '../src/importers/import-package.js';
import { createSourceOutline } from '../src/proposal/outline.js';
import type { AutomaticSegmentPlan } from '../src/automation/plan-schema.js';
import { automaticShot } from './automatic-plan-helpers.js';
import { nativeData, nativePackage, withNativeData } from './helpers.js';

export async function crowdedTextProject(): Promise<Project> {
  const payload = await nativePackage(); const data = nativeData(payload);
  const description: string = '화분의 흙을 확인한 뒤에 물을 주세요. 잎과 줄기를 차례로 살펴봅니다.';
  const units = data.units.filter((unit): boolean => unit.segmentId !== 'SEG-001');
  const project = createSourceOutline(importPackage(withNativeData(payload, { ...data,
    units: [
      { id: 'surface', segmentId: 'SEG-001', order: 1, kind: 'ACTION', text: '화분과 메모를 보여준다.', speakerId: null, informationIds: [] },
      { id: 'note-a', segmentId: 'SEG-001', order: 2, kind: 'NOTE', text: description, speakerId: null, informationIds: [] },
      { id: 'note-b', segmentId: 'SEG-001', order: 3, kind: 'NOTE', text: description + ' 물주기 안내.', speakerId: null, informationIds: [] }, ...units,
    ], textPlacements: data.textPlacements.filter((value): boolean => value.segmentId !== 'SEG-001'),
  })), { proposedTextHoldMs: 2000 });
  return { ...project, profile: { ...project.profile, aspectWidth: 16, aspectHeight: 9 }, textLayout: { ...project.textLayout, fontSize: 0.12, maxLines: 12 }, textReadability: { ...project.textReadability, graphemesPerSecond: 40, minHoldMs: 250 } };
}

export function crowdedTextPlan(): AutomaticSegmentPlan {
  return { schemaVersion: '1.0.0', segmentId: 'SEG-001', summary: '두 메모의 표시 시각 검토', mappings: [], placementInformation: [], audioTimings: [],
    textTimings: ['note-a', 'note-b'].map((id) => ({ authority: 'source-unit', targetId: id, startMs: 0, endMs: 2000, reason: '메모 원문 표시' })),
    shots: [{ ...automaticShot(0, 5000), action: '화분과 두 메모를 보여준다.',
      sourceLinks: ['surface', 'note-a', 'note-b'].map((unitId) => ({ unitId, usage: 'primary-visual', startOffsetMs: 0, endOffsetMs: 5000, reason: '메모와 화분의 직접 시각 근거' })) }],
  };
}

export function separatedTextPlan(): AutomaticSegmentPlan {
  const plan = crowdedTextPlan();
  return { ...plan, textTimings: plan.textTimings.map((value) => value.targetId === 'note-b' ? { ...value, startMs: 2500, endMs: 4500, reason: '앞 메모와 겹치지 않게 같은 표시 길이로 이동' } : value) };
}

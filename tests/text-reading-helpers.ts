import type { AutomaticSegmentPlan } from '../src/automation/plan-schema.js';
import type { Project } from '../src/domain/schema.js';
import { importPackage } from '../src/importers/import-package.js';
import { createSourceOutline } from '../src/proposal/outline.js';
import { automaticShot } from './automatic-plan-helpers.js';
import { nativeData, nativePackage, withNativeData } from './helpers.js';

export async function readingProject(): Promise<Project> {
  const payload = await nativePackage(); const data = nativeData(payload);
  return createSourceOutline(importPackage(withNativeData(payload, { ...data,
    textPlacements: data.textPlacements.map((value) => value.id === 'title-placement' ? { ...value, endMs: null } : value),
  })), { proposedTextHoldMs: 500 });
}

export function readingPlan(endMs: number): AutomaticSegmentPlan {
  return { schemaVersion: '1.0.0', segmentId: 'SEG-001', summary: '원문 제목의 읽기 시간 계획', mappings: [], placementInformation: [], audioTimings: [],
    textTimings: [{ authority: 'placement', targetId: 'title-placement', startMs: 0, endMs, reason: '원본 시작을 유지한 제목 표시' }],
    shots: [{ ...automaticShot(0, 5000), sourceLinks: ['UNIT-001', '제목'].map((unitId) => ({ unitId, usage: 'primary-visual', startOffsetMs: 0, endOffsetMs: 5000, reason: '화분과 원문 제목의 근거' })) }],
  };
}

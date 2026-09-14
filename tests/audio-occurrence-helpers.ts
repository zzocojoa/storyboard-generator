import type { AutomaticAudioInstructionPlan } from '../src/automation/plan-audio-instructions.js';
import type { Project } from '../src/domain/schema.js';
import { importPackage } from '../src/importers/import-package.js';
import { createSourceOutline } from '../src/proposal/outline.js';
import { audioInstructionFixture } from './audio-instruction-helpers.js';
import { nativeData, withNativeData } from './helpers.js';

export async function occurrenceProject(): Promise<Project> {
  const base = await audioInstructionFixture();
  const payload = { handoff: base.handoff, files: base.sources.map((source) => ({ path: source.path, content: source.content })) };
  const data = nativeData(payload);
  return createSourceOutline(importPackage(withNativeData(payload, { ...data,
    units: data.units.map((unit) => unit.id === '동작' ? { ...unit, text: '물이 흙에 닿는 소리가 들린다.' }
      : unit.id === '효과음' ? { ...unit, kind: 'ACTION' as const, text: '마지막에 컵을 내려놓는 소리가 들린다.' } : unit),
    instructions: data.instructions.map((instruction) => instruction.id === 'ambient-instruction' ? { ...instruction, text: '물 흐르는 소리와 마지막 컵 내려놓는 소리' } : instruction),
  })), { proposedTextHoldMs: 2000 });
}

export function occurrencePlan(): AutomaticAudioInstructionPlan {
  return { schemaVersion: '1.0.0', segmentId: 'demonstration', summary: '물소리와 뒤의 컵 소리를 별도 발생으로 계획한다.', decisions: [
    { instructionId: 'ambient-instruction', resolution: 'required', cueIds: [], informationIds: ['reveal:동작', 'reveal:효과음'],
      sourceEvidence: [{ unitId: '동작', quote: '물이 흙에 닿는 소리가 들린다.' }, { unitId: '효과음', quote: '마지막에 컵을 내려놓는 소리가 들린다.' }],
      reason: '서로 떨어진 소리의 시각과 공개 조건을 나눈다.', occurrences: [
        { cueId: null, source: { kind: 'unit', unitId: '동작', quote: '물이 흙에 닿는 소리' }, informationIds: ['reveal:동작'], reason: '앞의 물소리' },
        { cueId: null, source: { kind: 'unit', unitId: '효과음', quote: '컵을 내려놓는 소리' }, informationIds: ['reveal:효과음'], reason: '뒤의 컵 소리' },
      ] },
    { instructionId: 'music-instruction', resolution: 'none', cueIds: [], informationIds: [], reason: '원문에 음악 없음', occurrences: [] },
  ] };
}

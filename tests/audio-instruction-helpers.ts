import type { Project } from '../src/domain/schema.js';
import { importPackage } from '../src/importers/import-package.js';
import { createSourceOutline } from '../src/proposal/outline.js';
import { automaticPlanProject } from './automatic-plan-helpers.js';
import { nativeData, withNativeData } from './helpers.js';

export async function audioInstructionFixture(): Promise<Project> {
  const project = await automaticPlanProject();
  const payload = { handoff: project.handoff, files: project.sources.map((source) => ({ path: source.path, content: source.content })) };
  const data = nativeData(payload);
  return createSourceOutline(importPackage(withNativeData(payload, { ...data, instructions: [...data.instructions,
    { id: 'ambient-instruction', segmentId: 'demonstration', kind: 'ambience', text: '물 흐르는 소리' },
    { id: 'music-instruction', segmentId: 'demonstration', kind: 'music', text: '배경 음악 없음' },
  ] })), { proposedTextHoldMs: 2000 });
}

export async function audioPlaceholderFixture(): Promise<Project> {
  const project = await audioInstructionFixture();
  const payload = { handoff: project.handoff, files: project.sources.map((source) => ({ path: source.path, content: source.content })) };
  const data = nativeData(payload);
  return createSourceOutline(importPackage(withNativeData(payload, { ...data,
    instructions: data.instructions.map((instruction) => instruction.id === 'ambient-instruction' ? { ...instruction, text: '—' } : instruction),
    units: data.units.map((unit) => unit.id === '동작' ? { ...unit, text: '문을 두드리는 소리가 들린다. 민아가 고개를 든다.' } : unit),
  })), { proposedTextHoldMs: 2000 });
}

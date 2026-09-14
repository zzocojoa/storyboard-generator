import { createSourceRepairBasis } from '../src/automation/repair-basis.js';
import type { SourceRepairPlan } from '../src/automation/repair-basis.js';
import type { Project } from '../src/domain/schema.js';
import { automaticPlanProject } from './automatic-plan-helpers.js';

export async function manualMissingSpeechProject(): Promise<Project> {
  const project: Project = await automaticPlanProject();
  return { ...project, shots: project.shots.map((shot) => shot.segmentId === 'demonstration'
    ? { ...shot, proposalOrigin: 'manual', action: '직접 정한 손과 화분의 구도', camera: { size: 'CU', angle: '사용자 시선', move: '고정' } } : shot) };
}

export function missingSpeechPlan(project: Project, durationMs: number): SourceRepairPlan {
  const basis = createSourceRepairBasis(project, 'demonstration');
  const cue = project.audioCues.find((value): boolean => value.unitId === '안내-1')!;
  return { schemaVersion: '1.1.0', segmentId: 'demonstration', summary: '현재 발화 범위 안에서 음성을 배치하고 수동 연출을 보존한다.',
    links: basis.targets.map((target) => {
      const shot = project.shots.find((value): boolean => value.id === target.shotId)!;
      return { ...target, usage: target.unitId === '동작' ? 'primary-visual' : 'audio-only', startOffsetMs: 0,
        endOffsetMs: target.unitId === '안내-1' ? durationMs : shot.endMs - shot.startMs, reason: '원문 순서와 기존 편집을 보존한 배치.' };
    }),
    audioTimings: [{ cueId: cue.id, startMs: cue.startMs, endMs: cue.startMs + durationMs, timingRelation: cue.timingRelation, reason: '실측 발화를 반복 없이 한 번 배치한다.' }],
  };
}

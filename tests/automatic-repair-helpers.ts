import { createSegmentPlanBasis } from '../src/automation/plan-basis.js';
import { compileAutomaticSegmentPlan } from '../src/automation/plan-compiler.js';
import type { ExistingAudioFile, PlannedAssetWrite } from '../src/automation/plan-audio.js';
import type { SourceRepairPlan } from '../src/automation/repair-basis.js';
import type { Project } from '../src/domain/schema.js';
import { updateAudioCueTiming } from '../src/domain/tracks.js';
import { automaticPlanProject, automaticPlanProvenance, demonstrationPlan, existingPlanAudio, stagedPlanSpeech } from './automatic-plan-helpers.js';

export function manualRepairInput(project: Project): Project {
  const audio = project.audioCues.find((cue): boolean => cue.unitId === '안내-1')!;
  const moved = updateAudioCueTiming(project, audio.id, { startMs: audio.startMs + 1, endMs: audio.endMs + 1, timingRelation: audio.timingRelation });
  const pending = updateAudioCueTiming(moved, audio.id, { startMs: audio.startMs, endMs: audio.endMs, timingRelation: audio.timingRelation });
  return { ...pending, shots: pending.shots.map((shot) => shot.segmentId === 'demonstration' ? {
    ...shot, action: '직접 정한 연출: 작업대 앞에서 물을 준다.', proposalOrigin: 'manual',
    camera: { size: '사용자 구도', angle: '사용자 앵글', move: '사용자 움직임' },
    sourceLinks: shot.sourceLinks.map((link) => link.unitId === '동작' ? { ...link, status: 'mapping-required',
      temporalAnchor: { kind: 'unresolved', basis: 'mapping-change', status: 'review-required' } } : link),
  } : shot) };
}

export function repairPlan(project: Project): SourceRepairPlan {
  const shot = project.shots.find((value): boolean => value.segmentId === 'demonstration')!;
  const original = demonstrationPlan(project).shots[0]!;
  return { schemaVersion: '1.0.0', segmentId: 'demonstration', summary: '사용자 연출과 음원을 보존한 미정 연결 검토.',
    links: ['안내-1', '동작'].map((unitId) => ({ ...original.sourceLinks.find((link): boolean => link.unitId === unitId)!,
      shotId: shot.id, linkIndex: shot.sourceLinks.findIndex((link): boolean => link.unitId === unitId) })) };
}

export async function preparedRepair(): Promise<{ project: Project; files: ExistingAudioFile[]; writes: PlannedAssetWrite[] }> {
  const source = await automaticPlanProject();
  const first = compileAutomaticSegmentPlan(source, createSegmentPlanBasis(source, 'demonstration', ['shot-2']), demonstrationPlan(source), [stagedPlanSpeech(source)], [], automaticPlanProvenance(), 64);
  return { project: manualRepairInput(first.project), files: existingPlanAudio(first.project, first.writes), writes: first.writes };
}

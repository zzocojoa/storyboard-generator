import { storyboardAudioIssues } from '../domain/audio-storyboard.js';
import { audioCuesInSegment } from '../domain/audio-source.js';
import { reviewIssuesForTextCue } from '../domain/emission.js';
import { contractError, issue } from '../domain/errors.js';
import { reviewIssuesForFrame, reviewIssuesForSegment, reviewTransitionInformationIssues } from '../domain/mapping.js';
import type { Issue, Project } from '../domain/schema.js';
import { storyboardUnitOrderIssues as automaticUnitOrderIssues } from '../domain/emission-order.js';
export { storyboardUnitOrderIssues as automaticUnitOrderIssues } from '../domain/emission-order.js';
import { validateProject } from '../domain/validation.js';
import { stableJsonStringify } from '../io/stable-json.js';

export function automaticEmissionIssues(project: Project): Issue[] {
  return [
    ...project.textCues.flatMap((cue): Issue[] => reviewIssuesForTextCue(project, cue.id)),
    ...project.audioCues.flatMap((cue): Issue[] => storyboardAudioIssues(project, cue)),
    ...project.shots.flatMap((shot): Issue[] => reviewTransitionInformationIssues(project, shot)),
  ];
}

export function assertAutomaticCandidate(before: Project, next: Project, segmentId: string): void {
  const selectedIds: Set<string> = new Set([segmentId,
    ...next.shots.filter((shot): boolean => shot.segmentId === segmentId).map((shot): string => shot.id),
    ...next.dataset.units.filter((unit): boolean => unit.segmentId === segmentId).map((unit): string => unit.id),
    ...next.textCues.filter((cue): boolean => cue.segmentId === segmentId).map((cue): string => cue.id),
    ...next.textMappingDecisions.filter((decision): boolean => next.dataset.textPlacements.some((placement): boolean => placement.segmentId === segmentId && placement.id === decision.placementId)).map((decision): string => decision.id),
  ]);
  for (const cue of audioCuesInSegment(next, segmentId)) selectedIds.add(cue.id);
  const structural: Issue[] = validateProject(next, before.dataset);
  const beforeIssues: Set<string> = new Set([...validateProject(before, before.dataset), ...automaticEmissionIssues(before)].map((value): string => stableJsonStringify(value)));
  const relevant: Issue[] = [...structural, ...automaticEmissionIssues(next)].filter((value): boolean => value.severity === 'error' || (value.severity === 'conflict' && (selectedIds.has(value.entityId) || !beforeIssues.has(stableJsonStringify(value)))));
  const linkedIds: Set<string> = new Set(next.shots.filter((shot): boolean => shot.segmentId === segmentId).flatMap((shot): string[] => shot.sourceLinks.map((link): string => link.unitId)));
  const missing: Issue[] = next.dataset.units.filter((unit): boolean => unit.segmentId === segmentId && !linkedIds.has(unit.id)).map((unit): Issue => issue('AUTOMATION_SOURCE_COVERAGE', 'conflict', unit.id, 'sourceLinks', '모든 원문 단위의 컷 연결·용도를 계획해야 합니다.', 'linked source', null, unit.sourceRefs));
  const frames: Issue[] = next.frames.filter((frame): boolean => selectedIds.has(frame.shotId) && next.shots.some((shot): boolean => shot.id === frame.shotId && shot.visualMode === 'sourced')).flatMap((frame): Issue[] => reviewIssuesForFrame(next, frame.id));
  const issues: Issue[] = [...new Map([...relevant, ...missing, ...frames, ...reviewIssuesForSegment(next, segmentId), ...automaticUnitOrderIssues(next, segmentId)].map((value): [string, Issue] => [stableJsonStringify(value), value])).values()];
  if (issues.length > 0) throw contractError('AUTOMATION_CANDIDATE_INVALID', `${segmentId}: 후보 계획을 보정해야 합니다.\n${issues.map((value): string => `${value.code}: ${value.entityId}.${value.field}: ${value.message} ${stableJsonStringify({ expected: value.expected, actual: value.actual })}`).join('\n')}`, issues);
}

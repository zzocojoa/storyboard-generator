import type { Project, Shot, ShotSourceLink, SourceUnit } from '../domain/schema.js';
import { effectiveInformationGate } from '../domain/mapping.js';
import type { EffectiveInformationGate } from '../domain/mapping.js';
import { formatMilliseconds } from '../domain/time.js';
import { parseProject } from '../io/project.js';

/** 스프레드시트가 사용자 원문을 수식으로 실행하지 않도록 위험한 접두사에 작은따옴표를 붙인다. */
export function csvCell(value: string): string {
  const safe: string = /^[\s]*[=+@-]|^[\t\r\n]/u.test(value) ? `'${value}` : value;
  return `"${safe.replaceAll('"', '""')}"`;
}

function shotRow(project: Project, shot: Shot): string[] {
  const segment = project.dataset.segments.find((value): boolean => value.id === shot.segmentId);
  const scene = project.dataset.scenes.find((value): boolean => value.id === segment?.sceneId);
  const units: SourceUnit[] = shot.sourceLinks.flatMap((link: ShotSourceLink): SourceUnit[] => {
    const unit: SourceUnit | undefined = project.dataset.units.find((candidate: SourceUnit): boolean => candidate.id === link.unitId);
    return unit === undefined ? [] : [unit];
  });
  const audio = project.audioCues.filter((cue): boolean => cue.startMs < shot.endMs && cue.endMs > shot.startMs);
  const text = project.textCues.filter((cue): boolean => cue.startMs < shot.endMs && cue.endMs > shot.startMs);
  const gates: EffectiveInformationGate[] = project.dataset.informationRules
    .filter((rule): boolean => rule.segmentId === shot.segmentId)
    .map((rule): EffectiveInformationGate => effectiveInformationGate(project, rule.id));
  return [
    project.projectId, project.title, shot.id, shot.segmentId, segment?.sceneId ?? '', segment?.mode ?? '',
    String(shot.startMs), String(shot.endMs), String(shot.endMs - shot.startMs), formatMilliseconds(shot.startMs), formatMilliseconds(shot.endMs),
    scene?.storyLocationId ?? '', shot.visualLocationId ?? '', shot.action, shot.camera.size, shot.camera.angle, shot.camera.move,
    shot.transitionOut.kind, String(shot.transitionOut.durationMs), shot.transitionOut.note,
    JSON.stringify(shot.presence), JSON.stringify(shot.propIds), JSON.stringify(shot.sourceLinks),
    JSON.stringify(shot.sourceLinks.map((link: ShotSourceLink) => ({ unitId: link.unitId, temporalAnchor: link.temporalAnchor }))),
    JSON.stringify(units.map((unit: SourceUnit) => ({ ...shot.sourceLinks.find((link: ShotSourceLink): boolean => link.unitId === unit.id), id: unit.id, kind: unit.kind, order: unit.order, speakerId: unit.speakerId, text: unit.text, sourceRefs: unit.sourceRefs }))),
    JSON.stringify(gates),
    JSON.stringify(audio), JSON.stringify(text), JSON.stringify(project.frames.filter((frame): boolean => frame.shotId === shot.id)),
    shot.proposalOrigin, shot.approvalStatus, JSON.stringify(shot.lockedFields),
    JSON.stringify(shot.continuityBefore), JSON.stringify(shot.continuityAfter),
  ];
}

export function exportShotCsv(input: Project): string {
  const project: Project = parseProject(input);
  const header: string[] = ['project_id', 'title', 'shot_id', 'segment_id', 'scene_id', 'mode', 'start_ms', 'end_ms', 'duration_ms', 'start_time', 'end_time', 'story_location_id', 'visual_location_id', 'action', 'shot_size', 'camera_angle', 'camera_move', 'transition_kind', 'transition_duration_ms', 'transition_note', 'presence', 'prop_ids', 'source_links', 'source_temporal_anchors', 'source_units', 'information_gates', 'audio_events', 'text_events', 'frames', 'proposal_origin', 'approval_status', 'locked_fields', 'continuity_before', 'continuity_after'];
  return `\uFEFF${[header, ...project.shots.map((shot: Shot): string[] => shotRow(project, shot))].map((row: string[]): string => row.map(csvCell).join(',')).join('\r\n')}\r\n`;
}

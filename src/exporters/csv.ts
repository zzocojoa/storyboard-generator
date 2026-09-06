import { reviewIssuesForTextCue } from '../domain/emission.js';
import { contractError } from '../domain/errors.js';
import { reviewFrameOutput } from '../domain/frame-output.js';
import type { FrameOutputDecision } from '../domain/frame-output.js';
import { reviewAudioPlaybackAt } from '../domain/playback.js';
import type { BlockedCue } from '../domain/playback.js';
import type { Issue, Project, Shot, ShotSourceLink, SourceUnit, StoryboardFrame, TextCue } from '../domain/schema.js';
import { effectiveInformationGate, reviewIssuesForShot } from '../domain/mapping.js';
import type { EffectiveInformationGate } from '../domain/mapping.js';
import { formatMilliseconds, frameDisplayAbsoluteMs, frameEvaluationAbsoluteMs } from '../domain/time.js';
import { parseProject } from '../io/project.js';

/** 스프레드시트가 사용자 원문을 수식으로 실행하지 않도록 위험한 접두사에 작은따옴표를 붙인다. */
export function csvCell(value: string): string {
  const safe: string = /^[\s]*[=+@-]|^[\t\r\n]/u.test(value) ? `'${value}` : value;
  return `"${safe.replaceAll('"', '""')}"`;
}

function shotRow(project: Project, shot: Shot, assetIntegrity: Readonly<Record<string, string>>): string[] {
  const segment = project.dataset.segments.find((value): boolean => value.id === shot.segmentId);
  const scene = project.dataset.scenes.find((value): boolean => value.id === segment?.sceneId);
  const units: SourceUnit[] = shot.sourceLinks.flatMap((link: ShotSourceLink): SourceUnit[] => {
    const unit: SourceUnit | undefined = project.dataset.units.find((candidate: SourceUnit): boolean => candidate.id === link.unitId);
    return unit === undefined ? [] : [unit];
  });
  const audio = project.audioCues.filter((cue): boolean => cue.startMs < shot.endMs && cue.endMs > shot.startMs);
  const text = project.textCues.filter((cue): boolean => cue.startMs < shot.endMs && cue.endMs > shot.startMs);
  const blockedAudio: BlockedCue[] = audio.flatMap((cue): BlockedCue[] => reviewAudioPlaybackAt(project, cue.startMs).blocked.filter((entry: BlockedCue): boolean => entry.cueId === cue.id));
  const blockedText: { cue: TextCue; issues: Issue[] }[] = text.flatMap((cue: TextCue): { cue: TextCue; issues: Issue[] }[] => {
    const issues: Issue[] = reviewIssuesForTextCue(project, cue.id);
    return issues.length === 0 ? [] : [{ cue, issues }];
  });
  const shotIssues: Issue[] = reviewIssuesForShot(project, shot.id);
  const frameDecisions: FrameOutputDecision[] = project.frames.filter((frame: StoryboardFrame): boolean => frame.shotId === shot.id)
    .map((frame: StoryboardFrame): FrameOutputDecision => reviewFrameOutput(project, frame.id, 'csv-export'));
  const blockedCodes: string[] = [...new Set([...shotIssues.map((item: Issue): string => item.code),
    ...blockedAudio.flatMap((entry: BlockedCue): string[] => entry.issues.map((item: Issue): string => item.code)),
    ...blockedText.flatMap((entry): string[] => entry.issues.map((item: Issue): string => item.code)),
    ...frameDecisions.flatMap((decision: FrameOutputDecision): string[] => decision.issues.map((item: Issue): string => item.code))])];
  const frames: StoryboardFrame[] = project.frames.filter((frame: StoryboardFrame): boolean => frame.shotId === shot.id);
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
    JSON.stringify(units.map((unit: SourceUnit) => ({ ...shot.sourceLinks.find((link: ShotSourceLink): boolean => link.unitId === unit.id), id: unit.id, kind: unit.kind, order: unit.order, speakerId: unit.speakerId,
      ...(shotIssues.length === 0 ? { text: unit.text } : {}), sourceRefs: unit.sourceRefs, outputSafety: shotIssues.length === 0 ? 'safe' : 'blocked' }))),
    JSON.stringify(gates), blockedCodes.length === 0 ? 'SAFE' : 'DRAFT · OUTPUT INTERLOCK REVIEW REQUIRED',
    String(blockedAudio.length + blockedText.length), JSON.stringify(blockedCodes),
    JSON.stringify(audio.map((cue) => ({ ...cue, assetMetadata: cue.assetId === null ? null : project.assets.find((asset): boolean => asset.id === cue.assetId) ?? null,
      assetIntegrity: cue.assetId === null ? 'not-attached' : assetIntegrity[cue.assetId] ?? 'not-checked',
      outputSafety: blockedAudio.some((entry: BlockedCue): boolean => entry.cueId === cue.id) ? 'blocked' : 'safe' }))),
    JSON.stringify(text.map((cue: TextCue) => {
      const blocked = blockedText.find((entry): boolean => entry.cue.id === cue.id);
      return blocked === undefined ? { ...cue, outputSafety: 'safe' } : { id: cue.id, authority: cue.authority, mappingDecisionId: cue.mappingDecisionId,
        startMs: cue.startMs, endMs: cue.endMs, outputSafety: 'blocked', issueCodes: blocked.issues.map((item: Issue): string => item.code) };
    })),
    JSON.stringify(frames.map((frame: StoryboardFrame) => {
      const decision: FrameOutputDecision | undefined = frameDecisions.find((candidate: FrameOutputDecision): boolean => candidate.frameId === frame.id);
      if (decision === undefined) throw contractError('FRAME_OUTPUT_DECISION_NOT_FOUND', `${frame.id}: CSV 출력 판정을 찾을 수 없습니다.`, []);
      return { ...frame, historicalImageAssetId: frame.imageAssetId, displayAbsoluteMs: frameDisplayAbsoluteMs(shot, frame), evaluationAbsoluteMs: frameEvaluationAbsoluteMs(shot, frame),
        assetIntegrity: frame.imageAssetId === null ? 'not-attached' : assetIntegrity[frame.imageAssetId] ?? 'not-checked',
        outputSafety: decision.renderBitmap ? 'safe' : 'blocked', renderBitmap: decision.renderBitmap, issueCodes: decision.issues.map((item: Issue): string => item.code) };
    })),
    JSON.stringify(project.textPlacementInformationDecisions.filter((decision): boolean => project.dataset.textPlacements
      .some((placement): boolean => placement.id === decision.placementId && placement.segmentId === shot.segmentId))),
    shot.proposalOrigin, shot.approvalStatus, JSON.stringify(shot.lockedFields),
    JSON.stringify(shot.continuityBefore), JSON.stringify(shot.continuityAfter),
  ];
}

function exportShotCsvWithStatuses(input: Project, assetIntegrity: Readonly<Record<string, string>>): string {
  const project: Project = parseProject(input);
  const header: string[] = ['project_id', 'title', 'shot_id', 'segment_id', 'scene_id', 'mode', 'start_ms', 'end_ms', 'duration_ms', 'start_time', 'end_time', 'story_location_id', 'visual_location_id', 'action', 'shot_size', 'camera_angle', 'camera_move', 'transition_kind', 'transition_duration_ms', 'transition_note', 'presence', 'prop_ids', 'source_links', 'source_temporal_anchors', 'source_units', 'information_gates', 'output_safety_status', 'blocked_cue_count', 'blocked_issue_codes', 'audio_events', 'text_events', 'frames', 'placement_information_decisions', 'proposal_origin', 'approval_status', 'locked_fields', 'continuity_before', 'continuity_after'];
  return `\uFEFF${[header, ...project.shots.map((shot: Shot): string[] => shotRow(project, shot, assetIntegrity))].map((row: string[]): string => row.map(csvCell).join(',')).join('\r\n')}\r\n`;
}

export function exportShotCsv(input: Project): string {
  return exportShotCsvWithStatuses(input, {});
}

export function exportShotCsvWithIntegrity(input: Project, assetIntegrity: Readonly<Record<string, string>>): string {
  return exportShotCsvWithStatuses(input, assetIntegrity);
}

import { z } from 'zod';
import { assertNoErrors, contractError } from './errors.js';
import type { Asset, AudioCue, InformationRule, Project, Shot, ShotSourceLink, SourceUnit, StoryboardFrame, TextCue } from './schema.js';
import { MillisecondsSchema, ProjectSchema } from './schema.js';
import { validateProject } from './validation.js';

export const AudioCueTimingInputSchema = z.strictObject({
  startMs: MillisecondsSchema,
  endMs: MillisecondsSchema,
});
export const TextCueTimingInputSchema = z.strictObject({
  startMs: MillisecondsSchema,
  endMs: MillisecondsSchema,
  kind: z.enum(['overlay', 'prop-text', 'dialogue-subtitle']),
});

export type AudioCueTimingInput = z.infer<typeof AudioCueTimingInputSchema>;
export type TextCueTimingInput = z.infer<typeof TextCueTimingInputSchema>;

function finishTrackEdit(before: Project, input: Project): Project {
  const project: Project = ProjectSchema.parse(input);
  assertNoErrors(validateProject(project, before.dataset), 'INVALID_TRACK_EDIT');
  return project;
}

function requireAudioCue(project: Project, cueId: string): AudioCue {
  const cue: AudioCue | undefined = project.audioCues.find((candidate: AudioCue): boolean => candidate.id === cueId);
  if (cue === undefined) throw contractError('AUDIO_CUE_NOT_FOUND', `오디오 큐를 찾을 수 없습니다: ${cueId}`, []);
  return cue;
}

function requireTextCue(project: Project, cueId: string): TextCue {
  const cue: TextCue | undefined = project.textCues.find((candidate: TextCue): boolean => candidate.id === cueId);
  if (cue === undefined) throw contractError('TEXT_CUE_NOT_FOUND', `글자 큐를 찾을 수 없습니다: ${cueId}`, []);
  return cue;
}

function gateInformationIds(project: Project, cue: AudioCue): Set<string> {
  if (cue.timingStatus !== 'measured' || cue.assetId === null) return new Set<string>();
  const asset: Asset | undefined = project.assets.find((candidate: Asset): boolean => candidate.id === cue.assetId && candidate.kind === 'audio');
  const unit: SourceUnit | undefined = project.dataset.units.find((candidate: SourceUnit): boolean => candidate.id === cue.unitId);
  const segment = unit === undefined ? undefined : project.dataset.segments.find((candidate): boolean => candidate.id === unit.segmentId);
  if (asset === undefined || unit === undefined || segment === undefined || asset.subjectId !== cue.id
    || asset.durationMs !== cue.endMs - cue.startMs || cue.startMs < segment.startMs || cue.endMs > segment.endMs) return new Set<string>();
  return new Set<string>(unit.informationIds.filter((informationId: string): boolean => project.dataset.informationRules.some((rule: InformationRule): boolean => rule.id === informationId && rule.segmentId === unit.segmentId)));
}

function shotUsesGateInformation(project: Project, shot: Shot, informationIds: ReadonlySet<string>): boolean {
  if (shot.informationIds.some((informationId: string): boolean => informationIds.has(informationId))) return true;
  return shot.sourceLinks.some((link: ShotSourceLink): boolean => {
    if (link.usage !== 'primary-visual' && link.usage !== 'continued-visual') return false;
    const unit: SourceUnit | undefined = project.dataset.units.find((candidate: SourceUnit): boolean => candidate.id === link.unitId && candidate.segmentId === shot.segmentId);
    return unit?.informationIds.some((informationId: string): boolean => informationIds.has(informationId)) === true;
  });
}

export function updateAudioCueTiming(project: Project, cueId: string, input: AudioCueTimingInput): Project {
  const timing: AudioCueTimingInput = AudioCueTimingInputSchema.parse(input);
  const current: AudioCue = requireAudioCue(project, cueId);
  if (current.startMs === timing.startMs && current.endMs === timing.endMs) return project;
  const durationChanged: boolean = current.endMs - current.startMs !== timing.endMs - timing.startMs;
  const informationIds: Set<string> = gateInformationIds(project, current);
  const affectedShotIds: Set<string> = new Set<string>();
  const shots: Shot[] = project.shots.map((shot: Shot): Shot => {
    const audioAnchored: boolean = shot.sourceLinks.some((link: ShotSourceLink): boolean => link.unitId === current.unitId && link.temporalAnchor.kind === 'shot-offset' && link.temporalAnchor.basis === 'audio-cue');
    const affected: boolean = audioAnchored || shotUsesGateInformation(project, shot, informationIds);
    if (!affected) return shot;
    affectedShotIds.add(shot.id);
    return { ...shot, approvalStatus: 'proposed', sourceLinks: shot.sourceLinks.map((link: ShotSourceLink): ShotSourceLink => link.unitId === current.unitId && link.temporalAnchor.kind === 'shot-offset' && link.temporalAnchor.basis === 'audio-cue'
      ? { ...link, status: 'mapping-required', temporalAnchor: { kind: 'unresolved', basis: 'audio-change', status: 'review-required' } } : link) };
  });
  return finishTrackEdit(project, { ...project,
    audioCues: project.audioCues.map((cue: AudioCue): AudioCue => cue.id === cueId ? {
      ...cue,
      ...timing,
      assetId: durationChanged ? null : cue.assetId,
      timingStatus: 'proposed',
    } : cue),
    shots,
    frames: project.frames.map((frame: StoryboardFrame): StoryboardFrame => affectedShotIds.has(frame.shotId) ? { ...frame, visualReview: 'pending' } : frame),
  });
}

export function updateTextCueTiming(project: Project, cueId: string, input: TextCueTimingInput): Project {
  const timing: TextCueTimingInput = TextCueTimingInputSchema.parse(input);
  const current: TextCue = requireTextCue(project, cueId);
  if (current.startMs === timing.startMs && current.endMs === timing.endMs && current.kind === timing.kind) return project;
  const timingChanged: boolean = current.startMs !== timing.startMs || current.endMs !== timing.endMs;
  return finishTrackEdit(project, { ...project,
    textCues: project.textCues.map((cue: TextCue): TextCue => cue.id === cueId ? { ...cue, ...timing, timingStatus: timingChanged ? 'proposed' : cue.timingStatus } : cue),
  });
}

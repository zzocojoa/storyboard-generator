import { z } from 'zod';
import { assertNoErrors, contractError } from './errors.js';
import type { AudioCue, Project, Shot, ShotSourceLink, StoryboardFrame, TextCue } from './schema.js';
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

export function updateAudioCueTiming(project: Project, cueId: string, input: AudioCueTimingInput): Project {
  const timing: AudioCueTimingInput = AudioCueTimingInputSchema.parse(input);
  const current: AudioCue = requireAudioCue(project, cueId);
  if (current.startMs === timing.startMs && current.endMs === timing.endMs) return project;
  const durationChanged: boolean = current.endMs - current.startMs !== timing.endMs - timing.startMs;
  const affectedShotIds: Set<string> = new Set<string>();
  const shots: Shot[] = project.shots.map((shot: Shot): Shot => {
    const affected: boolean = shot.sourceLinks.some((link: ShotSourceLink): boolean => link.unitId === current.unitId && link.temporalAnchor.kind === 'shot-offset' && link.temporalAnchor.basis === 'audio-cue');
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

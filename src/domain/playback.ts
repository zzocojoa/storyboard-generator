import { audioTimingIssues } from './audio.js';
import { reviewInformationEmission, reviewIssuesForTextCue, textCueInformationIds } from './emission.js';
import { issue } from './errors.js';
import type { Asset, AudioCue, Issue, Project, Shot, StoryboardFrame, TextCue } from './schema.js';
import { frameEvaluationAbsoluteMs } from './time.js';

export type BlockedCue = {
  cueId: string;
  channel: 'text-overlay' | 'audio-playback';
  informationIds: string[];
  atMs: number;
  issues: Issue[];
};
export type TextPlaybackReview = { playable: TextCue[]; blocked: BlockedCue[] };
export type AudioPlaybackReview = { playable: AudioCue[]; blocked: BlockedCue[] };

export function activeStoryboardShot(project: Project, playheadMs: number): Shot | null {
  const finalShot: Shot | undefined = project.shots.at(-1);
  if (finalShot !== undefined && playheadMs === finalShot.endMs) return finalShot;
  return project.shots.find((shot: Shot): boolean => shot.startMs <= playheadMs && playheadMs < shot.endMs) ?? null;
}

export function activeStoryboardFrame(project: Project, shotId: string, playheadMs: number): StoryboardFrame | null {
  const shot: Shot | undefined = project.shots.find((candidate: Shot): boolean => candidate.id === shotId);
  if (shot === undefined) return null;
  const lastInsideMs: number = Math.max(shot.startMs, shot.endMs - 1);
  const evaluationMs: number = Math.max(shot.startMs, Math.min(lastInsideMs, playheadMs));
  const frames: StoryboardFrame[] = project.frames.filter((frame: StoryboardFrame): boolean => frame.shotId === shotId)
    .sort((left: StoryboardFrame, right: StoryboardFrame): number => {
      const byTime: number = frameEvaluationAbsoluteMs(shot, left) - frameEvaluationAbsoluteMs(shot, right);
      if (byTime !== 0) return byTime;
      return left.role === 'end' ? 1 : right.role === 'end' ? -1 : left.offsetMs - right.offsetMs;
    });
  return frames.filter((frame: StoryboardFrame): boolean => frameEvaluationAbsoluteMs(shot, frame) <= evaluationMs).at(-1) ?? frames[0] ?? null;
}

export function reviewTextPlaybackAt(project: Project, playheadMs: number): TextPlaybackReview {
  const playable: TextCue[] = [];
  const blocked: BlockedCue[] = [];
  for (const cue of project.textCues.filter((candidate: TextCue): boolean => candidate.startMs <= playheadMs && playheadMs < candidate.endMs)) {
    const issues: Issue[] = reviewIssuesForTextCue(project, cue.id);
    if (issues.length === 0) playable.push(cue);
    else blocked.push({ cueId: cue.id, channel: 'text-overlay', informationIds: textCueInformationIds(project, cue), atMs: playheadMs, issues });
  }
  return { playable, blocked };
}

export function playableTextCuesAt(project: Project, playheadMs: number): TextCue[] {
  return reviewTextPlaybackAt(project, playheadMs).playable;
}

function audioAssetIssues(project: Project, cue: AudioCue): Issue[] {
  if (cue.timingStatus !== 'measured') return [issue('AUDIO_NOT_MEASURED', 'conflict', cue.id, 'timingStatus',
    '제안 상태 Audio Cue는 재생할 수 없습니다.', 'measured', cue.timingStatus, [])];
  const asset: Asset | undefined = cue.assetId === null ? undefined
    : project.assets.find((candidate: Asset): boolean => candidate.id === cue.assetId && candidate.kind === 'audio');
  const valid: boolean = asset !== undefined && asset.subjectId === cue.id && asset.durationMs === cue.endMs - cue.startMs;
  return valid ? [] : [issue('AUDIO_ASSET_INVALID', 'conflict', cue.id, 'assetId',
    '측정된 Audio Cue에는 대상과 길이가 일치하는 Audio Asset이 필요합니다.', cue.id,
    cue.assetId ?? 'null', [])];
}

export function reviewAudioPlaybackAt(project: Project, playheadMs: number): AudioPlaybackReview {
  const playable: AudioCue[] = [];
  const blocked: BlockedCue[] = [];
  for (const cue of project.audioCues.filter((candidate: AudioCue): boolean => candidate.startMs <= playheadMs && playheadMs < candidate.endMs)) {
    const unit = project.dataset.units.find((candidate): boolean => candidate.id === cue.unitId);
    const informationIds: string[] = unit?.informationIds ?? [];
    const issues: Issue[] = [
      ...audioAssetIssues(project, cue),
      ...audioTimingIssues(project, cue),
      ...reviewInformationEmission(project, { entityId: cue.id, channel: 'audio-playback', informationIds, atMs: cue.startMs }),
    ];
    if (issues.length === 0) playable.push(cue);
    else blocked.push({ cueId: cue.id, channel: 'audio-playback', informationIds: [...informationIds], atMs: playheadMs, issues });
  }
  return { playable, blocked };
}

export function playableAudioCuesAt(project: Project, playheadMs: number): AudioCue[] {
  return reviewAudioPlaybackAt(project, playheadMs).playable;
}

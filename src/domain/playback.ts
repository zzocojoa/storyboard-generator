import type { Project, StoryboardFrame } from './schema.js';

export function activeStoryboardFrame(project: Project, shotId: string, playheadMs: number): StoryboardFrame | null {
  const shot = project.shots.find((candidate): boolean => candidate.id === shotId);
  if (shot === undefined) return null;
  const frames: StoryboardFrame[] = project.frames.filter((frame: StoryboardFrame): boolean => frame.shotId === shotId)
    .sort((left: StoryboardFrame, right: StoryboardFrame): number => left.offsetMs - right.offsetMs);
  const relativeTime: number = Math.max(0, Math.min(shot.endMs - shot.startMs, playheadMs - shot.startMs));
  return frames.filter((frame: StoryboardFrame): boolean => frame.offsetMs <= relativeTime).at(-1) ?? frames[0] ?? null;
}

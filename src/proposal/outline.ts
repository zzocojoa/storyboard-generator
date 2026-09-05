import { assertNoErrors, contractError } from '../domain/errors.js';
import { ProjectSchema } from '../domain/schema.js';
import type { AudioCue, Project, Segment, Shot, SourceUnit, StoryboardFrame, TextCue, TextPlacement } from '../domain/schema.js';
import { validateProject } from '../domain/validation.js';

export type OutlineSettings = { proposedTextHoldMs: number };

function audioKind(unit: SourceUnit): AudioCue['kind'] | null {
  switch (unit.kind) {
    case 'DIALOGUE': return 'dialogue';
    case 'NARRATION': return 'voiceover';
    case 'PANEL': return 'panel';
    case 'SOUND': return 'sfx';
    case 'MUSIC': return 'music';
    default: return null;
  }
}

function outlineAudio(project: Project, segment: Segment): AudioCue[] {
  const units: SourceUnit[] = project.dataset.units.filter((unit): boolean => unit.segmentId === segment.id && audioKind(unit) !== null);
  const spoken: SourceUnit[] = units.filter((unit): boolean => ['DIALOGUE', 'NARRATION', 'PANEL'].includes(unit.kind));
  return units.map((unit: SourceUnit): AudioCue => {
    const kind: AudioCue['kind'] | null = audioKind(unit);
    if (kind === null) throw contractError('INVALID_AUDIO_UNIT', `${unit.id}: 음성 또는 음향 원문이 필요합니다.`, []);
    const index: number = spoken.findIndex((candidate): boolean => candidate.id === unit.id);
    const duration: number = segment.endMs - segment.startMs;
    const totalWeight: number = spoken.reduce((sum: number, candidate: SourceUnit): number => sum + [...candidate.text].length, 0);
    const beforeWeight: number = spoken.slice(0, index).reduce((sum: number, candidate: SourceUnit): number => sum + [...candidate.text].length, 0);
    const startMs: number = index < 0 ? segment.startMs : segment.startMs + Math.floor(duration * beforeWeight / totalWeight);
    const endMs: number = index < 0 ? segment.endMs : segment.startMs + Math.floor(duration * (beforeWeight + [...unit.text].length) / totalWeight);
    return { id: `audio-${project.dataset.units.indexOf(unit) + 1}`, unitId: unit.id, kind, startMs, endMs, timingStatus: 'proposed', assetId: null };
  });
}

function placementCue(placement: TextPlacement, index: number, project: Project, holdMs: number): TextCue {
  const segment: Segment | undefined = project.dataset.segments.find((value): boolean => value.id === placement.segmentId);
  if (segment === undefined) throw contractError('UNKNOWN_PLACEMENT_SEGMENT', `${placement.id}: 구간이 없습니다.`, []);
  const mapped: SourceUnit | undefined = project.dataset.units.find((unit): boolean => unit.id === placement.unitId);
  const unitId: string | null = mapped?.text === placement.text ? placement.unitId : null;
  return {
    id: `text-placement-${index + 1}`, segmentId: placement.segmentId, unitId, placementId: placement.id,
    text: placement.text, startMs: placement.startMs, endMs: placement.endMs ?? Math.min(segment.endMs, placement.startMs + holdMs),
    kind: 'overlay', timingStatus: placement.endMs === null ? 'proposed' : 'confirmed',
  };
}

function unmappedTextCues(project: Project, placements: readonly TextCue[], holdMs: number): TextCue[] {
  return project.dataset.units.filter((unit): boolean => ['SCREEN_TEXT', 'CHAT', 'NOTE'].includes(unit.kind) && !placements.some((cue): boolean => cue.unitId === unit.id))
    .map((unit: SourceUnit): TextCue => {
      const segment: Segment | undefined = project.dataset.segments.find((value): boolean => value.id === unit.segmentId);
      if (segment === undefined) throw contractError('UNKNOWN_TEXT_SEGMENT', `${unit.id}: 구간이 없습니다.`, []);
      return { id: `text-unit-${project.dataset.units.indexOf(unit) + 1}`, segmentId: unit.segmentId, unitId: unit.id, placementId: null, text: unit.text,
        startMs: segment.startMs, endMs: Math.min(segment.endMs, segment.startMs + holdMs), kind: unit.kind === 'SCREEN_TEXT' ? 'overlay' : 'prop-text', timingStatus: 'proposed' };
    });
}

/** 구간별 수동 편집 뼈대다. 음성 길이는 원문 글자 수로 배분한 미확정 자리이며 낭독 측정값이 아니다. */
export function createSourceOutline(project: Project, settings: OutlineSettings): Project {
  if (!Number.isSafeInteger(settings.proposedTextHoldMs) || settings.proposedTextHoldMs <= 0) throw contractError('INVALID_OUTLINE_SETTINGS', '제안 자막 노출시간을 양의 정수 밀리초로 지정하세요.', []);
  if (project.shots.length > 0 || project.frames.length > 0 || project.audioCues.length > 0 || project.textCues.length > 0) throw contractError('OUTLINE_ALREADY_EXISTS', '기존 편집이 있습니다. 전체 뼈대 생성 대신 구간 편집 또는 부분 제안을 사용하세요.', []);
  const shots: Shot[] = project.dataset.segments.map((segment: Segment, index: number): Shot => {
    const units: SourceUnit[] = project.dataset.units.filter((unit): boolean => unit.segmentId === segment.id);
    return {
      id: `shot-${index + 1}`, segmentId: segment.id, startMs: segment.startMs, endMs: segment.endMs,
      sourceUnitIds: units.map((unit): string => unit.id), visualLocationId: null,
      action: units.filter((unit): boolean => unit.kind === 'ACTION').map((unit): string => unit.text).join('\n'),
      camera: { size: '', angle: '', move: '' }, presence: [], propIds: [], continuityBefore: [], continuityAfter: [], cameraAxis: null, screenDirection: null,
      informationIds: [...new Set(units.flatMap((unit): string[] => unit.informationIds))], proposalOrigin: 'source-outline', approvalStatus: 'proposed', lockedFields: [],
    };
  });
  const frames: StoryboardFrame[] = shots.map((shot: Shot, index: number): StoryboardFrame => ({ id: `frame-${index + 1}`, shotId: shot.id, offsetMs: 0, role: 'start', description: shot.action, imageAssetId: null, visualReview: 'pending' }));
  const placements: TextCue[] = project.dataset.textPlacements.map((placement: TextPlacement, index: number): TextCue => placementCue(placement, index, project, settings.proposedTextHoldMs));
  const result: Project = ProjectSchema.parse({ ...project, shots, frames,
    audioCues: project.dataset.segments.flatMap((segment: Segment): AudioCue[] => outlineAudio(project, segment)),
    textCues: [...placements, ...unmappedTextCues(project, placements, settings.proposedTextHoldMs)],
  });
  assertNoErrors(validateProject(result, project.dataset), 'INVALID_OUTLINE');
  return result;
}

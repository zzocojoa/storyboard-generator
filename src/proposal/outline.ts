import { assertNoErrors, contractError } from '../domain/errors.js';
import { reconcileTextCues } from '../domain/mapping.js';
import { ProjectSchema } from '../domain/schema.js';
import type { AudioCue, Project, Segment, Shot, ShotSourceLink, SourceTemporalAnchor, SourceUnit, StoryboardFrame, TextMappingDecision, TextPlacement } from '../domain/schema.js';
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
    return { id: `audio-${project.dataset.units.indexOf(unit) + 1}`, unitId: unit.id, kind, startMs, endMs,
      timingStatus: 'proposed', timingRelation: 'within-segment', assetId: null };
  });
}

function mappedAnchor(project: Project, segment: Segment, unit: SourceUnit): SourceTemporalAnchor | null {
  const decision: TextMappingDecision | undefined = project.textMappingDecisions.find((candidate: TextMappingDecision): boolean => candidate.canonicalUnitId === unit.id && candidate.status === 'confirmed');
  const placement: TextPlacement | undefined = decision === undefined ? undefined : project.dataset.textPlacements.find((candidate: TextPlacement): boolean => candidate.id === decision.placementId);
  const startMs: number | null = decision?.relation === 'separate-element' ? decision.canonicalStartMs : placement?.startMs ?? null;
  const endMs: number | null = decision?.relation === 'separate-element' ? decision.canonicalEndMs : placement?.endMs ?? null;
  if (startMs === null || startMs < segment.startMs || startMs >= segment.endMs) return null;
  return { kind: 'shot-offset', startOffsetMs: startMs - segment.startMs, endOffsetMs: Math.max(1, Math.min(segment.endMs, endMs ?? startMs + 1) - segment.startMs), basis: 'text-cue', status: 'confirmed' };
}

function nativeAnchor(project: Project, segment: Segment, unit: SourceUnit): SourceTemporalAnchor | null {
  const times: number[] = unit.informationIds.flatMap((id: string): number[] => project.dataset.informationRules
    .filter((rule): boolean => rule.id === id && rule.notBeforeUnitId === unit.id && rule.precision === 'exact-time')
    .map((rule): number => rule.baseNotBeforeMs));
  const startMs: number | undefined = times.sort((left: number, right: number): number => left - right)[0];
  if (startMs === undefined || startMs < segment.startMs || startMs >= segment.endMs) return null;
  return { kind: 'shot-offset', startOffsetMs: startMs - segment.startMs, endOffsetMs: Math.min(segment.endMs - segment.startMs, startMs - segment.startMs + 1), basis: 'native-exact', status: 'confirmed' };
}

function initialSourceLink(project: Project, segment: Segment, unit: SourceUnit, usage: ShotSourceLink['usage']): ShotSourceLink {
  const direct: boolean = usage === 'primary-visual' || usage === 'continued-visual';
  const safeWholeShot: SourceTemporalAnchor | null = direct && unit.informationIds.length === 0
    ? { kind: 'shot-offset', startOffsetMs: 0, endOffsetMs: segment.endMs - segment.startMs, basis: 'proposal', status: 'confirmed' } : null;
  const anchor: SourceTemporalAnchor = mappedAnchor(project, segment, unit) ?? nativeAnchor(project, segment, unit) ?? safeWholeShot
    ?? { kind: 'unresolved', basis: 'estimated', status: 'review-required' };
  return { unitId: unit.id, usage, status: direct && anchor.status === 'review-required' ? 'mapping-required' : 'confirmed', temporalAnchor: anchor };
}

function sourceLinks(project: Project, segment: Segment, units: readonly SourceUnit[]): ShotSourceLink[] {
  const visuallyGrounded: SourceUnit[] = units.filter((unit: SourceUnit): boolean => ['ACTION', 'SCREEN_TEXT', 'CHAT', 'NOTE'].includes(unit.kind));
  const fallbackVisualId: string | null = visuallyGrounded.length === 0
    ? units.find((unit: SourceUnit): boolean => unit.kind !== 'SOUND' && unit.kind !== 'MUSIC')?.id ?? null : null;
  return units.map((unit: SourceUnit): ShotSourceLink => initialSourceLink(project, segment, unit,
    visuallyGrounded.some((candidate: SourceUnit): boolean => candidate.id === unit.id) || fallbackVisualId === unit.id ? 'primary-visual' : 'audio-only'));
}

/** 구간별 수동 편집 뼈대다. 음성 길이는 원문 글자 수로 배분한 미확정 자리이며 낭독 측정값이 아니다. */
export function createSourceOutline(project: Project, settings: OutlineSettings): Project {
  if (!Number.isSafeInteger(settings.proposedTextHoldMs) || settings.proposedTextHoldMs <= 0) throw contractError('INVALID_OUTLINE_SETTINGS', '제안 자막 노출시간을 양의 정수 밀리초로 지정하세요.', []);
  if (project.shots.length > 0 || project.frames.length > 0 || project.audioCues.length > 0 || project.textCues.length > 0) throw contractError('OUTLINE_ALREADY_EXISTS', '기존 편집이 있습니다. 전체 뼈대 생성 대신 구간 편집 또는 부분 제안을 사용하세요.', []);
  const shots: Shot[] = project.dataset.segments.map((segment: Segment, index: number): Shot => {
    const units: SourceUnit[] = project.dataset.units.filter((unit): boolean => unit.segmentId === segment.id);
    return {
      id: `shot-${index + 1}`, segmentId: segment.id, startMs: segment.startMs, endMs: segment.endMs,
      sourceLinks: sourceLinks(project, segment, units), visualLocationId: null,
      action: units.filter((unit): boolean => unit.kind === 'ACTION').map((unit): string => unit.text).join('\n'),
      camera: { size: '', angle: '', move: '' }, presence: [], propIds: [], continuityBefore: [], continuityAfter: [], cameraAxis: null, screenDirection: null,
      informationIds: [], transitionOut: { kind: 'cut', durationMs: 0, note: '' },
      proposalOrigin: 'source-outline', approvalStatus: 'proposed', lockedFields: [],
    };
  });
  const frames: StoryboardFrame[] = shots.map((shot: Shot, index: number): StoryboardFrame => ({ id: `frame-${index + 1}`, shotId: shot.id, offsetMs: 0, role: 'start', description: shot.action, imageAssetId: null, visualReview: 'pending' }));
  const base: Project = { ...project, shots, frames,
    audioCues: project.dataset.segments.flatMap((segment: Segment): AudioCue[] => outlineAudio(project, segment)),
  };
  const result: Project = ProjectSchema.parse({ ...base, textCues: reconcileTextCues(base, project.textMappingDecisions, settings.proposedTextHoldMs) });
  assertNoErrors(validateProject(result, project.dataset), 'INVALID_OUTLINE');
  return result;
}

import { contractError, issue } from './errors.js';
import { directVisualLinks, effectiveInformationGate, sourceAnchorRange } from './mapping.js';
import type { EffectiveInformationGate } from './mapping.js';
import type { Issue, Project, Shot, ShotSourceLink, SourceRef, SourceUnit, StoryboardFrame, TextCue, TextMappingDecision, TextPlacement } from './schema.js';
import { frameEvaluationAbsoluteMs } from './time.js';

export type OutputChannel = 'image' | 'text-overlay' | 'audio-playback' | 'speech-generation' | 'proposal' | 'export';
export type InformationEmissionInput = {
  entityId: string;
  channel: OutputChannel;
  informationIds: string[];
  atMs: number;
};

function uniqueInformationIds(ids: readonly string[]): string[] {
  return [...new Set(ids)];
}

function unitInformationIds(project: Project, unitId: string | null): string[] {
  if (unitId === null) return [];
  return project.dataset.units.find((unit: SourceUnit): boolean => unit.id === unitId)?.informationIds ?? [];
}

export function textCueInformationIds(project: Project, cue: TextCue): string[] {
  if (cue.authority === 'mapping-decision') {
    const decision: TextMappingDecision | undefined = project.textMappingDecisions.find((candidate: TextMappingDecision): boolean => candidate.id === cue.mappingDecisionId);
    return uniqueInformationIds(unitInformationIds(project, decision?.canonicalUnitId ?? null));
  }
  if (cue.authority === 'placement') {
    const decision: TextMappingDecision | undefined = project.textMappingDecisions.find((candidate: TextMappingDecision): boolean =>
      candidate.placementId === cue.placementId && candidate.status === 'confirmed' && candidate.relation !== 'standalone-placement');
    return uniqueInformationIds(unitInformationIds(project, decision?.canonicalUnitId ?? null));
  }
  return uniqueInformationIds(unitInformationIds(project, cue.unitId));
}

function cueAuthorityIssue(code: string, cue: TextCue, message: string, expected: string, actual: string, refs: readonly SourceRef[]): Issue {
  return issue(code, 'conflict', cue.id, 'authority', message, expected, actual, refs);
}

/** Text Cue의 저장 필드가 선언된 단일 시각 권한과 일치하는지 검사한다. */
export function textCueAuthorityIssues(project: Project, cue: TextCue): Issue[] {
  if (cue.authority === 'review-required') {
    return [cueAuthorityIssue('TEXT_CUE_AUTHORITY_REVIEW_REQUIRED', cue, 'Text Cue의 시각 권한을 확정해야 출력할 수 있습니다.',
      'placement|mapping-decision|source-unit', cue.authority, [])];
  }
  if (cue.authority === 'placement') {
    const placement: TextPlacement | undefined = project.dataset.textPlacements.find((candidate: TextPlacement): boolean => candidate.id === cue.placementId);
    if (placement === undefined) return [cueAuthorityIssue('TEXT_CUE_AUTHORITY_MISMATCH', cue, '권한 Placement를 찾을 수 없습니다.', 'existing placement', String(cue.placementId), [])];
    const validEnd: boolean = placement.endMs === null || placement.endMs === cue.endMs;
    return placement.segmentId === cue.segmentId && placement.text === cue.text && placement.startMs === cue.startMs && validEnd
      ? [] : [cueAuthorityIssue('TEXT_CUE_AUTHORITY_MISMATCH', cue, 'Text Cue가 권한 Placement의 문구 또는 시각과 다릅니다.',
        `${placement.startMs}..${placement.endMs ?? 'open'}:${placement.text}`, `${cue.startMs}..${cue.endMs}:${cue.text}`, placement.sourceRefs)];
  }
  if (cue.authority === 'mapping-decision') {
    const decision: TextMappingDecision | undefined = project.textMappingDecisions.find((candidate: TextMappingDecision): boolean => candidate.id === cue.mappingDecisionId);
    const unit: SourceUnit | undefined = decision?.canonicalUnitId === null || decision?.canonicalUnitId === undefined ? undefined
      : project.dataset.units.find((candidate: SourceUnit): boolean => candidate.id === decision.canonicalUnitId);
    const valid: boolean = decision !== undefined && unit !== undefined && decision.status === 'confirmed'
      && decision.renderCanonicalSeparately && decision.canonicalStartMs === cue.startMs && decision.canonicalEndMs === cue.endMs
      && unit.id === cue.unitId && unit.segmentId === cue.segmentId && unit.text === cue.text;
    return valid ? [] : [cueAuthorityIssue('TEXT_CUE_AUTHORITY_MISMATCH', cue,
      'Canonical Text Cue는 확정된 TextMappingDecision의 파생 문구와 시각을 그대로 사용해야 합니다.',
      'confirmed mapping-derived cue', JSON.stringify({ mappingDecisionId: cue.mappingDecisionId, unitId: cue.unitId, startMs: cue.startMs, endMs: cue.endMs }), unit?.sourceRefs ?? [])];
  }
  const unit: SourceUnit | undefined = project.dataset.units.find((candidate: SourceUnit): boolean => candidate.id === cue.unitId);
  const valid: boolean = unit !== undefined && unit.segmentId === cue.segmentId && unit.text === cue.text;
  return valid ? [] : [cueAuthorityIssue('TEXT_CUE_AUTHORITY_MISMATCH', cue, 'Text Cue가 권한 Source Unit의 문구 또는 구간과 다릅니다.',
    'matching source unit', JSON.stringify({ unitId: cue.unitId, segmentId: cue.segmentId, text: cue.text }), unit?.sourceRefs ?? [])];
}

function directShotInformationIds(project: Project, shot: Shot, atMs: number | null): string[] {
  const links: ShotSourceLink[] = directVisualLinks(shot).filter((link: ShotSourceLink): boolean => {
    if (atMs === null) return true;
    const range = sourceAnchorRange(project, shot, link);
    return range !== null && range.startMs <= atMs && atMs < range.endMs;
  });
  return uniqueInformationIds(links.flatMap((link: ShotSourceLink): string[] => unitInformationIds(project, link.unitId)));
}

export function frameInformationIds(project: Project, frameId: string): string[] {
  const frame: StoryboardFrame | undefined = project.frames.find((candidate: StoryboardFrame): boolean => candidate.id === frameId);
  const shot: Shot | undefined = frame === undefined ? undefined : project.shots.find((candidate: Shot): boolean => candidate.id === frame.shotId);
  return frame === undefined || shot === undefined ? [] : directShotInformationIds(project, shot, frameEvaluationAbsoluteMs(shot, frame));
}

function relatedInformationIds(project: Project, input: InformationEmissionInput): string[] | null {
  if (input.channel === 'text-overlay') {
    const cue: TextCue | undefined = project.textCues.find((candidate: TextCue): boolean => candidate.id === input.entityId);
    return cue === undefined ? null : textCueInformationIds(project, cue);
  }
  if (input.channel === 'audio-playback' || input.channel === 'speech-generation') {
    const cue = project.audioCues.find((candidate): boolean => candidate.id === input.entityId);
    return cue === undefined ? null : unitInformationIds(project, cue.unitId);
  }
  if (input.channel === 'image') {
    const frame: StoryboardFrame | undefined = project.frames.find((candidate: StoryboardFrame): boolean => candidate.id === input.entityId);
    const shot: Shot | undefined = frame === undefined
      ? project.shots.find((candidate: Shot): boolean => candidate.id === input.entityId)
      : project.shots.find((candidate: Shot): boolean => candidate.id === frame.shotId);
    if (shot === undefined) return null;
    const evaluationMs: number = frame === undefined ? input.atMs : frameEvaluationAbsoluteMs(shot, frame);
    return directShotInformationIds(project, shot, evaluationMs);
  }
  if (input.channel === 'proposal') {
    const shot: Shot | undefined = project.shots.find((candidate: Shot): boolean => candidate.id === input.entityId);
    return shot === undefined ? null : uniqueInformationIds([...shot.informationIds, ...directShotInformationIds(project, shot, null)]);
  }
  const textCue: TextCue | undefined = project.textCues.find((candidate: TextCue): boolean => candidate.id === input.entityId);
  if (textCue !== undefined) return textCueInformationIds(project, textCue);
  const audioCue = project.audioCues.find((candidate): boolean => candidate.id === input.entityId);
  return audioCue === undefined ? null : unitInformationIds(project, audioCue.unitId);
}

/** 실제 출력 채널이 동일한 Information Gate와 원문 관계를 사용하도록 검사한다. */
export function reviewInformationEmission(project: Project, input: InformationEmissionInput): Issue[] {
  const related: string[] | null = relatedInformationIds(project, input);
  if (related === null) return [issue('UNSAFE_OUTPUT_CHANNEL', 'conflict', input.entityId, 'channel',
    '출력 대상을 프로젝트에서 찾을 수 없습니다.', 'existing output entity', input.channel, [])];
  return uniqueInformationIds(input.informationIds).flatMap((informationId: string): Issue[] => {
    if (!related.includes(informationId)) return [issue('INFORMATION_WITHOUT_OUTPUT_SOURCE', 'conflict', input.entityId, 'informationIds',
      `${informationId}를 방출하는 출력 대상과 원문 Source의 관계가 없습니다.`, 'related source information', informationId, [])];
    const rule = project.dataset.informationRules.find((candidate): boolean => candidate.id === informationId);
    if (rule === undefined) return [issue('UNRESOLVED_INFORMATION_RULE', 'conflict', input.entityId, 'informationIds',
      `${informationId}의 기준 공개 규칙이 없습니다.`, 'authoritative information rule', informationId, [])];
    const gate: EffectiveInformationGate = effectiveInformationGate(project, informationId);
    const gateIssues: Issue[] = gate.reviewRequired ? [issue('INFORMATION_GATE_REVIEW_REQUIRED', 'conflict', input.entityId, 'informationIds',
      `${informationId}의 공개 시점 근거를 검토해야 출력할 수 있습니다.`, String(gate.effectiveNotBeforeMs),
      gate.reviewReasons.join(','), gate.sourceRefs)] : [];
    if (input.atMs < rule.baseNotBeforeMs || input.atMs < gate.effectiveNotBeforeMs) {
      gateIssues.push(issue('EARLY_INFORMATION_EMISSION', 'conflict', input.entityId, 'informationIds',
        `${informationId}는 ${gate.effectiveNotBeforeMs}ms 이후에만 출력할 수 있습니다.`, String(gate.effectiveNotBeforeMs),
        String(input.atMs), gate.sourceRefs));
    }
    return gateIssues;
  });
}

export function assertInformationEmissionAllowed(project: Project, input: InformationEmissionInput): void {
  const issues: Issue[] = reviewInformationEmission(project, input);
  if (issues.length === 0) return;
  throw contractError('INFORMATION_OUTPUT_BLOCKED', issues.map((value: Issue): string => `${value.code}: ${value.message}`).join('\n'), issues);
}

export function reviewIssuesForTextCue(project: Project, cueId: string): Issue[] {
  const cue: TextCue | undefined = project.textCues.find((candidate: TextCue): boolean => candidate.id === cueId);
  if (cue === undefined) return [issue('TEXT_CUE_NOT_FOUND', 'conflict', cueId, 'id', 'Text Cue를 찾을 수 없습니다.', 'existing text cue', cueId, [])];
  return [...textCueAuthorityIssues(project, cue), ...reviewInformationEmission(project, {
    entityId: cue.id, channel: 'text-overlay', informationIds: textCueInformationIds(project, cue), atMs: cue.startMs,
  })];
}

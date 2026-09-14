import { z } from 'zod';
import { contractError, issue } from '../domain/errors.js';
import type { GenerationRecord, Issue, Project, TextCue } from '../domain/schema.js';
import type { TextLayoutPreset } from '../domain/text-layout-settings.js';
import { inspectTextReading } from '../domain/text-readability.js';
import type { TextReadabilityPolicy, TextReadingInspection } from '../domain/text-readability.js';
import { stableJsonStringify } from '../io/stable-json.js';
import { sha256Text } from '../importers/integrity.js';
import { projectTextLayoutAt } from '../rendering/project-text.js';
import type { TextFont } from '../rendering/text-font.js';
import { layoutStoryboardText } from '../rendering/text-layout.js';
import type { TextLayoutProblem } from '../rendering/text-layout.js';
import { textTimingKey } from './plan-text.js';

export type AutomaticTextInspection = {
  cueId: string; timingKey: string | null; startMs: number; endMs: number; timingStatus: TextCue['timingStatus'];
  kind: TextCue['kind']; textSha256: string; graphemes: number; lines: number | null; isolatedProblems: TextLayoutProblem[];
  reading: TextReadingInspection; canMoveStart: boolean; canChangeEnd: boolean; minimumCorrectionMs: number;
};
export type AutomaticTextReview = {
  version: '1.1.0'; segmentId: string; fontSha256: string; preset: TextLayoutPreset; readingPolicy: TextReadabilityPolicy;
  cues: AutomaticTextInspection[]; issues: Issue[]; correctionCueIds: string[];
};

function timingReference(cue: TextCue): string | null {
  return cue.authority === 'review-required' ? null : textTimingKey(cue);
}

function timingPermissions(before: Project, cue: TextCue): { canMoveStart: boolean; canChangeEnd: boolean } {
  if (before.textCues.some((value): boolean => value.id === cue.id && value.timingStatus === 'confirmed')) return { canMoveStart: false, canChangeEnd: false };
  if (cue.authority === 'placement') return { canMoveStart: false, canChangeEnd: before.dataset.textPlacements.some((value): boolean => value.id === cue.placementId && value.endMs === null) };
  const editable: boolean = cue.authority === 'source-unit' || cue.authority === 'mapping-decision' && !before.textMappingDecisions.some((value): boolean => value.id === cue.mappingDecisionId && value.status === 'confirmed');
  return { canMoveStart: editable, canChangeEnd: editable };
}

/** 배치 후보의 모든 글자 경계를 실제 출력 글꼴로 검사한다. 시각 확정은 하지 않는다. */
export function inspectAutomaticText(before: Project, candidate: Project, segmentId: string, font: TextFont): AutomaticTextReview {
  const segment = candidate.dataset.segments.find((value): boolean => value.id === segmentId);
  if (segment === undefined) throw contractError('SEGMENT_NOT_FOUND', `글자 검토 대상 구간이 없습니다: ${segmentId}`, []);
  const cues: TextCue[] = candidate.textCues.filter((cue): boolean => cue.segmentId === segmentId);
  const times: number[] = [...new Set([segment.startMs, ...candidate.textCues.flatMap((cue): number[] => [cue.startMs, cue.endMs])])]
    .filter((atMs): boolean => atMs >= segment.startMs && atMs < segment.endMs).sort((a, b): number => a - b);
  const issues: Map<string, Issue> = new Map();
  for (const atMs of times) for (const problem of projectTextLayoutAt(candidate, atMs, 'draft', font).problems) {
    const cue = cues.find((value): boolean => value.id === problem.cueId);
    if (cue === undefined) continue;
    const key: string = `${problem.code}:${problem.cueId}`;
    if (!issues.has(key)) issues.set(key, issue(problem.code, 'conflict', cue.id, 'textLayout',
      `${problem.message} 표시 시점 ${atMs}ms, 시각 계획 ${timingReference(cue) ?? '미해결'}.`, 'visible non-overlapping text', String(atMs), []));
  }
  const inspections: AutomaticTextInspection[] = cues.map((cue): AutomaticTextInspection => {
    const isolated = layoutStoryboardText([cue], candidate.profile.aspectWidth, candidate.profile.aspectHeight, candidate.textLayout, font.metrics);
    const reading = inspectTextReading(cue, candidate.textReadability);
    const permissions = timingPermissions(before, cue);
    for (const problem of reading.problems) if (cue.timingStatus !== 'confirmed') issues.set(`${problem.code}:${cue.id}`, problem);
    return { cueId: cue.id, timingKey: timingReference(cue), startMs: cue.startMs, endMs: cue.endMs, timingStatus: cue.timingStatus,
      kind: cue.kind, textSha256: sha256Text(cue.text),
      graphemes: [...new Intl.Segmenter('ko', { granularity: 'grapheme' }).segment(cue.text)].length,
      lines: isolated.boxes[0]?.lines.length ?? null, isolatedProblems: isolated.problems, reading, ...permissions,
      minimumCorrectionMs: Math.max(reading.requiredMs, Math.min(reading.actualMs, reading.maxHoldMs)) };
  });
  const problemIds: Set<string> = new Set([...issues.values()].map((value): string => value.entityId));
  const correctionCueIds: string[] = inspections.filter((value): boolean => {
    if (!problemIds.has(value.cueId) || !value.canChangeEnd) return false;
    if (value.reading.requiredMs > Math.min(value.reading.maxHoldMs, segment.endMs - (value.canMoveStart ? segment.startMs : value.startMs))) return false;
    return value.reading.problems.length > 0 || value.isolatedProblems.length === 0 && value.canMoveStart;
  }).map((value): string => value.cueId);
  return { version: '1.1.0', segmentId, fontSha256: font.sha256, preset: structuredClone(candidate.textLayout), readingPolicy: structuredClone(candidate.textReadability), cues: inspections, issues: [...issues.values()], correctionCueIds };
}

/** 보정 대상·원문·고정 시각을 지키고 설정된 읽기 시간보다 짧게 통과시키지 않는다. */
export function assertTextReviewDuration(candidate: Project, review: AutomaticTextReview): void {
  if (candidate.textCues.filter((cue): boolean => cue.segmentId === review.segmentId).length !== review.cues.length) throw contractError('AUTOMATION_TEXT_CONTENT_CHANGED', '글자 겹침 보정에서 본문 항목을 추가하거나 제거할 수 없습니다.', []);
  for (const previous of review.cues) {
    const cue = candidate.textCues.find((value): boolean => value.id === previous.cueId);
    if (cue === undefined || cue.kind !== previous.kind || timingReference(cue) !== previous.timingKey || sha256Text(cue.text) !== previous.textSha256) throw contractError('AUTOMATION_TEXT_CONTENT_CHANGED', `${previous.cueId}: 겹침 보정은 본문·종류·권한을 보존해야 합니다.`, []);
    if (!review.correctionCueIds.includes(cue.id) && (cue.startMs !== previous.startMs || cue.endMs !== previous.endMs)) throw contractError('AUTOMATION_TEXT_CORRECTION_SCOPE',
      `${previous.timingKey ?? previous.cueId}: 보정 대상이 아닌 글자의 표시 시각은 유지해야 합니다.`, []);
    if ((!previous.canMoveStart && cue.startMs !== previous.startMs) || (!previous.canChangeEnd && cue.endMs !== previous.endMs)) throw contractError('AUTOMATION_TEXT_CORRECTION_SCOPE',
      `${previous.timingKey ?? previous.cueId}: 원본 또는 사용자 검토에서 고정한 시작·종료 시각은 유지해야 합니다.`, []);
    const preservedMs: number = Math.min(previous.reading.actualMs, previous.minimumCorrectionMs);
    if (review.correctionCueIds.includes(cue.id) && cue.endMs - cue.startMs < preservedMs) throw contractError('AUTOMATION_TEXT_DURATION_REDUCED',
      `${previous.timingKey ?? previous.cueId}: 보정에서 표시 길이를 ${preservedMs}ms보다 줄일 수 없습니다. 초안 읽기 기준과 이전 표시 길이를 검토하세요.`, []);
  }
}

/** 이번 후보의 신규 생성 기록에만 글꼴·설정·잔여 검토를 결속하고 과거 기록은 보존한다. */
export function recordAutomaticTextReview(before: Project, candidate: Project, generationId: string, review: AutomaticTextReview): Project {
  if (before.generationRecords.some((record): boolean => record.id === generationId)) throw contractError('AUTOMATION_DUPLICATE_GENERATION', `과거 생성 기록에 글자 검토를 추가할 수 없습니다: ${generationId}`, []);
  const record: GenerationRecord | undefined = candidate.generationRecords.find((value): boolean => value.id === generationId);
  if (record === undefined) throw contractError('AUTOMATION_TEXT_RECORD_MISSING', `글자 검토를 연결할 신규 생성 기록이 없습니다: ${generationId}`, []);
  const envelope = z.record(z.string(), z.json()).parse(JSON.parse(record.prompt));
  const output: GenerationRecord = { ...record, prompt: stableJsonStringify({ ...envelope, textReview: review }),
    referenceHashes: [...new Set([...record.referenceHashes, review.fontSha256])] };
  return { ...candidate, generationRecords: candidate.generationRecords.map((value): GenerationRecord => value.id === generationId ? output : value) };
}

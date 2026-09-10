import { contractError } from '../domain/errors.js';
import { ProfileSchema, TimebaseSchema } from '../domain/schema.js';
import type { Profile, Timebase } from '../domain/schema.js';
import { validateTimebase } from '../domain/time.js';
import { inspectDocuments } from './compile.js';
import { DOCUMENT_FILES } from './schema.js';
import type { DocumentBindings, DocumentPreview, DocumentSettings, DocumentSources, MappingChoice } from './schema.js';
import { DocumentReviewResultSchema, ProductionFieldSchema } from './review-model.js';
import type { DocumentReviewResult, ProductionFields, ReviewAudit, ReviewEvidence, ReviewSuggestion } from './review-model.js';

export const REVIEW_GROUPS = ['people', 'scenes', 'units'] as const;
export const SUPPORTED_REVIEW_FPS: readonly string[] = ['24/1', '25/1', '30/1', '30000/1001', '60/1'];
export const SUPPORTED_REVIEW_SAMPLE_RATES: readonly string[] = ['44100', '48000', '96000'];

export function productionSettings(fields: ProductionFields): { timebase: Timebase; profile: Profile } {
  for (const key of ['width', 'height'] as const) {
    if (!/^[1-9]\d*$/u.test(fields[key]) || Number(fields[key]) > 16384) throw contractError('INVALID_DOCUMENT_REVIEW_SETTINGS', `${key}: 화면비는 1~16384 정수로 입력하세요.`, []);
  }
  if (!SUPPORTED_REVIEW_FPS.includes(fields.fps) || !SUPPORTED_REVIEW_SAMPLE_RATES.includes(fields.sampleRate)) {
    throw contractError('INVALID_DOCUMENT_REVIEW_SETTINGS', '지원하는 프레임레이트와 음성 샘플레이트를 선택하세요.', []);
  }
  const [numerator, denominator] = fields.fps.split('/').map(Number);
  const timebase: Timebase = TimebaseSchema.parse({ fpsNumerator: numerator, fpsDenominator: denominator, sampleRate: Number(fields.sampleRate), startTimecode: fields.startTimecode, dropFrame: false });
  const profile: Profile = ProfileSchema.parse({ medium: 'unspecified', aspectWidth: Number(fields.width), aspectHeight: Number(fields.height), visualStyle: null });
  if (validateTimebase(timebase).length > 0) throw contractError('INVALID_DOCUMENT_REVIEW_SETTINGS', '시작 타임코드와 프레임레이트가 맞지 않습니다.', []);
  return { timebase, profile };
}

export function settingsProductionFields(settings: Pick<DocumentSettings, 'timebase' | 'profile'>): ProductionFields {
  return { fps: `${settings.timebase.fpsNumerator}/${settings.timebase.fpsDenominator}`, sampleRate: String(settings.timebase.sampleRate),
    width: String(settings.profile.aspectWidth), height: String(settings.profile.aspectHeight), startTimecode: settings.timebase.startTimecode };
}

/** 인용문이 지정된 원본 행 또는 JSON 포인터의 실제 내용인지 확인한다. */
export function validateReviewEvidence(sources: DocumentSources, evidence: readonly ReviewEvidence[]): void {
  for (const entry of evidence) {
    const file = DOCUMENT_FILES.find((candidate): boolean => sources[candidate.key].id === entry.fileId);
    if (file === undefined) throw contractError('INVALID_DOCUMENT_REVIEW_EVIDENCE', `${entry.fileId}: 선택한 8개 문서에 없는 출처입니다.`, []);
    const content: string = sources[file.key].content;
    let excerpt: string | undefined;
    const line: RegExpExecArray | null = /^line:([1-9]\d*)$/u.exec(entry.locator);
    if (line !== null) excerpt = content.split(/\r?\n/u)[Number(line[1]) - 1];
    else if (file.key === 'manifest' && entry.locator.startsWith('/')) {
      let value: unknown = JSON.parse(content) as unknown;
      for (const token of entry.locator.slice(1).split('/').map((part: string): string => part.replace(/~1/gu, '/').replace(/~0/gu, '~'))) {
        if (typeof value !== 'object' || value === null || !Object.hasOwn(value, token)) { value = undefined; break; }
        value = (value as Record<string, unknown>)[token];
      }
      excerpt = typeof value === 'string' ? value : JSON.stringify(value);
    }
    if (excerpt === undefined || !excerpt.includes(entry.quote)) throw contractError('INVALID_DOCUMENT_REVIEW_EVIDENCE', `${entry.fileId}:${entry.locator}: 인용문이 실제 원문과 일치하지 않습니다.`, []);
  }
}

export function reviewTargetKey(entry: Pick<ReviewSuggestion, 'field' | 'key'>): string { return JSON.stringify([entry.field, entry.key]); }

/** 모델의 확신 대신 현재 후보·실제 출처·기존 자동 연결로 결과를 검증한다. */
export function validateDocumentReviewResult(sources: DocumentSources, bindings: DocumentBindings, fields: ProductionFields, input: unknown): DocumentReviewResult {
  const result: DocumentReviewResult = DocumentReviewResultSchema.parse(input);
  const initial: DocumentPreview = inspectDocuments(sources, bindings).preview;
  const automatic: DocumentPreview = inspectDocuments(sources, { people: [], scenes: [], units: [] }).preview;
  const seen: Set<string> = new Set<string>();
  const proposed: DocumentBindings = structuredClone(bindings);
  const production: ProductionFields = { ...fields };
  for (const suggestion of result.suggestions) {
    const target: string = reviewTargetKey(suggestion);
    if (seen.has(target)) throw contractError('INVALID_DOCUMENT_REVIEW_RESULT', `${target}: 결과 항목이 중복되었습니다.`, []);
    seen.add(target); validateReviewEvidence(sources, suggestion.evidence);
    if ((suggestion.value === null) !== (suggestion.origin === 'unresolved')) throw contractError('INVALID_DOCUMENT_REVIEW_RESULT', `${target}: 미해결 상태와 값이 일치하지 않습니다.`, []);
    if (suggestion.field === 'production') {
      const key = ProductionFieldSchema.parse(suggestion.key);
      if (!['recommendation', 'unresolved'].includes(suggestion.origin)) throw contractError('INVALID_DOCUMENT_REVIEW_RESULT', `${key}: 제작 추천을 문서 사실로 확정할 수 없습니다.`, []);
      if (fields[key] !== '' && suggestion.value !== fields[key]) throw contractError('INVALID_DOCUMENT_REVIEW_RESULT', `${key}: 입력된 제작 설정을 변경하는 결과입니다.`, []);
      if (suggestion.value !== null) production[key] = suggestion.value;
      continue;
    }
    const choice: MappingChoice | undefined = initial[suggestion.field].find((item: MappingChoice): boolean => item.key === suggestion.key);
    if (choice === undefined || suggestion.origin === 'recommendation') throw contractError('INVALID_DOCUMENT_REVIEW_RESULT', `${target}: 연결 대상 또는 출처 유형이 잘못됐습니다.`, []);
    if (suggestion.value === null) continue;
    if (!choice.candidates.includes(suggestion.value)) throw contractError('INVALID_DOCUMENT_REVIEW_RESULT', `${target}: 후보에 없는 ID ${suggestion.value}입니다.`, []);
    if (choice.selected !== null && choice.selected !== suggestion.value) throw contractError('INVALID_DOCUMENT_REVIEW_RESULT', `${target}: 이미 지정한 연결을 바꾸는 결과입니다.`, []);
    if (suggestion.evidence.length === 0) throw contractError('INVALID_DOCUMENT_REVIEW_EVIDENCE', `${target}: 연결 제안에 원문 근거가 필요합니다.`, []);
    if (suggestion.origin === 'document' && automatic[suggestion.field].find((item: MappingChoice): boolean => item.key === suggestion.key)?.selected !== suggestion.value) {
      throw contractError('INVALID_DOCUMENT_REVIEW_RESULT', `${target}: 파서로 증명되지 않은 연결은 추론으로 표시해야 합니다.`, []);
    }
    proposed[suggestion.field] = [...proposed[suggestion.field].filter((item): boolean => item.key !== suggestion.key), { key: suggestion.key, targetId: suggestion.value }];
  }
  for (const field of REVIEW_GROUPS) for (const choice of initial[field]) {
    if (choice.selected === null && !seen.has(reviewTargetKey({ field, key: choice.key }))) throw contractError('INVALID_DOCUMENT_REVIEW_RESULT', `${choice.key}: 검토 결과가 누락되었습니다. 미해결 사유라도 반환해야 합니다.`, []);
  }
  for (const key of ProductionFieldSchema.options) if (fields[key] === '' && !seen.has(reviewTargetKey({ field: 'production', key }))) {
    throw contractError('INVALID_DOCUMENT_REVIEW_RESULT', `${key}: 제작 설정 검토가 누락되었습니다.`, []);
  }
  const next: DocumentPreview = inspectDocuments(sources, proposed).preview;
  for (const field of ['people', 'scenes'] as const) {
    const selected: string[] = next[field].flatMap((choice: MappingChoice): string[] => choice.selected === null ? [] : [choice.selected]);
    if (new Set(selected).size !== selected.length) throw contractError('INVALID_DOCUMENT_REVIEW_RESULT', `${field}: 동일 ID를 중복 배정했습니다.`, []);
  }
  if (Object.values(production).every((value: string): boolean => value !== '')) productionSettings(production);
  else for (const key of ProductionFieldSchema.options) {
    const value: string = production[key];
    if (value === '') continue;
    if ((key === 'fps' && !SUPPORTED_REVIEW_FPS.includes(value)) || (key === 'sampleRate' && !SUPPORTED_REVIEW_SAMPLE_RATES.includes(value))
      || (['width', 'height'].includes(key) && (!/^[1-9]\d*$/u.test(value) || Number(value) > 16384)) || (key === 'startTimecode' && !/^\d{2}:[0-5]\d:[0-5]\d:\d{2}$/u.test(value))) {
      throw contractError('INVALID_DOCUMENT_REVIEW_SETTINGS', `${key}: 올바르지 않은 추천값 ${value}입니다.`, []);
    }
  }
  return result;
}

export function validateReviewAudit(sources: DocumentSources, settings: DocumentSettings, audit: ReviewAudit): void {
  const preview: DocumentPreview = inspectDocuments(sources, settings.bindings).preview;
  const automatic: DocumentPreview = inspectDocuments(sources, { people: [], scenes: [], units: [] }).preview;
  if (audit.sourceFingerprint !== preview.sourceFingerprint) throw contractError('INVALID_DOCUMENT_REVIEW_AUDIT', '검토 기록의 원본 fingerprint가 다릅니다.', []);
  const fields: ProductionFields = settingsProductionFields(settings);
  const expected: Map<string, string | null> = new Map([
    ...REVIEW_GROUPS.flatMap((field) => preview[field].map((choice: MappingChoice): [string, string | null] => [reviewTargetKey({ field, key: choice.key }), choice.selected])),
    ...ProductionFieldSchema.options.map((key): [string, string] => [reviewTargetKey({ field: 'production', key }), fields[key]]),
  ]);
  const seen: Set<string> = new Set<string>();
  for (const entry of audit.entries) {
    const key: string = reviewTargetKey(entry);
    if (seen.has(key) || expected.get(key) !== entry.value || !entry.confirmed) throw contractError('INVALID_DOCUMENT_REVIEW_AUDIT', `${key}: 최종 값·중복·확인 상태를 검토하세요.`, []);
    seen.add(key); validateReviewEvidence(sources, entry.evidence);
    if (['inference', 'recommendation'].includes(entry.origin) && (entry.reviewId === null || entry.model === null)) throw contractError('INVALID_DOCUMENT_REVIEW_AUDIT', `${key}: Codex 요청과 모델이 필요합니다.`, []);
    if (entry.origin === 'inference' && (entry.field === 'production' || entry.evidence.length === 0)) throw contractError('INVALID_DOCUMENT_REVIEW_AUDIT', `${key}: 연결 추론의 문서 근거가 필요합니다.`, []);
    if (entry.origin === 'recommendation' && entry.field !== 'production') throw contractError('INVALID_DOCUMENT_REVIEW_AUDIT', `${key}: 추천은 제작 설정에만 허용됩니다.`, []);
    if (entry.origin === 'document' && (entry.field === 'production' || automatic[entry.field].find((choice: MappingChoice): boolean => choice.key === entry.key)?.selected !== entry.value)) throw contractError('INVALID_DOCUMENT_REVIEW_AUDIT', `${key}: 자동 연결로 증명되지 않은 값입니다.`, []);
    if (entry.origin === 'preset' && (entry.field !== 'production' || audit.preset?.fields[ProductionFieldSchema.parse(entry.key)] !== entry.value)) throw contractError('INVALID_DOCUMENT_REVIEW_AUDIT', `${key}: 선택한 프리셋과 값이 다릅니다.`, []);
  }
  if (seen.size !== expected.size) throw contractError('INVALID_DOCUMENT_REVIEW_AUDIT', '일부 입력값의 출처 기록이 누락되었습니다.', []);
}

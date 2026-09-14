import type { DocumentBindings, DocumentPreview, MappingChoice } from '../../src/documents/schema.js';
import { ProductionFieldSchema } from '../../src/documents/review-model.js';
import type { ProductionFields, ProductionPreset, ReviewAudit, ReviewAuditEntry, ReviewState, ReviewSuggestion } from '../../src/documents/review-model.js';
import { choiceValue, MAPPING_GROUPS, reviewProductionFields } from './document-import-state.js';

export type ReviewDraft = { bindings: DocumentBindings; production: ProductionFields; entries: ReviewAuditEntry[] };

export function reviewEntryKey(entry: Pick<ReviewSuggestion, 'field' | 'key'>): string { return JSON.stringify([entry.field, entry.key]); }

export function documentBindingsEqual(left: DocumentBindings, right: DocumentBindings): boolean {
  return MAPPING_GROUPS.every(({ field }): boolean => left[field].length === right[field].length
    && left[field].every((entry): boolean => right[field].some((other): boolean => other.key === entry.key && other.targetId === entry.targetId)));
}

/** 검토 이후 사용자가 만진 필드는 값이 되돌아왔더라도 자동 입력하지 않는다. */
export function mergeDocumentReview(current: ReviewDraft, review: ReviewState, editedKeys: ReadonlySet<string>): ReviewDraft {
  if (review.status !== 'completed' || review.result === null || review.model === null) throw new Error('완료된 Codex 검토 결과가 필요합니다.');
  let next: ReviewDraft = structuredClone(current);
  for (const suggestion of review.result.suggestions) {
    const key: string = reviewEntryKey(suggestion);
    if (suggestion.value === null || suggestion.origin === 'unresolved' || editedKeys.has(key)) continue;
    const previous: ReviewAuditEntry | undefined = current.entries.find((entry: ReviewAuditEntry): boolean => reviewEntryKey(entry) === key);
    const value: string = suggestion.field === 'production' ? current.production[ProductionFieldSchema.parse(suggestion.key)]
      : current.bindings[suggestion.field].find((entry): boolean => entry.key === suggestion.key)?.targetId ?? '';
    if (value !== '' && (previous === undefined || previous.value !== value || !['inference', 'recommendation'].includes(previous.origin) || previous.confirmed)) continue;
    const entry: ReviewAuditEntry = { ...suggestion, value: suggestion.value, origin: suggestion.origin, reviewId: review.id, model: review.model, confirmed: suggestion.origin === 'document' };
    next = { ...next, entries: [...next.entries.filter((item: ReviewAuditEntry): boolean => reviewEntryKey(item) !== key), entry] };
    if (suggestion.field === 'production') next = { ...next, production: { ...next.production, [suggestion.key]: suggestion.value } };
    else next = { ...next, bindings: { ...next.bindings, [suggestion.field]: [...next.bindings[suggestion.field].filter((item): boolean => item.key !== suggestion.key), { key: suggestion.key, targetId: suggestion.value }] } };
  }
  if (Object.values(next.production).every((value: string): boolean => value !== '') && !reviewProductionFields(next.production).valid) throw new Error('현재 제작 설정과 Codex 추천값이 맞지 않습니다. 현재 값으로 다시 검토하세요.');
  return next;
}

export function applyDocumentPreset(current: ReviewDraft, preset: ProductionPreset): ReviewDraft {
  const entries: ReviewAuditEntry[] = ProductionFieldSchema.options.map((key): ReviewAuditEntry => ({ field: 'production', key, value: preset.fields[key], origin: 'preset',
    reason: `사용자가 선택한 제작 프리셋: ${preset.name}`, evidence: [], confirmed: true, reviewId: null, model: null }));
  return { bindings: current.bindings, production: { ...preset.fields }, entries: [...current.entries.filter((entry: ReviewAuditEntry): boolean => entry.field !== 'production'), ...entries] };
}

export function buildDocumentReviewAudit(preview: DocumentPreview, automatic: DocumentPreview, draft: ReviewDraft, preset: ProductionPreset | null): ReviewAudit {
  const values: { field: ReviewAuditEntry['field']; key: string; value: string; automatic: boolean }[] = [
    ...MAPPING_GROUPS.flatMap(({ field }) => preview[field].map((choice: MappingChoice) => ({ field, key: choice.key, value: choiceValue(choice, draft.bindings[field]),
      automatic: !draft.bindings[field].some((item): boolean => item.key === choice.key) && automatic[field].find((item: MappingChoice): boolean => item.key === choice.key)?.selected === choiceValue(choice, draft.bindings[field]) }))),
    ...ProductionFieldSchema.options.map((key) => ({ field: 'production' as const, key, value: draft.production[key], automatic: false })),
  ];
  return { sourceFingerprint: preview.sourceFingerprint, preset, entries: values.map((item): ReviewAuditEntry => {
    const saved: ReviewAuditEntry | undefined = draft.entries.find((entry: ReviewAuditEntry): boolean => reviewEntryKey(entry) === reviewEntryKey(item) && entry.value === item.value);
    return saved ?? { field: item.field, key: item.key, value: item.value, origin: item.automatic ? 'document' : 'user',
      reason: item.automatic ? '문서의 유일한 원문 연결을 파서로 확인했습니다.' : '사용자가 입력·선택한 값입니다.', evidence: [], confirmed: true, reviewId: null, model: null };
  }) };
}

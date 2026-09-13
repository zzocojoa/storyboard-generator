import { choiceValue, mappingInputId, mappingProblems } from './document-import-state.js';
import type { FieldProblem } from './document-import-state.js';
import type { DocumentBindings, DocumentPreview, MappingChoice } from '../../src/documents/schema.js';
import type { IdentityMatch } from '../../src/documents/identity-schema.js';
import type { ReviewAuditEntry } from '../../src/documents/review-model.js';
import type { ReviewDraft } from './document-review-state.js';

/** 검증 시점의 현재 연결과 일치하는 빈칸만 채우고 기존 결정과 제작 설정은 보존한다. */
export function applyIdentityMatches(draft: ReviewDraft, matches: readonly IdentityMatch[]): ReviewDraft {
  const additions: IdentityMatch[] = matches.filter((match: IdentityMatch): boolean => match.currentId === null);
  for (const match of matches) {
    const current: string = draft.bindings.people.find((item): boolean => item.key === match.name)?.targetId ?? '';
    if (current !== '' && current !== match.targetId) throw new Error(`${match.name}: 근거 검토 이후 연결이 바뀌었습니다. 다시 검증하세요.`);
  }
  const entries: ReviewAuditEntry[] = additions.map((match: IdentityMatch): ReviewAuditEntry => ({ field: 'people', key: match.name, value: match.targetId,
    origin: 'identity-document', reason: '현재 manifest와 해시로 연결된 인물 원본의 명시적 이름·ID 대응을 확인했습니다.',
    evidence: [{ fileId: 'identity-characters', locator: match.locator, quote: JSON.stringify({ name: match.name, character_id: match.targetId }) }],
    confirmed: true, reviewId: null, model: null }));
  return { ...draft, bindings: { ...draft.bindings, people: [...draft.bindings.people.filter((item): boolean => !additions.some((match): boolean => match.name === item.key)),
    ...additions.map((match): { key: string; targetId: string } => ({ key: match.name, targetId: match.targetId }))] },
    entries: [...draft.entries.filter((entry: ReviewAuditEntry): boolean => !entries.some((next: ReviewAuditEntry): boolean => entry.field === next.field && entry.key === next.key)), ...entries] };
}

export type PersonConnection = { name: string; value: string; status: 'connected' | 'pending' | 'unresolved' | 'invalid'; reason: string; origin: ReviewAuditEntry['origin'] };

/** 현재 선택과 공통 연결 검증에서 결론을 계산하며 미확정 추론이나 중복 ID를 완료로 표시하지 않는다. */
export function personConnections(preview: DocumentPreview, bindings: DocumentBindings, entries: readonly ReviewAuditEntry[]): PersonConnection[] {
  const problems: FieldProblem[] = mappingProblems(preview, bindings);
  return preview.people.map((choice: MappingChoice): PersonConnection => {
    const value: string = choiceValue(choice, bindings.people);
    const entry: ReviewAuditEntry | undefined = entries.find((item: ReviewAuditEntry): boolean => item.field === 'people' && item.key === choice.key && item.value === value);
    const problem: FieldProblem | undefined = problems.find((item: FieldProblem): boolean => item.id === mappingInputId('people', choice.key));
    if (value === '') return { origin: entry?.origin ?? 'document', name: choice.key, value, status: 'unresolved', reason: '연결 필요 · 이름과 ID의 대응이 아직 확인되지 않았습니다.' };
    if (problem !== undefined) return { origin: entry?.origin ?? 'document', name: choice.key, value, status: 'invalid', reason: problem.message };
    if (entry !== undefined && !entry.confirmed) return { origin: entry?.origin ?? 'document', name: choice.key, value, status: 'pending', reason: entry.reason };
    return { origin: entry?.origin ?? 'document', name: choice.key, value, status: 'connected', reason: entry?.reason ?? '문서에서 대응 정보를 확인했습니다.' };
  });
}

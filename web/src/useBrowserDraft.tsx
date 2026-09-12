import { useEffect, useRef, useState } from 'react';
import type { ReactElement } from 'react';
import type { z } from 'zod';
import { activeBrowserDrafts, draftPrefix, draftReference, readBrowserDrafts, writeBrowserDraft } from './browser-drafts.js';
import type { BrowserDraft, DraftReference } from './browser-drafts.js';

type DraftState<T> = {
  scope: string; id: string; sequence: number; basis: string; value: T; replaces: DraftReference[];
  candidates: BrowserDraft[]; error: string | null; restored: boolean;
};
export type BrowserDraftControl<T> = {
  value: T; setValue: (value: T | ((previous: T) => T)) => boolean; blocked: boolean; dirty: boolean;
  notice: ReactElement | null;
};

function errorText(error: unknown): string { return error instanceof Error ? error.message : String(error); }

function initialState<T>(scope: string, basis: string, baseline: T, schema: z.ZodType<T>): DraftState<T> {
  const state: DraftState<T> = { scope, id: crypto.randomUUID(), sequence: 0, basis, value: baseline, replaces: [], candidates: [], error: null, restored: false };
  try {
    const candidates: BrowserDraft[] = activeBrowserDrafts(readBrowserDrafts(window.localStorage, scope));
    // 저장된 잘못된 입력도 자동 삭제하지 않는다. 타입을 확인할 수 있을 때만 폼에 복원한다.
    for (const candidate of candidates) {
      schema.parse(JSON.parse(candidate.value!) as unknown);
      const savedBasis: unknown = JSON.parse(candidate.basis) as unknown;
      if (!Array.isArray(savedBasis) || savedBasis.length !== 2 || savedBasis.some((part: unknown): boolean => typeof part !== 'string')) throw new Error('임시 입력 기준 형식이 올바르지 않습니다.');
    }
    const selected: BrowserDraft | undefined = candidates.length === 1 ? candidates[0] : undefined;
    return selected === undefined ? { ...state, candidates } : { ...state, candidates, basis: selected.basis,
      value: schema.parse(JSON.parse(selected.value!) as unknown), replaces: [draftReference(selected)], restored: true };
  } catch (error: unknown) { return { ...state, error: `임시 입력을 복원하지 못했습니다. 브라우저 기록은 보존했습니다. ${errorText(error)}` }; }
}

/** 임시 입력 복원은 서버 저장·승인과 별개다. 기준 변경과 다른 탭의 수정은 사용자 선택 전까지 제출을 막는다. */
export function useBrowserDraft<T>(scope: string, baseline: T, context: string, schema: z.ZodType<T>): BrowserDraftControl<T> {
  const baselineJson: string = JSON.stringify(baseline);
  const basis: string = JSON.stringify([baselineJson, context]);
  const [state, setState] = useState<DraftState<T>>((): DraftState<T> => initialState(scope, basis, baseline, schema));
  const current = useRef<DraftState<T>>(state);
  if (state.scope !== scope) {
    const next: DraftState<T> = initialState(scope, basis, baseline, schema);
    current.current = next; setState(next);
  }
  const update = (next: DraftState<T>): void => { current.current = next; setState(next); };
  const persist = (value: T, nextBasis: string, replaces: DraftReference[]): boolean => {
    const previous: DraftState<T> = current.current;
    const next: DraftState<T> = { ...previous, basis: nextBasis, value, replaces, restored: false };
    try {
      schema.parse(value);
      const record: BrowserDraft = { version: 1, scope, id: previous.id, sequence: previous.sequence + 1,
        savedAt: new Date().toISOString(), basis: nextBasis, value: JSON.stringify(value) === baselineJson ? null : JSON.stringify(value), replaces };
      writeBrowserDraft(window.localStorage, record);
      current.current = { ...next, sequence: record.sequence };
      const candidates: BrowserDraft[] = activeBrowserDrafts(readBrowserDrafts(window.localStorage, scope));
      update({ ...next, sequence: record.sequence, error: null, candidates });
      return candidates.every((candidate: BrowserDraft): boolean => candidate.id === record.id
        || replaces.some((reference: DraftReference): boolean => reference.id === candidate.id && reference.sequence === candidate.sequence));
    } catch (error: unknown) {
      update({ ...next, sequence: current.current.sequence, error: `입력을 브라우저에 보관하거나 다시 확인하지 못했습니다. 현재 화면의 값을 복사하고 저장 공간·권한을 확인하세요. ${errorText(error)}` });
      return false;
    }
  };
  useEffect((): void => {
    const previous: DraftState<T> = current.current;
    if (previous.scope !== scope || previous.basis === basis) return;
    const oldBaseline: string = (JSON.parse(previous.basis) as [string, string])[0];
    const valueJson: string = JSON.stringify(previous.value);
    if (valueJson === oldBaseline || valueJson === baselineJson) {
      if (previous.sequence > 0 || previous.replaces.length > 0) persist(baseline, basis, previous.replaces);
      else update({ ...previous, value: baseline, basis });
    }
  }, [scope, basis]);
  useEffect((): (() => void) => {
    const refresh = (event: StorageEvent): void => {
      if (event.key !== null && !event.key.startsWith(draftPrefix(scope))) return;
      try { update({ ...current.current, candidates: activeBrowserDrafts(readBrowserDrafts(window.localStorage, scope)) }); }
      catch (error: unknown) { update({ ...current.current, error: `다른 화면의 임시 입력을 확인하지 못했습니다. ${errorText(error)}` }); }
    };
    window.addEventListener('storage', refresh);
    return (): void => { window.removeEventListener('storage', refresh); };
  }, [scope]);
  const dirty: boolean = JSON.stringify(state.value) !== baselineJson;
  const conflict: boolean = dirty && state.basis !== basis;
  const otherCandidates: BrowserDraft[] = state.candidates.filter((candidate: BrowserDraft): boolean =>
    candidate.id !== state.id && !state.replaces.some((reference: DraftReference): boolean => reference.id === candidate.id && reference.sequence === candidate.sequence));
  const ambiguous: boolean = otherCandidates.length > 0;
  useEffect((): (() => void) => {
    const warn = (event: BeforeUnloadEvent): void => { event.preventDefault(); };
    if (state.error !== null && dirty) window.addEventListener('beforeunload', warn);
    return (): void => { window.removeEventListener('beforeunload', warn); };
  }, [state.error, dirty]);
  const choose = (candidate: BrowserDraft): void => {
    try {
      const value: T = schema.parse(JSON.parse(candidate.value!) as unknown);
      // 선택은 폼 복원이며 저장은 사용자의 기존 저장 버튼을 통해서만 수행한다.
      persist(value, candidate.basis, state.candidates.filter((record: BrowserDraft): boolean => record.id !== state.id).map(draftReference));
    } catch (error: unknown) { update({ ...current.current, error: errorText(error) }); }
  };
  const notice: ReactElement | null = state.error === null && !dirty && !ambiguous ? null : <aside className="browser-draft-notice" aria-label="미저장 입력 복원">
    {state.error !== null && <p role="alert">{state.error}</p>}
    {dirty && <p>{state.restored ? '작성 중이던 입력을 복원했습니다.' : '작성 중인 입력을 이 브라우저에 보관합니다.'} 입력 복원은 서버 저장·승인·생성을 실행하지 않습니다.</p>}
    {conflict && <><p role="alert">작성 이후 저장된 기준이 바뀌었습니다. 비교한 뒤 사용할 값을 선택하세요.</p><details><summary>현재 서버 값과 작성한 값 비교</summary><h4>현재 서버 값</h4><pre>{JSON.stringify(baseline, null, 2)}</pre><h4>작성한 값</h4><pre>{JSON.stringify(state.value, null, 2)}</pre></details><button type="button" onClick={(): void => { persist(state.value, basis, state.replaces); }}>작성한 값을 현재 기준으로 검토</button></>}
    {ambiguous && <><p role="alert">다른 화면에서 작성한 입력이 있습니다. 사용할 입력을 선택하세요.</p>{otherCandidates.map((candidate: BrowserDraft): ReactElement => <details key={candidate.id}><summary>{candidate.savedAt}의 입력 보기</summary><pre>{JSON.stringify(JSON.parse(candidate.value!) as unknown, null, 2)}</pre><button type="button" onClick={(): void => { choose(candidate); }}>이 입력 복원</button></details>)}<button type="button" onClick={(): void => { persist(state.value, state.basis, state.candidates.filter((record: BrowserDraft): boolean => record.id !== state.id).map(draftReference)); }}>현재 화면의 입력 유지</button></>}
    <button type="button" onClick={(): void => { persist(baseline, basis, state.candidates.filter((record: BrowserDraft): boolean => record.id !== state.id).map(draftReference)); }}>임시 입력 버리고 편집 전 값 사용</button>
  </aside>;
  return { value: state.scope === scope ? state.value : baseline, setValue: (value: T | ((previous: T) => T)): boolean => {
    const next: T = typeof value === 'function' ? (value as (previous: T) => T)(current.current.value) : value;
    return persist(next, current.current.basis, current.current.replaces);
  },
    blocked: state.error !== null || conflict || ambiguous || state.scope !== scope, dirty, notice };
}

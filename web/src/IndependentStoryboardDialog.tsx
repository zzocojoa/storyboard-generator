import { useEffect, useRef, useState } from 'react';
import type { ReactElement } from 'react';
import type { IndependentStoryboardInput } from '../../src/domain/storyboard-creation.js';
import { apiErrorMessage } from './api.js';
import { IndependentStoryboardFields } from './IndependentStoryboardFields.js';
import { useStoryboardCreation } from './useStoryboardCreation.js';
import { EMPTY_STORYBOARD_DRAFT, IndependentStoryboardDraftSchema } from './document-import-draft.js';
import type { IndependentStoryboardDraft } from './document-import-draft.js';
import { useBrowserDraft } from './useBrowserDraft.js';

export function IndependentStoryboardDialog(props: { open: boolean; working: boolean; onClose: () => void; onCreate: (input: IndependentStoryboardInput) => Promise<void> }): ReactElement {
  const dialog = useRef<HTMLDialogElement>(null);
  const pending = useRef<boolean>(false);
  const recovery = useBrowserDraft('independent-storyboard', EMPTY_STORYBOARD_DRAFT, '1', IndependentStoryboardDraftSchema);
  const { path, name, hold, flowId } = recovery.value;
  const edit = (field: 'path' | 'name' | 'hold', value: string): void => {
    recovery.setValue((current: IndependentStoryboardDraft): IndependentStoryboardDraft => ({ ...current, flowId: current.flowId ?? crypto.randomUUID(), [field]: value }));
  };
  const [busy, setBusy] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const create = useStoryboardCreation(props.onCreate);
  const blocked: boolean = busy || props.working || recovery.blocked;
  useEffect((): void => {
    if (props.open && !dialog.current?.open) dialog.current?.showModal();
    if (!props.open && dialog.current?.open) dialog.current?.close();
  }, [props.open]);
  const submit = async (): Promise<void> => {
    if (blocked || pending.current) return;
    pending.current = true; setBusy(true); setError(null);
    try {
      if (flowId === null) throw new Error('새 콘티 입력을 먼저 작성하세요.');
      await create(flowId, path, name, hold);
      if (!recovery.setValue(EMPTY_STORYBOARD_DRAFT)) throw new Error('콘티는 생성했지만 브라우저 입력 정리를 완료하지 못했습니다. 같은 입력으로 재시도하면 기존 생성 결과를 엽니다.');
      props.onClose();
    }
    catch (caught: unknown) { setError(apiErrorMessage(caught)); }
    finally { pending.current = false; setBusy(false); }
  };
  return <dialog ref={dialog} className="document-workflow storyboard-start" aria-labelledby="storyboard-start-title"
    onCancel={(event): void => { event.preventDefault(); if (!blocked) props.onClose(); }}>
    <header className="document-topbar"><span className="document-brand">C / CUTROOM</span><button type="button" className="document-close" disabled={blocked} onClick={props.onClose}>닫기 · 나중에 계속</button></header>
    <form onSubmit={(event): void => { event.preventDefault(); void submit(); }}>
      <div className="document-scroll"><div className="document-container">
        <h1 id="storyboard-start-title">패키지로 별도 콘티 시작</h1>
        <p>생성한 handoff 파일을 불러와 새 콘티를 목록에 추가합니다. 같은 이야기의 기존 콘티와 독립적으로 편집합니다.</p>
        {error !== null && <div role="alert" className="document-error-summary">{error}</div>}
        <fieldset className="document-controls" disabled={busy || props.working}>{recovery.notice}</fieldset>
        <fieldset disabled={blocked} className="document-controls document-section">
          <label>handoff 파일 경로<input aria-label="handoff 파일 경로" value={path} required onChange={(event): void => { edit('path', event.target.value); }} /></label>
          <IndependentStoryboardFields name={name} hold={hold} onName={(value): void => { edit('name', value); }} onHold={(value): void => { edit('hold', value); }} />
        </fieldset>
      </div></div>
      <footer className="document-footer"><div className="document-footer-inner"><span>생성이 끝나면 새 콘티를 바로 엽니다.</span>
        <button className="document-primary" disabled={blocked}>{blocked ? '콘티 생성 중…' : '별도 콘티 생성·열기'}</button></div></footer>
    </form>
  </dialog>;
}

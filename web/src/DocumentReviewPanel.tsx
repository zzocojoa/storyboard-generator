import { useState } from 'react';
import type { ReactElement } from 'react';
import type { ProductionPreset, ReviewAuditEntry, ReviewSuggestion } from '../../src/documents/review-model.js';
import { reviewEntryKey } from './document-review-state.js';
import type { ReviewControls } from './useDocumentReview.js';

export const REVIEW_ORIGIN_LABELS: Readonly<Record<ReviewAuditEntry['origin'], string>> = { document: '문서 확인', inference: 'Codex 추론', recommendation: 'Codex 추천', preset: '제작 프리셋', user: '사용자 지정', 'identity-document': '보충 인물표 확인' };
export const PRODUCTION_LABELS: Readonly<Record<string, string>> = { fps: '프레임레이트', sampleRate: '음성 샘플레이트', width: '화면비 가로', height: '화면비 세로', startTimecode: '시작 타임코드' };

export function ReviewOrigin(props: { entry: ReviewAuditEntry | undefined }): ReactElement | null {
  return props.entry === undefined ? null : <small className={'document-review-origin ' + (props.entry.confirmed ? 'confirmed' : 'pending')}>
    {REVIEW_ORIGIN_LABELS[props.entry.origin]} · {props.entry.confirmed ? '확인됨' : '확인 필요'}</small>;
}

export function DocumentReviewPanel(props: { controls: ReviewControls; entries: readonly ReviewAuditEntry[]; preset: ProductionPreset | null;
  onPreset: (preset: ProductionPreset | null) => void; onConfirm: (key: string) => void; onConfirmAll: () => void }): ReactElement {
  const [presetName, setPresetName] = useState<string>('');
  const [saving, setSaving] = useState<boolean>(false);
  const { controls } = props;
  const pending: number = props.entries.filter((entry: ReviewAuditEntry): boolean => !entry.confirmed).length;
  const suggestions: readonly ReviewSuggestion[] = [...(controls.review?.result?.suggestions ?? []), ...props.entries.filter((entry: ReviewAuditEntry): boolean =>
    ['inference', 'recommendation'].includes(entry.origin) && entry.reviewId !== controls.review?.id).map((entry: ReviewAuditEntry): ReviewSuggestion => ({
      field: entry.field, key: entry.key, value: entry.value, origin: entry.origin === 'inference' ? 'inference' : 'recommendation', reason: entry.reason, evidence: entry.evidence,
    }))];
  return <section className="document-section document-review-panel" aria-labelledby="document-codex-review-title">
    <header><span className="document-kicker">CODEX APP</span><h2 id="document-codex-review-title">문서를 읽고, 빈칸을 채웁니다</h2>
      <p>8개 문서의 연결을 검토하고 제작 설정을 추천합니다. 직접 수정한 값은 유지합니다.</p></header>
    {controls.recoveryNotice !== null && <fieldset aria-label="문서 검토 요청 복원" disabled={controls.working}>{controls.recoveryNotice}</fieldset>}
    {controls.savedRequestId !== null && <p className="document-help">이전 검토 요청을 보관했습니다. 원본 확인 후 같은 요청의 진행 상태·결과를 다시 불러올 수 있습니다.</p>}
    <div className="document-review-actions"><button type="button" className="document-primary" disabled={controls.working || controls.configured !== true || controls.recoveryBlocked}
      onClick={(): void => { void controls.start(); }}>{controls.working ? 'Codex 검토 중…' : controls.review === null ? 'Codex로 검토하고 채우기' : '현재 값으로 다시 검토'}</button>
      {controls.savedRequestId !== null && <button type="button" className="document-secondary" disabled={controls.working || controls.configured !== true || controls.recoveryBlocked}
        onClick={(): void => { void controls.reconnect(); }}>이전 검토에 다시 연결</button>}
      {controls.canResend && controls.savedRequestId !== null && <button type="button" className="document-secondary" disabled={controls.working || controls.configured !== true || controls.recoveryBlocked}
        onClick={(): void => { void controls.resend(); }}>같은 요청 재전송</button>}
      {controls.working && <button type="button" className="document-secondary" disabled={controls.review?.status !== 'running'} onClick={(): void => { void controls.cancel(); }}>검토 취소</button>}</div>
    {controls.canResend && <p className="document-help">접수 여부를 확인하지 못했습니다. 같은 요청 재전송은 보관한 입력을 사용합니다. 이미 접수됐다면 기존 작업을 불러오고, 접수되지 않았다면 한 번 시작합니다. 이후 수정한 값은 유지합니다.</p>}
    {controls.configured === false && <p className="document-help">자동 검토 엔진이 설정되지 않았습니다. 서버 설정의 documentReview를 확인하세요. 연결·설정은 직접 입력할 수 있습니다.</p>}
    {controls.working && <p className="document-review-progress" aria-live="polite">설치된 Codex App 엔진이 문서를 검토하고 있습니다. 결과가 도착하면 입력값과 근거를 표시합니다.</p>}
    {controls.error !== null && <p className="document-review-error" role="alert">{controls.error}</p>}
    {controls.note !== '' && <p className="document-review-note" aria-live="polite">{controls.note}</p>}
    {(suggestions.length > 0 || controls.review?.result != null) && <div className="document-review-results">
      {controls.review?.result !== null && controls.review?.result !== undefined && <><p>{controls.review.result.summary}</p><small>검토 모델 · {controls.review.model}</small></>}
      {pending > 0 && <div className="document-review-actions"><strong>제안 확인 필요 {pending}개</strong><button type="button" className="document-secondary" onClick={props.onConfirmAll}>입력된 제안 모두 확인</button></div>}
      <details open={pending > 0 || suggestions.some((item: ReviewSuggestion): boolean => item.origin === 'unresolved' && !props.entries.some((entry: ReviewAuditEntry): boolean => reviewEntryKey(entry) === reviewEntryKey(item)))}><summary>항목별 검토 근거 {suggestions.length}개</summary>
        {suggestions.map((suggestion: ReviewSuggestion, index: number): ReactElement => {
          const key: string = reviewEntryKey(suggestion);
          const entry: ReviewAuditEntry | undefined = props.entries.find((item: ReviewAuditEntry): boolean => reviewEntryKey(item) === key && item.value === suggestion.value && item.origin === suggestion.origin);
          return <article key={key + index} className="document-review-suggestion"><div><strong>{suggestion.field === 'production' ? PRODUCTION_LABELS[suggestion.key] : suggestion.key}</strong>
            <span>{suggestion.value ?? '연결 확인 필요'}</span></div>
            {entry === undefined ? <small>{suggestion.origin === 'unresolved' ? '근거 부족 · 직접 확인 필요' : '검토 제안 · 현재 입력값 유지'}</small> : <ReviewOrigin entry={entry} />}
            <p>{suggestion.reason}</p>
            {entry?.model !== null && entry?.model !== undefined && entry.reviewId !== controls.review?.id && <small>이전 검토 · {entry.model}</small>}
            {suggestion.evidence.length > 0 && <details><summary>원문 근거 보기</summary>{suggestion.evidence.map((evidence, index: number): ReactElement => <div className="document-review-evidence" key={index}><code>{evidence.fileId} · {evidence.locator}</code><blockquote>{evidence.quote}</blockquote></div>)}</details>}
            {entry !== undefined && !entry.confirmed && <button type="button" className="document-secondary" onClick={(): void => { props.onConfirm(key); }}>{suggestion.key} 제안 확인</button>}
          </article>;
        })}</details>
    </div>}
    <details className="document-preset"><summary>내 제작 프리셋</summary><p>자주 사용하는 제작 설정을 저장하고 다른 스토리에서 선택할 수 있습니다. 프리셋 선택은 제작 설정 5개를 함께 적용합니다.</p>
      <label htmlFor="document-preset-select">제작 프리셋<select id="document-preset-select" aria-label="제작 프리셋" value={props.preset?.id ?? ''} disabled={controls.working}
        onChange={(event): void => { props.onPreset(controls.presets.find((preset: ProductionPreset): boolean => preset.id === event.target.value) ?? null); }}><option value="">프리셋 사용 안 함</option>
        {controls.presets.map((preset: ProductionPreset): ReactElement => <option key={preset.id} value={preset.id}>{preset.name} · {preset.fields.width}:{preset.fields.height} · {preset.fields.fps} fps</option>)}</select></label>
      <div className="document-preset-save"><label htmlFor="document-preset-name">새 프리셋 이름<input id="document-preset-name" value={presetName} maxLength={100} onChange={(event): void => { setPresetName(event.target.value); }} /></label>
        <button type="button" className="document-secondary" disabled={saving || controls.working || controls.configured !== true} onClick={(): void => {
          setSaving(true); void controls.savePreset(presetName).then((saved: ProductionPreset | null): void => { if (saved !== null) { props.onPreset(saved); setPresetName(''); } }).finally((): void => { setSaving(false); });
        }}>{saving ? '저장 중…' : '현재 제작 설정 저장'}</button></div>
    </details>
  </section>;
}

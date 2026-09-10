import { useEffect, useRef, useState } from 'react';
import type { ReactElement } from 'react';
import { DocumentSettingsSchema, DOCUMENT_FILES } from '../../src/documents/schema.js';
import type { DocumentBindings, DocumentPreview, DocumentSettings } from '../../src/documents/schema.js';
import { apiErrorMessage, createDocumentPackage, previewDocumentPackage } from './api.js';
import { DocumentMappings, DocumentProductionFields, FieldError } from './DocumentImportFields.js';
import { mappingProblems, reviewProductionFields, selectedBindings } from './document-import-state.js';
import type { FieldProblem, MappingField, ProductionFields, ProductionReview } from './document-import-state.js';
import type { ProductionPreset, ReviewAuditEntry } from '../../src/documents/review-model.js';
import { DocumentReviewPanel } from './DocumentReviewPanel.js';
import { applyDocumentPreset, buildDocumentReviewAudit, reviewEntryKey } from './document-review-state.js';
import type { ReviewDraft } from './document-review-state.js';
import { useDocumentReview } from './useDocumentReview.js';
import './document-import.css';

type ImportStep = 1 | 2 | 3;
type DocumentImportProps = { open: boolean; working: boolean; existingProjectIds: readonly string[]; onClose: () => void;
  onImport: (path: string, holdMs: number) => Promise<void>; onOpenProject: (projectId: string) => Promise<void> };
const EMPTY_BINDINGS: DocumentBindings = { people: [], scenes: [], units: [] };
const EMPTY_PRODUCTION: ProductionFields = { fps: '', sampleRate: '', width: '', height: '', startTimecode: '00:00:00:00' };
const STEP_LABELS: readonly string[] = ['문서 확인', '연결·설정', '생성·불러오기'];
const DOCUMENT_LABELS: readonly string[] = ['방송 대본', '인물 대본', '편집표', '촬영표', '내레이션', '패널 대본', '자막', '제작 목록'];

function focusProblem(id: string): void {
  const field: HTMLElement | null = document.getElementById(id);
  let ancestor: HTMLElement | null = field?.parentElement ?? null;
  while (ancestor !== null) {
    if (ancestor instanceof HTMLDetailsElement) ancestor.open = true;
    ancestor = ancestor.parentElement;
  }
  field?.focus();
}

export function DocumentImportPanel(props: DocumentImportProps): ReactElement {
  const dialog = useRef<HTMLDialogElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const scrollArea = useRef<HTMLDivElement>(null);
  const errorSummary = useRef<HTMLDivElement>(null);
  const pending = useRef<boolean>(false);
  const [step, setStep] = useState<ImportStep>(1);
  const [directory, setDirectory] = useState<string>('');
  const [output, setOutput] = useState<string>('');
  const [preview, setPreview] = useState<DocumentPreview | null>(null);
  const [automaticPreview, setAutomaticPreview] = useState<DocumentPreview | null>(null);
  const [bindings, setBindings] = useState<DocumentBindings>(EMPTY_BINDINGS);
  const [production, setProduction] = useState<ProductionFields>(EMPTY_PRODUCTION);
  const [reviewEntries, setReviewEntries] = useState<ReviewAuditEntry[]>([]);
  const [preset, setPreset] = useState<ProductionPreset | null>(null);
  const [version, setVersion] = useState<string>('');
  const [hold, setHold] = useState<string>('');
  const [busy, setBusy] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [problems, setProblems] = useState<FieldProblem[]>([]);
  const [message, setMessage] = useState<string>('');
  const [handoffPath, setHandoffPath] = useState<string | null>(null);
  const existing: boolean = preview !== null && props.existingProjectIds.includes(preview.projectId);
  const blocked: boolean = busy || props.working;
  const unresolved: number = preview === null ? 0 : mappingProblems(preview, bindings).length;
  const reviewDraft: ReviewDraft = { bindings, production, entries: reviewEntries };
  const applyReviewDraft = (draft: ReviewDraft): void => { setBindings(draft.bindings); setProduction(draft.production); setReviewEntries(draft.entries); setProblems([]); };
  const codexReview = useDocumentReview({ directory, preview, draft: reviewDraft, preset, onApplied: applyReviewDraft });
  const pendingReview: number = reviewEntries.filter((entry: ReviewAuditEntry): boolean => !entry.confirmed).length;
  const selectPreset = (selected: ProductionPreset | null): void => {
    setPreset(selected);
    if (selected !== null) applyReviewDraft(applyDocumentPreset(reviewDraft, selected));
    else setReviewEntries((entries: ReviewAuditEntry[]): ReviewAuditEntry[] => entries.filter((entry: ReviewAuditEntry): boolean => entry.origin !== 'preset'));
  };
  const noteManualEdit = (field: ReviewAuditEntry['field'], key: string, value: string): void => {
    const target: string = reviewEntryKey({ field, key }); codexReview.edited(target);
    setReviewEntries((entries: ReviewAuditEntry[]): ReviewAuditEntry[] => [
      ...entries.filter((entry: ReviewAuditEntry): boolean => reviewEntryKey(entry) !== target).map((entry: ReviewAuditEntry): ReviewAuditEntry =>
        field !== 'production' && entry.origin === 'inference' ? { ...entry, confirmed: false } : entry),
      ...(value === '' ? [] : [{ field, key, value, origin: 'user' as const, reason: '사용자가 직접 입력한 값입니다.', evidence: [], confirmed: true, reviewId: null, model: null }]),
    ]);
  };

  useEffect((): void => {
    if (props.open && !dialog.current?.open) dialog.current?.showModal();
    if (!props.open && dialog.current?.open) dialog.current?.close();
    if (props.open) heading.current?.focus();
  }, [props.open]);
  useEffect((): void => {
    if (props.open) { scrollArea.current?.scrollTo(0, 0); heading.current?.focus(); }
  }, [step]);
  useEffect((): void => {
    if (error !== null || problems.length > 0) errorSummary.current?.focus();
  }, [error, problems]);

  const run = async (action: () => Promise<void>): Promise<void> => {
    if (pending.current || props.working) return;
    pending.current = true; setBusy(true); setError(null); setProblems([]); setMessage('');
    try { await action(); }
    catch (caught: unknown) { setError(apiErrorMessage(caught)); }
    finally { pending.current = false; setBusy(false); }
  };
  const clearSource = (value: string): void => {
    codexReview.reset(); setAutomaticPreview(null); setReviewEntries([]); setPreset(null);
    setDirectory(value); setPreview(null); setBindings(EMPTY_BINDINGS); setProduction(EMPTY_PRODUCTION);
    setOutput(''); setVersion(''); setHold(''); setHandoffPath(null); setError(null); setProblems([]); setMessage('');
  };
  const goBack = (): void => { setError(null); setProblems([]); setMessage(''); setStep(step === 3 ? 2 : 1); };
  const analyze = async (): Promise<void> => {
    if (!directory.trim()) { setProblems([{ id: 'document-directory', message: '제작 문서 8개가 있는 폴더 경로를 입력하세요.' }]); return; }
    const next: DocumentPreview = await previewDocumentPackage(directory.trim(), EMPTY_BINDINGS);
    if (next.sourceFingerprint !== preview?.sourceFingerprint) { setPreview(next); setAutomaticPreview(next); setBindings(EMPTY_BINDINGS); setReviewEntries([]); codexReview.reset(); }
    setStep(2);
  };
  const changeBinding = (field: MappingField, key: string, targetId: string): void => {
    noteManualEdit(field, key, targetId);
    setBindings((current: DocumentBindings): DocumentBindings => ({ ...current, [field]: [...current[field].filter((entry): boolean => entry.key !== key), { key, targetId }] }));
    setMessage('');
  };
  const reviewConnections = async (): Promise<DocumentPreview | null> => {
    if (preview === null) throw new Error('문서 검토 결과가 없습니다. 폴더를 다시 검토하세요.');
    const selected: DocumentBindings = selectedBindings(bindings);
    const next: DocumentPreview = await previewDocumentPackage(directory.trim(), { ...selected, units: [] });
    if (next.sourceFingerprint !== preview.sourceFingerprint) {
      setError('검토 이후 원본 문서가 변경되었습니다. 이전 단계에서 문서를 다시 검토한 뒤 연결을 확인하세요.');
      return null;
    }
    setPreview(next);
    return next;
  };
  const review = async (): Promise<void> => {
    const next: DocumentPreview | null = await reviewConnections();
    if (next === null) return;
    const remaining: FieldProblem[] = mappingProblems(next, bindings);
    setProblems(remaining);
    setMessage(remaining.length === 0 ? '모든 연결을 확인했습니다.' : '연결 후보를 갱신했습니다. 남은 항목을 선택하세요.');
  };
  const continueToPackage = async (): Promise<void> => {
    if (codexReview.working) { setError('Codex 검토가 끝나거나 취소한 뒤 다음 단계로 진행하세요.'); return; }
    if (pendingReview > 0) { setError(`Codex가 입력한 제안 ${pendingReview}개의 근거를 확인한 뒤 진행하세요.`); return; }
    const next: DocumentPreview | null = await reviewConnections();
    if (next === null) return;
    const result: ProductionReview = reviewProductionFields(production);
    const remaining: FieldProblem[] = [...mappingProblems(next, bindings), ...(result.valid ? [] : result.problems)];
    if (remaining.length > 0) { setProblems(remaining); return; }
    setStep(3);
  };
  const create = async (): Promise<void> => {
    if (preview === null || automaticPreview === null) throw new Error('문서를 먼저 검토하세요.');
    const result: ProductionReview = reviewProductionFields(production);
    if (!result.valid) { setProblems(result.problems); setStep(2); return; }
    const remaining: FieldProblem[] = [];
    if (!version.trim()) remaining.push({ id: 'document-version', message: '패키지 버전을 입력하세요.' });
    if (!output.trim()) remaining.push({ id: 'document-output', message: '새 패키지를 저장할 폴더 경로를 입력하세요.' });
    if (remaining.length > 0) { setProblems(remaining); return; }
    const settings: DocumentSettings = DocumentSettingsSchema.parse({ formatVersion: '1.1.0', sourceFingerprint: preview.sourceFingerprint,
      packageVersion: version.trim(), timebase: result.timebase, profile: result.profile, bindings: selectedBindings(bindings),
      reviewAudit: buildDocumentReviewAudit(preview, automaticPreview, reviewDraft, preset) });
    const created = await createDocumentPackage(directory.trim(), output.trim(), settings);
    setHandoffPath(created.handoffPath);
    setMessage('패키지 생성 완료');
  };
  const importCreated = async (): Promise<void> => {
    if (handoffPath === null) throw new Error('패키지를 먼저 생성하세요.');
    if (!Number.isSafeInteger(Number(hold)) || Number(hold) <= 0) {
      setProblems([{ id: 'document-hold', message: '초안 글자 유지 시간은 1 이상의 정수 밀리초로 입력하세요.' }]); return;
    }
    await props.onImport(handoffPath, Number(hold));
    props.onClose(); clearSource(''); setStep(1);
  };
  const nextAction = (): void => { void run(step === 1 ? analyze : step === 2 ? continueToPackage : handoffPath === null ? create : importCreated); };
  const nextLabel: string = busy ? (step === 1 ? '문서 검토 중…' : step === 2 ? '연결 확인 중…' : handoffPath === null ? '패키지 생성 중…' : '불러오는 중…')
    : step === 1 ? '문서 검토' : step === 2 ? '생성 내용 확인' : handoffPath === null ? '패키지 생성' : '생성 패키지 불러오기';

  return <dialog className="document-workflow" ref={dialog} aria-labelledby="document-workflow-title" onCancel={(event): void => { event.preventDefault(); if (!blocked) props.onClose(); }}>
    <header className="document-topbar"><div><span className="document-brand">C / CUTROOM</span><span className="document-topbar-label">새 패키지 만들기</span></div>
      <button type="button" className="document-close" disabled={blocked} onClick={props.onClose}>닫기 · 나중에 계속 <span aria-hidden="true">×</span></button></header>
    <div className="document-scroll" ref={scrollArea}>
      <div className="document-container">
        <nav aria-label="패키지 제작 단계"><ol className="document-steps">{STEP_LABELS.map((label: string, index: number): ReactElement => <li key={label} aria-current={step === index + 1 ? 'step' : undefined} className={step > index + 1 ? 'complete' : ''}><span>{String(index + 1).padStart(2, '0')}</span>{label}</li>)}</ol></nav>
        <div className="document-page-heading"><span className="document-kicker">제작 문서 8개로 새 패키지 만들기</span>
          <h1 id="document-workflow-title" ref={heading} tabIndex={-1}>{step === 1 ? '어떤 이야기를 만들까요?' : step === 2 ? '연결과 제작 기준을 확인하세요' : handoffPath === null ? '새 패키지의 저장 위치를 정하세요' : '콘티 초안으로 이어가세요'}</h1>
          <p>{step === 1 ? '한 이야기의 제작 문서가 모인 폴더를 입력하세요.' : step === 2 ? '자동으로 확인한 연결을 검토하고, 남은 항목을 직접 지정합니다.' : '확인한 원문과 설정으로 다시 불러올 수 있는 패키지를 만듭니다.'}</p></div>
        {(error !== null || problems.length > 0) && <div className="document-error-summary" role="alert" tabIndex={-1} ref={errorSummary}>
          <strong>{error ?? '확인이 필요한 항목 ' + problems.length + '개'}</strong>
          {problems.length > 0 && <ul>{problems.map((problem: FieldProblem): ReactElement => <li key={problem.id}><button type="button" onClick={(): void => { focusProblem(problem.id); }}>{problem.message}</button></li>)}</ul>}
        </div>}
        <div className="document-layout">
          <div className="document-main">
            <fieldset className="document-controls" disabled={blocked}>
              {step === 1 && <section className="document-section"><header><h2>제작 문서 폴더</h2><p>아래 파일 8개가 들어 있는 폴더를 선택합니다.</p></header>
                <label htmlFor="document-directory">제작 문서 폴더<input id="document-directory" value={directory} placeholder="/프로젝트/09_PRODUCTION" aria-invalid={problems.some((problem: FieldProblem): boolean => problem.id === 'document-directory')}
                  onChange={(event): void => { clearSource(event.target.value); }} onKeyDown={(event): void => { if (event.key === 'Enter') { event.preventDefault(); void run(analyze); } }} /></label>
                <FieldError id="document-directory" problems={problems} />
                <ul className="document-file-list">{DOCUMENT_FILES.map((file, index: number): ReactElement => <li key={file.key}><span>{String(index + 1).padStart(2, '0')}</span><div><strong>{DOCUMENT_LABELS[index]}</strong><code>{file.name}</code></div></li>)}</ul>
              </section>}
              {step === 2 && preview !== null && <><DocumentReviewPanel controls={codexReview} entries={reviewEntries} preset={preset} onPreset={selectPreset}
                onConfirm={(key: string): void => { setReviewEntries((entries: ReviewAuditEntry[]): ReviewAuditEntry[] => entries.map((entry: ReviewAuditEntry): ReviewAuditEntry => reviewEntryKey(entry) === key ? { ...entry, confirmed: true } : entry)); }}
                onConfirmAll={(): void => { setReviewEntries((entries: ReviewAuditEntry[]): ReviewAuditEntry[] => entries.map((entry: ReviewAuditEntry): ReviewAuditEntry => ({ ...entry, confirmed: true }))); setError(null); }} />
                <DocumentMappings preview={preview} bindings={bindings} entries={reviewEntries} problems={problems} onChange={changeBinding} onReview={(): void => { void run(review); }} />
                <DocumentProductionFields fields={production} entries={reviewEntries} problems={problems} onChange={(field: keyof ProductionFields, value: string): void => { noteManualEdit('production', field, value); setProduction((current: ProductionFields): ProductionFields => ({ ...current, [field]: value })); }} /></>}
              {step === 3 && preview !== null && <section className="document-section"><header><span className="document-kicker">패키지 출력</span><h2>저장 위치와 버전</h2><p>새 폴더에 원본 문서 8개, 연결·제작 설정, handoff 파일을 저장합니다.</p></header>
                {handoffPath === null ? <div className="document-fields-grid"><label className="document-full-field" htmlFor="document-output">새 패키지 폴더<input id="document-output" aria-label="새 패키지 폴더" value={output} onChange={(event): void => { setOutput(event.target.value); }} aria-invalid={problems.some((problem: FieldProblem): boolean => problem.id === 'document-output')} /><small>원본 폴더 밖에 아직 존재하지 않는 새 폴더 경로를 입력하세요.</small><FieldError id="document-output" problems={problems} /></label>
                  <label className="document-full-field" htmlFor="document-version">패키지 버전<input id="document-version" aria-label="패키지 버전" value={version} placeholder="예: draft-01" onChange={(event): void => { setVersion(event.target.value); }} aria-invalid={problems.some((problem: FieldProblem): boolean => problem.id === 'document-version')} /><FieldError id="document-version" problems={problems} /></label></div>
                  : <div className="document-success"><strong>패키지 생성 완료</strong><p>버전 {version.trim()}</p><code>{handoffPath}</code></div>}
                {handoffPath !== null && !existing && <div className="document-import-created"><h3>편집용 초안 만들기</h3><p>종료 시각이 없는 화면 글자를 초안에서 얼마나 유지할지 지정하세요. 최종 출력 전에 각 시각을 확정합니다.</p>
                  <label htmlFor="document-hold">초안 글자 유지 시간 (ms)<input id="document-hold" aria-label="초안 글자 유지 시간 (ms)" type="number" min="1" step="1" value={hold} onChange={(event): void => { setHold(event.target.value); }} aria-invalid={problems.some((problem: FieldProblem): boolean => problem.id === 'document-hold')} /><FieldError id="document-hold" problems={problems} /></label></div>}
              </section>}
            </fieldset>
          </div>
          <aside className="document-overview" aria-label="가져오기 요약">
            <span className="document-kicker">{preview === null ? 'SOURCE TO STORYBOARD' : '문서 검토 완료 · 8개'}</span>
            <h2>{preview?.title ?? '하나의 이야기, 하나의 패키지'}</h2>
            {preview === null ? <p>제작 문서 검토 후 인물과 장면을 연결하고, 영상 제작 기준을 지정합니다.</p> : <><code>{preview.projectId}</code><p>{preview.counts.scenes}장면 · {preview.counts.segments}구간 · 원문 {preview.counts.units}개</p>
              <dl className="document-stats"><div><dt>내레이션</dt><dd>{preview.counts.narration}개</dd></div><div><dt>패널 발화</dt><dd>{preview.counts.panel}개</dd></div><div><dt>연결 확인 필요</dt><dd>{unresolved}개</dd></div></dl>
              <details className="document-source"><summary>입력 폴더 확인</summary><code>{directory.trim()}</code></details>
              {step === 3 && <dl className="document-stats"><div><dt>프레임레이트</dt><dd>{production.fps === '30000/1001' ? '29.97' : production.fps.split('/')[0]} fps</dd></div><div><dt>화면비</dt><dd>{production.width} : {production.height}</dd></div><div><dt>샘플레이트</dt><dd>{production.sampleRate} Hz</dd></div><div><dt>시작</dt><dd>{production.startTimecode}</dd></div></dl>}
              <details className="document-source"><summary>검토 범위와 후속 작업</summary>{preview.notices.map((notice: string): ReactElement => <p key={notice}>{notice}</p>)}</details></>}
            <p className="document-help">생성한 패키지를 불러오면 컷·그림·음성 작업을 시작할 수 있습니다.</p>
            {existing && preview !== null && <div className="document-existing"><strong>이미 저장된 프로젝트입니다</strong><p>같은 ID의 콘티가 있습니다. 새 패키지를 만들어도 기존 콘티는 바뀌지 않습니다.</p><p>기존 콘티의 원본을 바꾸려면 편집기의 SOURCE UPDATE에서 변경 영향을 먼저 확인하세요.</p>
              <button className="document-secondary" type="button" disabled={blocked} onClick={(): void => { void run(async (): Promise<void> => { await props.onOpenProject(preview.projectId); props.onClose(); }); }}>기존 프로젝트 열기</button></div>}
          </aside>
        </div>
      </div>
    </div>
    <footer className="document-footer"><div className="document-footer-inner"><div className="document-progress-note" role="status">{message || (error !== null && handoffPath !== null ? '패키지는 보존되었습니다. 오류를 해결한 뒤 다시 불러오세요.' : step === 1 ? '8개 파일의 내용과 연결을 검토합니다.' : step === 2 ? '연결 확인 필요 ' + unresolved + '개 · 제작 설정을 지정하세요.' : handoffPath !== null && existing ? '패키지는 생성됐습니다. 기존 프로젝트에서 원본 변경을 검토할 수 있습니다.' : handoffPath === null ? '아직 파일을 생성하지 않았습니다.' : '초안 글자 유지 시간을 입력하고 불러오세요.')}</div>
      <div className="document-footer-actions">{step > 1 && handoffPath === null && <button type="button" className="document-secondary" disabled={blocked} onClick={goBack}>이전 단계</button>}
        {handoffPath !== null && existing ? <button type="button" className="document-primary" disabled={blocked} onClick={props.onClose}>완료 · 편집기로 돌아가기</button>
          : <button type="button" className="document-primary" disabled={blocked} onClick={nextAction}>{nextLabel}<span aria-hidden="true"> →</span></button>}
        {handoffPath !== null && <button type="button" className="document-secondary" disabled={blocked} onClick={(): void => { clearSource(''); setStep(1); }}>다른 패키지 만들기</button>}
      </div></div></footer>
  </dialog>;
}

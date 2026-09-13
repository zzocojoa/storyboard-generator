import { useEffect, useRef, useState } from 'react';
import type { ReactElement } from 'react';
import { DocumentSettingsSchema, DOCUMENT_FILES } from '../../src/documents/schema.js';
import type { DocumentBindings, DocumentPreview, DocumentSettings } from '../../src/documents/schema.js';
import { apiErrorMessage, createDocumentPackage, previewDocumentPackage, verifyDocumentPackage } from './api.js';
import { DocumentMappings, DocumentProductionFields, FieldError } from './DocumentImportFields.js';
import { mappingProblems, reviewProductionFields, selectedBindings } from './document-import-state.js';
import type { FieldProblem, MappingField, ProductionFields, ProductionReview } from './document-import-state.js';
import type { ProductionPreset, ReviewAuditEntry } from '../../src/documents/review-model.js';
import { DocumentReviewPanel } from './DocumentReviewPanel.js';
import { applyDocumentPreset, buildDocumentReviewAudit, reviewEntryKey } from './document-review-state.js';
import type { ReviewDraft } from './document-review-state.js';
import { DocumentIdentityPanel } from './DocumentIdentityPanel.js';
import { DocumentPersonConnections } from './DocumentPersonConnections.js';
import { IndependentStoryboardFields } from './IndependentStoryboardFields.js';
import { useStoryboardCreation } from './useStoryboardCreation.js';
import type { IndependentStoryboardInput } from '../../src/domain/storyboard-creation.js';
import { applyIdentityMatches } from './document-identity-state.js';
import type { IdentityPreview } from '../../src/documents/identity-schema.js';
import { useDocumentReview } from './useDocumentReview.js';
import { useSavedDocumentIdentity } from './useSavedDocumentIdentity.js';
import { DocumentImportDraftSchema, EMPTY_DOCUMENT_IMPORT } from './document-import-draft.js';
import type { DocumentImportDraft } from './document-import-draft.js';
import { useBrowserDraft } from './useBrowserDraft.js';
import { stableJsonStringify } from '../../src/io/stable-json.js';
import './document-import.css';

type ImportStep = 1 | 2 | 3;
type CreatedDocumentPackage = { handoffPath: string; output: string; version: string; contentKey: string };
type DocumentImportProps = { open: boolean; working: boolean; existingProjectIds: readonly string[]; onClose: () => void;
  onImport: (path: string, holdMs: number) => Promise<void>; onOpenProject: (projectId: string) => Promise<void>;
  onCreateIndependent: (input: IndependentStoryboardInput) => Promise<void> };
const EMPTY_BINDINGS: DocumentBindings = { people: [], scenes: [], units: [] };
const IMPORT_STEPS: readonly { step: ImportStep; label: string }[] = [{ step: 1, label: '문서 확인' }, { step: 2, label: '연결·설정' }, { step: 3, label: '생성·불러오기' }];
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
  const recovery = useBrowserDraft('document-import', EMPTY_DOCUMENT_IMPORT, '1', DocumentImportDraftSchema);
  const { step, furthestStep, flowId, directory, output, preview, automaticPreview, bindings, production,
    reviewEntries, identityEvidence, preset, version, hold, storyboardName, createdPackages, packageAttempts } = recovery.value;
  const packageAttempt: DocumentImportDraft['packageAttempts'][number] | null = packageAttempts.at(-1) ?? null;
  const fieldSetter = <K extends keyof DocumentImportDraft,>(field: K): ((value: DocumentImportDraft[K] | ((previous: DocumentImportDraft[K]) => DocumentImportDraft[K])) => void) =>
    (value): void => { recovery.setValue((current: DocumentImportDraft): DocumentImportDraft => ({ ...current, flowId: current.flowId ?? crypto.randomUUID(),
      [field]: typeof value === 'function' ? (value as (previous: DocumentImportDraft[K]) => DocumentImportDraft[K])(current[field]) : value })); };
  const setStep = fieldSetter('step'); const setFurthestStep = fieldSetter('furthestStep');
  const setOutput = fieldSetter('output'); const setPreview = fieldSetter('preview'); const setAutomaticPreview = fieldSetter('automaticPreview');
  const setBindings = fieldSetter('bindings'); const setProduction = fieldSetter('production'); const setReviewEntries = fieldSetter('reviewEntries');
  const setIdentityEvidence = fieldSetter('identityEvidence'); const setPreset = fieldSetter('preset'); const setVersion = fieldSetter('version');
  const setHold = fieldSetter('hold'); const setStoryboardName = fieldSetter('storyboardName');
  const [verifiedSource, setVerifiedSource] = useState<string | null>(null);
  const sourceKey: string = JSON.stringify([directory.trim(), preview?.sourceFingerprint ?? null]);
  const needsSourceVerification: boolean = preview !== null && sourceKey !== verifiedSource;
  const [identityBusy, setIdentityBusy] = useState<boolean>(false);
  const [identityReviewPending, setIdentityReviewPending] = useState<boolean>(false);
  const createIndependent = useStoryboardCreation(props.onCreateIndependent);
  const [busy, setBusy] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [problems, setProblems] = useState<FieldProblem[]>([]);
  const [message, setMessage] = useState<string>('');
  const existing: boolean = preview !== null && props.existingProjectIds.includes(preview.projectId);
  const blocked: boolean = busy || props.working || identityBusy || recovery.blocked;
  const unresolved: number = preview === null ? 0 : mappingProblems(preview, bindings).length;
  const reviewDraft: ReviewDraft = { bindings, production, entries: reviewEntries };
  const applyReviewDraft = (draft: ReviewDraft): boolean => { const saved: boolean = recovery.setValue((current: DocumentImportDraft): DocumentImportDraft => ({ ...current, bindings: draft.bindings, production: draft.production, reviewEntries: draft.entries })); setProblems([]); setMessage(''); return saved; };
  const codexReview = useDocumentReview({ flowId, directory, preview: needsSourceVerification || recovery.blocked ? null : preview, draft: reviewDraft, preset, ...(identityEvidence === null ? {} : { identityEvidence }), onApplied: applyReviewDraft });
  const pendingReview: number = reviewEntries.filter((entry: ReviewAuditEntry): boolean => !entry.confirmed).length;
  const navigationBlocked: boolean = blocked || codexReview.working;
  const contentKey: string | null = preview === null || automaticPreview === null ? null : stableJsonStringify({
    directory: directory.trim(), production, identityEvidence, audit: buildDocumentReviewAudit(preview, automaticPreview, reviewDraft, preset),
  });
  const latestPackage: CreatedDocumentPackage | null = createdPackages.at(-1) ?? null;
  const handoffPath: string | null = latestPackage !== null && latestPackage.contentKey === contentKey ? latestPackage.handoffPath : null;
  const packageChanged: boolean = latestPackage !== null && handoffPath === null;
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
    if (identityReviewPending && !blocked && !needsSourceVerification) { setIdentityReviewPending(false); void codexReview.start(); }
  }, [identityReviewPending, blocked, needsSourceVerification]);

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
    if (pending.current || props.working || recovery.blocked) return;
    pending.current = true; setBusy(true); setError(null); setProblems([]); setMessage('');
    try { await action(); }
    catch (caught: unknown) { setError(apiErrorMessage(caught)); }
    finally { pending.current = false; setBusy(false); }
  };
  const clearSource = (value: string): void => {
    recovery.setValue({ ...EMPTY_DOCUMENT_IMPORT, directory: value, flowId: value === '' ? null : crypto.randomUUID() });
    setVerifiedSource(null); setIdentityReviewPending(false); codexReview.reset(); setError(null); setProblems([]); setMessage('');
  };
  const goBack = (): void => { setError(null); setProblems([]); setMessage(''); setStep(step === 3 ? 2 : 1); };
  const analyze = async (): Promise<void> => {
    if (!directory.trim()) { setProblems([{ id: 'document-directory', message: '제작 문서 8개가 있는 폴더 경로를 입력하세요.' }]); return; }
    const next: DocumentPreview = await previewDocumentPackage(directory.trim(), EMPTY_BINDINGS);
    if (preview !== null && next.projectId !== preview.projectId) clearSource(directory);
    if (next.sourceFingerprint !== preview?.sourceFingerprint) { setPreview(next); setAutomaticPreview(next); setBindings(EMPTY_BINDINGS); setReviewEntries([]); setIdentityEvidence(null); setFurthestStep(2); codexReview.reset(); }
    setVerifiedSource(JSON.stringify([directory.trim(), next.sourceFingerprint]));
    setStep(2);
  };
  const revalidateRestored = async (): Promise<void> => {
    if (preview === null) return;
    const automatic: DocumentPreview = await previewDocumentPackage(directory.trim(), EMPTY_BINDINGS);
    if (automatic.sourceFingerprint !== preview.sourceFingerprint) {
      setStep(1);
      throw new Error('보관한 검토 이후 원본 문서가 변경되었습니다. 입력은 유지했습니다. 문서 검토를 다시 실행하면 새 원본의 연결을 검토합니다.');
    }
    const next: DocumentPreview = await previewDocumentPackage(directory.trim(), { ...selectedBindings(bindings), units: [] });
    if (next.sourceFingerprint !== automatic.sourceFingerprint) throw new Error('원본 확인 중 문서가 변경되었습니다. 다시 확인하세요.');
    setPreview(next); setAutomaticPreview(automatic); setVerifiedSource(sourceKey);
    setMessage('현재 원본을 다시 확인했습니다. 복원한 연결과 제작 설정은 유지됩니다.');
  };
  const changeBinding = (field: MappingField, key: string, targetId: string): void => {
    noteManualEdit(field, key, targetId);
    setBindings((current: DocumentBindings): DocumentBindings => ({ ...current, [field]: [...current[field].filter((entry): boolean => entry.key !== key), { key, targetId }] }));
    setMessage('');
  };
  const reviewConnections = async (): Promise<DocumentPreview | null> => {
    if (preview === null || needsSourceVerification) throw new Error('현재 원본을 다시 확인한 뒤 연결을 검토하세요.');
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
    setStep(2);
    if (codexReview.working) { setError('Codex 검토가 끝나거나 취소한 뒤 다음 단계로 진행하세요.'); return; }
    if (pendingReview > 0) { setError(`Codex가 입력한 제안 ${pendingReview}개의 근거를 확인한 뒤 진행하세요.`); return; }
    const next: DocumentPreview | null = await reviewConnections();
    if (next === null) return;
    const result: ProductionReview = reviewProductionFields(production);
    const remaining: FieldProblem[] = [...mappingProblems(next, bindings), ...(result.valid ? [] : result.problems)];
    if (remaining.length > 0) { setProblems(remaining); return; }
    setFurthestStep(3); setStep(3);
  };
  const navigateToStep = (target: ImportStep): void => {
    if (navigationBlocked || pending.current || target === step || target > furthestStep || (needsSourceVerification && target !== 1)) return;
    if (target === 3) { void run(continueToPackage); return; }
    if (target === 2 && step === 1) { void run(analyze); return; }
    setError(null); setProblems([]); setMessage(''); setStep(target);
  };
  const create = async (): Promise<void> => {
    if (preview === null || automaticPreview === null || contentKey === null || needsSourceVerification) throw new Error('현재 원본을 먼저 확인하세요.');
    const result: ProductionReview = reviewProductionFields(production);
    if (!result.valid) { setProblems(result.problems); setStep(2); return; }
    const remaining: FieldProblem[] = [];
    if (!version.trim()) remaining.push({ id: 'document-version', message: '패키지 버전을 입력하세요.' });
    if (!output.trim()) remaining.push({ id: 'document-output', message: '새 패키지를 저장할 폴더 경로를 입력하세요.' });
    if (createdPackages.some((entry: CreatedDocumentPackage): boolean => entry.version === version.trim())) remaining.push({ id: 'document-version', message: '수정한 패키지에는 이전에 사용하지 않은 새 버전을 입력하세요.' });
    if (createdPackages.some((entry: CreatedDocumentPackage): boolean => entry.output === output.trim())) remaining.push({ id: 'document-output', message: '기존 패키지를 보존할 수 있도록 다른 새 폴더를 입력하세요.' });
    if (remaining.length > 0) { setProblems(remaining); return; }
    const settings: DocumentSettings = DocumentSettingsSchema.parse({ formatVersion: identityEvidence === null ? '1.1.0' : '1.2.0', ...(identityEvidence === null ? {} : { identityEvidence }), sourceFingerprint: preview.sourceFingerprint,
      packageVersion: version.trim(), timebase: result.timebase, profile: result.profile, bindings: selectedBindings(bindings),
      reviewAudit: buildDocumentReviewAudit(preview, automaticPreview, reviewDraft, preset) });
    const attempt: DocumentImportDraft['packageAttempts'][number] = { directory: directory.trim(), output: output.trim(), settings, contentKey, title: preview.title };
    if (!recovery.setValue((current: DocumentImportDraft): DocumentImportDraft => ({ ...current, packageAttempts: [...current.packageAttempts.filter((entry): boolean => JSON.stringify(entry) !== JSON.stringify(attempt)), attempt] }))) {
      throw new Error('생성 요청을 브라우저에 보관하지 못해 실행하지 않았습니다. 저장 공간·권한을 확인하세요.');
    }
    const created = await createDocumentPackage(attempt.directory, attempt.output, attempt.settings);
    recordPackage(attempt, created.handoffPath);
  };
  const recordPackage = (attempt: DocumentImportDraft['packageAttempts'][number], path: string): void => {
    if (!recovery.setValue((current: DocumentImportDraft): DocumentImportDraft => ({ ...current, packageAttempts: current.packageAttempts.filter((entry): boolean => JSON.stringify(entry) !== JSON.stringify(attempt)),
      storyboardName: `${attempt.title} — ${attempt.settings.packageVersion}`.slice(0, 120),
      createdPackages: [...current.createdPackages.filter((entry): boolean => entry.handoffPath !== path),
        { handoffPath: path, output: attempt.output, version: attempt.settings.packageVersion, contentKey: attempt.contentKey }] }))) {
      throw new Error(`패키지를 만들었지만 결과 보관을 완료하지 못했습니다. 생성 결과 확인으로 복구하세요: ${path}`);
    }
    setMessage('패키지 생성 완료');
  };
  const verifyAttempt = async (): Promise<void> => {
    if (packageAttempt === null) return;
    const result = await verifyDocumentPackage(packageAttempt.directory, packageAttempt.output, packageAttempt.settings);
    recordPackage(packageAttempt, result.handoffPath);
  };
  const applyIdentity = (result: IdentityPreview): void => {
    applyReviewDraft(applyIdentityMatches(reviewDraft, result.matches)); setIdentityEvidence(result.evidence);
    setError(null); setMessage('인물 원본의 연결을 적용했습니다. Codex가 보완된 입력을 검토합니다.'); setIdentityReviewPending(true);
    focusProblem('document-person-connections-title');
  };
  const savedIdentity = useSavedDocumentIdentity({ input: preview === null || needsSourceVerification ? null : { directory: directory.trim(), sourceFingerprint: preview.sourceFingerprint, bindings: selectedBindings(bindings) }, onBusy: setIdentityBusy, onApply: applyIdentity });
  const clearIdentity = (): void => {
    const keys: string[] = reviewEntries.filter((entry: ReviewAuditEntry): boolean => entry.origin === 'identity-document').map((entry: ReviewAuditEntry): string => entry.key);
    setBindings((current: DocumentBindings): DocumentBindings => ({ ...current, people: current.people.filter((entry): boolean => !keys.includes(entry.key)) }));
    setReviewEntries((current: ReviewAuditEntry[]): ReviewAuditEntry[] => current.filter((entry: ReviewAuditEntry): boolean => entry.origin !== 'identity-document'));
    setIdentityEvidence(null); codexReview.reset(); setMessage('보충 근거와 그 근거로 채운 연결을 해제했습니다.');
  };
  const importCreated = async (): Promise<void> => {
    if (handoffPath === null || needsSourceVerification) throw new Error('현재 원본과 생성 패키지를 먼저 확인하세요.');
    if (!Number.isSafeInteger(Number(hold)) || Number(hold) <= 0) {
      setProblems([{ id: 'document-hold', message: '초안 글자 유지 시간은 1 이상의 정수 밀리초로 입력하세요.' }]); return;
    }
    await props.onImport(handoffPath, Number(hold));
    props.onClose(); clearSource(''); setStep(1);
  };
  const startIndependent = async (): Promise<void> => {
    if (handoffPath === null || needsSourceVerification || flowId === null) throw new Error('현재 원본과 생성 패키지를 먼저 확인하세요.');
    await createIndependent(flowId, handoffPath, storyboardName, hold);
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
        <nav aria-label="패키지 제작 단계"><ol className="document-steps">{IMPORT_STEPS.map((item): ReactElement => <li key={item.step} className={step === item.step ? 'current' : furthestStep > item.step ? 'complete' : ''}>
          <button type="button" aria-label={`${item.step} ${item.label}`} aria-current={step === item.step ? 'step' : undefined} disabled={navigationBlocked || item.step > furthestStep || (needsSourceVerification && item.step !== 1)}
            onClick={(): void => { navigateToStep(item.step); }}><span>{String(item.step).padStart(2, '0')}</span>{item.label}</button></li>)}</ol></nav>
        <p className="document-navigation-help">완료한 단계는 위 버튼으로 다시 열 수 있습니다. 단계 이동 시 입력값은 유지됩니다.</p>
        <div className="document-page-heading"><span className="document-kicker">제작 문서 8개로 새 패키지 만들기</span>
          <h1 id="document-workflow-title" ref={heading} tabIndex={-1}>{step === 1 ? '어떤 이야기를 만들까요?' : step === 2 ? '연결과 제작 기준을 확인하세요' : handoffPath === null ? '새 패키지의 저장 위치를 정하세요' : '콘티 초안으로 이어가세요'}</h1>
          <p>{step === 1 ? '한 이야기의 제작 문서가 모인 폴더를 입력하세요.' : step === 2 ? '자동으로 확인한 연결을 검토하고, 남은 항목을 직접 지정합니다.' : '확인한 원문과 설정으로 다시 불러올 수 있는 패키지를 만듭니다.'}</p></div>
        {(error !== null || problems.length > 0) && <div className="document-error-summary" role="alert" tabIndex={-1} ref={errorSummary}>
          <strong>{error ?? '확인이 필요한 항목 ' + problems.length + '개'}</strong>
          {problems.length > 0 && <ul>{problems.map((problem: FieldProblem): ReactElement => <li key={problem.id}><button type="button" onClick={(): void => { focusProblem(problem.id); }}>{problem.message}</button></li>)}</ul>}
        </div>}
        <fieldset className="document-controls" disabled={busy || props.working || identityBusy || codexReview.working}>{recovery.notice}</fieldset>
        {needsSourceVerification && <div className="document-error-summary"><p>입력과 이전 검토 결과를 복원했습니다. 현재 원본을 다시 확인한 뒤 이어갈 수 있습니다. 생성·검토 요청은 자동으로 실행하지 않습니다.</p>
          <button type="button" disabled={blocked} onClick={(): void => { void run(revalidateRestored); }}>원본 다시 확인</button></div>}
        {packageAttempt !== null && <div className="document-package-changed"><strong>확인이 필요한 패키지 생성 요청 {packageAttempts.length}개</strong><p>응답을 받지 못했을 수 있습니다. 실제 파일을 확인하여 생성 결과를 복구할 수 있습니다.</p><code>{packageAttempt.output}</code>
          <button type="button" disabled={blocked} onClick={(): void => { void run(verifyAttempt); }}>생성 결과 확인</button></div>}
        <div className="document-layout">
          <div className="document-main">
            <fieldset className="document-controls" disabled={blocked || (needsSourceVerification && step !== 1)}>
              {step === 1 && <section className="document-section"><header><h2>제작 문서 폴더</h2><p>아래 파일 8개가 들어 있는 폴더를 선택합니다.</p></header>
                <label htmlFor="document-directory">제작 문서 폴더<input id="document-directory" value={directory} placeholder="/프로젝트/09_PRODUCTION" aria-invalid={problems.some((problem: FieldProblem): boolean => problem.id === 'document-directory')}
                  onChange={(event): void => { clearSource(event.target.value); }} onKeyDown={(event): void => { if (event.key === 'Enter') { event.preventDefault(); void run(analyze); } }} /></label>
                <FieldError id="document-directory" problems={problems} />
                <ul className="document-file-list">{DOCUMENT_FILES.map((file, index: number): ReactElement => <li key={file.key}><span>{String(index + 1).padStart(2, '0')}</span><div><strong>{DOCUMENT_LABELS[index]}</strong><code>{file.name}</code></div></li>)}</ul>
              </section>}
              {step === 2 && preview !== null && <><DocumentPersonConnections preview={preview} bindings={bindings} entries={reviewEntries} working={codexReview.working} saved={savedIdentity}
                onFocus={focusProblem} onConfirm={(name: string): void => { setReviewEntries((entries: ReviewAuditEntry[]): ReviewAuditEntry[] => entries.map((entry: ReviewAuditEntry): ReviewAuditEntry => entry.field === 'people' && entry.key === name ? { ...entry, confirmed: true } : entry)); }} />
                <DocumentReviewPanel controls={codexReview} entries={reviewEntries} preset={preset} onPreset={selectPreset}
                onConfirm={(key: string): void => { setReviewEntries((entries: ReviewAuditEntry[]): ReviewAuditEntry[] => entries.map((entry: ReviewAuditEntry): ReviewAuditEntry => reviewEntryKey(entry) === key ? { ...entry, confirmed: true } : entry)); }}
                onConfirmAll={(): void => { setReviewEntries((entries: ReviewAuditEntry[]): ReviewAuditEntry[] => entries.map((entry: ReviewAuditEntry): ReviewAuditEntry => ({ ...entry, confirmed: true }))); setError(null); }} />
                <DocumentIdentityPanel key={preview.sourceFingerprint} directory={directory} preview={preview} bindings={selectedBindings(bindings)} evidence={identityEvidence}
                  working={codexReview.working} onBusy={setIdentityBusy} onApply={applyIdentity} onClear={clearIdentity} />
                <DocumentMappings preview={preview} bindings={bindings} entries={reviewEntries} suggestions={codexReview.review?.result?.suggestions ?? []} problems={problems} onChange={changeBinding} onReview={(): void => { void run(review); }} />
                <DocumentProductionFields fields={production} entries={reviewEntries} problems={problems} onChange={(field: keyof ProductionFields, value: string): void => { noteManualEdit('production', field, value); setProduction((current: ProductionFields): ProductionFields => ({ ...current, [field]: value })); }} /></>}
              {step === 3 && preview !== null && <section className="document-section"><header><span className="document-kicker">패키지 출력</span><h2>저장 위치와 버전</h2><p>새 폴더에 원본 문서 8개, 연결·제작 설정, handoff 파일을 저장합니다.</p></header>
                {packageChanged && latestPackage !== null && <div className="document-package-changed"><strong>변경한 내용으로 새 패키지를 저장하세요</strong><p>기존 버전 {latestPackage.version}은 보존되어 있습니다. 현재 입력을 다시 검증하고 새 폴더와 버전으로 생성합니다.</p><code>{latestPackage.handoffPath}</code></div>}
                {handoffPath === null ? <div className="document-fields-grid"><label className="document-full-field" htmlFor="document-output">새 패키지 폴더<input id="document-output" aria-label="새 패키지 폴더" value={output} onChange={(event): void => { setOutput(event.target.value); }} aria-invalid={problems.some((problem: FieldProblem): boolean => problem.id === 'document-output')} /><small>원본 폴더 밖에 아직 존재하지 않는 새 폴더 경로를 입력하세요.</small><FieldError id="document-output" problems={problems} /></label>
                  <label className="document-full-field" htmlFor="document-version">패키지 버전<input id="document-version" aria-label="패키지 버전" value={version} placeholder="예: draft-01" onChange={(event): void => { setVersion(event.target.value); }} aria-invalid={problems.some((problem: FieldProblem): boolean => problem.id === 'document-version')} /><FieldError id="document-version" problems={problems} /></label></div>
                  : <div className="document-success"><strong>패키지 생성 완료</strong><p>버전 {latestPackage?.version}</p><code>{handoffPath}</code></div>}
                {handoffPath !== null && existing && <div className="document-import-created"><h3>별도 콘티로 새로 시작</h3><p>이 패키지로 새 콘티를 만들어 왼쪽 목록에 추가합니다. 기존 콘티의 컷·그림·음성은 보존합니다.</p>
                  <IndependentStoryboardFields name={storyboardName} hold={hold} onName={setStoryboardName} onHold={setHold} /></div>}
                {handoffPath !== null && !existing && <div className="document-import-created"><h3>편집용 초안 만들기</h3><p>종료 시각이 없는 화면 글자를 초안에서 얼마나 유지할지 지정하세요. 최종 출력 전에 각 시각을 확정합니다.</p>
                  <label htmlFor="document-hold">초안 글자 유지 시간 (ms)<input id="document-hold" aria-label="초안 글자 유지 시간 (ms)" type="number" min="1" step="1" value={hold} onChange={(event): void => { setHold(event.target.value); }} aria-invalid={problems.some((problem: FieldProblem): boolean => problem.id === 'document-hold')} /><FieldError id="document-hold" problems={problems} /></label></div>}
              </section>}
            </fieldset>
          </div>
          <aside className="document-overview" aria-label="가져오기 요약">
            <span className="document-kicker">{preview === null ? 'SOURCE TO STORYBOARD' : needsSourceVerification ? '보관된 문서 검토 · 8개' : '문서 검토 완료 · 8개'}</span>
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
    <footer className="document-footer"><div className="document-footer-inner"><div className="document-progress-note" role="status">{message || (error !== null && handoffPath !== null ? '패키지는 보존되었습니다. 오류를 해결한 뒤 다시 불러오세요.' : step === 1 ? '8개 파일의 내용과 연결을 검토합니다.' : step === 2 ? '연결 확인 필요 ' + unresolved + '개 · ' + (reviewProductionFields(production).valid ? '제작 설정 입력 완료' : '제작 설정을 지정하세요.') : packageChanged ? '수정한 내용은 아직 새 패키지로 저장하지 않았습니다.' : handoffPath !== null && existing ? '파일 생성 완료 · 새 콘티 이름과 글자 유지 시간을 입력한 뒤 콘티를 생성하세요.' : handoffPath === null ? '아직 파일을 생성하지 않았습니다.' : '초안 글자 유지 시간을 입력하고 불러오세요.')}</div>
      <div className="document-footer-actions">{step > 1 && <button type="button" className="document-secondary" disabled={navigationBlocked} onClick={goBack}>이전 단계</button>}
        {step === 3 && handoffPath !== null && existing ? <button type="button" className="document-primary" disabled={blocked || needsSourceVerification} onClick={(): void => { void run(startIndependent); }}>{busy ? '콘티 생성 중…' : '별도 콘티 생성·열기'}</button>
          : <button type="button" className="document-primary" disabled={blocked || (needsSourceVerification && step !== 1)} onClick={nextAction}>{nextLabel}<span aria-hidden="true"> →</span></button>}
        {step === 3 && latestPackage !== null && <button type="button" className="document-secondary" disabled={navigationBlocked} onClick={(): void => { clearSource(''); setStep(1); }}>다른 패키지 만들기</button>}
      </div></div></footer>
  </dialog>;
}

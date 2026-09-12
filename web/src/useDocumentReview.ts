import { useEffect, useRef, useState } from 'react';
import type { ReactElement } from 'react';
import type { IdentityEvidence } from '../../src/documents/identity-schema.js';
import type { DocumentPreview } from '../../src/documents/schema.js';
import type { DocumentReviewInput } from '../../src/documents/review-input.js';
import type { ProductionPreset, ReviewAuditEntry, ReviewState } from '../../src/documents/review-model.js';
import { ApiError, apiErrorMessage, cancelDocumentReview, documentReviewStatus, listDocumentPresets, readDocumentReview, saveDocumentPreset, startDocumentReview, validateDocumentReview } from './api.js';
import { selectedBindings, reviewProductionFields } from './document-import-state.js';
import { documentBindingsEqual, mergeDocumentReview } from './document-review-state.js';
import type { ReviewDraft } from './document-review-state.js';
import { ProductionFieldSchema } from '../../src/documents/review-model.js';
import { stableJsonStringify } from '../../src/io/stable-json.js';
import { DocumentReviewRecoverySchema } from './document-review-recovery.js';
import type { DocumentReviewRecovery } from './document-review-recovery.js';
import { useBrowserDraft } from './useBrowserDraft.js';

type ReviewProps = { flowId: string | null; identityEvidence?: IdentityEvidence; directory: string; preview: DocumentPreview | null; draft: ReviewDraft; preset: ProductionPreset | null; onApplied: (draft: ReviewDraft) => boolean };
export type ReviewControls = { review: ReviewState | null; working: boolean; configured: boolean | null; error: string | null; note: string; presets: ProductionPreset[];
  recoveryNotice: ReactElement | null; savedRequestId: string | null; recoveryBlocked: boolean; reconnect: () => Promise<void>; resend: () => Promise<void>; canResend: boolean;
  start: () => Promise<void>; cancel: () => Promise<void>; savePreset: (name: string) => Promise<ProductionPreset | null>;
  edited: (key: string) => void; reset: () => void };

export function useDocumentReview(props: ReviewProps): ReviewControls {
  const latest = useRef<ReviewProps>(props); latest.current = props;
  const recovery = useBrowserDraft(`document-review:${props.flowId}`, null, 'request-reference-v1', DocumentReviewRecoverySchema.nullable());
  const saved = useRef(recovery); saved.current = recovery;
  const edits = useRef<Set<string>>(new Set<string>());
  const basis = useRef<DocumentReviewInput | null>(null);
  const activeId = useRef<string | null>(null);
  const sending = useRef<boolean>(false);
  const generation = useRef<number>(0);
  const activeFlowId = useRef<string | null>(props.flowId);
  const [pollEpoch, setPollEpoch] = useState<number>(0);
  const [review, setReview] = useState<ReviewState | null>(null);
  const [working, setWorking] = useState<boolean>(false);
  const [configured, setConfigured] = useState<boolean | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string>('');
  const [canResend, setCanResend] = useState<boolean>(false);
  const [presets, setPresets] = useState<ProductionPreset[]>([]);
  useEffect((): void => {
    if (activeFlowId.current === props.flowId) return;
    activeFlowId.current = props.flowId; generation.current += 1; activeId.current = null; basis.current = null; edits.current = new Set<string>();
    setReview(null); setWorking(false); setError(null); setNote(''); setCanResend(false);
  }, [props.flowId]);
  useEffect((): (() => void) => {
    let live: boolean = true;
    void Promise.all([documentReviewStatus(), listDocumentPresets()]).then(([runtime, list]): void => {
      if (live) { setConfigured(runtime.configured); setPresets(list); }
    }).catch((caught: unknown): void => { if (live) setError(apiErrorMessage(caught)); });
    return (): void => { live = false; };
  }, []);

  const receive = async (next: ReviewState, isCurrent: () => boolean): Promise<void> => {
    if (!isCurrent()) return;
    setReview(next);
    if (next.status === 'running') return;
    if (next.status !== 'completed') { setError(next.error?.message ?? `검토가 ${next.status} 상태로 종료되었습니다.`); setWorking(false); return; }
    const original: DocumentReviewInput | null = basis.current;
    if (original === null || saved.current.value?.requestId !== next.id) throw new Error('검토 요청의 입력 기준이 없습니다. 다시 연결하거나 현재 값으로 검토하세요.');
    if (saved.current.blocked) throw new Error('보관한 검토 요청에 충돌이나 저장 오류가 있습니다. 기록을 확인한 뒤 다시 연결하세요.');
    await validateDocumentReview(next.id, original);
    if (!isCurrent()) return;
    const remembered: DocumentReviewRecovery | null = saved.current.value;
    if (saved.current.blocked || remembered?.requestId !== next.id || stableJsonStringify(remembered.input) !== stableJsonStringify(original)) {
      throw new Error('검증 중 보관한 검토 요청이 바뀌었습니다. 입력을 보존했습니다. 사용할 기록을 확인한 뒤 다시 연결하세요.');
    }
    const current: ReviewProps = latest.current;
    if (current.preview?.sourceFingerprint !== original.sourceFingerprint || current.directory.trim() !== original.directory
      || stableJsonStringify(current.identityEvidence ?? null) !== stableJsonStringify(original.identityEvidence ?? null)) {
      throw new Error('검토 중 원본 또는 연결을 수정했습니다. 입력값은 유지했습니다. 현재 원본을 확인하고 다시 검토하세요.');
    }
    if (remembered.applied) { setNote('이미 반영한 검토 결과를 다시 불러왔습니다. 현재 입력과 확인 상태는 유지했습니다.'); setWorking(false); return; }
    if (!documentBindingsEqual(selectedBindings(current.draft.bindings), original.bindings)
      || current.preset?.id !== (original.presetId ?? undefined)
      || [...edits.current, ...remembered.editedKeys].some((key: string): boolean => !key.startsWith('["production",'))) {
      throw new Error('검토 중 원본 또는 연결을 수정했습니다. 입력값은 유지했습니다. 현재 값으로 다시 검토하세요.');
    }
    const protectedKeys: Set<string> = new Set([...edits.current, ...remembered.editedKeys,
      ...ProductionFieldSchema.options.filter((key): boolean => current.draft.production[key] !== original.production[key]).map((key): string => JSON.stringify(['production', key]))]);
    const merged: ReviewDraft = mergeDocumentReview(current.draft, next, protectedKeys);
    if (!current.onApplied(merged)) throw new Error('검토 결과를 입력에 반영했지만 브라우저 보관을 확인하지 못했습니다. 입력 복원 안내를 확인하세요.');
    if (!saved.current.setValue({ ...remembered, editedKeys: [...protectedKeys], applied: true })) throw new Error('검토 반영 기록을 보관하지 못했습니다. 현재 입력을 보존하고 브라우저 저장 상태를 확인하세요.');
    const count: number = merged.entries.filter((entry: ReviewAuditEntry): boolean => entry.reviewId === next.id).length;
    setNote(original.identityEvidence !== undefined && count === 0 ? '보충 인물 근거 검토를 완료했습니다. 적용한 연결과 기존 설정을 유지했습니다.' : `${count}개 입력값을 채웠습니다. 추론과 추천의 근거를 확인하세요.`); setWorking(false);
  };

  useEffect((): (() => void) | undefined => {
    if (review?.status !== 'running') return undefined;
    const id: string = review.id; let live: boolean = true; let timer: ReturnType<typeof setTimeout> | null = null;
    const isCurrent = (): boolean => live && activeId.current === id && activeFlowId.current === latest.current.flowId;
    const poll = async (): Promise<void> => {
      try {
        const next: ReviewState = await readDocumentReview(id);
        if (!isCurrent()) return;
        if (next.status === 'running') { timer = setTimeout((): void => { void poll(); }, 1000); return; }
        await receive(next, isCurrent);
      } catch (caught: unknown) { if (isCurrent()) { setError(apiErrorMessage(caught)); setWorking(false); } }
    };
    timer = setTimeout((): void => { void poll(); }, 500);
    return (): void => { live = false; if (timer !== null) clearTimeout(timer); };
  }, [review?.id, pollEpoch]);

  const restoreRequest = async (load: (remembered: DocumentReviewRecovery) => Promise<ReviewState>): Promise<void> => {
    const remembered: DocumentReviewRecovery | null = saved.current.value;
    if (sending.current || working || saved.current.blocked || remembered === null) return;
    if (latest.current.preview === null) { setError('현재 원본을 다시 확인한 뒤 이전 검토에 연결하세요.'); return; }
    if (latest.current.preview.sourceFingerprint !== remembered.input.sourceFingerprint || latest.current.directory.trim() !== remembered.input.directory
      || stableJsonStringify(latest.current.identityEvidence ?? null) !== stableJsonStringify(remembered.input.identityEvidence ?? null)) {
      setError('보관한 검토 요청과 현재 원본이 다릅니다. 입력을 보존했습니다. 현재 값으로 새 검토를 시작하세요.'); setCanResend(false); return;
    }
    const startedGeneration: number = generation.current;
    const isCurrent = (): boolean => generation.current === startedGeneration && activeId.current === remembered.requestId && activeFlowId.current === latest.current.flowId;
    activeId.current = remembered.requestId; basis.current = structuredClone(remembered.input); edits.current = new Set(remembered.editedKeys);
    sending.current = true; setWorking(true); setError(null); setNote(''); setCanResend(false);
    try {
      const next: ReviewState = await load(remembered);
      await receive(next, isCurrent);
      if (isCurrent() && next.status === 'running') { setNote('같은 검토 요청에 다시 연결했습니다. 진행 상태와 결과를 확인합니다.'); setPollEpoch((value: number): number => value + 1); }
    } catch (caught: unknown) { if (isCurrent()) {
      setError(apiErrorMessage(caught)); setWorking(false);
      setCanResend(caught instanceof ApiError && ['DOCUMENT_REVIEW_NOT_FOUND', 'NETWORK_REQUEST_FAILED', 'DOCUMENT_REVIEW_BUSY'].includes(caught.code));
    } }
    finally { sending.current = false; }
  };
  const reconnect = (): Promise<void> => restoreRequest((remembered: DocumentReviewRecovery): Promise<ReviewState> => readDocumentReview(remembered.requestId));
  const resend = (): Promise<void> => restoreRequest((remembered: DocumentReviewRecovery): Promise<ReviewState> => startDocumentReview(remembered.requestId, remembered.input));

  const start = async (): Promise<void> => {
    if (sending.current || working || recovery.blocked) return;
    const current: ReviewProps = latest.current;
    if (current.preview === null) { setError('먼저 문서 폴더를 검토하세요.'); return; }
    sending.current = true; setWorking(true); setReview(null); activeId.current = null; setError(null); setNote(''); setCanResend(false); edits.current = new Set<string>();
    const input: DocumentReviewInput = { directory: current.directory.trim(), sourceFingerprint: current.preview.sourceFingerprint,
      bindings: selectedBindings(current.draft.bindings), production: current.draft.production, presetId: current.preset?.id ?? null, ...(current.identityEvidence === undefined ? {} : { identityEvidence: current.identityEvidence }) };
    basis.current = structuredClone(input);
    const startedGeneration: number = generation.current;
    const id: string = crypto.randomUUID(); activeId.current = id;
    const isCurrent = (): boolean => generation.current === startedGeneration && activeId.current === id && activeFlowId.current === latest.current.flowId;
    try {
      if (!saved.current.setValue({ requestId: id, input: structuredClone(input), editedKeys: [], applied: false })) throw new Error('검토 요청을 브라우저에 보관하지 못해 전송하지 않았습니다. 저장 상태를 확인하세요.');
      const next: ReviewState = await startDocumentReview(id, input);
      if (generation.current !== startedGeneration) { await cancelDocumentReview(next.id); return; }
      await receive(next, isCurrent);
      setPollEpoch((value: number): number => value + 1);
    }
    catch (caught: unknown) { if (generation.current === startedGeneration) {
      setError(apiErrorMessage(caught)); setWorking(false);
      setCanResend(caught instanceof ApiError && ['NETWORK_REQUEST_FAILED', 'DOCUMENT_REVIEW_BUSY'].includes(caught.code));
    } }
    finally { sending.current = false; }
  };
  const cancel = async (): Promise<void> => {
    if (activeId.current === null) return;
    try { const next: ReviewState = await cancelDocumentReview(activeId.current); activeId.current = null; setReview(next); setWorking(false); setNote('검토를 취소했습니다. 입력값은 유지됩니다.'); }
    catch (caught: unknown) { setError(apiErrorMessage(caught)); }
  };
  const savePreset = async (name: string): Promise<ProductionPreset | null> => {
    if (latest.current.draft.entries.some((entry: ReviewAuditEntry): boolean => entry.field === 'production' && !entry.confirmed)) { setError('제작 설정 추천의 근거를 확인한 뒤 프리셋으로 저장하세요.'); return null; }
    const result = reviewProductionFields(latest.current.draft.production);
    if (!result.valid) { setError('유효한 제작 설정을 모두 입력한 뒤 프리셋으로 저장하세요.'); return null; }
    if (!name.trim()) { setError('제작 프리셋 이름을 입력하세요.'); return null; }
    try {
      const saved: ProductionPreset = await saveDocumentPreset(name.trim(), latest.current.draft.production);
      setPresets((current: ProductionPreset[]): ProductionPreset[] => [...current, saved]); setError(null); setNote('제작 프리셋을 저장했습니다. 다른 스토리에서도 선택할 수 있습니다.'); return saved;
    } catch (caught: unknown) { setError(apiErrorMessage(caught)); return null; }
  };
  const reset = (): void => {
    generation.current += 1; saved.current.setValue(null); setCanResend(false);
    const id: string | null = activeId.current; activeId.current = null; basis.current = null; setReview(null); setNote(''); setError(null); setWorking(false);
    if (id !== null && working) void cancelDocumentReview(id).catch((caught: unknown): void => { setError(apiErrorMessage(caught)); });
  };
  return { review, working, configured, error, note, presets, start, cancel, savePreset, reconnect, resend, canResend,
    recoveryNotice: recovery.notice, savedRequestId: recovery.value?.requestId ?? null, recoveryBlocked: recovery.blocked || props.preview === null,
    edited: (key: string): void => {
      edits.current.add(key);
      const remembered: DocumentReviewRecovery | null = saved.current.value;
      if (remembered !== null && !remembered.applied) saved.current.setValue({ ...remembered, editedKeys: [...new Set([...remembered.editedKeys, key])] });
    }, reset };
}

import { useEffect, useRef, useState } from 'react';
import type { DocumentPreview } from '../../src/documents/schema.js';
import type { DocumentReviewInput } from '../../src/documents/review-input.js';
import type { ProductionPreset, ReviewAuditEntry, ReviewState } from '../../src/documents/review-model.js';
import { apiErrorMessage, cancelDocumentReview, documentReviewStatus, listDocumentPresets, readDocumentReview, saveDocumentPreset, startDocumentReview, validateDocumentReview } from './api.js';
import { selectedBindings, reviewProductionFields } from './document-import-state.js';
import { documentBindingsEqual, mergeDocumentReview } from './document-review-state.js';
import type { ReviewDraft } from './document-review-state.js';

type ReviewProps = { directory: string; preview: DocumentPreview | null; draft: ReviewDraft; preset: ProductionPreset | null; onApplied: (draft: ReviewDraft) => void };
export type ReviewControls = { review: ReviewState | null; working: boolean; configured: boolean | null; error: string | null; note: string; presets: ProductionPreset[];
  start: () => Promise<void>; cancel: () => Promise<void>; savePreset: (name: string) => Promise<ProductionPreset | null>;
  edited: (key: string) => void; reset: () => void };

export function useDocumentReview(props: ReviewProps): ReviewControls {
  const latest = useRef<ReviewProps>(props); latest.current = props;
  const edits = useRef<Set<string>>(new Set<string>());
  const basis = useRef<DocumentReviewInput | null>(null);
  const activeId = useRef<string | null>(null);
  const sending = useRef<boolean>(false);
  const generation = useRef<number>(0);
  const [pollEpoch, setPollEpoch] = useState<number>(0);
  const [review, setReview] = useState<ReviewState | null>(null);
  const [working, setWorking] = useState<boolean>(false);
  const [configured, setConfigured] = useState<boolean | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string>('');
  const [presets, setPresets] = useState<ProductionPreset[]>([]);
  useEffect((): (() => void) => {
    let live: boolean = true;
    void Promise.all([documentReviewStatus(), listDocumentPresets()]).then(([runtime, list]): void => {
      if (live) { setConfigured(runtime.configured); setPresets(list); }
    }).catch((caught: unknown): void => { if (live) setError(apiErrorMessage(caught)); });
    return (): void => { live = false; };
  }, []);

  useEffect((): (() => void) | undefined => {
    if (review?.status !== 'running') return undefined;
    const id: string = review.id; let live: boolean = true; let timer: ReturnType<typeof setTimeout> | null = null;
    const poll = async (): Promise<void> => {
      try {
        const next: ReviewState = await readDocumentReview(id);
        if (!live || activeId.current !== id) return;
        if (next.status === 'running') { timer = setTimeout((): void => { void poll(); }, 1000); return; }
        setReview(next);
        if (next.status !== 'completed') { setError(next.error?.message ?? `검토가 ${next.status} 상태로 종료되었습니다.`); setWorking(false); return; }
        const original: DocumentReviewInput | null = basis.current;
        if (original === null) throw new Error('검토 요청의 입력 기준이 없습니다. 다시 검토하세요.');
        await validateDocumentReview(id, original);
        if (!live || activeId.current !== id) return;
        const current: ReviewProps = latest.current;
        if (current.preview?.sourceFingerprint !== original.sourceFingerprint || current.directory.trim() !== original.directory
          || !documentBindingsEqual(selectedBindings(current.draft.bindings), original.bindings)
          || [...edits.current].some((key: string): boolean => !key.startsWith('["production",'))) {
          throw new Error('검토 중 원본 또는 연결을 수정했습니다. 입력값은 유지했습니다. 현재 값으로 다시 검토하세요.');
        }
        const merged: ReviewDraft = mergeDocumentReview(current.draft, next, edits.current);
        current.onApplied(merged);
        const count: number = merged.entries.filter((entry: ReviewAuditEntry): boolean => entry.reviewId === id).length;
        setNote(`${count}개 입력값을 채웠습니다. 추론과 추천의 근거를 확인하세요.`); setWorking(false);
      } catch (caught: unknown) { if (live && activeId.current === id) { setError(apiErrorMessage(caught)); setWorking(false); } }
    };
    timer = setTimeout((): void => { void poll(); }, 500);
    return (): void => { live = false; if (timer !== null) clearTimeout(timer); };
  }, [review?.id, pollEpoch]);

  const start = async (): Promise<void> => {
    if (sending.current || working) return;
    const current: ReviewProps = latest.current;
    if (current.preview === null) { setError('먼저 문서 폴더를 검토하세요.'); return; }
    sending.current = true; setWorking(true); setReview(null); activeId.current = null; setError(null); setNote(''); edits.current = new Set<string>();
    const input: DocumentReviewInput = { directory: current.directory.trim(), sourceFingerprint: current.preview.sourceFingerprint,
      bindings: selectedBindings(current.draft.bindings), production: current.draft.production, presetId: current.preset?.id ?? null };
    basis.current = structuredClone(input);
    const startedGeneration: number = generation.current;
    try {
      const next: ReviewState = await startDocumentReview(input);
      if (generation.current !== startedGeneration) { await cancelDocumentReview(next.id); return; }
      activeId.current = next.id; setReview(next); setPollEpoch((value: number): number => value + 1);
    }
    catch (caught: unknown) { if (generation.current === startedGeneration) { setError(apiErrorMessage(caught)); setWorking(false); } }
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
    generation.current += 1;
    const id: string | null = activeId.current; activeId.current = null; basis.current = null; setReview(null); setNote(''); setError(null); setWorking(false);
    if (id !== null && working) void cancelDocumentReview(id).catch((caught: unknown): void => { setError(apiErrorMessage(caught)); });
  };
  return { review, working, configured, error, note, presets, start, cancel, savePreset,
    edited: (key: string): void => { edits.current.add(key); }, reset };
}

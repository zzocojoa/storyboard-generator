import { useEffect, useRef, useState } from 'react';
import type { IdentityBasis, IdentityPreview, SavedIdentityPreview } from '../../src/documents/identity-schema.js';
import { apiErrorMessage, savedDocumentIdentity, validateSavedDocumentIdentity } from './api.js';

export type SavedIdentityControls = { result: SavedIdentityPreview | null; error: string | null; loading: boolean; apply: () => Promise<void> };

/** 현재 8개 문서에 검증된 저장 근거를 제시하고 적용 시 같은 요청과 입력을 다시 검사한다. */
export function useSavedDocumentIdentity(props: { input: IdentityBasis | null; onBusy: (busy: boolean) => void; onApply: (result: IdentityPreview) => void }): SavedIdentityControls {
  const basis: string = JSON.stringify(props.input);
  const current = useRef<string>(basis); current.current = basis;
  const latest = useRef<typeof props>(props); latest.current = props;
  const pending = useRef<boolean>(false);
  const [saved, setSaved] = useState<{ basis: string; result: SavedIdentityPreview | null } | null>(null);
  const [failure, setFailure] = useState<{ basis: string; message: string } | null>(null);
  const [loading, setLoading] = useState<boolean>(false);
  useEffect((): (() => void) => {
    let live: boolean = true;
    const input: IdentityBasis | null = props.input;
    setSaved(null); setFailure(null);
    if (input === null) { setLoading(false); return (): void => { live = false; }; }
    setLoading(true);
    void savedDocumentIdentity(input).then((result: SavedIdentityPreview | null): void => {
      if (live && current.current === basis) setSaved({ basis, result });
    }).catch((error: unknown): void => {
      if (live && current.current === basis) setFailure({ basis, message: apiErrorMessage(error) });
    }).finally((): void => { if (live) setLoading(false); });
    return (): void => { live = false; };
  }, [basis]);
  const apply = async (): Promise<void> => {
    const input: IdentityBasis | null = props.input;
    if (pending.current || input === null || saved?.basis !== basis || saved.result === null) return;
    pending.current = true; props.onBusy(true); setFailure(null);
    try {
      const result: SavedIdentityPreview = await validateSavedDocumentIdentity(input, saved.result.reviewId);
      if (current.current !== basis) throw new Error('적용 중 원본 또는 연결이 바뀌었습니다. 현재 값에서 다시 확인하세요.');
      latest.current.onApply(result);
    } catch (error: unknown) { if (current.current === basis) setFailure({ basis, message: apiErrorMessage(error) }); }
    finally { pending.current = false; latest.current.onBusy(false); }
  };
  return { result: saved?.basis === basis ? saved.result : null, error: failure?.basis === basis ? failure.message : null, loading, apply };
}

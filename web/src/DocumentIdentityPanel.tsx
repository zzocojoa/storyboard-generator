import { useRef, useState } from 'react';
import type { ReactElement } from 'react';
import type { IdentityEvidence, IdentityPreview } from '../../src/documents/identity-schema.js';
import type { DocumentBindings, DocumentPreview } from '../../src/documents/schema.js';
import { apiErrorMessage, previewDocumentIdentity, validateDocumentIdentity } from './api.js';
import type { IdentityRequest } from './api.js';

type IdentityPanelProps = { directory: string; preview: DocumentPreview; bindings: DocumentBindings; evidence: IdentityEvidence | null;
  working: boolean; onBusy: (busy: boolean) => void; onApply: (result: IdentityPreview) => void; onClear: () => void };

export function DocumentIdentityPanel(props: IdentityPanelProps): ReactElement {
  const [charactersPath, setCharactersPath] = useState<string>('');
  const [footprintPath, setFootprintPath] = useState<string>('');
  const [result, setResult] = useState<IdentityPreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<boolean>(false);
  const pending = useRef<boolean>(false);
  const latest = useRef<IdentityPanelProps>(props); latest.current = props;
  const input: IdentityRequest = { directory: props.directory.trim(), sourceFingerprint: props.preview.sourceFingerprint, bindings: props.bindings, charactersPath, footprintPath };
  const basis: string = JSON.stringify(input);
  const currentBasis = useRef<string>(basis); currentBasis.current = basis;
  const [verifiedBasis, setVerifiedBasis] = useState<string | null>(null);
  const checkBasis = (): void => {
    if (currentBasis.current !== basis) throw new Error('검토 중 입력이 바뀌었습니다. 현재 값으로 근거를 다시 확인하세요.');
  };
  const readPreview = async (): Promise<IdentityPreview> => {
    if (!charactersPath.trim() || !footprintPath.trim()) throw new Error('인물 원본과 제작 근거 파일 경로를 모두 입력하세요.');
    const next: IdentityPreview = await previewDocumentIdentity(input);
    checkBasis();
    return next;
  };
  const applyVerified = async (preview: IdentityPreview): Promise<void> => {
    const next: IdentityPreview = await validateDocumentIdentity(input, preview.evidence);
    checkBasis();
    latest.current.onApply(next); setResult(null);
  };
  const inspect = async (): Promise<void> => {
    if (pending.current) return;
    pending.current = true; setBusy(true); props.onBusy(true); setError(null); setResult(null);
    try {
      const next: IdentityPreview = await readPreview();
      setResult(next); setVerifiedBasis(basis);
    } catch (caught: unknown) { setError(apiErrorMessage(caught)); }
    finally { pending.current = false; setBusy(false); latest.current.onBusy(false); }
  };
  const apply = async (): Promise<void> => {
    if (pending.current || result === null || basis !== verifiedBasis) return;
    pending.current = true; setBusy(true); props.onBusy(true); setError(null);
    try {
      await applyVerified(result);
    } catch (caught: unknown) { setError(apiErrorMessage(caught)); }
    finally { pending.current = false; setBusy(false); latest.current.onBusy(false); }
  };
  const connect = async (): Promise<void> => {
    if (pending.current) return;
    pending.current = true; setBusy(true); props.onBusy(true); setError(null); setResult(null);
    try { await applyVerified(await readPreview()); }
    catch (caught: unknown) { setError(apiErrorMessage(caught)); }
    finally { pending.current = false; setBusy(false); latest.current.onBusy(false); }
  };
  return <section className="document-section document-identity" aria-labelledby="document-identity-title">
    <header><span className="document-kicker">연결 근거 보완</span><h2 id="document-identity-title">인물 대응표로 보완</h2>
      <p>선택 사항입니다. 연결이 남았을 때 두 파일의 전체 경로를 입력하면, 같은 프로젝트의 원본인지 검증한 뒤 이름에 맞는 ID를 자동 선택합니다. 이미 연결을 마쳤으면 추가할 필요가 없습니다.</p></header>
    {props.evidence !== null && <div className="document-identity-applied" role="status"><strong>보충 인물 근거 적용됨</strong><p>검증한 원본 사본과 해시를 패키지에 함께 저장합니다.</p>
      <button type="button" className="document-secondary" disabled={props.working || busy} onClick={props.onClear}>보충 근거 해제</button></div>}
    <div className="document-fields-grid">
      <label className="document-full-field">인물 원본 파일<input id="document-identity-characters" aria-label="인물 원본 파일" value={charactersPath} disabled={busy || props.working} placeholder="선택한 프로젝트의 characters.json 경로" onChange={(event): void => { setCharactersPath(event.target.value); setResult(null); }} /><small>이름과 ID가 함께 기록된 인물표입니다. 인물 사진이 아닌 JSON 파일 경로를 입력하세요.</small></label>
      <label className="document-full-field">제작 근거 파일<input aria-label="제작 근거 파일" value={footprintPath} disabled={busy || props.working} placeholder="선택한 프로젝트의 production_footprint.json 경로" onChange={(event): void => { setFootprintPath(event.target.value); setResult(null); }} /><small>위 인물표가 현재 8개 제작 문서의 원본인지 확인하는 production_footprint.json 파일입니다.</small></label>
    </div><details className="document-source"><summary>지원 파일 형식 확인</summary><p className="document-help">production-characters-v1 · 인물표의 project_id, characters[].name·character_id와 production-footprint 1.0.0의 연결 해시가 필요합니다.</p></details>
    <div className="document-review-actions"><button type="button" className="document-primary" disabled={busy || props.working} onClick={(): void => { void connect(); }}>{busy ? '인물 연결 처리 중…' : '근거 확인 후 자동 연결'}</button>
      <button type="button" className="document-secondary" disabled={busy || props.working} onClick={(): void => { void inspect(); }}>인물 근거 확인</button></div>
    <p className="document-help">자동 연결은 빈칸만 채우고 Codex 검토로 이어집니다. 결과는 위의 ‘최종 인물 연결’에 표시합니다. 적용 전에 대응표를 먼저 보려면 ‘인물 근거 확인’을 누르세요.</p>
    {error !== null && <p role="alert" className="document-review-error">{error}</p>}
    {result !== null && basis === verifiedBasis && <div className="document-identity-results"><strong>프로젝트·원본 버전·이름·ID 검증 완료</strong>
      <ul>{result.matches.map((match): ReactElement => <li key={match.name}><strong>{match.name}</strong> · {match.currentId ?? '미연결'} → {match.targetId} · {match.currentId === null ? '새 연결' : '기존 값 유지'}<small>인물 원본 · {match.locator}</small></li>)}</ul>
      <button type="button" className="document-primary" disabled={busy || props.working} onClick={(): void => { void apply(); }}>연결 적용하고 Codex 검토</button></div>}
  </section>;
}

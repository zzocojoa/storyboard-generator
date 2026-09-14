import { useEffect, useState } from 'react';
import type { ReactElement } from 'react';
import { z } from 'zod';
import { TextTypographySchema } from '../../src/domain/text-typography.js';
import type { TextFontCatalog, TextTypography } from '../../src/domain/text-typography.js';
import type { TextLayoutPreview } from '../../src/rendering/text-response.js';
import { apiErrorMessage, fetchTextFonts, previewTextTypography } from './api.js';
import { useBrowserDraft } from './useBrowserDraft.js';

const DraftSchema = z.strictObject({ version: z.literal('1.0.0'), language: z.string(), fontId: z.string(), fontSha256: z.string() });
type Preview = { basis: string; value: TextLayoutPreview };

export function TextTypographySettings(props: { projectId: string; revision: number; value: TextTypography | undefined; atMs: number; working: boolean; onSave: (value: TextTypography) => Promise<void> }): ReactElement {
  const recovery = useBrowserDraft(JSON.stringify([props.projectId, 'text-typography']),
    props.value ?? { version: '1.0.0' as const, language: 'und', fontId: '', fontSha256: '' }, String(props.revision), DraftSchema);
  const draft = recovery.value;
  const [catalog, setCatalog] = useState<TextFontCatalog | null>(null);
  const [refresh, setRefresh] = useState<number>(0);
  const [catalogError, setCatalogError] = useState<string>('');
  const [previewError, setPreviewError] = useState<string>('');
  const [preview, setPreview] = useState<Preview | null>(null);
  const [previewing, setPreviewing] = useState<boolean>(false);
  const basis: string = JSON.stringify([props.projectId, props.revision, props.atMs, draft]);
  const parsed = TextTypographySchema.safeParse(draft);
  const selected = catalog?.fonts.find((font): boolean => font.id === draft.fontId);
  const changedFile: boolean = selected !== undefined && selected.sha256 !== draft.fontSha256;
  const canSave: boolean = parsed.success && selected !== undefined && !changedFile && !recovery.blocked && !props.working;
  useEffect((): (() => void) => {
    let active: boolean = true;
    setCatalog(null); setCatalogError('');
    void fetchTextFonts().then((value): void => { if (active) setCatalog(value); }, (error: unknown): void => { if (active) setCatalogError(apiErrorMessage(error)); });
    return (): void => { active = false; };
  }, [refresh]);
  const inspect = async (): Promise<void> => {
    if (!canSave || !parsed.success) return;
    setPreviewing(true); setPreviewError('');
    try {
      const value = await previewTextTypography(props.projectId, props.revision, parsed.data, props.atMs);
      if (value.projectId !== props.projectId || value.revision !== props.revision || value.fontSha256 !== parsed.data.fontSha256 || value.atMs !== props.atMs) throw new Error('글꼴 미리보기의 기준이 다릅니다. 다시 확인하세요.');
      setPreview({ basis, value });
    } catch (error: unknown) { setPreviewError(apiErrorMessage(error)); }
    finally { setPreviewing(false); }
  };
  return <form className="text-typography-settings" aria-label="글꼴과 언어" onSubmit={(event): void => { event.preventDefault(); if (canSave && parsed.success) void props.onSave(parsed.data); }}>
    <header>화면 글꼴과 언어</header>{recovery.notice}
    <p>이 콘티의 화면 글자와 PDF 그림에 적용할 글꼴입니다. 자동 글자 배치도 선택한 글꼴의 실제 폭으로 검토합니다.</p>
    {props.value === undefined && <p>현재는 실행 환경의 기본 글꼴을 사용합니다. 아래에서 선택해 저장하면 이 콘티에 글꼴 버전이 기록됩니다.</p>}
    <div className="text-layout-fields"><label>화면 글꼴<select aria-label="화면 글꼴" value={draft.fontId} disabled={catalog === null} onChange={(event): void => {
      const font = catalog?.fonts.find((item): boolean => item.id === event.target.value);
      if (font !== undefined) recovery.setValue({ ...draft, fontId: font.id, fontSha256: font.sha256 });
    }}><option value="">글꼴 선택</option>
      {draft.fontId !== '' && selected === undefined && <option value={draft.fontId}>{draft.fontId} · 현재 사용할 수 없음</option>}
      {catalog?.fonts.map((font): ReactElement => <option key={font.id} value={font.id}>{font.label} · {font.postscriptName}</option>)}
    </select></label>
    <label>문구 언어<input aria-label="문구 언어" list="cutroom-text-languages" value={draft.language} onChange={(event): void => { recovery.setValue({ ...draft, language: event.target.value }); }} />
      <datalist id="cutroom-text-languages"><option value="und">미지정</option><option value="ko">한국어</option><option value="en">영어</option><option value="ja">일본어</option><option value="zh-Hans">중국어 간체</option><option value="zh-Hant">중국어 번체</option></datalist>
      <small>ko, en, ja, zh-Hans 등 언어 태그 · 미지정은 und</small></label></div>
    {catalogError !== '' && <p role="alert">{catalogError}</p>}
    {catalog?.unavailable.map((font): ReactElement => <p role="alert" key={font.id}>{font.label}: {font.message}</p>)}
    <button type="button" onClick={(): void => { setRefresh((value): number => value + 1); }}>글꼴 목록 다시 확인</button>
    {changedFile && <div role="alert"><p>선택한 글꼴 파일이 저장된 버전과 다릅니다. 원래 파일을 복원하거나 현재 파일을 새 버전으로 선택하세요.</p>
      <button type="button" onClick={(): void => { if (selected !== undefined) recovery.setValue({ ...draft, fontSha256: selected.sha256 }); }}>현재 글꼴 파일 선택</button></div>}
    {draft.fontId !== '' && !parsed.success && <p role="alert">올바른 문구 언어와 글꼴을 지정하세요.</p>}
    <div className="form-actions"><button type="button" disabled={!canSave || previewing} onClick={(): void => { void inspect(); }}>{previewing ? '미리보기 중' : '선택한 글꼴 미리보기'}</button>
      <button disabled={!canSave}>글꼴·언어 저장</button></div>
    {previewError !== '' && <p role="alert">{previewError}</p>}
    {preview !== null && preview.basis === basis && <section aria-label="글꼴 미리보기"><p>첫 글자 시점 · {preview.value.atMs}ms · 초안 배치 검토 {preview.value.issues.length}건</p>
      <img style={{ width: '100%', maxHeight: 320, background: '#e6e8df', objectFit: 'contain' }} alt="선택한 글꼴로 조판한 화면 글자" src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(preview.value.svg)}`} />
      {preview.value.issues.map((item, index): ReactElement => <p key={`${item.entityId}:${item.code}:${index}`}>{item.message}</p>)}</section>}
  </form>;
}

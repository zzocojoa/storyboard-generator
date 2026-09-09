import { useRef, useState } from 'react';
import type { ReactElement } from 'react';
import { DocumentSettingsSchema } from '../../src/documents/schema.js';
import type { DocumentBindings, DocumentPreview, MappingChoice } from '../../src/documents/schema.js';
import { createDocumentPackage, previewDocumentPackage } from './api.js';

type MappingField = keyof DocumentBindings;
const EMPTY_BINDINGS: DocumentBindings = { people: [], scenes: [], units: [] };

export function DocumentImportPanel(props: { working: boolean; onImport: (path: string, holdMs: number) => Promise<void> }): ReactElement {
  const [directory, setDirectory] = useState<string>('');
  const [output, setOutput] = useState<string>('');
  const [preview, setPreview] = useState<DocumentPreview | null>(null);
  const [bindings, setBindings] = useState<DocumentBindings>(EMPTY_BINDINGS);
  const [busy, setBusy] = useState<boolean>(false);
  const pending = useRef<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [handoffPath, setHandoffPath] = useState<string | null>(null);
  const [fps, setFps] = useState<string>('');
  const [sampleRate, setSampleRate] = useState<string>('');
  const [width, setWidth] = useState<string>('');
  const [height, setHeight] = useState<string>('');
  const [startTimecode, setStartTimecode] = useState<string>('00:00:00:00');
  const [version, setVersion] = useState<string>('');
  const [hold, setHold] = useState<string>('');
  const run = async (action: () => Promise<void>): Promise<void> => {
    if (pending.current || props.working) return;
    pending.current = true; setBusy(true); setError(null);
    try { await action(); }
    catch (caught: unknown) { if (!(caught instanceof Error)) throw caught; setError(caught.message); }
    finally { pending.current = false; setBusy(false); }
  };
  const analyze = async (): Promise<void> => {
    const next: DocumentPreview = await previewDocumentPackage(directory, bindings);
    setPreview(next); setHandoffPath(null);
  };
  const changeBinding = (field: MappingField, key: string, targetId: string): void => {
    setBindings((current: DocumentBindings): DocumentBindings => ({ ...current, [field]: [...current[field].filter((entry): boolean => entry.key !== key), ...(targetId === '' ? [] : [{ key, targetId }])] }));
    setHandoffPath(null);
  };
  const create = async (): Promise<void> => {
    if (preview === null) throw new Error('먼저 문서를 검토하세요.');
    const parts: string[] = fps.split('/');
    const settings = DocumentSettingsSchema.parse({ formatVersion: '1.0.0', sourceFingerprint: preview.sourceFingerprint, packageVersion: version,
      timebase: { fpsNumerator: Number(parts[0]), fpsDenominator: Number(parts[1]), dropFrame: false, sampleRate: Number(sampleRate), startTimecode },
      profile: { medium: 'unspecified', aspectWidth: Number(width), aspectHeight: Number(height), visualStyle: null }, bindings });
    const result = await createDocumentPackage(directory, output, settings);
    setHandoffPath(result.handoffPath);
  };
  const choices = (field: MappingField, title: string): ReactElement => <fieldset><legend>{title}</legend>{preview?.[field].filter((choice: MappingChoice): boolean => field !== 'units' || choice.selected === null).map((choice: MappingChoice): ReactElement => {
    const value: string = bindings[field].find((entry): boolean => entry.key === choice.key)?.targetId ?? choice.selected ?? '';
    return <label key={choice.key}>{choice.label}<select aria-label={`${title}: ${choice.key}`} value={value} onChange={(event): void => { changeBinding(field, choice.key, event.target.value); }}>
      <option value="">연결 선택 필요</option>{choice.candidates.map((id: string): ReactElement => <option key={id} value={id}>{id}</option>)}</select>
      <small>{choice.sourceRefs.map((ref): string => `${ref.fileId}:${ref.locator}`).join(' · ')}{choice.selected !== null ? ' · 연결 선택됨' : ''}</small></label>;
  })}</fieldset>;
  return <details className="document-import"><summary>제작 문서 8개로 새 패키지 만들기</summary>
    <fieldset className="import-panel" disabled={busy || props.working}>
      <p>8개 제작 문서가 있는 폴더를 검토하고 인물 연결과 제작 설정을 지정하세요.</p>
      <label>제작 문서 폴더<input value={directory} onChange={(event): void => { setDirectory(event.target.value); setPreview(null); setBindings(EMPTY_BINDINGS); setHandoffPath(null); }} /></label>
      <button type="button" disabled={busy || props.working || directory === ''} onClick={(): void => { void run(analyze); }}>문서 검토</button>
      {preview !== null && <>
        <p>{preview.title} · {preview.counts.scenes}장면 · {preview.counts.segments}구간 · 원문 {preview.counts.units}개</p>
        {preview.notices.map((notice: string): ReactElement => <p key={notice}>{notice}</p>)}
        {choices('people', '인물 ID')}{choices('scenes', '장면 ID')}{choices('units', '원문 구간')}
        <button type="button" disabled={busy || props.working} onClick={(): void => { void run(analyze); }}>연결 다시 확인</button>
        <label>프레임레이트<select aria-label="프레임레이트" value={fps} onChange={(event): void => { setFps(event.target.value); setHandoffPath(null); }}><option value="">선택</option>{['24/1', '25/1', '30/1', '30000/1001', '60/1'].map((value: string): ReactElement => <option key={value} value={value}>{value}</option>)}</select></label>
        <label>음성 샘플레이트<select aria-label="음성 샘플레이트" value={sampleRate} onChange={(event): void => { setSampleRate(event.target.value); setHandoffPath(null); }}><option value="">선택</option>{[44100, 48000, 96000].map((value: number): ReactElement => <option key={value} value={value}>{value} Hz</option>)}</select></label>
        <label>화면비 가로<input type="number" min="1" value={width} onChange={(event): void => { setWidth(event.target.value); setHandoffPath(null); }} /></label>
        <label>화면비 세로<input type="number" min="1" value={height} onChange={(event): void => { setHeight(event.target.value); setHandoffPath(null); }} /></label>
        <label>시작 타임코드<input value={startTimecode} onChange={(event): void => { setStartTimecode(event.target.value); setHandoffPath(null); }} /></label>
        <label>패키지 버전<input value={version} onChange={(event): void => { setVersion(event.target.value); setHandoffPath(null); }} /></label>
        <label>새 패키지 폴더<input value={output} onChange={(event): void => { setOutput(event.target.value); setHandoffPath(null); }} /></label>
        <button type="button" disabled={busy || props.working || !fps || !sampleRate || !width || !height || !version || !output} onClick={(): void => { void run(create); }}>패키지 생성</button>
      </>}
      {handoffPath !== null && <div role="status"><p>패키지 생성 완료: {handoffPath}</p>
        <label>초안 글자 유지 시간 (ms)<input type="number" min="1" value={hold} onChange={(event): void => { setHold(event.target.value); }} /></label>
        <button type="button" disabled={busy || props.working || Number(hold) <= 0} onClick={(): void => { void run(async (): Promise<void> => { await props.onImport(handoffPath, Number(hold)); }); }}>생성 패키지 불러오기</button></div>}
      {error !== null && <p role="alert">{error}</p>}
    </fieldset>
  </details>;
}

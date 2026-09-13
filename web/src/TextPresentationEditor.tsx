import { useState } from 'react';
import type { ReactElement } from 'react';
import { z } from 'zod';
import type { Project, TextCue } from '../../src/domain/schema.js';
import { initialTextPresentation, TextPresentationValuesSchema } from '../../src/domain/text-presentation.js';
import type { TextPresentationValues } from '../../src/domain/text-presentation.js';
import type { TextLayoutPreview } from '../../src/rendering/text-response.js';
import { apiErrorMessage, previewTextPresentation } from './api.js';
import { TextCompositionPreview } from './TextCompositionPreview.js';
import { useBrowserDraft } from './useBrowserDraft.js';

const DraftSchema = TextPresentationValuesSchema.extend({ x: z.number(), y: z.number(), width: z.number(), fontSize: z.number(), layer: z.number() });
const numericFields: readonly { key: 'x' | 'y' | 'width' | 'fontSize' | 'layer'; label: string; scale: number; min: number; max: number; step: number }[] = [
  { key: 'x', label: '가로 위치 %', scale: 100, min: 0, max: 100, step: 1 }, { key: 'y', label: '세로 위치 %', scale: 100, min: 0, max: 100, step: 1 },
  { key: 'width', label: '글자 영역 폭 %', scale: 100, min: 10, max: 100, step: 1 }, { key: 'fontSize', label: '개별 글자 크기 %', scale: 100, min: 2, max: 12, step: 0.1 },
  { key: 'layer', label: '레이어', scale: 1, min: 0, max: 99, step: 1 },
];

export function TextPresentationEditor(props: { project: Project; cue: TextCue; working: boolean;
  onSave: (cueId: string, value: TextPresentationValues) => Promise<void>; onReset: (cueId: string) => Promise<void> }): ReactElement {
  const { mode: _mode, ...saved } = props.cue.presentation ?? { ...initialTextPresentation(props.project.textLayout, props.cue.kind), mode: 'manual' };
  const recovery = useBrowserDraft(JSON.stringify([props.project.projectId, 'text-presentation', props.cue.id]), saved, String(props.project.revision), DraftSchema);
  const draft = recovery.value; const parsed = TextPresentationValuesSchema.safeParse(draft);
  const [preview, setPreview] = useState<{ basis: string; value: TextLayoutPreview } | null>(null);
  const [largePreview, setLargePreview] = useState<string | null>(null);
  const [error, setError] = useState<string>(''); const [busy, setBusy] = useState<boolean>(false);
  const basis: string = JSON.stringify([props.project.projectId, props.project.revision, props.cue.id, props.cue.startMs, draft]);
  const disabled: boolean = props.working || recovery.blocked || !parsed.success;
  const inspect = async (): Promise<void> => {
    if (disabled || !parsed.success) return;
    setBusy(true); setError('');
    try {
      const value = await previewTextPresentation(props.project.projectId, props.cue.id, props.project.revision, parsed.data, props.cue.startMs, null);
      if (value.projectId !== props.project.projectId || value.revision !== props.project.revision || value.atMs !== props.cue.startMs) throw new Error('개별 배치 미리보기의 기준이 변경됐습니다. 다시 확인하세요.');
      setPreview({ basis, value });
    } catch (failure: unknown) { setError(apiErrorMessage(failure)); }
    finally { setBusy(false); }
  };
  return <details className="text-presentation-editor"><summary>개별 글자 배치 · {props.cue.presentation === undefined ? '공통 프리셋' : props.cue.presentation.mode === 'manual' ? '직접 지정' : 'Codex 배치'}</summary>
    <form aria-label={`개별 글자 배치 ${props.cue.id}`} onSubmit={(event): void => { event.preventDefault(); if (!disabled && parsed.success) void props.onSave(props.cue.id, parsed.data); }}>
      {recovery.notice}<p>이 문구의 위치와 표현만 정합니다. 원문과 표시 시간은 유지됩니다. 레이어가 달라도 글자 겹침은 검토해야 합니다.</p>
      <div className="pair">{numericFields.map((field): ReactElement => <label className="field" key={field.key}>{field.label}<input type="number" min={field.min} max={field.max} step={field.step}
        value={Number((draft[field.key] * field.scale).toFixed(3))} onChange={(event): void => { recovery.setValue({ ...draft, [field.key]: Number(event.target.value) / field.scale }); }} /></label>)}</div>
      <label className="field">세로 기준<select value={draft.verticalAnchor} onChange={(event): void => { recovery.setValue({ ...draft, verticalAnchor: TextPresentationValuesSchema.shape.verticalAnchor.parse(event.target.value) }); }}><option value="top">영역 위쪽</option><option value="center">영역 가운데</option><option value="bottom">영역 아래쪽</option></select></label>
      <label className="field">글자 정렬<select value={draft.alignment} onChange={(event): void => { recovery.setValue({ ...draft, alignment: TextPresentationValuesSchema.shape.alignment.parse(event.target.value) }); }}><option value="left">왼쪽</option><option value="center">가운데</option><option value="right">오른쪽</option></select></label>
      <label className="field">글자 배경<select value={draft.background} onChange={(event): void => { recovery.setValue({ ...draft, background: TextPresentationValuesSchema.shape.background.parse(event.target.value) }); }}><option value="dark">어두운 배경 · 흰 글자</option><option value="light">밝은 배경 · 어두운 글자</option></select></label>
      {!parsed.success && <p role="alert">위치·폭·크기·레이어의 허용 범위를 확인하세요.</p>}
      <div className="track-actions"><button type="button" disabled={disabled || busy} onClick={(): void => { void inspect(); }}>{busy ? '미리보기 중' : '개별 배치 미리보기'}</button><button disabled={disabled}>개별 배치 저장</button>
        <button type="button" disabled={props.working || recovery.blocked || props.cue.presentation === undefined} onClick={(): void => { void props.onReset(props.cue.id); }}>공통 배치 사용</button></div>
      {error !== '' && <p role="alert">{error}</p>}
      {preview !== null && preview.basis === basis && <section aria-label="개별 배치 미리보기"><img alt="개별 글자 배치를 적용한 화면" style={{ width: '100%', maxHeight: 320, objectFit: 'contain', background: '#e6e8df' }} src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(preview.value.svg)}`} />
        <button type="button" disabled={disabled} onClick={(): void => { setLargePreview(basis); }}>그림과 크게 보기</button>
        {largePreview === basis && parsed.success && <TextCompositionPreview key={basis} project={props.project} cue={props.cue} presentation={parsed.data} initial={preview.value} onClose={(): void => { setLargePreview(null); }} />}
        {preview.value.issues.filter((item): boolean => item.entityId === props.cue.id).map((item, index): ReactElement => <p key={`${item.code}:${index}`}>{item.message}</p>)}</section>}
    </form></details>;
}

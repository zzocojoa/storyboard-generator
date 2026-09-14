import { z } from 'zod';
import { useBrowserDraft } from './useBrowserDraft.js';
import type { ReactElement } from 'react';
import { TextLayoutPresetSchema } from '../../src/domain/text-layout-settings.js';
import type { TextLayoutPreset } from '../../src/domain/text-layout-settings.js';
import type { TextLayoutControl } from '../../src/domain/text-layout-control.js';
import type { TextPresetReview } from '../../src/automation/text-preset-review.js';

type NumericField = 'fontSize' | 'lineHeight' | 'safeMargin' | 'padding' | 'gap' | 'maxLines';
const fields: readonly { key: NumericField; label: string; min: number; max: number; step: number; factor: number }[] = [
  { key: 'fontSize', label: '글자 크기 · 짧은 변의 %', min: 2, max: 12, step: 0.1, factor: 100 },
  { key: 'lineHeight', label: '줄 간격', min: 1.1, max: 2, step: 0.1, factor: 1 },
  { key: 'safeMargin', label: '안전 여백 %', min: 2, max: 20, step: 0.5, factor: 100 },
  { key: 'padding', label: '글자 안쪽 여백 %', min: 0, max: 4, step: 0.5, factor: 100 },
  { key: 'gap', label: '글자 영역 간격 %', min: 0, max: 8, step: 0.5, factor: 100 },
  { key: 'maxLines', label: '최대 줄 수', min: 1, max: 12, step: 1, factor: 1 },
];
const roles = [{ kind: 'overlay', label: '화면 고지 위치' }, { kind: 'prop-text', label: '소품 글자 위치' }, { kind: 'dialogue-subtitle', label: '대사 자막 위치' }] as const;

export function TextLayoutSettings(props: { projectId: string; revision: number; value: TextLayoutPreset; mode: TextLayoutControl['mode']; review: TextPresetReview | null; working: boolean; onSave: (value: TextLayoutPreset, mode: TextLayoutControl['mode']) => Promise<void> }): ReactElement {
  const recovery = useBrowserDraft(JSON.stringify([props.projectId, 'text-layout']), { draft: props.value, mode: props.mode }, String(props.revision), z.strictObject({ draft: TextLayoutPresetSchema.extend({ fontSize: z.number(), lineHeight: z.number(), safeMargin: z.number(), padding: z.number(), gap: z.number(), maxLines: z.number() }), mode: z.enum(['automatic', 'manual']) }));
  const { draft, mode } = recovery.value;
  const valid: boolean = TextLayoutPresetSchema.safeParse(draft).success;
  return <form className="text-layout-settings" aria-label="글자 배치 설정" onSubmit={(event): void => { event.preventDefault(); if (valid && !recovery.blocked) void props.onSave(draft, mode); }}>
    <header>글자 배치</header>{recovery.notice}<p>화면 고지·소품 글자·대사 자막을 같은 글꼴로 조판합니다. 검토 화면과 PDF에 같은 설정이 적용됩니다. 원문과 표시 시각은 유지됩니다.</p>
    <label className="text-layout-choice">배치 설정 방식<select value={mode} onChange={(event): void => { recovery.setValue({ draft, mode: event.target.value as TextLayoutControl['mode'] }); }}>
      <option value="automatic">Codex 자동 설정</option><option value="manual">직접 지정한 설정 유지</option></select></label>
    <p>자동 설정은 다음 자동 제작에서 콘티 전체의 문구 길이·종류·화면비를 검토합니다. 값을 직접 바꾸면 수동 설정으로 전환됩니다. 확정된 표시 시각은 유지하며, 확정·잠금 컷이나 승인 그림이 있으면 현재 배치를 보존합니다.</p>
    <div className="text-layout-fields">{fields.map((field): ReactElement => <label key={field.key}>{field.label}<input type="number" required min={field.min} max={field.max} step={field.step}
      value={Math.round(draft[field.key] * field.factor * 1000) / 1000} onChange={(event): void => { recovery.setValue({ mode: 'manual', draft: { ...draft, [field.key]: Number(event.target.value) / field.factor } }); }} /></label>)}
      {roles.map(({ kind, label }): ReactElement => <label key={kind}>{label}<select value={draft.positions[kind]} onChange={(event): void => { recovery.setValue({ mode: 'manual', draft: { ...draft, positions: { ...draft.positions, [kind]: event.target.value as TextLayoutPreset['positions']['overlay'] } } }); }}>
        <option value="top">위</option><option value="center">가운데</option><option value="bottom">아래</option></select></label>)}</div>
    <p>같은 위치의 글자는 순서대로 쌓습니다. 넘침·겹침은 검토 항목으로 표시하며, 내용을 자르지 않습니다. 글꼴은 위의 화면 글꼴·언어 설정을 사용합니다.</p>
    {props.review?.status === 'invalid' && <p role="alert">{props.review.message}</p>}
    {props.review?.status === 'recorded' && <section className="text-layout-review" aria-label="최근 자동 글자 배치"><h4>Codex의 배치 제안</h4><p>{props.review.reason}</p>
      <p>{props.review.matchesCurrentPreset ? '현재 저장한 배치와 같습니다.' : '제안 이후 배치 설정이 변경됐습니다.'} 생성 당시 검토 {props.review.problems.length}건 · {props.review.model}</p>
      {props.review.problems.length > 0 && <details><summary>생성 당시 남은 검토</summary>{props.review.problems.map((problem) => <p key={`${problem.code}:${problem.cueId}`}>{problem.message}</p>)}</details>}
    </section>}
    <button disabled={props.working || recovery.blocked || !valid}>글자 배치 저장</button><span role="status">{mode !== props.mode || JSON.stringify(draft) !== JSON.stringify(props.value) ? '저장하지 않은 글자 설정' : '저장된 글자 설정'}</span>
  </form>;
}

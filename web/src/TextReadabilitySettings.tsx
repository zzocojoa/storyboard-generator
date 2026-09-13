import { z } from 'zod';
import { useBrowserDraft } from './useBrowserDraft.js';
import type { ReactElement } from 'react';
import { TextReadabilityPolicySchema } from '../../src/domain/text-readability.js';
import type { TextReadabilityPolicy } from '../../src/domain/text-readability.js';

const fields: readonly { key: 'graphemesPerSecond' | 'minHoldMs' | 'maxHoldMs'; label: string; min: number; max: number; step: number }[] = [
  { key: 'graphemesPerSecond', label: '읽기 속도 · 초당 표시 문자', min: 2, max: 40, step: 0.5 },
  { key: 'minHoldMs', label: '최소 표시 시간 ms', min: 250, max: 10000, step: 50 },
  { key: 'maxHoldMs', label: '최대 표시 시간 ms', min: 1000, max: 60000, step: 50 },
];

export function TextReadabilitySettings(props: { projectId: string; revision: number; value: TextReadabilityPolicy; working: boolean; onSave: (value: TextReadabilityPolicy) => Promise<void> }): ReactElement {
  const recovery = useBrowserDraft(JSON.stringify([props.projectId, 'text-readability']), props.value, String(props.revision), z.strictObject({ version: z.literal('1.0.0'), graphemesPerSecond: z.number(), minHoldMs: z.number(), maxHoldMs: z.number() }));
  const draft: TextReadabilityPolicy = recovery.value; const setDraft = recovery.setValue;
  const validation = TextReadabilityPolicySchema.safeParse(draft);
  return <form className="text-layout-settings text-readability-settings" aria-label="글자 읽기 기준" onSubmit={(event): void => { event.preventDefault(); if (validation.success && !recovery.blocked) void props.onSave(draft); }}>
    <header>글자 읽기 기준</header>{recovery.notice}
    <p>자동 제작에서 미확정 글자의 표시 시간을 계획하는 기준입니다. 공백을 제외한 표시 문자 묶음을 셉니다. 초기값은 수정 가능한 초안 기준이며 작품의 확정 지시가 아닙니다.</p>
    <div className="text-layout-fields">{fields.map((field): ReactElement => <label key={field.key}>{field.label}<input type="number" required min={field.min} max={field.max} step={field.step} value={draft[field.key]}
      onChange={(event): void => { setDraft({ ...draft, [field.key]: Number(event.target.value) }); }} /></label>)}</div>
    <p>저장하면 검토 항목을 다시 계산합니다. 원문과 현재 시각은 유지하며 다음 자동 계획부터 적용합니다. 확정한 시각은 자동 변경하지 않습니다.</p>
    {!validation.success && <p role="alert">{validation.error.issues.map((problem): string => problem.message).join(' · ')}</p>}
    <button disabled={props.working || recovery.blocked || !validation.success}>읽기 기준 저장</button><span role="status">{JSON.stringify(draft) === JSON.stringify(props.value) ? '저장된 읽기 기준' : '저장하지 않은 읽기 기준'}</span>
  </form>;
}

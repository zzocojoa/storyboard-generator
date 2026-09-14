import { useState } from 'react';
import type { ReactElement } from 'react';
import { z } from 'zod';
import type { Project } from '../../src/domain/schema.js';
import type { ReviewedSourceImpact } from './api.js';
import { useBrowserDraft } from './useBrowserDraft.js';

const SourceUpdateDraftSchema = z.strictObject({ path: z.string(), hold: z.string() });
const EMPTY_SOURCE_UPDATE = { path: '', hold: '2000' };

export function SourceUpdateForm(props: { project: Project; working: boolean;
  onPreview: (path: string, holdMs: number) => Promise<ReviewedSourceImpact | null>;
  onApply: (path: string, holdMs: number, basisSha256: string) => Promise<void>;
}): ReactElement {
  const draft = useBrowserDraft(`source-update:${props.project.projectId}`, EMPTY_SOURCE_UPDATE, String(props.project.revision), SourceUpdateDraftSchema);
  const [checked, setChecked] = useState<{ key: string; review: ReviewedSourceImpact } | null>(null);
  const { path, hold } = draft.value;
  const holdMs: number = Number(hold);
  const valid: boolean = path.trim() !== '' && Number.isSafeInteger(holdMs) && holdMs > 0;
  const blocked: boolean = props.working || draft.blocked || !valid;
  const key: string = JSON.stringify([props.project.projectId, props.project.revision, path.trim(), holdMs]);
  const review: ReviewedSourceImpact | null = checked?.key === key && !draft.blocked ? checked.review : null;
  const preview = async (): Promise<void> => {
    if (blocked) return;
    setChecked(null);
    const result: ReviewedSourceImpact | null = await props.onPreview(path.trim(), holdMs);
    if (result !== null) setChecked({ key, review: result });
  };
  const apply = async (): Promise<void> => {
    if (blocked || review?.impact.canApply !== true) return;
    setChecked(null);
    await props.onApply(path.trim(), holdMs, review.basisSha256);
  };
  return <section className="source-update-form" aria-label="원본 업데이트">
    <header>원본 업데이트</header>
    <p className="empty-note">새 handoff를 검토한 뒤 변경 영향을 확인하세요. 원본 적용은 기존 컷에 영향을 줍니다. 복원된 입력의 변경 영향은 다시 확인해야 합니다.</p>
    {draft.notice !== null && <fieldset className="automation-start-fields" disabled={props.working}>{draft.notice}</fieldset>}
    <label className="field"><span>새 handoff 파일 경로</span><input aria-label="새 handoff 파일 경로" disabled={props.working} value={path} onChange={(event): void => { draft.setValue({ ...draft.value, path: event.target.value }); }} placeholder="새 handoff 파일 경로" /></label>
    <label className="field"><span>초안 글자 유지 시간 (ms)</span><input aria-label="원본 업데이트 초안 글자 유지 시간 (ms)" disabled={props.working} type="number" min="1" value={hold} onChange={(event): void => { draft.setValue({ ...draft.value, hold: event.target.value }); }} /></label>
    {(!Number.isSafeInteger(holdMs) || holdMs <= 0) && <p role="alert">초안 글자 유지 시간을 1 이상의 정수로 입력하세요.</p>}
    <button disabled={blocked} onClick={(): void => { void preview(); }}>변경 영향 확인</button>
    {review !== null && <div className={review.impact.canApply ? 'impact ready' : 'impact blocked'}><b>{review.impact.canApply ? 'APPLY READY' : 'LOCKED IMPACT'}</b><span>{review.impact.changedSourceFileIds.length} FILES · {review.impact.impactedSegmentIds.length} SEGMENTS · {review.impact.impactedShotIds.length} CUTS</span>{review.impact.lockedShotIds.length > 0 && <p>잠긴 컷: {review.impact.lockedShotIds.join(', ')}</p>}</div>}
    <button className="source-apply" disabled={blocked || review?.impact.canApply !== true} onClick={(): void => { void apply(); }}>새 원본 적용</button>
  </section>;
}

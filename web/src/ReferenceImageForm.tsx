import { useEffect, useRef, useState } from 'react';
import type { FormEvent, ReactElement } from 'react';
import { z } from 'zod';
import { productionLocations } from '../../src/domain/production-resources.js';
import type { Project } from '../../src/domain/schema.js';
import { useBrowserDraft } from './useBrowserDraft.js';

const ReferenceInputSchema = z.strictObject({ kind: z.enum(['character', 'location', 'prop']), subjectId: z.string(), description: z.string() });
type ReferenceInput = z.infer<typeof ReferenceInputSchema>;
export type ReferenceDraft = ReferenceInput & { file: File | null };
const EMPTY_REFERENCE: ReferenceInput = { kind: 'character', subjectId: '', description: '' };

export function ReferenceImageForm(props: { project: Project; working: boolean; onRegister: (draft: ReferenceDraft) => Promise<void> }): ReactElement {
  const draft = useBrowserDraft(`reference-image:${props.project.projectId}`, EMPTY_REFERENCE, String(props.project.revision), ReferenceInputSchema);
  const reference: ReferenceInput = draft.value;
  const [selection, setSelection] = useState<{ key: string; file: File } | null>(null);
  const input = useRef<HTMLInputElement | null>(null);
  const targetKey: string = JSON.stringify([props.project.projectId, props.project.revision, reference.kind, reference.subjectId]);
  const file: File | null = selection?.key === targetKey ? selection.file : null;
  const subjects = reference.kind === 'character' ? props.project.dataset.people : reference.kind === 'location' ? productionLocations(props.project) : [];
  const missingTarget: boolean = reference.kind !== 'prop' && reference.subjectId !== '' && !subjects.some((subject): boolean => subject.id === reference.subjectId);
  const blocked: boolean = props.working || draft.blocked || missingTarget || file === null || reference.description.trim() === '' || reference.kind !== 'prop' && reference.subjectId === '';
  useEffect((): void => { setSelection(null); if (input.current !== null) input.current.value = ''; }, [targetKey]);
  const upload = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (!blocked) void props.onRegister({ ...reference, file });
  };
  return <form className="reference-form" aria-label="기준 이미지 등록" onSubmit={upload}>
    <header>기준 이미지</header>
    {draft.notice !== null && <fieldset className="automation-start-fields" disabled={props.working}>{draft.notice}</fieldset>}
    <label className="field"><span>기준 이미지 종류</span><select aria-label="기준 이미지 종류" disabled={props.working} value={reference.kind} onChange={(event): void => { draft.setValue({ ...reference, kind: ReferenceInputSchema.shape.kind.parse(event.target.value), subjectId: '' }); }}><option value="character">인물</option><option value="location">장소</option><option value="prop">소품</option></select></label>
    {reference.kind !== 'prop' && <label className="field"><span>연결 대상</span><select aria-label="기준 이미지 대상" disabled={props.working} required value={reference.subjectId} onChange={(event): void => { draft.setValue({ ...reference, subjectId: event.target.value }); }}><option value="">대상 선택</option>{missingTarget && <option value={reference.subjectId}>현재 원본에 없는 대상 · {reference.subjectId}</option>}{subjects.map((subject): ReactElement => <option key={subject.id} value={subject.id}>{subject.name}</option>)}</select></label>}
    {missingTarget && <p role="alert">복원한 기준 이미지 대상이 현재 원본에 없습니다. 대상을 다시 선택하세요.</p>}
    <label className="field"><span>외형·상태 설명</span><input aria-label="외형·상태 설명" disabled={props.working} required placeholder="외형·상태 설명" value={reference.description} onChange={(event): void => { draft.setValue({ ...reference, description: event.target.value }); }} /></label>
    <label className="field"><span>기준 이미지 파일</span><input ref={input} aria-label="기준 이미지 파일" disabled={props.working} required type="file" accept="image/png,image/jpeg,image/webp" onChange={(event): void => { const selected: File | undefined = event.target.files?.[0]; setSelection(selected === undefined ? null : { key: targetKey, file: selected }); }} /></label>
    {file === null && <p className="empty-note">등록할 이미지 파일을 선택하세요. 파일 선택은 복원하지 않으며 원본 버전이나 대상을 바꾸면 다시 선택해야 합니다.</p>}
    <button disabled={blocked}>기준 이미지 등록</button>
  </form>;
}

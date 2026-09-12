import type { ReactElement } from 'react';
import { z } from 'zod';
import { AudioInstructionInputSchema, audioInstructions } from '../../src/domain/audio-instructions.js';
import type { AudioInstructionInput } from '../../src/domain/audio-instructions.js';
import { audioCuesInSegment, audioCueSource } from '../../src/domain/audio-source.js';
import type { Instruction, Project } from '../../src/domain/schema.js';
import { useBrowserDraft } from './useBrowserDraft.js';

type ReviewProps = { project: Project; working: boolean; onSave: (input: AudioInstructionInput) => Promise<void>; onConfirm: (id: string) => Promise<void> };
const DraftSchema = AudioInstructionInputSchema.extend({ resolution: z.enum(['none', 'required']).nullable(), reason: z.string() });

function InstructionEditor(props: ReviewProps & { instruction: Instruction }): ReactElement {
  const saved = (props.project.audioInstructionDecisions ?? []).find((value): boolean => value.instructionId === props.instruction.id);
  const recovery = useBrowserDraft(JSON.stringify([props.project.projectId, 'audio-instruction', props.instruction.id]), {
    instructionId: props.instruction.id, resolution: saved?.resolution ?? null, cueIds: saved?.cueIds ?? [],
    informationIds: saved?.informationIds ?? [], reason: saved?.reason ?? '',
    ...(saved?.sourceEvidence === undefined ? {} : { sourceEvidence: saved.sourceEvidence }),
    ...(saved?.sharedScope === undefined ? {} : { sharedScope: saved.sharedScope }),
  }, String(props.project.revision), DraftSchema);
  const draft = recovery.value;
  const candidates = audioCuesInSegment(props.project, props.instruction.segmentId).filter((cue): boolean => cue.kind === (props.instruction.kind === 'music' ? 'music' : 'sfx'));
  const validation = AudioInstructionInputSchema.safeParse(draft);
  return <article aria-label={`${props.instruction.id} 음향 지시 검토`}>
    <h4>{props.instruction.kind === 'music' ? '배경 음악' : '환경 음향'}</h4><p>{props.instruction.text}</p>
    <p>{saved === undefined ? '자동 제작을 실행하면 필요 여부와 준비할 트랙을 제안합니다.' : `${saved.origin === 'automatic' ? 'Codex 제안' : '직접 설정'} · ${saved.reviewStatus === 'confirmed' ? '검토 완료' : '검토 대기'}`}</p>
    {saved !== undefined && <p>{saved.reason}</p>}
    {saved?.sharedScope !== undefined && saved.sharedScope !== null && <section aria-label="공통 음향 적용 구간"><h5>같은 음향의 적용 구간</h5>
      <p>{saved.sharedScope.requiredSegmentIds.length === 0 ? '이 공통 지시로 추가할 음향 트랙이 없습니다.' : saved.sharedScope.requiredSegmentIds.map((id): string => {
        const segment = props.project.dataset.segments.find((value): boolean => value.id === id);
        return `${id} · ${segment?.mode ?? '구간 확인 필요'}`;
      }).join(', ')}</p><p>{saved.resolution === 'required' ? '현재 구간에 배치합니다.' : '현재 구간에는 반복 배치하지 않습니다.'}</p><p>{saved.sharedScope.reason}</p>
      {saved.sharedScope.sourceEvidence.map((entry): ReactElement => <blockquote key={entry.unitId}>{entry.quote}<small>{entry.unitId}</small></blockquote>)}</section>}
    {(saved?.sourceEvidence?.length ?? 0) > 0 && <section aria-label="소리의 대본 근거"><h5>콘티에 기록할 소리의 원문</h5>{saved!.sourceEvidence!.map((entry): ReactElement => <blockquote key={entry.unitId}>{entry.quote}<small>{entry.unitId}</small></blockquote>)}</section>}
    <details><summary>음향 지시 출처</summary>{props.instruction.sourceRefs.map((ref, index): ReactElement => <p key={index}>{ref.fileId} · {ref.locator}</p>)}</details>
    {recovery.notice}
    <fieldset disabled={props.working || recovery.blocked}>
      <label className="field">음향 필요 여부<select value={draft.resolution ?? ''} onChange={(event): void => { const resolution = event.target.value === '' ? null : event.target.value as 'none' | 'required'; recovery.setValue({ ...draft, resolution, sharedScope: null, cueIds: resolution === 'none' ? [] : draft.cueIds, informationIds: resolution === 'none' ? [] : draft.informationIds, ...(draft.sourceEvidence === undefined ? {} : { sourceEvidence: resolution === 'none' ? [] : draft.sourceEvidence }) }); }}>
        <option value="">판정 대기</option><option value="required">음향 필요</option><option value="none">현재 구간에 추가 트랙 없음</option>
      </select></label>
      {draft.resolution === 'required' && <><p>같은 소리의 기존 트랙을 연결하세요. 선택하지 않고 저장하면 별도 준비 트랙을 만듭니다.</p>
        {candidates.map((cue): ReactElement => <label className="check-row" key={cue.id}><input type="checkbox" checked={draft.cueIds.includes(cue.id)} onChange={(event): void => { recovery.setValue({ ...draft, cueIds: event.target.checked ? [...draft.cueIds, cue.id] : draft.cueIds.filter((id): boolean => id !== cue.id) }); }} />
          {audioCueSource(props.project, cue)?.text} · {cue.assetId === null ? '음향 지시 · 재생 음원 선택 사항' : cue.timingStatus === 'prepared' ? '재생 음원 준비됨 · 배치 검토 필요' : '음원 연결됨'}</label>)}
        <details><summary>소리로 드러나는 원문 정보</summary>{props.project.dataset.informationRules.filter((rule): boolean => rule.segmentId === props.instruction.segmentId).map((rule): ReactElement => <label className="check-row" key={rule.id}><input type="checkbox" checked={draft.informationIds.includes(rule.id)} onChange={(event): void => { recovery.setValue({ ...draft, informationIds: event.target.checked ? [...draft.informationIds, rule.id] : draft.informationIds.filter((id): boolean => id !== rule.id) }); }} />{rule.id}</label>)}</details>
      </>}
      <label className="field">판정 근거<textarea value={draft.reason} onChange={(event): void => { recovery.setValue({ ...draft, reason: event.target.value }); }} /></label>
      <button disabled={!validation.success || !recovery.dirty} onClick={(): void => { if (validation.success) void props.onSave(validation.data); }}>음향 판정 저장</button>
      <button disabled={saved === undefined || saved.reviewStatus === 'confirmed' || recovery.dirty} onClick={(): void => { void props.onConfirm(props.instruction.id); }}>음향 판정 확인</button>
    </fieldset>
    {saved?.resolution === 'required' && <p>콘티에는 이 음향의 지시와 계획 시각을 기록합니다. 실제 소리도 듣고 싶을 때 아래 트랙에서 WAV를 준비하고 자동 제작으로 배치하세요. 음원 등록은 기본 콘티 완료 조건에 포함되지 않습니다.</p>}
  </article>;
}

export function AudioInstructionReview(props: ReviewProps & { segmentId: string }): ReactElement | null {
  const instructions = audioInstructions(props.project).filter((instruction): boolean => instruction.segmentId === props.segmentId);
  if (instructions.length === 0) return null;
  return <section className="inspector-section audio-block" aria-label="음악·환경 음향 지시"><header>음악·환경 음향 지시 <span>{instructions.length}</span></header>
    <p>자동 제작이 제안한 음향의 필요 여부·연결·근거를 검토하고 판정을 확인하세요. 기본 콘티에는 음향 지시를 포함하며, 실제 음원 재생은 선택 사항입니다.</p>
    {instructions.map((instruction): ReactElement => <InstructionEditor {...props} instruction={instruction} key={instruction.id} />)}
  </section>;
}

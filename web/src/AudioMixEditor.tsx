import { audioMixReview } from '../../src/automation/audio-mix-review.js';
import { z } from 'zod';
import { useBrowserDraft } from './useBrowserDraft.js';
import type { ReactElement } from 'react';
import { AudioMixInputSchema, audioMixValues } from '../../src/domain/audio-mix.js';
import type { AudioMixInput } from '../../src/domain/audio-mix.js';
import { automaticAudioProtected } from '../../src/domain/edit-protection.js';
import type { AudioCue, Project } from '../../src/domain/schema.js';

/** 자동 제안과 수동 수정은 같은 저장값을 사용한다. 저장 전 수정은 재생에 적용하지 않는다. */
export function AudioMixEditor(props: { project: Project; cue: AudioCue; working: boolean; onSave: (cueId: string, mix: AudioMixInput) => Promise<void> }): ReactElement {
  const recovery = useBrowserDraft(JSON.stringify([props.project.projectId, 'audio-mix', props.cue.id]), { ...audioMixValues(props.cue), mode: props.cue.mix?.mode ?? 'automatic' }, String(props.project.revision), AudioMixInputSchema.extend({ volumeDb: z.number(), fadeInMs: z.number(), fadeOutMs: z.number() }));
  const draft: AudioMixInput = recovery.value; const setDraft = recovery.setValue;
  const review = audioMixReview(props.project, props.cue.id);
  const protectedCue: boolean = automaticAudioProtected(props.project, props.cue);
  const invalid: boolean = !Number.isFinite(draft.volumeDb) || draft.volumeDb < -30 || draft.volumeDb > 0
    || !Number.isSafeInteger(draft.fadeInMs) || !Number.isSafeInteger(draft.fadeOutMs) || draft.fadeInMs < 0 || draft.fadeOutMs < 0
    || draft.fadeInMs > 60000 || draft.fadeOutMs > 60000 || draft.fadeInMs + draft.fadeOutMs > props.cue.endMs - props.cue.startMs;
  return <section className="audio-mix-editor" aria-label={`${props.cue.id} 음량 설정`}>
    <h4>음량·페이드</h4>{recovery.notice}
    <p>{props.cue.mix?.reason ?? '아직 음량을 계획하지 않았습니다. 현재는 원래 음량으로 재생합니다.'}</p>
    {review.status === 'invalid' && <p role="alert">{review.message}</p>}
    {review.status === 'recorded' && <details><summary>자동 음량 검토 근거</summary><p>{review.summary}</p>
      <p>{review.model} · 원본 표본 피크 {review.peakDbfs === null ? '무음' : `${review.peakDbfs.toFixed(1)}dBFS`} · RMS {review.rmsDbfs === null ? '무음' : `${review.rmsDbfs.toFixed(1)}dBFS`}</p>
      {!review.matchesCurrent && <p>제안 이후 현재 음량 설정이 변경됐습니다.</p>}
      <p>전체 파일의 표본 분석입니다. 실제 동시 재생의 클리핑·LUFS 측정은 아니며 함께 들어 확인하세요.</p>
      {review.problems.length > 0 && <ul>{review.problems.map((problem, index): ReactElement => <li key={index}>{problem}</li>)}</ul>}</details>}
    <fieldset disabled={props.working || protectedCue}>
      <label className="field">음량 계획<select value={draft.mode} onChange={(event): void => { setDraft({ ...draft, mode: event.target.value as AudioMixInput['mode'] }); }}>
        <option value="automatic">다음 자동 제작에서 조정</option><option value="manual">직접 지정한 값 유지</option></select></label>
      <label className="field">음량 (dB)<input type="number" min="-30" max="0" step="0.5" value={draft.volumeDb} onChange={(event): void => { setDraft({ ...draft, mode: 'manual', volumeDb: Number(event.target.value) }); }} /></label>
      <div className="pair"><label className="field">페이드 인 (ms)<input type="number" min="0" max="60000" step="1" value={draft.fadeInMs} onChange={(event): void => { setDraft({ ...draft, mode: 'manual', fadeInMs: Number(event.target.value) }); }} /></label>
        <label className="field">페이드 아웃 (ms)<input type="number" min="0" max="60000" step="1" value={draft.fadeOutMs} onChange={(event): void => { setDraft({ ...draft, mode: 'manual', fadeOutMs: Number(event.target.value) }); }} /></label></div>
      <button disabled={invalid || recovery.blocked} onClick={(): void => { void props.onSave(props.cue.id, draft); }}>음량 설정 저장</button>
    </fieldset>
    {invalid && <p role="alert">음량은 −30~0dB, 페이드는 각각 0~60,000ms이며 합계는 음원 길이 이내여야 합니다.</p>}
    {protectedCue && <p>확정·잠금 컷과 공유하는 음원입니다. 해당 컷의 보호 상태를 먼저 확인하세요.</p>}
    <p>저장한 음량은 개별 검토와 시간순 재생에 적용됩니다. 원본 WAV는 그대로 보존합니다.</p>
  </section>;
}

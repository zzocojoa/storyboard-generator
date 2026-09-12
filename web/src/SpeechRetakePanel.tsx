import { SpeechPronunciationSchema } from '../../src/domain/speech-pronunciation.js';
import type { SpeechPronunciation } from '../../src/domain/speech-pronunciation.js';
import { PronunciationDraftSchema, SpeechPronunciationEditor, pronunciationPreview } from './SpeechPronunciationEditor.js';
import { useEffect, useState } from 'react';
import type { ReactElement } from 'react';
import { z } from 'zod';
import type { AutomationOverview, AutomationView } from '../../src/automation/run-view.js';
import { SpeechRetakeInputSchema } from '../../src/automation/speech-retake-schema.js';
import { speechRetakeProtected } from '../../src/domain/edit-protection.js';
import type { AudioCue, Project } from '../../src/domain/schema.js';
import { SpeechVoiceSchema } from '../../src/domain/speech-voice.js';
import type { InstalledSpeechVoice, SpeechVoice } from '../../src/domain/speech-voice.js';
import { apiErrorMessage, cancelAutomation, fetchAutomation, fetchInstalledSpeechVoices, pauseAutomation, resumeAutomation, startSpeechRetake } from './api.js';
import { AudioReviewPreview } from './AudioReviewPreview.js';
import { useBrowserDraft } from './useBrowserDraft.js';
import type { ReviewPlaybackPreference } from './useReviewPlayback.js';

type Props = { project: Project; cue: AudioCue; disabled: boolean; reviewPlayback: ReviewPlaybackPreference; onPlay: () => void; onRefresh: () => Promise<void> };
const RetakeDraftSchema = z.strictObject({ voice: z.strictObject({ name: z.string(), rateWordsPerMinute: z.number() }), latestEndMs: z.number(), pronunciation: PronunciationDraftSchema.optional(), reviewedSourceText: z.string().optional() });

/** 알려진 생성 계약의 실제 선택만 읽고 외부 WAV의 목소리는 추측하지 않는다. */
function recordedVoice(project: Project, cue: AudioCue): { voice: SpeechVoice | null; pronunciation?: SpeechPronunciation; staleSource?: string; error: string } {
  const record = project.generationRecords.findLast((value): boolean => cue.assetId !== null && value.resultAssetIds.includes(cue.assetId)
    && ['automatic-guide-speech-1.0.0', 'automatic-speech-retake-1.0.0', 'automatic-speech-retake-1.1.0'].includes(value.templateVersion));
  if (record === undefined) return { voice: null, error: '' };
  try {
    const prompt: unknown = JSON.parse(record.prompt);
    const voice = z.object({ voice: SpeechVoiceSchema }).parse(prompt).voice;
    if (record.templateVersion !== 'automatic-speech-retake-1.1.0') return { voice, error: '' };
    const reading = z.object({ sourceText: z.string(), pronunciation: z.object({ replacements: SpeechPronunciationSchema }) }).parse(prompt);
    if (reading.sourceText !== project.dataset.units.find((unit): boolean => unit.id === cue.unitId)?.text) return { voice, pronunciation: reading.pronunciation.replacements, staleSource: reading.sourceText, error: '' };
    return { voice, pronunciation: reading.pronunciation.replacements, error: '' };
  }
  catch (cause: unknown) {
    if (!(cause instanceof SyntaxError) && !(cause instanceof z.ZodError)) throw cause;
    return { voice: null, error: `기존 음성의 생성 설정을 읽지 못했습니다: ${record.id}. ${apiErrorMessage(cause)}` };
  }
}

function SpeechRetakeForm(props: Props & { overview: AutomationOverview; voices: InstalledSpeechVoice[]; onRun: (run: AutomationView) => void; current: AutomationView | null }): ReactElement {
  const recorded = recordedVoice(props.project, props.cue);
  const recovery = useBrowserDraft(JSON.stringify([props.project.projectId, 'speech-retake', props.cue.id]),
    { voice: recorded.voice ?? { name: '', rateWordsPerMinute: 180 }, latestEndMs: props.cue.endMs, ...(recorded.pronunciation === undefined ? {} : { pronunciation: recorded.pronunciation }) }, String(props.project.revision), RetakeDraftSchema);
  const draft = recovery.value;
  const source: string = props.project.dataset.units.find((unit): boolean => unit.id === props.cue.unitId)?.text ?? '';
  const reading = pronunciationPreview(source, draft.pronunciation ?? []);
  const sourceReviewNeeded: boolean = recorded.staleSource !== undefined && (draft.pronunciation?.length ?? 0) > 0 && draft.reviewedSourceText !== source;
  const [busy, setBusy] = useState<boolean>(false); const [error, setError] = useState<string>('');
  const current = props.current;
  const active = props.overview.runs.find((run): boolean => !['review-ready', 'cancelled'].includes(run.status));
  const protectedCue: boolean = speechRetakeProtected(props.project, props.cue);
  const perform = async (operation: () => Promise<AutomationView>): Promise<void> => {
    setBusy(true); setError('');
    try { props.onRun(await operation()); } catch (cause: unknown) { setError(apiErrorMessage(cause)); } finally { setBusy(false); }
  };
  const start = async (): Promise<AutomationView> => {
    if (props.overview.recommendedSettings === null) throw new Error('자동 음성 실행 설정이 없습니다.');
    const input = SpeechRetakeInputSchema.parse({ cueId: props.cue.id, voice: draft.voice, latestEndMs: draft.latestEndMs, ...(draft.pronunciation === undefined || draft.pronunciation.length === 0 ? {} : { pronunciation: draft.pronunciation }) });
    return startSpeechRetake(props.project.projectId, props.project.revision, input, { ...props.overview.recommendedSettings,
      voice: input.voice, speakerVoices: [], voicePlanning: 'configured', maxJobs: 1, maxActiveMs: 300000, maxStagedBytes: 67108864 });
  };
  return <section aria-label="선택 발화 자동 생성" className="speaker-voices">
    <p>이 발화만 로컬 macOS 음성으로 합성하고 검사·저장합니다. 시작 {props.cue.startMs}ms는 유지하며 실제 길이만큼 종료 시각을 정합니다.</p>
    <p>원문·기존 음원·다른 발화는 보존합니다. 실행 한도는 5분·64MB이며 채팅에 작업 문구를 붙여 넣을 필요가 없습니다.</p>
    {recorded.error !== '' && <p role="alert">{recorded.error}</p>}{recovery.notice}
    <label className="field">새 목소리<select aria-label="새 목소리" value={draft.voice.name} onChange={(event): void => { recovery.setValue({ ...draft, voice: { ...draft.voice, name: event.target.value } }); }}>
      <option value="">목소리 선택</option>{draft.voice.name !== '' && !props.voices.some((voice): boolean => voice.name === draft.voice.name) && <option value={draft.voice.name}>{draft.voice.name} · 현재 미설치</option>}
      {props.voices.map((voice): ReactElement => <option key={voice.name} value={voice.name}>{voice.name} · {voice.locale}</option>)}</select></label>
    <label className="field">합성 속도 (단어/분)<input aria-label="합성 속도" type="number" min="80" max="360" value={draft.voice.rateWordsPerMinute} onChange={(event): void => { recovery.setValue({ ...draft, voice: { ...draft.voice, rateWordsPerMinute: Number(event.target.value) } }); }} /></label>
    <label className="field">종료 허용 시각 (ms)<input aria-label="종료 허용 시각" type="number" min={props.cue.startMs + 1} value={draft.latestEndMs} onChange={(event): void => { recovery.setValue({ ...draft, latestEndMs: Number(event.target.value) }); }} /></label>
    <p>허용 길이 {Math.max(0, draft.latestEndMs - props.cue.startMs)}ms · 길이를 넘거나 다음 발화와 겹치면 기존 음원을 유지하고 조정할 항목을 알려줍니다.</p>
    <SpeechPronunciationEditor source={source} value={draft.pronunciation ?? []} onChange={(pronunciation): void => { recovery.setValue({ ...draft, pronunciation }); }} />
    {recorded.staleSource !== undefined && <div><p>기존 음원 생성 후 원문이 변경됐습니다. 보완을 제거하거나 현재 낭독문에서 다시 검토하세요.</p>
      <details><summary>이전 음원의 원문 보기</summary><blockquote>{recorded.staleSource}</blockquote></details>
      {(draft.pronunciation?.length ?? 0) > 0 && <label><input type="checkbox" checked={draft.reviewedSourceText === source} onChange={(event): void => { recovery.setValue({ ...draft, reviewedSourceText: event.target.checked ? source : '' }); }} />변경된 원문에서 발음 보완을 다시 확인했습니다</label>}
    </div>}
    {protectedCue && <p role="alert">이 발화는 확정·잠금 컷과 연결됩니다. 해당 컷을 잠금 해제하여 검토 대기로 변경한 뒤 다시 생성하세요.</p>}
    {active !== undefined && active.id !== current?.id && <p role="status">다른 자동 제작이 진행 중입니다. 제작 현황에서 완료를 기다리거나 중지·취소한 뒤 시작하세요.</p>}
    {error !== '' && <p role="alert">{error} · 접수 여부는 아래 실행 상태를 다시 확인하세요.</p>}
    <button disabled={busy || props.disabled || recovery.blocked || sourceReviewNeeded || recorded.error !== '' || reading.error !== '' || protectedCue || active !== undefined || !props.voices.some((voice): boolean => voice.name === draft.voice.name)} onClick={(): void => { void perform(start); }}>이 발화만 자동 생성</button>
    {current !== null && <div aria-live="polite"><p>선택 발화 실행: {current.status === 'review-ready' ? '생성·저장 완료 — 청취 검토 대기' : current.status === 'running' ? '생성 중' : current.status === 'paused' ? '일시 중지' : current.status === 'cancelled' ? '취소됨' : '설정 확인 필요'}</p>
      <p>{current.purpose?.voice.name} · {current.purpose?.voice.rateWordsPerMinute} 단어/분 · {current.progress}</p>
      {current.problem !== null && <p role="alert">{current.problem.code}: {current.problem.message}</p>}{current.serviceError !== null && <p role="alert">{current.serviceError.message}</p>}
      {current.status === 'running' && <button disabled={busy} onClick={(): void => { void perform(() => pauseAutomation(props.project.projectId, current.id)); }}>음성 생성 중지</button>}
      {['paused', 'needs-attention'].includes(current.status) && <button disabled={busy || current.workerActive} onClick={(): void => { void perform(() => resumeAutomation(props.project.projectId, current.id)); }}>같은 설정으로 이어 만들기</button>}
      {!['review-ready', 'cancelled'].includes(current.status) && <button disabled={busy} onClick={(): void => { void perform(() => cancelAutomation(props.project.projectId, current.id)); }}>음성 실행 취소 · 결과 보존</button>}
      {current.status === 'review-ready' && <button disabled={busy || props.disabled} onClick={(): void => { void props.onRefresh(); }}>새 음원 불러와 비교</button>}
    </div>}
  </section>;
}

function AudioVersionComparison(props: Props): ReactElement | null {
  const [selected, setSelected] = useState<string>('');
  const previous = props.project.assets.filter((asset): boolean => asset.kind === 'audio' && asset.subjectId === props.cue.id && asset.id !== props.cue.assetId);
  if (previous.length === 0) return null;
  const asset = previous.find((value): boolean => value.id === selected);
  const { mix: _mix, ...cue } = props.cue;
  return <section aria-label="이전 음원 비교"><label className="field">보존된 이전 음원<select value={selected} onChange={(event): void => { setSelected(event.target.value); }}><option value="">비교할 버전 선택</option>{previous.map((value): ReactElement => <option key={value.id} value={value.id}>v{value.version} · {value.description} · {value.durationMs}ms</option>)}</select></label>
    {asset !== undefined && <AudioReviewPreview key={asset.id} projectId={props.project.projectId} asset={asset} cue={{ ...cue, assetId: asset.id, endMs: cue.startMs + (asset.durationMs ?? 0) }} reviewPlayback={props.reviewPlayback} onPlay={props.onPlay} />}
    <p>이전 버전은 원본 음량으로 비교합니다. 현재 타임라인의 음원 선택과 최종 승인 상태는 바뀌지 않습니다.</p>
  </section>;
}

/** 화면을 열어도 실행하지 않는다. 저장된 동일 발화 실행을 조회하고 명시적 시작만 접수한다. */
export function SpeechRetakePanel(props: Props): ReactElement {
  const [overview, setOverview] = useState<AutomationOverview | null>(null); const [voices, setVoices] = useState<InstalledSpeechVoice[] | null>(null);
  const [error, setError] = useState<string>(''); const [refresh, setRefresh] = useState<number>(0);
  useEffect((): (() => void) => {
    let disposed: boolean = false; let timer: ReturnType<typeof setTimeout> | null = null;
    void fetchInstalledSpeechVoices().then((catalog): void => { if (!disposed) setVoices(catalog); }, (cause: unknown): void => { if (!disposed) { setVoices(null); setError(apiErrorMessage(cause)); } });
    const poll = async (): Promise<void> => {
      try {
        const runs = await fetchAutomation(props.project.projectId);
        if (!disposed) { setOverview(runs); }
      } catch (cause: unknown) { if (!disposed) setError(apiErrorMessage(cause)); }
      finally { if (!disposed) timer = setTimeout((): void => { void poll(); }, 2500); }
    };
    setError('');
    void poll(); return (): void => { disposed = true; if (timer !== null) clearTimeout(timer); };
  }, [props.project.projectId, refresh]);
  const current = overview?.runs.find((run): boolean => run.purpose?.cueId === props.cue.id) ?? null;
  return <div className="speech-retake-panel"><h4>발화 선택 생성·비교</h4>
    {error !== '' && <p role="alert">{error}</p>}{overview === null && error === '' && <p role="status">자동 음성 실행을 확인합니다.</p>}
    <button onClick={(): void => { setRefresh((value): number => value + 1); }}>음성 실행 상태 다시 확인</button>
    {overview?.configured === false && <p role="alert">서버에 자동 제작 실행 설정이 필요합니다.</p>}
    {overview?.configured === true && voices !== null && <SpeechRetakeForm {...props} disabled={props.disabled || error !== ''} overview={overview} voices={voices} current={current}
      onRun={(run): void => { setOverview((value): AutomationOverview | null => value === null ? null : { ...value, runs: [run, ...value.runs.filter((entry): boolean => entry.id !== run.id)] }); setRefresh((value): number => value + 1); }} />}
    <AudioVersionComparison {...props} />
  </div>;
}

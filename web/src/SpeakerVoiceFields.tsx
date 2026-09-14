import { useEffect, useId, useState } from 'react';
import type { ReactElement } from 'react';
import type { Project } from '../../src/domain/schema.js';
import { spokenSpeakers } from '../../src/domain/speech-voice.js';
import type { InstalledSpeechVoice } from '../../src/domain/speech-voice.js';
import { useVoiceCastingBasis } from './VoiceCastingReview.js';
import type { AutomationStartDraft } from './automation-start-draft.js';
import { apiErrorMessage, fetchInstalledSpeechVoices } from './api.js';

type Settings = AutomationStartDraft['settings'];
type VoiceInput = Settings['voice'];

/** 실제 발화 화자의 설정을 실행 초안에 보관한다. 원문 ID가 사라져도 자동 삭제하거나 다른 인물에 배정하지 않는다. */
export function SpeakerVoiceFields(props: { project: Project; settings: Settings; onChange: (settings: Settings) => void }): ReactElement {
  const [voices, setVoices] = useState<InstalledSpeechVoice[] | null>(null);
  const [error, setError] = useState<string>(''); const [refresh, setRefresh] = useState<number>(0);
  const [locale, setLocale] = useState<string>(''); const listId: string = useId();
  const { current: castingCurrent, error: castingError } = useVoiceCastingBasis(props.project);
  const automatic: boolean = props.settings.voicePlanning === 'automatic';
  const speakers = spokenSpeakers(props.project); const assignments = props.settings.speakerVoices ?? [];
  useEffect((): (() => void) => {
    let disposed: boolean = false; setVoices(null); setError('');
    void fetchInstalledSpeechVoices().then((values): void => { if (!disposed) setVoices(values); }, (cause: unknown): void => { if (!disposed) setError(apiErrorMessage(cause)); });
    return (): void => { disposed = true; };
  }, [refresh]);
  const choose = (speakerId: string | null, voice: VoiceInput | null): void => {
    const kept = assignments.filter((entry): boolean => entry.speakerId !== speakerId);
    props.onChange({ ...props.settings, speakerVoices: voice === null ? kept : [...kept, { speakerId, voice }] });
  };
  const options: InstalledSpeechVoice[] = (voices ?? []).filter((voice): boolean => locale === '' || voice.locale === locale);
  const missing = assignments.filter((entry): boolean => !speakers.some((speaker): boolean => speaker.speakerId === entry.speakerId));
  const input = (voice: VoiceInput, label: string, onChange: (value: VoiceInput) => void): ReactElement => <div className="speaker-voice-inputs">
    <label>음성 이름<input aria-label={`${label} 음성 이름`} list={listId} value={voice.name} onChange={(event): void => { onChange({ ...voice, name: event.target.value }); }} /></label>
    <label>말하기 속도<input aria-label={`${label} 말하기 속도`} type="number" min="80" max="360" value={voice.rateWordsPerMinute} onChange={(event): void => { onChange({ ...voice, rateWordsPerMinute: Number(event.target.value) }); }} /><span>단어/분</span></label>
    {voices !== null && !voices.some((entry): boolean => entry.name === voice.name) && <p role="alert">현재 설치 목록에 없는 음성입니다: {voice.name || '(미지정)'}</p>}
  </div>;
  return <section className="speaker-voices" aria-label="인물별 가이드 음성">
    <h3>인물별 가이드 음성</h3><p>등록되지 않은 발화를 만들 때 사용합니다. 기존 음원과 확정한 컷은 유지합니다.</p>
    <label>음성 배정 방식<select aria-label="음성 배정 방식" value={props.settings.voicePlanning ?? 'configured'} onChange={(event): void => { props.onChange({ ...props.settings, voicePlanning: event.target.value === 'automatic' ? 'automatic' : 'configured' }); }}>
      <option value="automatic">Codex 자동 배정</option><option value="configured">공통·직접 지정 음성</option>
    </select></label>
    {automatic && <p>자동 제작을 시작하면 원문 언어·역할과 설치 음성을 검토해 빈 배정을 채웁니다. 개별 지정한 음성이 우선하며, 현재 원문의 저장된 배정을 재사용합니다.</p>}
    {castingError !== '' && <p role="alert">저장된 음성 배정의 원문을 확인할 수 없습니다: {castingError}</p>}
    {automatic && castingCurrent === false && <p role="status">원문이 변경되었습니다. 미등록 발화의 목소리를 다시 배정하고 기존 음원은 보존합니다.</p>}
    <button type="button" onClick={(): void => { setRefresh((value): number => value + 1); }}>설치 음성 다시 확인</button>
    {voices === null && error === '' && <p role="status">설치된 음성 이름과 언어를 확인합니다.</p>}{error !== '' && <p role="alert">{error}</p>}
    {voices !== null && <label>음성 후보 언어<select aria-label="음성 후보 언어" value={locale} onChange={(event): void => { setLocale(event.target.value); }}><option value="">모든 언어</option>{[...new Set(voices.map((voice): string => voice.locale))].map((value): ReactElement => <option key={value} value={value}>{value}</option>)}</select></label>}
    <datalist id={listId}>{options.map((voice): ReactElement => <option key={voice.name} value={voice.name}>{voice.locale} · {voice.sample}</option>)}</datalist>
    <fieldset><legend>{automatic ? '자동 배정 참고 설정' : '공통 음성'}</legend>{input(props.settings.voice, '공통', (voice): void => { props.onChange({ ...props.settings, voice }); })}</fieldset>
    {speakers.map((speaker): ReactElement => {
      const entry = assignments.find((value): boolean => value.speakerId === speaker.speakerId);
      const casting = castingCurrent === true ? props.project.voiceCasting?.assignments.find((value): boolean => value.speakerId === speaker.speakerId) : undefined;
      return <fieldset key={JSON.stringify(speaker.speakerId)}><legend>{speaker.name} · {speaker.unitIds.length}개 발화</legend>
        <label><input aria-label={`${speaker.name} 개별 음성 지정`} type="checkbox" checked={entry !== undefined} onChange={(event): void => { choose(speaker.speakerId, event.target.checked ? { ...props.settings.voice } : null); }} />개별 음성 지정</label>
        {entry !== undefined ? input(entry.voice, speaker.name, (voice): void => { choose(speaker.speakerId, voice); }) : automatic
          ? casting === undefined ? <p>미등록 발화 생성 전에 Codex가 배정합니다.</p> : <div><p>Codex 배정: {casting.voice.name} · {casting.locale} · {casting.voice.rateWordsPerMinute} 단어/분</p><p>{casting.reason}</p></div>
          : <p>공통: {props.settings.voice.name} · {props.settings.voice.rateWordsPerMinute} 단어/분</p>}
        <details><summary>원문 화자 연결</summary><p>{speaker.speakerId ?? '원문 화자 미지정'} · {speaker.unitIds.join(', ')}</p></details>
      </fieldset>;
    })}
    {missing.map((entry): ReactElement => <div role="alert" key={JSON.stringify(entry.speakerId)}>현재 발화에 없는 화자: {entry.speakerId ?? '(미지정)'} · {entry.voice.name}
      <button type="button" onClick={(): void => { choose(entry.speakerId, null); }}>없는 화자의 음성 설정 제거</button></div>)}
    <p>시스템에 설치된 음성만 합성할 수 있습니다. 자동 배정은 청취 검토용 제안입니다. 생성 후 음성 탭에서 확인하며, 재생 배속은 별도 검토 설정입니다.</p>
  </section>;
}

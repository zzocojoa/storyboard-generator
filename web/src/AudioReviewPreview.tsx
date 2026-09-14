import { ReviewPlaybackControl } from './ReviewPlaybackControl.js';
import type { ReviewPlaybackPreference } from './useReviewPlayback.js';
import { useEffect, useRef, useState } from 'react';
import type { ReactElement } from 'react';
import { audioVolumeAt } from '../../src/domain/audio-mix.js';
import type { Asset, AudioCue } from '../../src/domain/schema.js';

/** 검토 음원은 화면을 떠나면 정지한다. 최종 타임라인 재생과 승인 상태는 변경하지 않는다. */
export function AudioReviewPreview(props: { reviewPlayback: ReviewPlaybackPreference; projectId: string; cue: AudioCue; asset: Asset; onPlay: () => void }): ReactElement {
  const element = useRef<HTMLAudioElement>(null);
  const [failed, setFailed] = useState<boolean>(false);
  const [listen, setListen] = useState<'saved' | 'source'>('saved');
  const source: string = `/api/projects/${encodeURIComponent(props.projectId)}/assets/${encodeURIComponent(props.asset.id)}`;
  useEffect((): (() => void) => {
    setFailed(false);
    const audio: HTMLAudioElement | null = element.current;
    const stopOther: EventListener = (event: Event): void => { if (event.target instanceof HTMLMediaElement && event.target !== audio) audio?.pause(); };
    const hide = (): void => { if (document.hidden) audio?.pause(); };
    document.addEventListener('play', stopOther, true); document.addEventListener('visibilitychange', hide);
    return (): void => {
      document.removeEventListener('play', stopOther, true); document.removeEventListener('visibilitychange', hide);
      audio?.pause(); audio?.removeAttribute('src'); audio?.load();
    };
  }, [source]);
  useEffect((): (() => void) => {
    const audio: HTMLAudioElement | null = element.current;
    if (audio === null) return (): void => {};
    let frame: number | null = null;
    const update = (): void => {
      audio.volume = listen === 'source' || props.cue.mix === undefined ? 1 : audioVolumeAt(props.cue, props.cue.startMs + audio.currentTime * 1000);
    };
    const tick = (): void => { update(); frame = audio.paused || audio.ended ? null : requestAnimationFrame(tick); };
    const start = (): void => { if (frame !== null) cancelAnimationFrame(frame); tick(); };
    const stop = (): void => { if (frame !== null) cancelAnimationFrame(frame); frame = null; };
    audio.addEventListener('play', start); audio.addEventListener('pause', stop); audio.addEventListener('ended', stop);
    audio.addEventListener('seeked', update); update(); if (!audio.paused) start();
    return (): void => { stop(); audio.removeEventListener('play', start); audio.removeEventListener('pause', stop);
      audio.removeEventListener('ended', stop); audio.removeEventListener('seeked', update); };
  }, [listen, props.cue]);
  useEffect((): void => {
    const audio: HTMLAudioElement | null = element.current;
    if (audio === null) return;
    if (props.reviewPlayback.rate === null) { audio.pause(); return; }
    audio.preservesPitch = true; audio.playbackRate = props.reviewPlayback.rate;
  }, [props.reviewPlayback.rate, source]);
  return <figure className="audio-review-preview">
    <figcaption>음성·음향 개별 검토 · {props.asset.description}</figcaption>
    <label className="field">청취 음량<select value={listen} onChange={(event): void => { setListen(event.target.value as 'saved' | 'source'); }}><option value="saved">저장한 음량·페이드</option><option value="source">원본 음량 비교</option></select></label>
    <ReviewPlaybackControl preference={props.reviewPlayback} />
    <audio ref={element} key={source} data-storyboard-review={props.cue.id} aria-label={`${props.cue.id} 음원 검토`} controls preload="metadata" src={source}
      onPlay={(): void => { if (props.reviewPlayback.rate === null) { element.current?.pause(); return; } props.onPlay(); }} onError={(): void => { setFailed(true); }} />
    {failed && <p role="alert">음원 파일을 재생할 수 없습니다. 자산 무결성 상태와 WAV 형식을 확인하세요.</p>}
    <p>검토 속도로 저장된 파일 전체를 듣습니다. 원본 음성과 제작 시간표는 유지됩니다. 타임라인 배치와 최종 출력 가능 여부는 별도로 검토합니다.</p>
  </figure>;
}

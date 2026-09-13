import { audioVolumeAt } from '../../src/domain/audio-mix.js';
import type { AudioMix } from '../../src/domain/audio-mix.js';
import type { ReviewPlaybackRate } from './review-playback.js';

export type AudioElementPort = {
  currentTime: number;
  volume: number;
  playbackRate: number;
  pause: () => void;
  play: () => Promise<void>;
  dispose?: () => void;
};

export type AudioLifecycleCue = {
  id: string;
  startMs: number;
  endMs: number;
  mix?: AudioMix | undefined;
};

export type AudioScheduler = {
  schedule: (callback: () => void, delayMs: number) => number;
  cancel: (timerId: number) => void;
};

type ActiveAudio = {
  projectId: string;
  cue: AudioLifecycleCue;
  element: AudioElementPort;
  timerId: number;
  epoch: number;
};

/** 브라우저 Audio 객체를 Cue와 Project 수명에 맞춰 정리한다. */
export class BrowserAudioController {
  readonly #createAudio: (url: string) => AudioElementPort;
  readonly #scheduler: AudioScheduler;
  readonly #active: Map<string, ActiveAudio> = new Map<string, ActiveAudio>();
  readonly #played: Set<string> = new Set<string>();
  #epoch: number = 0;
  #projectId: string | null = null;

  constructor(createAudio: (url: string) => AudioElementPort, scheduler: AudioScheduler) {
    this.#createAudio = createAudio;
    this.#scheduler = scheduler;
  }

  #stopEntry(cueId: string): void {
    const active: ActiveAudio | undefined = this.#active.get(cueId);
    if (active === undefined) return;
    this.#scheduler.cancel(active.timerId);
    active.element.pause();
    active.element.dispose?.();
    this.#active.delete(cueId);
  }

  start(projectId: string, cue: AudioLifecycleCue, playheadMs: number, url: string, rate: ReviewPlaybackRate, onError: (error: unknown) => void): void {
    if (this.#projectId !== null && this.#projectId !== projectId) this.reset();
    this.#projectId = projectId;
    if (playheadMs < cue.startMs || playheadMs >= cue.endMs || this.#played.has(cue.id)) return;
    const element: AudioElementPort = this.#createAudio(url);
    element.volume = audioVolumeAt(cue, playheadMs);
    element.playbackRate = rate;
    element.currentTime = Math.max(0, (playheadMs - cue.startMs) / 1000);
    const epoch: number = this.#epoch;
    const timerId: number = this.#scheduler.schedule((): void => {
      const current: ActiveAudio | undefined = this.#active.get(cue.id);
      if (current?.epoch === epoch && current.element === element && current.timerId === timerId) this.#stopEntry(cue.id);
    }, (cue.endMs - playheadMs) / rate);
    const active: ActiveAudio = { projectId, cue, element, timerId, epoch };
    this.#active.set(cue.id, active);
    this.#played.add(cue.id);
    void element.play().then((): void => {
      if (this.#epoch !== epoch || this.#active.get(cue.id) !== active) element.pause();
    }).catch((error: unknown): void => {
      if (this.#epoch === epoch && this.#active.get(cue.id) === active) {
        onError(error);
        this.#stopEntry(cue.id);
      } else {
        element.pause();
      }
    });
  }

  reconcile(projectId: string, playheadMs: number, playing: boolean, rate: ReviewPlaybackRate): void {
    if (!playing) {
      this.reset();
      return;
    }
    if (this.#projectId !== null && this.#projectId !== projectId) this.reset();
    this.#projectId = projectId;
    for (const [cueId, active] of this.#active) {
      if (active.projectId !== projectId || playheadMs < active.cue.startMs || playheadMs >= active.cue.endMs) this.#stopEntry(cueId);
      else {
        active.element.volume = audioVolumeAt(active.cue, playheadMs);
        if (active.element.playbackRate !== rate) {
          active.element.playbackRate = rate;
          this.#scheduler.cancel(active.timerId);
          const timerId: number = this.#scheduler.schedule((): void => {
            if (this.#active.get(cueId) === active && active.timerId === timerId) this.#stopEntry(cueId);
          }, (active.cue.endMs - playheadMs) / rate);
          active.timerId = timerId;
        }
        // 로딩 대기나 백그라운드 복귀의 지연을 원본 시각에 맞춘다.
        const expectedTime: number = (playheadMs - active.cue.startMs) / 1000;
        if (Math.abs(active.element.currentTime - expectedTime) > 0.15) active.element.currentTime = expectedTime;
      }
    }
  }

  reset(): void {
    this.#epoch += 1;
    for (const cueId of [...this.#active.keys()]) this.#stopEntry(cueId);
    this.#played.clear();
    this.#projectId = null;
  }

  activeCount(): number {
    return this.#active.size;
  }
}

/** 실제 Media Element를 문서 수명에 연결하고 종료 시 Decoder와 네트워크 자원을 해제한다. */
export function createBrowserAudio(url: string): AudioElementPort {
  const audio: HTMLAudioElement = new Audio(url);
  if (!(audio instanceof HTMLAudioElement)) return audio;
  audio.hidden = true;
  audio.dataset.storyboardAudio = 'active';
  audio.preload = 'auto';
  audio.preservesPitch = true;
  let requestedTime: number = 0;
  const seekAfterMetadata = (): void => { audio.currentTime = requestedTime; };
  audio.addEventListener('loadedmetadata', seekAfterMetadata);
  document.body.append(audio);
  return {
    get volume(): number { return audio.volume; },
    set volume(value: number) { audio.volume = value; },
    get playbackRate(): number { return audio.playbackRate; },
    set playbackRate(value: number) { audio.playbackRate = value; },
    get currentTime(): number { return audio.currentTime; },
    set currentTime(value: number) { requestedTime = value; if (audio.readyState >= 1) audio.currentTime = value; },
    play: (): Promise<void> => audio.play(),
    pause: (): void => { audio.pause(); },
    dispose: (): void => { audio.removeEventListener('loadedmetadata', seekAfterMetadata); audio.pause(); audio.removeAttribute('src'); audio.load(); audio.remove(); },
  };
}

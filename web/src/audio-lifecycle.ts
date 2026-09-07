export type AudioElementPort = {
  currentTime: number;
  pause: () => void;
  play: () => Promise<void>;
};

export type AudioLifecycleCue = {
  id: string;
  startMs: number;
  endMs: number;
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
    this.#active.delete(cueId);
  }

  start(projectId: string, cue: AudioLifecycleCue, playheadMs: number, url: string, onError: (error: unknown) => void): void {
    if (this.#projectId !== null && this.#projectId !== projectId) this.reset();
    this.#projectId = projectId;
    if (playheadMs < cue.startMs || playheadMs >= cue.endMs || this.#played.has(cue.id)) return;
    const element: AudioElementPort = this.#createAudio(url);
    element.currentTime = Math.max(0, (playheadMs - cue.startMs) / 1000);
    const epoch: number = this.#epoch;
    const timerId: number = this.#scheduler.schedule((): void => {
      const current: ActiveAudio | undefined = this.#active.get(cue.id);
      if (current?.epoch === epoch && current.element === element) this.#stopEntry(cue.id);
    }, cue.endMs - playheadMs);
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

  reconcile(projectId: string, playheadMs: number, playing: boolean): void {
    if (!playing) {
      this.reset();
      return;
    }
    if (this.#projectId !== null && this.#projectId !== projectId) this.reset();
    this.#projectId = projectId;
    for (const [cueId, active] of this.#active) {
      if (active.projectId !== projectId || playheadMs < active.cue.startMs || playheadMs >= active.cue.endMs) this.#stopEntry(cueId);
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

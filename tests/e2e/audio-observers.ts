import { WorkerAudioNormalizer } from '../../src/domain/audio-normalizer.js';
import type { AudioNormalizationWorkerOptions, AudioNormalizerDiagnostics } from '../../src/domain/audio-normalizer.js';
import { ProjectStore, processHeartbeatTimerHasRef } from '../../src/server/store.js';
import type { AudioLifecycleEvent } from '../audio-diagnostics.js';

export type AudioLifecycleRecorder = (event: AudioLifecycleEvent) => void;
export class ObservedAudioNormalizer extends WorkerAudioNormalizer {
  readonly #record: AudioLifecycleRecorder;
  constructor(options: AudioNormalizationWorkerOptions, record: AudioLifecycleRecorder) { super(options); this.#record = record; }
  #observe(event: string, error: string | null): void {
    const state: AudioNormalizerDiagnostics = this.diagnostics();
    this.#record({ event, timestamp: new Date().toISOString(), heartbeatTimers: null, activeWorkers: state.activeWorkers, queuedJobs: state.queuedJobs,
      workerTimers: state.queueTimers + state.executionTimers, error });
  }
  override async close(): Promise<void> {
    this.#observe('worker-close-start', null);
    try { await super.close(); this.#observe('worker-close-end', null); }
    catch (error: unknown) { this.#observe('worker-close-end', error instanceof Error ? error.name : 'UNKNOWN'); throw error; }
  }
}
export class ObservedAudioStore extends ProjectStore {
  readonly #dataRoot: string;
  readonly #record: AudioLifecycleRecorder;
  constructor(dataRoot: string, record: AudioLifecycleRecorder) { super(dataRoot); this.#dataRoot = dataRoot; this.#record = record; }
  heartbeatTimers(): number { return processHeartbeatTimerHasRef(this.#dataRoot, this.processHeartbeat().processInstanceId) === null ? 0 : 1; }
  #observe(event: string, error: string | null): void {
    this.#record({ event, timestamp: new Date().toISOString(), heartbeatTimers: this.heartbeatTimers(), activeWorkers: null, queuedJobs: null, workerTimers: null, error });
  }
  override async close(): Promise<void> {
    this.#observe('store-close-start', null);
    try { await super.close(); this.#observe('store-close-end', null); }
    catch (error: unknown) { this.#observe('store-close-end', error instanceof Error ? error.name : 'UNKNOWN'); throw error; }
  }
}

import { Worker } from 'node:worker_threads';
import { z } from 'zod';
import { contractError } from './errors.js';

export const AudioNormalizationWorkerOptionsSchema = z.strictObject({
  maxWorkers: z.number().int().positive().max(8),
  maxQueuedJobs: z.number().int().nonnegative().max(64),
  maxQueuedInputBytes: z.number().int().positive().max(1024 * 1024 * 1024),
  queueTimeoutMs: z.number().int().positive().max(120_000),
  executionTimeoutMs: z.number().int().positive().max(120_000),
  maxOldGenerationSizeMb: z.number().int().positive().max(512),
  maxYoungGenerationSizeMb: z.number().int().positive().max(128),
  stackSizeMb: z.number().positive().max(16),
});

export type AudioNormalizationWorkerOptions = z.infer<typeof AudioNormalizationWorkerOptionsSchema>;
export type AudioNormalizationPlan = {
  sourceData: Buffer;
  sourceSampleRate: number;
  sourceChannels: 1 | 2;
  sourceBitsPerSample: 16 | 24;
  sourceFrames: number;
  targetSampleRate: number;
  targetFrames: number;
  outputBytes: number;
  sampleOperations: number;
};
export type AudioNormalizer = { normalize(plan: AudioNormalizationPlan): Promise<Buffer> };

export type NormalizationWorker = {
  once(event: 'message', listener: (value: unknown) => void): NormalizationWorker;
  once(event: 'error', listener: (error: Error) => void): NormalizationWorker;
  once(event: 'exit', listener: (code: number) => void): NormalizationWorker;
  terminate(): Promise<number>;
};
export type AudioNormalizationWorkerFactory = (plan: AudioNormalizationPlan, options: AudioNormalizationWorkerOptions) => NormalizationWorker;
type PendingNormalization = {
  id: number;
  plan: AudioNormalizationPlan;
  resolve: (bytes: Buffer) => void;
  reject: (error: Error) => void;
  queueTimer: NodeJS.Timeout | null;
  settled: boolean;
};
type ActiveNormalization = { pending: PendingNormalization; worker: NormalizationWorker; executionTimer: NodeJS.Timeout };
type WorkerSuccess = { ok: true; bytes: Uint8Array };
type WorkerFailure = { ok: false; code: string; message: string };
type WorkerResult = WorkerSuccess | WorkerFailure;

function isWorkerResult(value: unknown): value is WorkerResult {
  if (typeof value !== 'object' || value === null || !('ok' in value) || typeof value.ok !== 'boolean') return false;
  if (value.ok) return 'bytes' in value && value.bytes instanceof Uint8Array;
  return 'code' in value && typeof value.code === 'string' && 'message' in value && typeof value.message === 'string';
}

function workerContext(plan: AudioNormalizationPlan): string {
  return `source=${plan.sourceSampleRate}Hz/${plan.sourceChannels}ch/${plan.sourceBitsPerSample}bit, target=${plan.targetSampleRate}Hz, frames=${plan.targetFrames}, bytes=${plan.outputBytes}, operations=${plan.sampleOperations}`;
}

function createWorker(plan: AudioNormalizationPlan, options: AudioNormalizationWorkerOptions): NormalizationWorker {
  const sourceData: Uint8Array<ArrayBuffer> = Uint8Array.from(plan.sourceData);
  return new Worker(new URL('./audio-normalization-worker.ts', import.meta.url), {
    workerData: { ...plan, sourceData }, transferList: [sourceData.buffer],
    resourceLimits: { maxOldGenerationSizeMb: options.maxOldGenerationSizeMb,
      maxYoungGenerationSizeMb: options.maxYoungGenerationSizeMb, stackSizeMb: options.stackSizeMb },
  });
}

/** CPU 집약적인 PCM 변환을 제한된 수의 Worker Thread에서 실행한다. */
export class WorkerAudioNormalizer implements AudioNormalizer {
  readonly #options: AudioNormalizationWorkerOptions;
  readonly #factory: AudioNormalizationWorkerFactory;
  readonly #queue: PendingNormalization[] = [];
  readonly #active: Map<number, ActiveNormalization> = new Map<number, ActiveNormalization>();
  #reservedInputBytes: number = 0;
  #nextId: number = 1;
  #closed: boolean = false;

  constructor(options: AudioNormalizationWorkerOptions, factory?: AudioNormalizationWorkerFactory) {
    this.#options = AudioNormalizationWorkerOptionsSchema.parse(options);
    this.#factory = factory ?? createWorker;
  }

  normalize(plan: AudioNormalizationPlan): Promise<Buffer> {
    if (this.#closed) return Promise.reject(contractError('AUDIO_NORMALIZATION_CLOSED', 'Audio normalization Worker pool이 종료되었습니다.', []));
    const waiting: boolean = this.#active.size >= this.#options.maxWorkers;
    if ((waiting && this.#queue.length >= this.#options.maxQueuedJobs)
      || this.#reservedInputBytes + plan.sourceData.byteLength > this.#options.maxQueuedInputBytes) {
      return Promise.reject(contractError('AUDIO_NORMALIZATION_QUEUE_FULL',
        `Audio normalization 대기열 용량을 초과했습니다. active=${this.#active.size}, queued=${this.#queue.length}, reservedInputBytes=${this.#reservedInputBytes}, requestInputBytes=${plan.sourceData.byteLength}`, []));
    }
    return new Promise<Buffer>((resolve: (bytes: Buffer) => void, reject: (error: Error) => void): void => {
      const pending: PendingNormalization = { id: this.#nextId, plan, resolve, reject, queueTimer: null, settled: false };
      this.#nextId += 1;
      this.#reservedInputBytes += plan.sourceData.byteLength;
      if (waiting) pending.queueTimer = setTimeout((): void => this.#expireQueued(pending.id), this.#options.queueTimeoutMs);
      this.#queue.push(pending);
      this.#drain();
    });
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    const closedError: Error = contractError('AUDIO_NORMALIZATION_CLOSED', 'Audio normalization Worker pool이 종료되었습니다.', []);
    for (const pending of this.#queue.splice(0)) this.#settleFailure(pending, closedError);
    const terminations: Promise<number>[] = [];
    for (const active of this.#active.values()) {
      clearTimeout(active.executionTimer);
      this.#settleFailure(active.pending, closedError);
      terminations.push(active.worker.terminate());
    }
    await Promise.allSettled(terminations);
  }

  #expireQueued(id: number): void {
    const index: number = this.#queue.findIndex((pending: PendingNormalization): boolean => pending.id === id);
    if (index < 0) return;
    const pending: PendingNormalization | undefined = this.#queue.splice(index, 1)[0];
    if (pending === undefined) return;
    this.#settleFailure(pending, contractError('AUDIO_NORMALIZATION_QUEUE_TIMEOUT',
      `Audio normalization 작업이 제한 시간 안에 시작되지 않았습니다. queueTimeoutMs=${this.#options.queueTimeoutMs}, ${workerContext(pending.plan)}`, []));
    this.#drain();
  }

  #settleFailure(pending: PendingNormalization, error: Error): void {
    if (pending.settled) return;
    pending.settled = true;
    if (pending.queueTimer !== null) clearTimeout(pending.queueTimer);
    this.#reservedInputBytes -= pending.plan.sourceData.byteLength;
    pending.reject(error);
  }

  #settleSuccess(pending: PendingNormalization, bytes: Buffer): void {
    if (pending.settled) return;
    pending.settled = true;
    if (pending.queueTimer !== null) clearTimeout(pending.queueTimer);
    this.#reservedInputBytes -= pending.plan.sourceData.byteLength;
    pending.resolve(bytes);
  }

  #drain(): void {
    if (this.#closed) return;
    while (this.#active.size < this.#options.maxWorkers) {
      const pending: PendingNormalization | undefined = this.#queue.shift();
      if (pending === undefined) return;
      if (pending.queueTimer !== null) { clearTimeout(pending.queueTimer); pending.queueTimer = null; }
      this.#start(pending);
    }
  }

  #start(pending: PendingNormalization): void {
    let worker: NormalizationWorker;
    try {
      worker = this.#factory(pending.plan, this.#options);
    } catch (error: unknown) {
      this.#settleFailure(pending, contractError('AUDIO_NORMALIZATION_WORKER_START_FAILED',
        `Audio normalization Worker를 시작할 수 없습니다. cause=${error instanceof Error ? error.message : String(error)}, ${workerContext(pending.plan)}`, []));
      return;
    }
    const executionTimer: NodeJS.Timeout = setTimeout((): void => {
      this.#settleFailure(pending, contractError('AUDIO_NORMALIZATION_TIMEOUT',
        `Audio normalization Worker가 제한 시간 안에 끝나지 않았습니다. executionTimeoutMs=${this.#options.executionTimeoutMs}, ${workerContext(pending.plan)}`, []));
      void worker.terminate().catch((error: unknown): void => {
        console.warn(JSON.stringify({ event: 'audio-normalization-worker-terminate-failed', cause: error instanceof Error ? error.message : String(error) }));
      });
    }, this.#options.executionTimeoutMs);
    this.#active.set(pending.id, { pending, worker, executionTimer });
    let resultReceived: boolean = false;
    worker.once('message', (value: unknown): void => {
      resultReceived = true;
      if (!isWorkerResult(value)) {
        this.#settleFailure(pending, contractError('AUDIO_NORMALIZATION_WORKER_PROTOCOL_ERROR', `Audio normalization Worker 응답 형식이 올바르지 않습니다. ${workerContext(pending.plan)}`, []));
        void worker.terminate();
        return;
      }
      if (!value.ok) { this.#settleFailure(pending, contractError(value.code, `${value.message} ${workerContext(pending.plan)}`, [])); return; }
      this.#settleSuccess(pending, Buffer.from(value.bytes.buffer, value.bytes.byteOffset, value.bytes.byteLength));
    });
    worker.once('error', (error: Error): void => {
      this.#settleFailure(pending, contractError('AUDIO_NORMALIZATION_WORKER_FAILED', `Audio normalization Worker가 실패했습니다. cause=${error.message}, ${workerContext(pending.plan)}`, []));
    });
    worker.once('exit', (code: number): void => {
      clearTimeout(executionTimer);
      if (!resultReceived && !pending.settled) this.#settleFailure(pending, contractError('AUDIO_NORMALIZATION_WORKER_EXITED',
        `Audio normalization Worker가 결과 없이 종료됐습니다. exitCode=${code}, ${workerContext(pending.plan)}`, []));
      this.#active.delete(pending.id);
      this.#drain();
    });
  }
}

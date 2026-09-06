import { Worker } from 'node:worker_threads';
import { z } from 'zod';
import { contractError } from './errors.js';

export const AudioNormalizationWorkerOptionsSchema = z.strictObject({
  maxWorkers: z.number().int().positive().max(8),
  timeoutMs: z.number().int().positive().max(120_000),
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

export type AudioNormalizer = {
  normalize(plan: AudioNormalizationPlan): Promise<Buffer>;
};

type PendingNormalization = {
  plan: AudioNormalizationPlan;
  resolve: (bytes: Buffer) => void;
  reject: (error: Error) => void;
};

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

/** CPU 집약적인 PCM 변환을 제한된 수의 Worker Thread에서 실행한다. */
export class WorkerAudioNormalizer implements AudioNormalizer {
  readonly #options: AudioNormalizationWorkerOptions;
  readonly #queue: PendingNormalization[] = [];
  #activeWorkers: number = 0;

  constructor(options: AudioNormalizationWorkerOptions) {
    this.#options = AudioNormalizationWorkerOptionsSchema.parse(options);
  }

  normalize(plan: AudioNormalizationPlan): Promise<Buffer> {
    return new Promise<Buffer>((resolve: (bytes: Buffer) => void, reject: (error: Error) => void): void => {
      this.#queue.push({ plan, resolve, reject });
      this.#drain();
    });
  }

  #drain(): void {
    while (this.#activeWorkers < this.#options.maxWorkers) {
      const pending: PendingNormalization | undefined = this.#queue.shift();
      if (pending === undefined) return;
      this.#start(pending);
    }
  }

  #start(pending: PendingNormalization): void {
    this.#activeWorkers += 1;
    let worker: Worker;
    try {
      const sourceData: Uint8Array<ArrayBuffer> = Uint8Array.from(pending.plan.sourceData);
      worker = new Worker(new URL('./audio-normalization-worker.ts', import.meta.url), {
        workerData: { ...pending.plan, sourceData },
        transferList: [sourceData.buffer],
        resourceLimits: {
          maxOldGenerationSizeMb: this.#options.maxOldGenerationSizeMb,
          maxYoungGenerationSizeMb: this.#options.maxYoungGenerationSizeMb,
          stackSizeMb: this.#options.stackSizeMb,
        },
      });
    } catch (error: unknown) {
      this.#activeWorkers -= 1;
      pending.reject(contractError('AUDIO_NORMALIZATION_WORKER_START_FAILED', `Audio normalization Worker를 시작할 수 없습니다. cause=${error instanceof Error ? error.message : String(error)}, ${workerContext(pending.plan)}`, []));
      return;
    }
    let resultReceived: boolean = false;
    let taskSettled: boolean = false;
    const settleFailure = (error: Error): void => {
      if (taskSettled) return;
      taskSettled = true;
      pending.reject(error);
    };
    const timeout = setTimeout((): void => {
      settleFailure(contractError('AUDIO_NORMALIZATION_TIMEOUT', `Audio normalization Worker가 제한 시간 안에 끝나지 않았습니다. timeoutMs=${this.#options.timeoutMs}, ${workerContext(pending.plan)}`, []));
      void worker.terminate().catch((error: unknown): void => {
        console.warn(JSON.stringify({ event: 'audio-normalization-worker-terminate-failed',
          cause: error instanceof Error ? error.message : String(error) }));
      });
    }, this.#options.timeoutMs);
    worker.once('message', (value: unknown): void => {
      resultReceived = true;
      if (!isWorkerResult(value)) {
        settleFailure(contractError('AUDIO_NORMALIZATION_WORKER_PROTOCOL_ERROR', `Audio normalization Worker 응답 형식이 올바르지 않습니다. ${workerContext(pending.plan)}`, []));
        void worker.terminate();
        return;
      }
      if (!value.ok) {
        settleFailure(contractError(value.code, `${value.message} ${workerContext(pending.plan)}`, []));
        return;
      }
      if (!taskSettled) {
        taskSettled = true;
        pending.resolve(Buffer.from(value.bytes.buffer, value.bytes.byteOffset, value.bytes.byteLength));
      }
    });
    worker.once('error', (error: Error): void => {
      settleFailure(contractError('AUDIO_NORMALIZATION_WORKER_FAILED', `Audio normalization Worker가 실패했습니다. cause=${error.message}, ${workerContext(pending.plan)}`, []));
    });
    worker.once('exit', (code: number): void => {
      clearTimeout(timeout);
      if (!resultReceived && !taskSettled) {
        settleFailure(contractError('AUDIO_NORMALIZATION_WORKER_EXITED', `Audio normalization Worker가 결과 없이 종료됐습니다. exitCode=${code}, ${workerContext(pending.plan)}`, []));
      }
      this.#activeWorkers -= 1;
      this.#drain();
    });
  }
}

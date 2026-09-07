import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { describe, expect, it } from 'vitest';
import { CodexRequestStore } from '../src/codex/requests.js';
import { WorkerAudioNormalizer } from '../src/domain/audio-normalizer.js';
import type { AudioNormalizationPlan, AudioNormalizationWorkerFactory, AudioNormalizationWorkerOptions, NormalizationWorker } from '../src/domain/audio-normalizer.js';
import type { AudioCue, Project } from '../src/domain/schema.js';
import { importPackage } from '../src/importers/import-package.js';
import { createSourceOutline } from '../src/proposal/outline.js';
import { createApp } from '../src/server/app.js';
import type { AppConfig } from '../src/server/config.js';
import { ProjectStore } from '../src/server/store.js';
import { nativePackage, pcmWav, TEST_AUDIO_NORMALIZATION_OPTIONS } from './helpers.js';

class ControlledWorker extends EventEmitter {
  terminateCount: number = 0;

  succeed(bytes: Buffer): void {
    this.emit('message', { ok: true, bytes: Uint8Array.from(bytes) });
    queueMicrotask((): boolean => this.emit('exit', 0));
  }

  fail(error: Error): void {
    this.emit('error', error);
    queueMicrotask((): boolean => this.emit('exit', 1));
  }

  terminate(): Promise<number> {
    this.terminateCount += 1;
    queueMicrotask((): boolean => this.emit('exit', 1));
    return Promise.resolve(1);
  }
}

function options(overrides: Partial<AudioNormalizationWorkerOptions>): AudioNormalizationWorkerOptions {
  return { maxWorkers: 1, maxQueuedJobs: 1, maxQueuedInputBytes: 16, queueTimeoutMs: 20, executionTimeoutMs: 1000,
    maxOldGenerationSizeMb: 32, maxYoungGenerationSizeMb: 8, stackSizeMb: 2, ...overrides };
}

function plan(bytes: number): AudioNormalizationPlan {
  return { sourceData: Buffer.alloc(bytes), sourceSampleRate: 24000, sourceChannels: 1, sourceBitsPerSample: 24,
    sourceFrames: 1, targetSampleRate: 48000, targetFrames: 2, outputBytes: 48, sampleOperations: 2 };
}

function controlledFactory(workers: ControlledWorker[]): AudioNormalizationWorkerFactory {
  return (): NormalizationWorker => {
    const worker: ControlledWorker | undefined = workers.shift();
    if (worker === undefined) throw new Error('검증 Worker가 부족합니다.');
    return worker as unknown as NormalizationWorker;
  };
}

function codeOf(error: unknown): string { return error instanceof Error && 'code' in error ? String(error.code) : ''; }

async function appFixture(normalizer?: WorkerAudioNormalizer): Promise<{ app: FastifyInstance; root: string; project: Project }> {
  const root: string = await mkdtemp(join(tmpdir(), 'storyboard-worker-queue-'));
  const webRoot: string = join(root, 'web'); await mkdir(webRoot); await writeFile(join(webRoot, 'index.html'), '<main></main>');
  const config: AppConfig = { host: '127.0.0.1', port: 4317, dataRoot: join(root, 'data'), webRoot,
    pdfFontPath: resolve('assets/fonts/NanumGothic-Regular.ttf'), audioNormalization: TEST_AUDIO_NORMALIZATION_OPTIONS,
    codex: { requestRoot: join(root, 'requests'), speechVoice: 'Yuna' } };
  const store = new ProjectStore(config.dataRoot);
  const project: Project = await store.create(createSourceOutline(importPackage(await nativePackage()), { proposedTextHoldMs: 2000 }));
  return { app: await createApp(config, store, new CodexRequestStore(config.codex.requestRoot), normalizer), root, project };
}

function multipart(bytes: Buffer): { payload: Buffer; headers: { 'content-type': string } } {
  const boundary: string = '----worker-queue-boundary';
  return { payload: Buffer.concat([Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="expectedRevision"\r\n\r\n0\r\n--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="large.wav"\r\nContent-Type: audio/wav\r\n\r\n`), bytes, Buffer.from(`\r\n--${boundary}--\r\n`)]),
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` } };
}

describe('Audio normalization Worker Queue', (): void => {
  it('queue_rejects_job_count_over_limit', async (): Promise<void> => {
    const workers: ControlledWorker[] = [new ControlledWorker(), new ControlledWorker()];
    const normalizer = new WorkerAudioNormalizer(options({ maxQueuedJobs: 1 }), controlledFactory(workers));
    const first = normalizer.normalize(plan(1)); first.catch((): void => {});
    const second = normalizer.normalize(plan(1)); second.catch((): void => {});
    await expect(normalizer.normalize(plan(1))).rejects.toSatisfy((error: unknown): boolean => codeOf(error) === 'AUDIO_NORMALIZATION_QUEUE_FULL');
    await normalizer.close(); await Promise.allSettled([first, second]);
  });

  it('queue_rejects_input_bytes_over_limit', async (): Promise<void> => {
    const worker = new ControlledWorker(); const normalizer = new WorkerAudioNormalizer(options({ maxQueuedInputBytes: 5 }), controlledFactory([worker]));
    const first = normalizer.normalize(plan(4)); first.catch((): void => {});
    await expect(normalizer.normalize(plan(2))).rejects.toSatisfy((error: unknown): boolean => codeOf(error) === 'AUDIO_NORMALIZATION_QUEUE_FULL');
    await normalizer.close(); await Promise.allSettled([first]);
  });

  it('queue_timeout_returns_structured_error', async (): Promise<void> => {
    const normalizer = new WorkerAudioNormalizer(options({ queueTimeoutMs: 5 }), controlledFactory([new ControlledWorker()]));
    const first = normalizer.normalize(plan(1)); first.catch((): void => {});
    await expect(normalizer.normalize(plan(1))).rejects.toSatisfy((error: unknown): boolean => codeOf(error) === 'AUDIO_NORMALIZATION_QUEUE_TIMEOUT');
    await normalizer.close(); await Promise.allSettled([first]);
  });

  it('queue_timeout_releases_reserved_bytes', async (): Promise<void> => {
    const normalizer = new WorkerAudioNormalizer(options({ maxQueuedInputBytes: 6, queueTimeoutMs: 5 }), controlledFactory([new ControlledWorker()]));
    const first = normalizer.normalize(plan(3)); first.catch((): void => {});
    await expect(normalizer.normalize(plan(3))).rejects.toSatisfy((error: unknown): boolean => codeOf(error) === 'AUDIO_NORMALIZATION_QUEUE_TIMEOUT');
    const replacement = normalizer.normalize(plan(3)); replacement.catch((): void => {});
    await normalizer.close(); await expect(replacement).rejects.toSatisfy((error: unknown): boolean => codeOf(error) === 'AUDIO_NORMALIZATION_CLOSED');
    await Promise.allSettled([first]);
  });

  it('completed_job_releases_reserved_bytes', async (): Promise<void> => {
    const firstWorker = new ControlledWorker(); const secondWorker = new ControlledWorker();
    const normalizer = new WorkerAudioNormalizer(options({ maxQueuedInputBytes: 4 }), controlledFactory([firstWorker, secondWorker]));
    const first = normalizer.normalize(plan(4)); firstWorker.succeed(Buffer.from([1])); await expect(first).resolves.toEqual(Buffer.from([1]));
    await new Promise<void>((resolve): void => queueMicrotask(resolve));
    const second = normalizer.normalize(plan(4)); secondWorker.succeed(Buffer.from([2])); await expect(second).resolves.toEqual(Buffer.from([2]));
    await normalizer.close();
  });

  it('failed_worker_releases_reserved_bytes', async (): Promise<void> => {
    const firstWorker = new ControlledWorker(); const secondWorker = new ControlledWorker();
    const normalizer = new WorkerAudioNormalizer(options({ maxQueuedInputBytes: 4 }), controlledFactory([firstWorker, secondWorker]));
    const first = normalizer.normalize(plan(4)); firstWorker.fail(new Error('worker failed')); await expect(first).rejects.toSatisfy((error: unknown): boolean => codeOf(error) === 'AUDIO_NORMALIZATION_WORKER_FAILED');
    await new Promise<void>((resolve): void => queueMicrotask(resolve));
    const second = normalizer.normalize(plan(4)); secondWorker.succeed(Buffer.from([2])); await expect(second).resolves.toEqual(Buffer.from([2]));
    await normalizer.close();
  });

  it('worker_start_failure_continues_draining_queue', async (): Promise<void> => {
    const firstWorker = new ControlledWorker(); const thirdWorker = new ControlledWorker(); let starts: number = 0;
    const factory: AudioNormalizationWorkerFactory = (): NormalizationWorker => {
      starts += 1;
      if (starts === 1) return firstWorker as unknown as NormalizationWorker;
      if (starts === 2) throw new Error('start failed');
      return thirdWorker as unknown as NormalizationWorker;
    };
    const normalizer = new WorkerAudioNormalizer(options({ maxQueuedJobs: 2 }), factory);
    const first = normalizer.normalize(plan(1)); const second = normalizer.normalize(plan(1)); const third = normalizer.normalize(plan(1));
    second.catch((): void => {}); third.catch((): void => {});
    firstWorker.succeed(Buffer.from([1])); await first;
    await expect(second).rejects.toSatisfy((error: unknown): boolean => codeOf(error) === 'AUDIO_NORMALIZATION_WORKER_START_FAILED');
    thirdWorker.succeed(Buffer.from([3])); await expect(third).resolves.toEqual(Buffer.from([3])); await normalizer.close();
  });

  it('normalizer_close_rejects_queued_jobs', async (): Promise<void> => {
    const normalizer = new WorkerAudioNormalizer(options({}), controlledFactory([new ControlledWorker()]));
    const first = normalizer.normalize(plan(1)); const queued = normalizer.normalize(plan(1)); first.catch((): void => {}); queued.catch((): void => {});
    await normalizer.close();
    await expect(queued).rejects.toSatisfy((error: unknown): boolean => codeOf(error) === 'AUDIO_NORMALIZATION_CLOSED');
    await Promise.allSettled([first]);
  });

  it('normalizer_close_terminates_active_workers', async (): Promise<void> => {
    const worker = new ControlledWorker(); const normalizer = new WorkerAudioNormalizer(options({}), controlledFactory([worker]));
    const active = normalizer.normalize(plan(1)); active.catch((): void => {}); await normalizer.close();
    expect(worker.terminateCount).toBe(1); await Promise.allSettled([active]);
  });

  it('app_close_closes_audio_normalizer', async (): Promise<void> => {
    const worker = new ControlledWorker(); const normalizer = new WorkerAudioNormalizer(options({}), controlledFactory([worker]));
    const fixture = await appFixture(normalizer); const active = normalizer.normalize(plan(1)); active.catch((): void => {});
    await fixture.app.close();
    await expect(active).rejects.toSatisfy((error: unknown): boolean => codeOf(error) === 'AUDIO_NORMALIZATION_CLOSED');
    expect(worker.terminateCount).toBe(1); await rm(fixture.root, { recursive: true, force: true });
  });

  it('concurrent_status_request_completes_before_large_upload', async (): Promise<void> => {
    const fixture = await appFixture();
    const cue: AudioCue | undefined = fixture.project.audioCues.find((candidate: AudioCue): boolean => candidate.kind === 'sfx');
    if (cue === undefined) throw new Error('대용량 업로드용 Cue가 없습니다.');
    const body = multipart(pcmWav(160_000, 48_000, 2, 24));
    let uploadSettled: boolean = false;
    const upload = fixture.app.inject({ method: 'POST', url: `/api/projects/${fixture.project.projectId}/audio/${cue.id}/asset`, ...body })
      .finally((): void => { uploadSettled = true; });
    await new Promise<void>((resolveImmediate): void => { setImmediate(resolveImmediate); });
    const status = await fixture.app.inject({ method: 'GET', url: '/api/status' });
    expect(status.statusCode).toBe(200); expect(uploadSettled).toBe(false);
    await upload; await fixture.app.close(); await rm(fixture.root, { recursive: true, force: true });
  }, 20_000);
});

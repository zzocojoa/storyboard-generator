import type { EventEmitter } from 'node:events';
import type { Socket } from 'node:net';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

export const BROWSER_AUDIO_EVENTS: readonly string[] = ['loadstart', 'loadedmetadata', 'canplay', 'playing', 'seeking', 'seeked', 'pause', 'ended', 'stalled', 'suspend', 'abort', 'emptied', 'error'];
export type MediaEventProbe = { event: string; timestamp: string; readyState: number; networkState: number; currentTime: number; duration: number | null; src: string; audioElements: number; errorCode: number | null; errorMessage: string | null };
export type AudioServerProbe = { event: 'request' | 'send' | 'finish' | 'close' | 'aborted' | 'socket-error'; timestamp: string;
  requestId: string; route: string; method: string; rangePresent: boolean; elapsedMs: number; status: number; bytes: number | null; errorCode: string | null };
export type AudioLifecycleEvent = { event: string; timestamp: string; heartbeatTimers: number | null; activeWorkers: number | null; queuedJobs: number | null; workerTimers: number | null; error: string | null };
type OwnedListener = { emitter: EventEmitter; event: string; listener: (...args: unknown[]) => void };
type RequestTiming = { startedAt: number; bytes: number | null };

/** Body·Header 값은 보관하지 않고 전송 시각·상태·크기와 이 관찰자가 소유한 Listener만 추적한다. */
export class AudioServerDiagnostics {
  readonly #events: AudioServerProbe[] = [];
  readonly #listeners: Set<OwnedListener> = new Set<OwnedListener>();
  readonly #sockets: Set<Socket> = new Set<Socket>();
  readonly #requests: Map<string, RequestTiming> = new Map<string, RequestTiming>();
  constructor(app: FastifyInstance) {
    this.#listen(app.server, 'connection', (...args: unknown[]): void => {
      const socket: Socket = args[0] as Socket; this.#sockets.add(socket);
      let owned: OwnedListener;
      owned = this.#listen(socket, 'close', (): void => { this.#sockets.delete(socket); this.#remove(owned); });
    });
    app.addHook('onRequest', async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
      if (!request.url.includes('/output/audio/')) return;
      this.#requests.set(request.id, { startedAt: performance.now(), bytes: null });
      const record = (event: AudioServerProbe['event'], errorCode: string | null): void => { this.#record(request, reply, event, errorCode); };
      record('request', null);
      const owned: OwnedListener[] = [];
      owned.push(this.#listen(reply.raw, 'finish', (): void => { record('finish', null); }));
      owned.push(this.#listen(request.raw, 'aborted', (): void => { record('aborted', null); }));
      owned.push(this.#listen(request.raw.socket, 'error', (...args: unknown[]): void => {
        const error: unknown = args[0]; record('socket-error', error instanceof Error && 'code' in error ? String(error.code) : 'UNKNOWN_SOCKET_ERROR');
      }));
      owned.push(this.#listen(reply.raw, 'close', (): void => {
        record('close', null); for (const listener of owned) this.#remove(listener); this.#requests.delete(request.id);
      }));
    });
    app.addHook('onSend', async (request: FastifyRequest, reply: FastifyReply, payload: unknown): Promise<unknown> => {
      const timing: RequestTiming | undefined = this.#requests.get(request.id);
      if (timing !== undefined) {
        timing.bytes = Buffer.isBuffer(payload) ? payload.length : typeof payload === 'string' ? Buffer.byteLength(payload) : null;
        this.#record(request, reply, 'send', null);
      }
      return payload;
    });
  }
  #listen(emitter: EventEmitter, event: string, listener: (...args: unknown[]) => void): OwnedListener {
    const owned: OwnedListener = { emitter, event, listener }; this.#listeners.add(owned); emitter.on(event, listener); return owned;
  }
  #remove(owned: OwnedListener): void { owned.emitter.off(owned.event, owned.listener); this.#listeners.delete(owned); }
  #record(request: FastifyRequest, reply: FastifyReply, event: AudioServerProbe['event'], errorCode: string | null): void {
    const timing: RequestTiming | undefined = this.#requests.get(request.id);
    if (timing === undefined) throw new Error(`Audio Request 진단 시각이 없습니다. requestId=${request.id}`);
    this.#events.push({ event, timestamp: new Date().toISOString(), requestId: request.id, route: request.routeOptions.url ?? '/unmatched', method: request.method,
      rangePresent: request.headers.range !== undefined, elapsedMs: performance.now() - timing.startedAt, status: reply.statusCode, bytes: timing.bytes, errorCode });
  }
  events(): AudioServerProbe[] { return this.#events.map((event: AudioServerProbe): AudioServerProbe => ({ ...event })); }
  resources(): { listeners: number; sockets: number; requests: number } { return { listeners: this.#listeners.size, sockets: this.#sockets.size, requests: this.#requests.size }; }
  async waitForClosedConnections(): Promise<void> {
    await Promise.all([...this.#sockets].map((socket: Socket): Promise<void> => new Promise<void>((done): void => {
      let owned: OwnedListener;
      owned = this.#listen(socket, 'close', (): void => { this.#remove(owned); done(); });
    })));
  }
  dispose(): void { for (const owned of this.#listeners) this.#remove(owned); }
}

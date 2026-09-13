import { spawn } from 'node:child_process';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { z } from 'zod';
import { contractError } from '../domain/errors.js';
import type { JsonValue } from '../io/stable-json.js';

const EnvelopeSchema = z.object({
  id: z.union([z.string(), z.number()]).optional(), method: z.string().optional(),
  params: z.json().optional(), result: z.json().optional(),
  error: z.object({ code: z.number(), message: z.string(), data: z.json().optional() }).optional(),
}).superRefine((message, context): void => {
  if (message.method !== undefined && (message.result !== undefined || message.error !== undefined)) context.addIssue({ code: 'custom', message: '요청과 응답 필드를 혼합할 수 없습니다.' });
  if (message.result !== undefined && message.error !== undefined) context.addIssue({ code: 'custom', message: '응답의 result와 error를 함께 지정할 수 없습니다.' });
});
export type AppServerNotification = { method: string; params: JsonValue };
export type AppServerRequest = AppServerNotification & { id: string | number };
export type AppServerDiagnostics = {
  elapsedMs: number; receivedBytes: number; pendingRpcCount: number; pendingMethods: string[];
  lastRequestedMethod: string | null; notificationCount: number;
  lastNotificationMethod: string | null; lastItemType: string | null; lastMessageElapsedMs: number | null; processExited: boolean;
};
export type AppServerConfigValue = string | number | boolean | readonly string[];
export type AppServerTransportOptions = {
  executable: string; cwd: string; config: Readonly<Record<string, AppServerConfigValue>>;
  maxMessageBytes: number; maxOutputBytes: number; requestTimeoutMs: number; shutdownTimeoutMs: number;
};
type PendingRpc = { method: string; resolve: (value: JsonValue) => void; reject: (error: Error) => void; timer: NodeJS.Timeout };
type ConnectionEvents = { notification: [AppServerNotification]; failure: [Error] };

/** 진단에는 인증 값과 무제한 원문을 남기지 않는다. */
export function appServerDiagnostic(value: string): string {
  return value.replace(/Bearer\s+[^\s"']+/giu, 'Bearer [REDACTED]')
    .replace(/sk-[A-Za-z0-9_-]+/gu, '[REDACTED]')
    .replace(/("(?:access_token|refresh_token|id_token|api_key)"\s*:\s*")[^"]+/giu, '$1[REDACTED]')
    .slice(-4000);
}

/** 설치된 Codex의 JSON-RPC 연결만 관리하며 모델 실행과 파일 반영 정책은 호출자가 결정한다. */
export class AppServerConnection extends EventEmitter<ConnectionEvents> {
  readonly #child: ChildProcessWithoutNullStreams;
  readonly #options: AppServerTransportOptions;
  readonly #pending: Map<string | number, PendingRpc> = new Map();
  readonly #closed: Promise<void>;
  readonly #answer: (request: AppServerRequest) => JsonValue;
  #sequence: number = 0;
  #buffer: string = '';
  #bytes: number = 0;
  #stderr: string = '';
  #failure: Error | null = null;
  #closing: boolean = false;
  #exited: boolean = false;
  readonly #startedAt: number = Date.now();
  #lastRequestedMethod: string | null = null;
  #notificationCount: number = 0;
  #lastNotificationMethod: string | null = null;
  #lastItemType: string | null = null;
  #lastMessageElapsedMs: number | null = null;

  constructor(options: AppServerTransportOptions, answer: (request: AppServerRequest) => JsonValue) {
    super();
    for (const value of [options.maxMessageBytes, options.maxOutputBytes, options.requestTimeoutMs, options.shutdownTimeoutMs]) {
      if (!Number.isSafeInteger(value) || value <= 0) throw contractError('CODEX_TRANSPORT_OPTIONS_INVALID', 'Codex 연결 제한은 양의 정수여야 합니다.', []);
    }
    if (options.maxMessageBytes > options.maxOutputBytes) throw contractError('CODEX_TRANSPORT_OPTIONS_INVALID', '단일 메시지 제한은 전체 응답 제한보다 클 수 없습니다.', []);
    this.#options = { ...options, config: { ...options.config } };
    this.#answer = answer;
    const overrides: string[] = Object.entries(options.config).flatMap(([key, value]): string[] => ['-c', `${key}=${JSON.stringify(value)}`]);
    this.#child = spawn(options.executable, ['app-server', '--listen', 'stdio://', ...overrides], { cwd: options.cwd, stdio: ['pipe', 'pipe', 'pipe'], shell: false });
    this.#closed = new Promise<void>((resolve): void => {
      this.#child.once('close', (code: number | null, signal: NodeJS.Signals | null): void => {
        this.#exited = true;
        if (!this.#closing) this.#fail(contractError('CODEX_ENGINE_EXIT', `Codex 연결 종료: exitCode=${code}, signal=${signal}, detail=${appServerDiagnostic(this.#stderr)}`, []));
        resolve();
      });
    });
    this.#child.on('error', (error: Error): void => { this.#fail(contractError('CODEX_ENGINE_UNAVAILABLE', `Codex 실행 실패: executable=${options.executable}, cause=${appServerDiagnostic(error.message)}`, [])); });
    this.#child.stdin.on('error', (error: Error): void => { if (!this.#closing) this.#fail(contractError('CODEX_ENGINE_IO', `Codex 전송 실패: ${appServerDiagnostic(error.message)}`, [])); });
    this.#child.stderr.setEncoding('utf8');
    this.#child.stderr.on('data', (chunk: string): void => { this.#stderr = (this.#stderr + chunk).slice(-8192); });
    this.#child.stdout.setEncoding('utf8');
    this.#child.stdout.on('data', (chunk: string): void => { this.#receive(chunk); });
  }

  #fail(error: Error): void {
    if (this.#failure !== null) return;
    this.#failure = error;
    for (const pending of this.#pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
    this.#pending.clear();
    this.emit('failure', error);
    if (!this.#exited) this.#child.kill('SIGTERM');
  }

  #assertOpen(): void {
    if (this.#failure !== null) throw this.#failure;
    if (this.#closing || this.#exited) throw contractError('CODEX_ENGINE_CLOSED', 'Codex 연결이 종료되었습니다. 새 실행 연결을 시작하세요.', []);
  }

  #write(value: JsonValue): void {
    const message: string = JSON.stringify(value) + '\n';
    const bytes: number = Buffer.byteLength(message);
    if (bytes > this.#options.maxMessageBytes) throw contractError('CODEX_INPUT_TOO_LARGE', `Codex 전송 메시지 제한 초과: bytes=${bytes}, maxBytes=${this.#options.maxMessageBytes}`, []);
    if (this.#child.stdin.writableLength + bytes > this.#options.maxOutputBytes) throw contractError('CODEX_INPUT_BACKPRESSURE', `Codex 전송 대기 제한 초과: maxBytes=${this.#options.maxOutputBytes}`, []);
    this.#child.stdin.write(message);
  }

  notify(method: string, params: JsonValue): void {
    this.#assertOpen();
    this.#write({ method, params });
  }

  /** 진단은 단계·수신량만 복사하며 원문·인증값·모델 사고 내용은 포함하지 않는다. */
  diagnostics(): AppServerDiagnostics {
    return { elapsedMs: Math.max(0, Date.now() - this.#startedAt), receivedBytes: this.#bytes,
      pendingRpcCount: this.#pending.size, pendingMethods: [...this.#pending.values()].slice(0, 16).map((pending): string => appServerDiagnostic(pending.method).slice(0, 200)),
      lastRequestedMethod: this.#lastRequestedMethod, notificationCount: this.#notificationCount,
      lastNotificationMethod: this.#lastNotificationMethod, lastItemType: this.#lastItemType,
      lastMessageElapsedMs: this.#lastMessageElapsedMs, processExited: this.#exited };
  }

  request(method: string, params: JsonValue): Promise<JsonValue> {
    this.#assertOpen();
    this.#lastRequestedMethod = appServerDiagnostic(method).slice(0, 200);
    const id: number = ++this.#sequence;
    return new Promise<JsonValue>((resolve, reject): void => {
      const timer: NodeJS.Timeout = setTimeout((): void => {
        this.#fail(contractError('CODEX_RPC_TIMEOUT', `Codex 응답 제한 시간 초과: method=${appServerDiagnostic(method)}, requestId=${id}, timeoutMs=${this.#options.requestTimeoutMs}, diagnostics=${JSON.stringify(this.diagnostics())}`, []));
      }, this.#options.requestTimeoutMs);
      this.#pending.set(id, { method, resolve, reject, timer });
      try { this.#write({ id, method, params }); }
      catch (error: unknown) {
        clearTimeout(timer); this.#pending.delete(id);
        reject(error instanceof Error ? error : contractError('CODEX_ENGINE_IO', appServerDiagnostic(String(error)), []));
      }
    });
  }

  #receive(chunk: string): void {
    if (this.#failure !== null || this.#closing) return;
    this.#lastMessageElapsedMs = Math.max(0, Date.now() - this.#startedAt);
    this.#bytes += Buffer.byteLength(chunk);
    if (this.#bytes > this.#options.maxOutputBytes) { this.#fail(contractError('CODEX_OUTPUT_TOO_LARGE', `Codex 누적 응답 제한 초과: maxBytes=${this.#options.maxOutputBytes}`, [])); return; }
    this.#buffer += chunk;
    let newline: number = this.#buffer.indexOf('\n');
    while (newline >= 0) {
      const line: string = this.#buffer.slice(0, newline);
      this.#buffer = this.#buffer.slice(newline + 1);
      if (Buffer.byteLength(line) > this.#options.maxMessageBytes) { this.#fail(contractError('CODEX_MESSAGE_TOO_LARGE', `Codex 메시지 제한 초과: maxBytes=${this.#options.maxMessageBytes}`, [])); return; }
      try { this.#dispatch(line); }
      catch (error: unknown) {
        const failure: Error = error instanceof SyntaxError || error instanceof z.ZodError
          ? contractError('CODEX_PROTOCOL_INVALID', `Codex JSON-RPC 형식 오류: ${error instanceof SyntaxError ? appServerDiagnostic(error.message) : 'envelope schema mismatch'}`, [])
          : error instanceof Error ? error : contractError('CODEX_PROTOCOL_INVALID', appServerDiagnostic(String(error)), []);
        this.#fail(failure); return;
      }
      if (this.#failure !== null) return;
      newline = this.#buffer.indexOf('\n');
    }
    if (Buffer.byteLength(this.#buffer) > this.#options.maxMessageBytes) this.#fail(contractError('CODEX_MESSAGE_TOO_LARGE', `Codex 미완성 메시지 제한 초과: maxBytes=${this.#options.maxMessageBytes}`, []));
  }

  #dispatch(line: string): void {
    const message = EnvelopeSchema.parse(JSON.parse(line) as unknown);
    if (message.method !== undefined) {
      this.#notificationCount += 1;
      this.#lastNotificationMethod = appServerDiagnostic(message.method).slice(0, 200);
      if (message.method === 'item/started' || message.method === 'item/completed') {
        const item = z.object({ item: z.object({ type: z.string() }) }).safeParse(message.params);
        if (item.success) this.#lastItemType = appServerDiagnostic(item.data.item.type).slice(0, 200);
      }
      const notification: AppServerNotification = { method: message.method, params: message.params ?? null };
      if (message.id === undefined) this.emit('notification', notification);
      else {
        try { this.#write({ id: message.id, result: this.#answer({ ...notification, id: message.id }) }); }
        catch (error: unknown) {
          this.#write({ id: message.id, error: { code: -32601, message: '허용하지 않은 실행 요청입니다.' } });
          throw error;
        }
      }
      return;
    }
    if (message.id === undefined) throw contractError('CODEX_PROTOCOL_INVALID', 'Codex 응답에 method 또는 id가 없습니다.', []);
    const pending: PendingRpc | undefined = this.#pending.get(message.id);
    if (pending === undefined) throw contractError('CODEX_PROTOCOL_INVALID', `Codex 응답에 대응하는 요청이 없습니다: requestId=${message.id}`, []);
    this.#pending.delete(message.id); clearTimeout(pending.timer);
    if (message.error !== undefined) pending.reject(contractError('CODEX_RPC_ERROR', `Codex 요청 오류: method=${pending.method}, requestId=${message.id}, code=${message.error.code}, detail=${appServerDiagnostic(JSON.stringify(message.error))}`, []));
    else if (message.result === undefined) {
      const error: Error = contractError('CODEX_PROTOCOL_INVALID', `Codex 응답에 result가 없습니다: method=${pending.method}`, []);
      pending.reject(error); throw error;
    } else pending.resolve(message.result);
  }

  /** 취소와 종료는 대기 요청을 정산하고 자식 프로세스가 종료된 뒤 반환한다. */
  async close(): Promise<void> {
    if (!this.#closing) {
      this.#closing = true;
      this.#fail(contractError('CODEX_ENGINE_CLOSED', 'Codex 연결 종료로 요청이 중단되었습니다.', []));
      this.#child.stdin.end();
      if (!this.#exited) this.#child.kill('SIGTERM');
    }
    const timer: NodeJS.Timeout = setTimeout((): void => { if (!this.#exited) this.#child.kill('SIGKILL'); }, this.#options.shutdownTimeoutMs);
    try { await this.#closed; }
    finally { clearTimeout(timer); }
  }
}

export function rejectAppServerRequest(request: AppServerRequest): never {
  throw contractError('CODEX_UNEXPECTED_TOOL_REQUEST', `허용하지 않은 Codex 실행 요청입니다: method=${request.method}, requestId=${request.id}`, []);
}

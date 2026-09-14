import type { Stats } from 'node:fs';
import { lstat, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { contractError } from '../domain/errors.js';
import { isMissingFile } from '../io/package.js';
import { sameFileIdentity } from '../server/safe-filesystem.js';
import type { FileIdentity } from '../server/safe-filesystem.js';
import { AppServerConnection, appServerDiagnostic, rejectAppServerRequest } from './app-server-transport.js';

export type AppServerSessionOptions = {
  executable: string; model: string | null; timeoutMs: number;
  sandbox: 'read-only' | 'workspace-write';
  capabilities: readonly 'imageGeneration'[];
  maxMessageBytes: number; maxOutputBytes: number;
  developerInstructions: string;
};
const AccountSchema = z.object({ account: z.object({ type: z.string() }).nullable() });
const ConfigurationSchema = z.object({ config: z.object({ mcp_servers: z.record(z.string(), z.json()).optional() }) });
const ThreadSchema = z.object({ thread: z.object({ id: z.string().min(1) }), model: z.string().min(1), modelProvider: z.string().min(1),
  approvalPolicy: z.string(), reasoningEffort: z.string().nullable().optional(), sandbox: z.object({ type: z.string(), networkAccess: z.boolean().optional(), writableRoots: z.array(z.string()).optional() }) });

function executionConfig(capabilities: readonly 'imageGeneration'[]): Record<string, string | boolean> {
  return { 'features.apps': false, 'features.plugins': false, 'features.shell_tool': false, 'features.unified_exec': false,
    'features.multi_agent': false, 'features.hooks': false, 'features.view_image': false, 'features.sleep_tool': false,
    'features.image_generation': capabilities.includes('imageGeneration'), 'features.tool_suggest': false, web_search: 'disabled' };
}

/** 실행 시작 때 만든 폴더와 같은 파일시스템 객체인 경우에만 임시 결과를 정리한다. */
async function removeSessionWorkspace(cwd: string, identity: FileIdentity): Promise<void> {
  let metadata: Stats;
  try { metadata = await lstat(cwd); }
  catch (error: unknown) {
    if (!isMissingFile(error)) throw error;
    throw contractError('CODEX_WORKSPACE_CHANGED', `Codex 임시 폴더가 사라졌습니다. 다른 경로를 대신 정리하지 않습니다: cwd=${cwd}, expected=${identity.dev}:${identity.ino}`, []);
  }
  if (!metadata.isDirectory() || metadata.isSymbolicLink() || !sameFileIdentity(metadata, identity) || await realpath(cwd) !== cwd) {
    throw contractError('CODEX_WORKSPACE_CHANGED', `Codex 임시 폴더가 변경되어 정리를 중단했습니다. 현재 파일을 보존하고 경로를 확인하세요: cwd=${cwd}, expected=${identity.dev}:${identity.ino}, actual=${metadata.dev}:${metadata.ino}`, []);
  }
  await rm(cwd, { recursive: true, force: false });
}

/** 실행별 임시 영역·수명·ChatGPT 인증을 관리하며 모델에게 저장된 콘티를 노출하지 않는다. */
export class AppServerSession {
  readonly connection: AppServerConnection;
  readonly cwd: string;
  readonly #workspaceIdentity: FileIdentity;
  readonly #signal: AbortSignal;
  readonly #timer: NodeJS.Timeout;
  readonly #abort: () => void;
  #cause: Error | null = null;
  #closing: Promise<void> | null = null;
  #threadId: string | null = null;
  #model: string | null = null;
  #reasoningEffort: string | null = null;

  private constructor(cwd: string, workspaceIdentity: FileIdentity, options: AppServerSessionOptions, signal: AbortSignal) {
    this.cwd = cwd; this.#workspaceIdentity = { ...workspaceIdentity }; this.#signal = signal;
    this.connection = new AppServerConnection({ executable: options.executable, cwd, config: executionConfig(options.capabilities),
      maxMessageBytes: options.maxMessageBytes, maxOutputBytes: options.maxOutputBytes,
      requestTimeoutMs: Math.min(options.timeoutMs, 30000), shutdownTimeoutMs: 1500 }, rejectAppServerRequest);
    this.#abort = (): void => { this.#interrupt(contractError('CODEX_EXECUTION_CANCELLED', 'Codex 자동 실행을 취소했습니다. 저장된 콘티는 유지됩니다.', [])); };
    this.#timer = setTimeout((): void => { this.#interrupt(contractError('CODEX_EXECUTION_TIMEOUT', `Codex 실행 제한 시간 초과: timeoutMs=${options.timeoutMs}, diagnostics=${JSON.stringify({ model: this.#model === null ? null : appServerDiagnostic(this.#model), reasoningEffort: this.#reasoningEffort === null ? null : appServerDiagnostic(this.#reasoningEffort), ...this.connection.diagnostics() })}`, [])); }, options.timeoutMs);
    signal.addEventListener('abort', this.#abort, { once: true });
    if (signal.aborted) this.#abort();
  }

  static async open(options: AppServerSessionOptions, signal: AbortSignal): Promise<AppServerSession> {
    if (signal.aborted) throw contractError('CODEX_EXECUTION_CANCELLED', '시작 전에 Codex 자동 실행이 취소되었습니다.', []);
    for (const value of [options.timeoutMs, options.maxMessageBytes, options.maxOutputBytes]) {
      if (!Number.isSafeInteger(value) || value <= 0) throw contractError('CODEX_SESSION_OPTIONS_INVALID', 'Codex 실행 제한은 양의 정수여야 합니다.', []);
    }
    const cwd: string = await realpath(await mkdtemp(join(tmpdir(), 'cutroom-automation-')));
    const metadata: Stats = await lstat(cwd);
    const identity: FileIdentity = { dev: metadata.dev, ino: metadata.ino };
    let session: AppServerSession;
    try { session = new AppServerSession(cwd, identity, options, signal); }
    catch (error: unknown) { await removeSessionWorkspace(cwd, identity); throw error; }
    try { await session.#initialize(options); return session; }
    catch (error: unknown) { await session.close(); throw session.#cause ?? error; }
  }

  get threadId(): string {
    if (this.#threadId === null) throw contractError('CODEX_SESSION_NOT_READY', 'Codex 실행 연결이 아직 준비되지 않았습니다.', []);
    return this.#threadId;
  }
  get model(): string {
    if (this.#model === null) throw contractError('CODEX_SESSION_NOT_READY', 'Codex 실행 모델이 아직 확인되지 않았습니다.', []);
    return this.#model;
  }
  get interruption(): Error | null { return this.#cause; }

  async #initialize(options: AppServerSessionOptions): Promise<void> {
    await this.connection.request('initialize', { clientInfo: { name: 'cutroom_automation', title: 'Cutroom Automation', version: '0.1.0' }, capabilities: { experimentalApi: true } });
    this.connection.notify('initialized', {});
    const account = AccountSchema.parse(await this.connection.request('account/read', {}));
    if (account.account?.type !== 'chatgpt') throw contractError('CODEX_LOGIN_REQUIRED', 'Codex App에서 ChatGPT 계정으로 로그인한 뒤 다시 실행하세요. API 키 인증은 사용하지 않습니다.', []);
    const configuration = ConfigurationSchema.parse(await this.connection.request('config/read', { includeLayers: false, cwd: this.cwd }));
    const disabledServers: Record<string, boolean> = Object.fromEntries(Object.keys(configuration.config.mcp_servers ?? {}).map((name): [string, boolean] => [
      `mcp_servers.${/^[\w-]+$/u.test(name) ? name : JSON.stringify(name)}.enabled`, false,
    ]));
    const thread = ThreadSchema.parse(await this.connection.request('thread/start', {
      cwd: this.cwd, runtimeWorkspaceRoots: [this.cwd], ephemeral: true, approvalPolicy: 'never', sandbox: options.sandbox,
      environments: [], selectedCapabilityRoots: [], config: { ...disabledServers, ...executionConfig(options.capabilities),
        'sandbox_workspace_write.writable_roots': [this.cwd], 'sandbox_workspace_write.exclude_tmpdir_env_var': true, 'sandbox_workspace_write.exclude_slash_tmp': true },
      developerInstructions: options.developerInstructions, ...(options.model === null ? {} : { model: options.model }), allowProviderModelFallback: false,
    }));
    const expectedSandbox: string = options.sandbox === 'read-only' ? 'readOnly' : 'workspaceWrite';
    if (thread.modelProvider !== 'openai' || thread.approvalPolicy !== 'never' || thread.sandbox.type !== expectedSandbox || thread.sandbox.networkAccess === true
      || (thread.sandbox.writableRoots ?? []).some((root): boolean => root !== this.cwd)) {
      throw contractError('CODEX_EXECUTION_POLICY', `Codex 엔진이 지정된 실행 정책을 적용하지 않았습니다: expected=${JSON.stringify({ provider: 'openai', approvalPolicy: 'never', sandbox: expectedSandbox, cwd: this.cwd })}, actual=${JSON.stringify({ provider: thread.modelProvider, approvalPolicy: thread.approvalPolicy, sandbox: thread.sandbox })}`, []);
    }
    if (options.model !== null && options.model !== thread.model) throw contractError('CODEX_MODEL_MISMATCH', `Codex 실행 모델이 다릅니다: expected=${options.model}, actual=${thread.model}`, []);
    this.#threadId = thread.thread.id; this.#model = thread.model; this.#reasoningEffort = thread.reasoningEffort ?? null;
  }

  #interrupt(error: Error): void {
    if (this.#cause !== null || this.#closing !== null) return;
    this.#cause = error;
    // 임시 영역 삭제는 실행 소비자가 종료된 뒤 close에서 수행한다.
    void this.connection.close();
  }

  close(): Promise<void> {
    if (this.#closing === null) {
      clearTimeout(this.#timer); this.#signal.removeEventListener('abort', this.#abort);
      this.#closing = this.#cleanup();
    }
    return this.#closing;
  }

  async #cleanup(): Promise<void> {
    await this.connection.close();
    await removeSessionWorkspace(this.cwd, this.#workspaceIdentity);
  }
}

import { writeNodeFixture } from './node-process-fixture.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { TestContext } from 'vitest';
import { AppServerConnection, appServerDiagnostic, rejectAppServerRequest } from '../src/codex/app-server-transport.js';
import type { AppServerNotification, AppServerTransportOptions } from '../src/codex/app-server-transport.js';
import type { JsonValue } from '../src/io/stable-json.js';

const FIXTURE: string = `#!${process.execPath}
import { createInterface } from 'node:readline';
const send = value => process.stdout.write(JSON.stringify(value) + '\\n');
let first;
createInterface({ input: process.stdin }).on('line', line => {
  const { id, method, params } = JSON.parse(line);
  if (method === 'first') first = id;
  if (method === 'second') {
    send({ id, result: 'second' });
    const bytes = Buffer.from(JSON.stringify({ id: first, result: '한글 응답' }) + '\\n');
    const split = bytes.indexOf(Buffer.from('한')) + 1;
    process.stdout.write(bytes.subarray(0, split));
    setTimeout(() => process.stdout.write(bytes.subarray(split)), 10);
  }
  if (method === 'rpc-error') send({ id, error: { code: -32000, message: 'Bearer private-token', data: { access_token: 'token-value' } } });
  if (method === 'echo') send({ id, result: params });
  if (method === 'event') { send({ method: 'progress', params }); send({ id, result: null }); }
  if (method === 'reasoning-event') { send({ method: 'item/started', params: { item: { type: 'reasoning', text: 'DO_NOT_LEAK_PROMPT_OR_REASONING', api_key: 'sk-private123' } } }); send({ id, result: null }); }
  if (method === 'unknown') send({ id: 'unknown-id', result: 'unexpected' });
  if (method === 'mixed') send({ id, result: 'value', error: { code: 1, message: 'error' } });
  if (method === 'invalid') process.stdout.write('invalid\\n');
  if (method === 'large') process.stdout.write('a'.repeat(5000));
  if (method === 'accumulate') { for (let i = 0; i < 20; i++) send({ method: 'progress', params: 'a'.repeat(2000) }); }
  if (method === 'permission') send({ id: 'server-request', method: 'item/permissions/requestApproval', params: {} });
  if (method === 'ignore-stop') { process.on('SIGTERM', () => {}); send({ id, result: 'ready' }); }
  if (method === 'exit') { process.stderr.write('Bearer private-token'); process.exit(7); }
});
send({ method: 'fixture-ready', params: null });
`;

function transportOptions(root: string, executable: string): AppServerTransportOptions {
  return { executable, cwd: root, config: {}, maxMessageBytes: 4096, maxOutputBytes: 16384, requestTimeoutMs: 500, shutdownTimeoutMs: 100 };
}

/** 프로세스 기동과 RPC 동작을 분리한다. 시작 대기도 기존 Test 취소 신호로 종료한다. */
function waitForFixture(connection: AppServerConnection, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject): void => {
    const cleanup = (): void => { connection.off('notification', notification); connection.off('failure', failure); signal.removeEventListener('abort', abort); };
    const notification = (event: AppServerNotification): void => { if (event.method === 'fixture-ready') { cleanup(); resolve(); } };
    const failure = (error: Error): void => { cleanup(); reject(error); };
    const abort = (): void => { failure(new Error('통신 Fixture 시작 대기가 Test 종료로 취소됐습니다.', { cause: signal.reason })); };
    connection.on('notification', notification); connection.on('failure', failure); signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
  });
}

async function withConnection(signal: AbortSignal, check: (connection: AppServerConnection) => Promise<void>): Promise<void> {
  const root: string = await mkdtemp(join(tmpdir(), 'cutroom-transport-test-'));
  const executable: string = join(root, 'fixture.mjs');
  await writeNodeFixture(executable, FIXTURE);
  const connection: AppServerConnection = new AppServerConnection(transportOptions(root, executable), rejectAppServerRequest);
  try { await waitForFixture(connection, signal); await check(connection); }
  finally { await connection.close(); await rm(root, { recursive: true, force: true }); }
}

describe('Codex App Server transport', (): void => {
  it('app_server_diagnostics_distinguish_pending_rpc_and_generation_without_private_content', async (context: TestContext): Promise<void> => {
    await withConnection(context.signal, async (connection): Promise<void> => {
      await connection.request('reasoning-event', { prompt: 'DO_NOT_LEAK_USER_INPUT' });
      const received = connection.diagnostics();
      expect(received).toMatchObject({ pendingRpcCount: 0, pendingMethods: [], lastRequestedMethod: 'reasoning-event', lastNotificationMethod: 'item/started', lastItemType: 'reasoning', processExited: false });
      expect(received.receivedBytes).toBeGreaterThan(0);
      expect(received.lastMessageElapsedMs).not.toBeNull();
      const pending = connection.request('no-response', { prompt: 'DO_NOT_LEAK_USER_INPUT' });
      const snapshot = connection.diagnostics();
      expect(snapshot).toMatchObject({ pendingRpcCount: 1, pendingMethods: ['no-response'], lastRequestedMethod: 'no-response' });
      snapshot.pendingMethods.push('external-edit');
      expect(connection.diagnostics().pendingMethods).toEqual(['no-response']);
      const failure: unknown = await pending.then((): null => null, (error: unknown): unknown => error);
      expect(failure).toMatchObject({ code: 'CODEX_RPC_TIMEOUT' });
      if (!(failure instanceof Error)) throw new Error('진단 오류가 반환되지 않았습니다.');
      expect(failure.message).toContain('"pendingRpcCount":1');
      expect(failure.message).toContain('"lastItemType":"reasoning"');
      expect(JSON.stringify(received) + failure.message).not.toMatch(/DO_NOT_LEAK|sk-private123|external-edit/u);
    });
  });

  it('matches out-of-order replies and preserves split UTF-8 messages and notifications', async (context: TestContext): Promise<void> => {
    await withConnection(context.signal, async (connection): Promise<void> => {
      const values: JsonValue[] = await Promise.all([connection.request('first', {}), connection.request('second', {})]);
      expect(values).toEqual(['한글 응답', 'second']);
      const events: JsonValue[] = [];
      connection.on('notification', (event): void => { events.push(event.params); });
      expect(await connection.request('event', { count: 2 })).toBeNull();
      expect(events).toEqual([{ count: 2 }]);
    });
  });

  it('rejects an RPC error without leaking credentials and keeps later RPCs usable', async (context: TestContext): Promise<void> => {
    await withConnection(context.signal, async (connection): Promise<void> => {
      const outcome = await Promise.allSettled([connection.request('rpc-error', {})]);
      expect(outcome[0]).toMatchObject({ status: 'rejected', reason: { code: 'CODEX_RPC_ERROR' } });
      const failure: PromiseRejectedResult = outcome[0] as PromiseRejectedResult;
      expect(String(failure.reason)).toContain('method=rpc-error');
      expect(String(failure.reason)).not.toMatch(/private-token|token-value/u);
      expect(await connection.request('echo', { value: 3 })).toEqual({ value: 3 });
      expect(appServerDiagnostic('sk-sensitive-secret')).toBe('[REDACTED]');
    });
  });

  it('rejects malformed, unsolicited and conflicting protocol messages', async (context: TestContext): Promise<void> => {
    for (const method of ['unknown', 'mixed', 'invalid']) {
      await withConnection(context.signal, async (connection): Promise<void> => {
        await expect(connection.request(method, {})).rejects.toMatchObject({ code: 'CODEX_PROTOCOL_INVALID' });
      });
    }
  });

  it('bounds unfinished messages, cumulative output and outbound payloads', async (context: TestContext): Promise<void> => {
    for (const [method, code] of [['large', 'CODEX_MESSAGE_TOO_LARGE'], ['accumulate', 'CODEX_OUTPUT_TOO_LARGE']] as const) {
      await withConnection(context.signal, async (connection): Promise<void> => { await expect(connection.request(method, {})).rejects.toMatchObject({ code }); });
    }
    await withConnection(context.signal, async (connection): Promise<void> => {
      await expect(connection.request('echo', 'a'.repeat(5000))).rejects.toMatchObject({ code: 'CODEX_INPUT_TOO_LARGE' });
      expect(await connection.request('echo', 'valid')).toBe('valid');
    });
  });

  it('denies unexpected permission requests and settles every pending RPC', async (context: TestContext): Promise<void> => {
    await withConnection(context.signal, async (connection): Promise<void> => {
      const outcomes = await Promise.allSettled([connection.request('wait', {}), connection.request('permission', {})]);
      expect(outcomes).toHaveLength(2);
      for (const outcome of outcomes) expect(outcome).toMatchObject({ status: 'rejected', reason: { code: 'CODEX_UNEXPECTED_TOOL_REQUEST' } });
    });
  });

  it('settles timeouts and forced shutdown without leaving unresolved requests', async (context: TestContext): Promise<void> => {
    await withConnection(context.signal, async (connection): Promise<void> => {
      await expect(connection.request('wait', {})).rejects.toMatchObject({ code: 'CODEX_RPC_TIMEOUT' });
    });
    await withConnection(context.signal, async (connection): Promise<void> => {
      expect(await connection.request('ignore-stop', {})).toBe('ready');
      const pending: Promise<PromiseSettledResult<JsonValue>[]> = Promise.allSettled([connection.request('wait', {})]);
      await connection.close();
      expect(await pending).toMatchObject([{ status: 'rejected', reason: { code: 'CODEX_ENGINE_CLOSED' } }]);
    });
  });

  it('reports spawn failure and unexpected process exit with sanitized diagnostics', async (context: TestContext): Promise<void> => {
    const connection: AppServerConnection = new AppServerConnection(transportOptions(tmpdir(), join(tmpdir(), 'cutroom-missing-executable')), rejectAppServerRequest);
    try { await expect(connection.request('initialize', {})).rejects.toMatchObject({ code: 'CODEX_ENGINE_UNAVAILABLE' }); }
    finally { await connection.close(); }
    await withConnection(context.signal, async (child): Promise<void> => {
      const outcomes = await Promise.allSettled([child.request('exit', {})]);
      expect(outcomes[0]).toMatchObject({ status: 'rejected', reason: { code: 'CODEX_ENGINE_EXIT' } });
      expect(String((outcomes[0] as PromiseRejectedResult).reason)).not.toContain('private-token');
    });
  });
});

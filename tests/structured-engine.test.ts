import { writeNodeFixture } from './node-process-fixture.js';
import { lstat, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CodexStructuredEngine } from '../src/codex/structured-engine.js';
import type { StructuredGenerationInput } from '../src/codex/structured-engine.js';

type EngineCase = 'success' | 'api-key' | 'foreign-provider' | 'wrong-model' | 'wide-policy' | 'permission' | 'tool' | 'invalid-json' | 'no-result' | 'failed' | 'hang' | 'initialize-hang' | 'workspace-replaced' | 'workspace-linked' | 'workspace-missing';
const INPUT: StructuredGenerationInput = { prompt: '합성 원문을 검토하세요.', outputSchema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'], additionalProperties: false } };

async function writeFixture(root: string, behavior: EngineCase): Promise<string> {
  const executable: string = join(root, 'engine.mjs');
  await writeNodeFixture(executable, `#!${process.execPath}
import { createInterface } from 'node:readline';
import { appendFileSync, mkdirSync, renameSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const behavior = ${JSON.stringify(behavior)};
const transcript = ${JSON.stringify(join(root, 'transcript.jsonl'))};
const send = value => process.stdout.write(JSON.stringify(value) + '\\n');
const item = (turnId, data) => send({ method: 'item/completed', params: { threadId: 'thread', turnId, item: data } });
createInterface({ input: process.stdin }).on('line', line => {
  appendFileSync(transcript, line + '\\n');
  const { id, method, params } = JSON.parse(line);
  if (method === 'initialize' && behavior !== 'initialize-hang') send({ id, result: {} });
  if (method === 'account/read') send({ id, result: { account: { type: behavior === 'api-key' ? 'apiKey' : 'chatgpt' } } });
  if (method === 'config/read') send({ id, result: { config: { mcp_servers: { unrelated: { enabled: true } } } } });
  if (method === 'thread/start') send({ id, result: { thread: { id: 'thread' }, model: behavior === 'wrong-model' ? 'different-model' : 'fixture-model', reasoningEffort: 'xhigh', modelProvider: behavior === 'foreign-provider' ? 'other' : 'openai', approvalPolicy: 'never', sandbox: { type: 'readOnly', networkAccess: behavior === 'wide-policy' } } });
  if (method === 'turn/start') {
    if (['workspace-replaced', 'workspace-linked', 'workspace-missing'].includes(behavior)) {
      const workspace = process.cwd();
      writeFileSync(${JSON.stringify(join(root, 'workspace-path.txt'))}, workspace);
      renameSync(workspace, ${JSON.stringify(join(root, 'moved-workspace'))});
      if (behavior !== 'workspace-missing') {
        const replacement = behavior === 'workspace-linked' ? ${JSON.stringify(join(root, 'linked-workspace'))} : workspace;
        mkdirSync(replacement);
        writeFileSync(join(replacement, 'other-owner.txt'), '기존 사용자 파일');
        if (behavior === 'workspace-linked') symlinkSync(replacement, workspace, 'dir');
      }
    }
    item('another-turn', { type: 'agentMessage', phase: 'final_answer', text: '{"ok":false}' });
    send({ method: 'turn/completed', params: { threadId: 'thread', turn: { id: 'another-turn', status: 'completed' } } });
    if (behavior === 'permission') { send({ id: 'permission', method: 'item/permissions/requestApproval', params: {} }); return; }
    if (behavior === 'tool') { item('turn', { type: 'commandExecution' }); }
    item('turn', { type: 'agentMessage', phase: 'commentary', text: '검토 중입니다.' });
    if (behavior !== 'no-result') item('turn', { type: 'agentMessage', phase: 'final_answer', text: behavior === 'invalid-json' ? 'not-json' : '{"ok":true}' });
    send({ id, result: { turn: { id: 'turn', status: 'inProgress' } } });
    if (behavior === 'hang') return;
    send({ method: 'turn/completed', params: { threadId: 'thread', turn: { id: 'turn', status: behavior === 'failed' ? 'failed' : 'completed', error: behavior === 'failed' ? { message: 'upstream failed' } : null } } });
  }
});
`);
  return executable;
}

async function checkEngine(behavior: EngineCase, check: (engine: CodexStructuredEngine, root: string) => Promise<void>): Promise<void> {
  const root: string = await mkdtemp(join(tmpdir(), 'cutroom-structured-test-'));
  try {
    const executable: string = await writeFixture(root, behavior);
    await check(new CodexStructuredEngine({ executable, model: 'fixture-model', timeoutMs: 1000 }), root);
  } finally { await rm(root, { recursive: true, force: true }); }
}

describe('Codex structured engine', (): void => {
  it('automation_structured_engine_preserves_a_replaced_workspace_during_cleanup', async (): Promise<void> => {
    const cases: readonly EngineCase[] = ['workspace-replaced', 'workspace-linked', 'workspace-missing'];
    for (const behavior of cases) await checkEngine(behavior, async (engine, root): Promise<void> => {
      try {
        await expect(engine.run(INPUT, new AbortController().signal)).rejects.toMatchObject({ code: 'CODEX_WORKSPACE_CHANGED' });
        const workspace: string = await readFile(join(root, 'workspace-path.txt'), 'utf8');
        if (behavior === 'workspace-missing') await expect(lstat(workspace)).rejects.toMatchObject({ code: 'ENOENT' });
        else {
          expect(await readFile(join(workspace, 'other-owner.txt'), 'utf8')).toBe('기존 사용자 파일');
          expect((await lstat(workspace)).isSymbolicLink()).toBe(behavior === 'workspace-linked');
        }
        expect((await lstat(join(root, 'moved-workspace'))).isDirectory()).toBe(true);
      } finally {
        const workspace: string = await readFile(join(root, 'workspace-path.txt'), 'utf8');
        await rm(workspace, { recursive: true, force: true });
      }
    });
  });

  it('automation_structured_engine_times_out_during_initialization_without_a_response', async (): Promise<void> => {
    await checkEngine('initialize-hang', async (engine, root): Promise<void> => {
      const failure: unknown = await engine.run(INPUT, new AbortController().signal).then((): null => null, (error: unknown): unknown => error);
      expect(failure).toMatchObject({ code: 'CODEX_EXECUTION_TIMEOUT' });
      if (!(failure instanceof Error)) throw new Error('초기 응답 시간 초과가 반환되지 않았습니다.');
      const diagnostics: unknown = JSON.parse(failure.message.split('diagnostics=')[1]!);
      expect(diagnostics).toMatchObject({ model: null, receivedBytes: 0, pendingRpcCount: 1, pendingMethods: ['initialize'], lastRequestedMethod: 'initialize', processExited: false });
      const transcript: string = await readFile(join(root, 'transcript.jsonl'), 'utf8');
      expect(transcript).toContain('"method":"initialize"');
      expect(transcript).not.toContain('"method":"turn/start"');
      expect(failure.message).not.toContain(INPUT.prompt);
    });
  });

  it('automation_structured_engine_isolates_tools_auth_and_correlates_early_turn_events', async (): Promise<void> => {
    await checkEngine('success', async (engine, root): Promise<void> => {
      expect(await engine.run(INPUT, new AbortController().signal)).toEqual({ model: 'fixture-model', turnId: 'turn', result: { ok: true } });
      const transcript: string = await readFile(join(root, 'transcript.jsonl'), 'utf8');
      expect(transcript).toContain('"mcp_servers.unrelated.enabled":false');
      expect(transcript).toContain('"features.image_generation":false');
      expect(transcript).toContain('"features.shell_tool":false');
      expect(transcript).toContain('"selectedCapabilityRoots":[]');
      expect(transcript).toContain('"allowProviderModelFallback":false');
      expect(transcript).toContain('"outputSchema":');
    });
  });

  it('automation_structured_engine_rejects_foreign_auth_provider_model_and_expanded_policy', async (): Promise<void> => {
    const cases: readonly [EngineCase, string][] = [['api-key', 'CODEX_LOGIN_REQUIRED'], ['foreign-provider', 'CODEX_EXECUTION_POLICY'], ['wrong-model', 'CODEX_MODEL_MISMATCH'], ['wide-policy', 'CODEX_EXECUTION_POLICY']];
    for (const [behavior, code] of cases) await checkEngine(behavior, async (engine): Promise<void> => {
      await expect(engine.run(INPUT, new AbortController().signal)).rejects.toMatchObject({ code });
    });
  });

  it('automation_structured_engine_rejects_tools_invalid_json_missing_result_and_failed_turns', async (): Promise<void> => {
    const cases: readonly [EngineCase, string][] = [['permission', 'CODEX_UNEXPECTED_TOOL_REQUEST'], ['tool', 'CODEX_UNEXPECTED_EXECUTION'], ['invalid-json', 'CODEX_PLAN_INVALID_JSON'], ['no-result', 'CODEX_PLAN_RESULT_MISSING'], ['failed', 'CODEX_GENERATION_FAILED']];
    for (const [behavior, code] of cases) await checkEngine(behavior, async (engine): Promise<void> => {
      await expect(engine.run(INPUT, new AbortController().signal)).rejects.toMatchObject({ code });
    });
  });

  it('automation_structured_engine_times_out_cancels_and_cleans_its_private_workspace', async (): Promise<void> => {
    await checkEngine('hang', async (engine, root): Promise<void> => {
      const failure: unknown = await engine.run(INPUT, new AbortController().signal).then((): null => null, (error: unknown): unknown => error);
      expect(failure).toMatchObject({ code: 'CODEX_EXECUTION_TIMEOUT' });
      if (!(failure instanceof Error)) throw new Error('진단 오류가 반환되지 않았습니다.');
      const diagnostics: unknown = JSON.parse(failure.message.split('diagnostics=')[1]!);
      expect(diagnostics).toMatchObject({ model: 'fixture-model', reasoningEffort: 'xhigh', pendingRpcCount: 0, pendingMethods: [], lastRequestedMethod: 'turn/start', lastItemType: 'agentMessage', processExited: false });
      expect(failure.message).not.toContain(INPUT.prompt);
      const transcript: string = await readFile(join(root, 'transcript.jsonl'), 'utf8');
      const request = transcript.split('\n').filter(Boolean).map((line): { method: string; params: { cwd: string } } => JSON.parse(line) as { method: string; params: { cwd: string } }).find((message): boolean => message.method === 'thread/start');
      expect(request).toBeDefined();
      await expect(lstat(request!.params.cwd)).rejects.toMatchObject({ code: 'ENOENT' });
    });
    await checkEngine('success', async (engine): Promise<void> => {
      const controller: AbortController = new AbortController(); controller.abort();
      await expect(engine.run(INPUT, controller.signal)).rejects.toMatchObject({ code: 'CODEX_EXECUTION_CANCELLED' });
    });
    await checkEngine('hang', async (engine): Promise<void> => {
      const controller: AbortController = new AbortController();
      const timer: NodeJS.Timeout = setTimeout((): void => { controller.abort(); }, 150);
      try { await expect(engine.run(INPUT, controller.signal)).rejects.toMatchObject({ code: 'CODEX_EXECUTION_CANCELLED' }); }
      finally { clearTimeout(timer); }
    });
  });
});

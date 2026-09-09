import { fork } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { resolve } from 'node:path';
import { z } from 'zod';

const WorkerMessageSchema = z.object({ event: z.string(), ok: z.boolean().optional(), code: z.string().optional(), result: z.unknown().optional() });
export type WorkerMessage = z.infer<typeof WorkerMessageSchema>;
export type ControlledProcess = { child: ChildProcess; event(name: string): Promise<WorkerMessage>; send(value: string): void; stop(): Promise<void>; exited: Promise<void> };

/** IPC Barrier로 Process 진행·종료를 제어하며 종료를 기다린 뒤 Root를 지울 수 있게 한다. */
export function controlledProcess(script: string, input: string): ControlledProcess {
  const child: ChildProcess = fork(resolve(script), [input], { execArgv: ['--import', 'tsx'], stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  const messages: WorkerMessage[] = []; const listeners: Map<string, ((value: WorkerMessage) => void)[]> = new Map();
  let stderr: string = ''; let closed: boolean = false;
  child.stderr?.on('data', (bytes: Buffer): void => { stderr += bytes.toString('utf8'); });
  child.stdout?.resume();
  const exited: Promise<void> = new Promise<void>((done): void => { child.once('exit', (): void => { closed = true; done(); }); });
  const streamsClosed: Promise<void> = new Promise<void>((done): void => { child.once('close', (): void => { listeners.clear(); done(); }); });
  child.on('message', (raw: unknown): void => {
    const message: WorkerMessage = WorkerMessageSchema.parse(raw); const waiting = listeners.get(message.event)?.shift();
    if (waiting !== undefined) waiting(message); else messages.push(message);
  });
  return {
    child, exited,
    async event(name: string): Promise<WorkerMessage> {
      const index: number = messages.findIndex((message: WorkerMessage): boolean => message.event === name);
      if (index >= 0) return messages.splice(index, 1)[0]!;
      if (closed) throw new Error(`Child Process가 응답 전에 종료됐습니다. event=${name}, stderr=${stderr}`);
      return Promise.race([
        new Promise<WorkerMessage>((done): void => { const waiting = listeners.get(name) ?? []; waiting.push(done); listeners.set(name, waiting); }),
        exited.then((): never => { throw new Error(`Child Process가 응답 전에 종료됐습니다. event=${name}, stderr=${stderr}`); }),
      ]);
    },
    send(value: string): void { child.send(value); },
    async stop(): Promise<void> {
      if (!closed) child.kill('SIGKILL');
      let timer: NodeJS.Timeout | undefined;
      try {
        await Promise.race([streamsClosed, new Promise<never>((_resolve, reject): void => {
          timer = setTimeout((): void => { reject(new Error(`Child Process close를 확인하지 못했습니다. pid=${child.pid}, script=${script}`)); }, 2000);
        })]);
      } finally { if (timer !== undefined) clearTimeout(timer); }
    },
  };
}

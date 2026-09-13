import { z } from 'zod';
import { contractError } from '../domain/errors.js';
import type { JsonValue } from '../io/stable-json.js';
import type { AppServerSession } from './app-server-session.js';
import { appServerDiagnostic } from './app-server-transport.js';
import type { AppServerNotification } from './app-server-transport.js';

const ItemEventSchema = z.object({ threadId: z.string(), turnId: z.string(), item: z.object({ type: z.string() }).passthrough() });
const TurnEventSchema = z.object({ threadId: z.string(), turn: z.object({ id: z.string(), status: z.string(), error: z.json().nullable().optional() }) });
const ErrorEventSchema = z.object({ threadId: z.string(), turnId: z.string(), willRetry: z.boolean(), error: z.json() });
const StartSchema = z.object({ turn: z.object({ id: z.string().min(1) }) });
export type AppServerTurnInput = { text: string; imageUrls: readonly string[]; outputSchema: JsonValue | null; allowedItemTypes: readonly string[]; itemLimits: Readonly<Record<string, number>> };
export type AppServerTurnResult = { turnId: string; items: JsonValue[] };

/** 같은 Thread·Turn의 완료 결과만 수집하며 도구 실행과 권한 요청을 별도로 차단한다. */
export async function executeAppServerTurn(session: AppServerSession, input: AppServerTurnInput): Promise<AppServerTurnResult> {
  for (const [type, count] of Object.entries(input.itemLimits)) {
    if (!input.allowedItemTypes.includes(type) || !Number.isSafeInteger(count) || count <= 0) throw contractError('CODEX_ITEM_LIMIT_INVALID', `Codex 작업 수 제한이 올바르지 않습니다: type=${type}, count=${count}`, []);
  }
  let turnId: string | null = null;
  const buffered: AppServerNotification[] = [];
  const items: JsonValue[] = [];
  const seenItems: Map<string, Set<string>> = new Map();
  let resolveFinal!: (value: AppServerTurnResult) => void;
  let rejectFinal!: (error: Error) => void;
  const completion: Promise<AppServerTurnResult> = new Promise((resolve, reject): void => { resolveFinal = resolve; rejectFinal = reject; });
  // Turn 시작 응답보다 먼저 실패 통지가 도착해도 후속 await에서 같은 원인을 반환한다.
  void completion.catch((): void => undefined);
  const failure = (error: Error): void => { rejectFinal(session.interruption ?? error); };
  const processEvent = (event: AppServerNotification): void => {
    if (event.method === 'item/started' || event.method === 'item/completed') {
      const value = ItemEventSchema.parse(event.params);
      if (value.threadId !== session.threadId || value.turnId !== turnId) return;
      if (!input.allowedItemTypes.includes(value.item.type)) throw contractError('CODEX_UNEXPECTED_EXECUTION', `자동 실행에서 허용하지 않은 항목입니다: type=${value.item.type}, turnId=${turnId}`, []);
      const limit: number | undefined = input.itemLimits[value.item.type];
      if (limit !== undefined) {
        const itemId: string = z.string().min(1).parse(value.item.id);
        const seen: Set<string> = seenItems.get(value.item.type) ?? new Set();
        seen.add(itemId); seenItems.set(value.item.type, seen);
        if (seen.size > limit) throw contractError('CODEX_GENERATION_LIMIT', `Codex 생성 작업 수 제한을 초과했습니다: type=${value.item.type}, limit=${limit}, actual=${seen.size}`, []);
      }
      if (event.method === 'item/completed') items.push(z.json().parse(value.item));
    } else if (event.method === 'turn/completed') {
      const value = TurnEventSchema.parse(event.params);
      if (value.threadId !== session.threadId || value.turn.id !== turnId) return;
      if (value.turn.status !== 'completed') throw contractError('CODEX_GENERATION_FAILED', `Codex 생성 실패: turnId=${turnId}, status=${value.turn.status}, detail=${appServerDiagnostic(JSON.stringify(value.turn.error ?? null))}`, []);
      resolveFinal({ turnId: value.turn.id, items: [...items] });
    } else if (event.method === 'error') {
      const value = ErrorEventSchema.parse(event.params);
      if (value.threadId !== session.threadId || value.turnId !== turnId) return;
      if (value.willRetry) console.warn(JSON.stringify({ event: 'codex-execution-retry', threadId: value.threadId, turnId: value.turnId, detail: appServerDiagnostic(JSON.stringify(value.error)) }));
      else throw contractError('CODEX_GENERATION_FAILED', `Codex 생성 오류: turnId=${turnId}, detail=${appServerDiagnostic(JSON.stringify(value.error))}`, []);
    }
  };
  const receive = (event: AppServerNotification): void => {
    if (!['item/started', 'item/completed', 'turn/completed', 'error'].includes(event.method)) return;
    if (turnId === null) { buffered.push(event); return; }
    processEvent(event);
  };
  session.connection.on('notification', receive); session.connection.on('failure', failure);
  try {
    const start = StartSchema.parse(await session.connection.request('turn/start', { threadId: session.threadId,
      input: [{ type: 'text', text: input.text, text_elements: [] }, ...input.imageUrls.map((url): JsonValue => ({ type: 'image', url }))], outputSchema: input.outputSchema }));
    turnId = start.turn.id;
    for (const event of buffered) processEvent(event);
    return await completion;
  } catch (error: unknown) { throw session.interruption ?? error; }
  finally { session.connection.off('notification', receive); session.connection.off('failure', failure); }
}

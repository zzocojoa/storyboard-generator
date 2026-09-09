import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { setTimeout as waitForLock } from 'node:timers/promises';
import { z } from 'zod';
import { contractError } from '../domain/errors.js';
import { sha256Text } from '../importers/integrity.js';
import { SafeStoreFilesystem, sameFileIdentity } from '../server/safe-filesystem.js';
import type { FileIdentity } from '../server/safe-filesystem.js';

import { REQUEST_LOCK_VERSION } from './storage-contract.js';
export { REQUEST_LOCK_VERSION } from './storage-contract.js';
export const RequestLockSchema = z.strictObject({
  version: z.literal(REQUEST_LOCK_VERSION), key: z.string().regex(/^[a-f0-9]{64}$/), transactionId: z.uuid(), parentTransactionId: z.uuid().nullable(),
  host: z.string().min(1), pid: z.number().int().positive(), createdAt: z.iso.datetime(),
});
export type RequestLockMetadata = z.infer<typeof RequestLockSchema>;
export type RequestLock = { path: string; metadata: RequestLockMetadata; identity: FileIdentity; bytes: string };
type RecoverRequest = (original: RequestLock, assertOwnership: () => Promise<void>) => Promise<void>;
const WAIT_LIMIT_MS: number = 5000;

export function requestStorageError(code: string, message: string): never { throw contractError(code, message, []); }
export function requestErrorCode(error: unknown): string {
  return error instanceof Error && 'code' in error && typeof error.code === 'string' ? error.code : error instanceof Error ? error.name : 'UNKNOWN';
}
export function requestOwnerAlive(metadata: RequestLockMetadata): boolean {
  if (metadata.host !== hostname()) requestStorageError('CODEX_REQUEST_RECOVERY_REQUIRED', `다른 Host의 Request Lock은 보존해야 합니다. key=${metadata.key}, host=${metadata.host}`);
  try { process.kill(metadata.pid, 0); return true; }
  catch (error: unknown) {
    if (requestErrorCode(error) === 'ESRCH') return false;
    requestStorageError('CODEX_REQUEST_RECOVERY_REQUIRED', `Request Lock의 소유 PID를 증명할 수 없습니다. key=${metadata.key}, pid=${metadata.pid}, cause=${requestErrorCode(error)}`);
  }
}

/** 논리 Key를 직렬화한다. 중단된 복구자의 자식 Claim을 append-only로 남겨 재중단 시에도 단일 복구자를 선출한다. */
export class RequestLockManager {
  readonly #fs: SafeStoreFilesystem;
  readonly #recover: RecoverRequest;
  constructor(fs: SafeStoreFilesystem, recover: RecoverRequest) { this.#fs = fs; this.#recover = recover; }

  path(key: string): string { return this.#fs.path('.locks', `${key}.lock`); }

  async read(path: string): Promise<RequestLock | null> {
    try {
      if (await this.#fs.kind(path) === 'missing') return null;
      const identity: FileIdentity = await this.#fs.identity(path); const bytes: string = await this.#fs.readText(path);
      const metadata: RequestLockMetadata = RequestLockSchema.parse(JSON.parse(bytes) as unknown);
      if (!sameFileIdentity(identity, await this.#fs.identity(path))) requestStorageError('CODEX_REQUEST_STATE_CONFLICT', `Request Lock identity가 변경됐습니다. path=${path}`);
      return { path, metadata, identity, bytes };
    } catch (error: unknown) {
      if (await this.#fs.kind(path) === 'missing') return null;
      requestStorageError('CODEX_REQUEST_RECOVERY_REQUIRED', `Request Lock을 검증할 수 없습니다. path=${path}, cause=${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async verify(lock: RequestLock): Promise<void> {
    const current: RequestLock | null = await this.read(lock.path);
    if (current === null || current.bytes !== lock.bytes || !sameFileIdentity(current.identity, lock.identity)) {
      requestStorageError('CODEX_REQUEST_STATE_CONFLICT', `Request Lock 소유권이 변경됐습니다. key=${lock.metadata.key}, transactionId=${lock.metadata.transactionId}`);
    }
  }

  async release(lock: RequestLock): Promise<void> {
    await this.verify(lock); await this.#fs.unlinkFile(lock.path, lock.identity); await this.#fs.syncDirectory(dirname(lock.path));
  }

  async #publish(path: string, key: string, parentTransactionId: string | null): Promise<RequestLock> {
    const metadata: RequestLockMetadata = { version: 1, key, host: hostname(), pid: process.pid,
      transactionId: randomUUID(), parentTransactionId, createdAt: new Date().toISOString() };
    const bytes: string = JSON.stringify(metadata);
    const identity: FileIdentity = await this.#fs.publishExclusiveFileWithIdentity(path, bytes,
      `${sha256Text(hostname()).slice(0, 16)}.${process.pid}.${metadata.transactionId}`);
    return { path, metadata, identity, bytes };
  }

  async #recoveryClaim(parent: RequestLock, ancestors: readonly RequestLock[]): Promise<readonly RequestLock[]> {
    if (ancestors.length >= 64) requestStorageError('CODEX_REQUEST_RECOVERY_REQUIRED', `Request 복구 Claim 깊이 제한에 도달했습니다. key=${parent.metadata.key}`);
    const path: string = this.#fs.path('.recovery-claims', `${parent.metadata.key}.${parent.metadata.transactionId}.lock`);
    try { return [...ancestors, parent, await this.#publish(path, parent.metadata.key, parent.metadata.transactionId)]; }
    catch (error: unknown) { if (requestErrorCode(error) !== 'EXCLUSIVE_FILE_EXISTS') throw error; }
    const child: RequestLock | null = await this.read(path);
    if (child === null) requestStorageError('CODEX_REQUEST_STORE_BUSY', `Request 복구 Claim이 변경 중입니다. key=${parent.metadata.key}`);
    if (child.metadata.key !== parent.metadata.key || child.metadata.parentTransactionId !== parent.metadata.transactionId) {
      requestStorageError('CODEX_REQUEST_RECOVERY_REQUIRED', `Request 복구 Claim 연결이 다릅니다. key=${parent.metadata.key}`);
    }
    if (requestOwnerAlive(child.metadata)) requestStorageError('CODEX_REQUEST_STORE_BUSY', `다른 Process가 Request를 복구 중입니다. key=${parent.metadata.key}`);
    return this.#recoveryClaim(child, [...ancestors, parent]);
  }

  async #recoverAbandoned(original: RequestLock): Promise<void> {
    const chain: readonly RequestLock[] = await this.#recoveryClaim(original, []);
    const own: RequestLock = chain[chain.length - 1]!;
    const assertOwnership = async (): Promise<void> => { for (const lock of chain) await this.verify(lock); };
    try {
      await assertOwnership();
      await this.#recover(original, assertOwnership);
      await assertOwnership();
      await this.release(original);
    } catch (error: unknown) {
      await this.release(own);
      throw error;
    }
    // 과거 복구 Claim은 UUID 연결 감사 증거다. 재사용·삭제하지 않아 이전 관찰자의 ABA를 막는다.
    await this.verify(own);
  }

  /** Lock 대기만 제한하며 사용자 상태 변경 함수는 획득 후 정확히 한 번 실행한다. */
  async acquire(key: string): Promise<RequestLock> {
    const startedAt: number = Date.now(); let warned: boolean = false;
    while (true) {
      try { return await this.#publish(this.path(key), key, null); }
      catch (error: unknown) { if (requestErrorCode(error) !== 'EXCLUSIVE_FILE_EXISTS') throw error; }
      const current: RequestLock | null = await this.read(this.path(key));
      if (current !== null) {
        if (current.metadata.key !== key || current.metadata.parentTransactionId !== null) requestStorageError('CODEX_REQUEST_RECOVERY_REQUIRED', `논리 Key와 Request Lock이 다릅니다. key=${key}`);
        if (!requestOwnerAlive(current.metadata)) {
          try { await this.#recoverAbandoned(current); }
          catch (error: unknown) { if (!['CODEX_REQUEST_STORE_BUSY', 'CODEX_REQUEST_STATE_CONFLICT'].includes(requestErrorCode(error))) throw error; }
        }
      }
      if (Date.now() - startedAt >= WAIT_LIMIT_MS) requestStorageError('CODEX_REQUEST_STORE_BUSY', `Request Lock 대기 제한을 초과했습니다. key=${key}, waitLimitMs=${WAIT_LIMIT_MS}`);
      if (!warned) { console.warn(JSON.stringify({ event: 'codex-request-lock-wait', key, waitLimitMs: WAIT_LIMIT_MS })); warned = true; }
      await waitForLock(10);
    }
  }

  /** 완성 전 게시 파일은 현재 Host의 살아 있는 PID에 한해 대기로 보며, 중단된 파일은 보존한다. */
  async inspectTemporary(parent: string, name: string): Promise<void> {
    const path: string = join(parent, name);
    if (await this.#fs.kind(path) === 'missing') return;
    const match: RegExpMatchArray | null = name.match(/-([a-f0-9]{16})\.([0-9]+)\.([a-f0-9-]{36})\.tmp$/);
    if (name.startsWith('.publish-') && match !== null && match[1] === sha256Text(hostname()).slice(0, 16)) {
      const pid: number = Number(match[2]);
      if (Number.isSafeInteger(pid) && pid > 0) {
        if (requestOwnerAlive({ version: 1, key: '0'.repeat(64), transactionId: match[3]!, parentTransactionId: null, host: hostname(), pid, createdAt: new Date().toISOString() })) return;
        const identity: FileIdentity = await this.#fs.identity(path); const bytes: string = await this.#fs.readText(path);
        let raw: unknown;
        try { raw = JSON.parse(bytes) as unknown; } catch (error: unknown) { requestStorageError('CODEX_REQUEST_RECOVERY_REQUIRED', `중단된 Request 게시 JSON을 해석할 수 없습니다. path=${path}, cause=${error instanceof Error ? error.message : String(error)}`); }
        const parsed = RequestLockSchema.safeParse(raw);
        if (parsed.success && parsed.data.pid === pid && parsed.data.host === hostname() && parsed.data.transactionId === match[3]) {
          const metadata: RequestLockMetadata = parsed.data;
          const finalName: string = metadata.parentTransactionId === null ? `${metadata.key}.lock` : `${metadata.key}.${metadata.parentTransactionId}.lock`;
          if (name !== `.publish-${finalName}-${match[1]}.${pid}.${metadata.transactionId}.tmp`
            || basename(parent) !== (metadata.parentTransactionId === null ? '.locks' : '.recovery-claims')) {
            requestStorageError('CODEX_REQUEST_RECOVERY_REQUIRED', `Request 게시 파일의 소유 경로가 다릅니다. path=${path}`);
          }
          const finalPath: string = join(parent, finalName);
          if (await this.#fs.exists(finalPath) && !sameFileIdentity(identity, await this.#fs.identity(finalPath))) requestStorageError('CODEX_REQUEST_RECOVERY_REQUIRED', `Request 게시 대상 identity가 다릅니다. path=${path}`);
          if (await this.#fs.readText(path) !== bytes) requestStorageError('CODEX_REQUEST_RECOVERY_REQUIRED', `Request 임시 파일이 변경됐습니다. path=${path}`);
          await this.#fs.unlinkFile(path, identity); await this.#fs.syncDirectory(parent); return;
        }
      }
    }
    requestStorageError('CODEX_REQUEST_RECOVERY_REQUIRED', `소유권이 확정되지 않은 Request 게시 임시 파일은 보존합니다. path=${path}`);
  }
}

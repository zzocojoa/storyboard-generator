import { randomUUID } from 'node:crypto';
import { dirname } from 'node:path';
import { z } from 'zod';
import { generatorBuildProvenance } from '../build.js';
import type { BuildManifest } from '../build.js';
import { sameGenerationBuild } from '../build-fingerprint.js';
import { contractError } from '../domain/errors.js';
import { stableJsonStringify } from '../io/stable-json.js';
import { sha256Text } from '../importers/integrity.js';
import type { FileIdentity } from '../server/safe-filesystem.js';
import { SafeStoreFilesystem, sameFileIdentity } from '../server/safe-filesystem.js';
import { RequestLockManager, RequestLockSchema, requestErrorCode, requestOwnerAlive, requestStorageError } from './request-lock.js';
import type { RequestLock } from './request-lock.js';
import { CodexRequestSchema } from './schema.js';
import type { CodexRequest, CodexRequestKind, CodexRequestStatus } from './schema.js';

import { REQUEST_JOURNAL_VERSION } from './storage-contract.js';
export { REQUEST_LOCK_VERSION, REQUEST_JOURNAL_VERSION } from './storage-contract.js';
const RequestChangeSchema = z.strictObject({ id: z.uuid(), before: z.string().nullable(), after: z.string(), stagingIdentity: z.strictObject({ dev: z.number().int().nonnegative(), ino: z.number().int().nonnegative() }) });
const RequestJournalSchema = z.strictObject({ version: z.literal(REQUEST_JOURNAL_VERSION), owner: RequestLockSchema, changes: z.array(RequestChangeSchema).min(1) });
type RequestChange = z.infer<typeof RequestChangeSchema>;
type RequestChangeInput = Pick<RequestChange, 'id' | 'before' | 'after'>;
type RequestJournal = z.infer<typeof RequestJournalSchema>;
type RequestSnapshot = { request: CodexRequest; bytes: string };
function translateRequestError(error: unknown): never {
  const code: string = requestErrorCode(error);
  if (code === 'STORE_PATH_UNSAFE' || code === 'EXCLUSIVE_FILE_EXISTS') requestStorageError('CODEX_REQUEST_RECOVERY_REQUIRED', `Request 저장 경로를 증명할 수 없습니다. causeCode=${code}, cause=${error instanceof Error ? error.message : String(error)}`);
  if (['EEXIST', 'ENOENT', 'ENOTEMPTY', 'EACCES', 'EIO'].includes(code)) requestStorageError('CODEX_REQUEST_STORE_UNAVAILABLE', `Request 파일 연산이 실패했습니다. causeCode=${code}, cause=${error instanceof Error ? error.message : String(error)}`);
  throw error;
}
export type RequestFaultPoint = 'after-lock-acquired' | 'before-state-cas' | 'after-journal-published' | 'after-request-published'
  | 'after-recovery-request-published' | 'after-journal-cleanup';
export type RequestFaultContext = { point: RequestFaultPoint; key: string; requestId: string | null; index: number | null };
export type RequestFaultInjector = { trigger(context: RequestFaultContext): void | Promise<void> };

export function codexRequestKey(request: Pick<CodexRequest, 'kind' | 'projectId' | 'targetId' | 'basisHash'>): string {
  return sha256Text(JSON.stringify([request.kind, request.projectId, request.targetId, request.basisHash]));
}
function serialize(request: CodexRequest): string { return `${JSON.stringify(CodexRequestSchema.parse(request), null, 2)}\n`; }
function pending(request: CodexRequest): void {
  if (request.status !== 'pending') throw contractError('CODEX_REQUEST_SETTLED', `${request.id}: 이미 ${request.status} 상태인 요청입니다.`, []);
}
function validateJournal(journal: RequestJournal, lock: RequestLock): void {
  if (JSON.stringify(journal.owner) !== JSON.stringify(lock.metadata)) requestStorageError('CODEX_REQUEST_RECOVERY_REQUIRED', `Request Journal 소유 Lock이 다릅니다. key=${lock.metadata.key}`);
  const ids: Set<string> = new Set<string>();
  for (const change of journal.changes) {
    const next: CodexRequest = CodexRequestSchema.parse(JSON.parse(change.after) as unknown);
    if (ids.has(change.id) || next.id !== change.id || codexRequestKey(next) !== lock.metadata.key) requestStorageError('CODEX_REQUEST_RECOVERY_REQUIRED', `Request Journal 대상이 다릅니다. key=${lock.metadata.key}, requestId=${change.id}`);
    ids.add(change.id);
    if (change.before === null) { if (next.status !== 'pending') requestStorageError('CODEX_REQUEST_RECOVERY_REQUIRED', `신규 Request Journal 상태가 잘못됐습니다. requestId=${next.id}`); continue; }
    const previous: CodexRequest = CodexRequestSchema.parse(JSON.parse(change.before) as unknown);
    if (previous.status !== 'pending' || next.status === 'pending' || serialize({ ...next, status: previous.status, resultRevision: previous.resultRevision, error: previous.error, updatedAt: previous.updatedAt }) !== serialize(previous)) {
      requestStorageError('CODEX_REQUEST_RECOVERY_REQUIRED', `Request Journal이 Terminal 상태 또는 불변 metadata를 변경합니다. requestId=${next.id}`);
    }
  }
}

/** 논리 Key Lock과 원본 바이트 SHA-256 CAS 아래에서 Journal의 모든 변경을 재실행 가능하게 게시한다. */
export class CodexRequestStore {
  readonly #fs: SafeStoreFilesystem;
  readonly #build: BuildManifest;
  readonly #locks: RequestLockManager;
  readonly #faultInjector: RequestFaultInjector | undefined;
  #initialization: Promise<void> | null = null;

  constructor(root: string, build: BuildManifest, faultInjector?: RequestFaultInjector) {
    this.#fs = new SafeStoreFilesystem(root); this.#build = structuredClone(build); this.#faultInjector = faultInjector;
    this.#locks = new RequestLockManager(this.#fs, (lock: RequestLock, assertOwnership: () => Promise<void>): Promise<void> => this.#recover(lock, assertOwnership));
  }
  buildManifest(): BuildManifest { return structuredClone(this.#build); }
  #path(id: string): string { return this.#fs.path(`${CodexRequestSchema.shape.id.parse(id)}.json`); }
  #journal(key: string): string { return this.#fs.path('.transactions', `${key}.json`); }
  #block(key: string): string { return this.#fs.path('.transactions', `${key}.blocked`); }
  async #fault(point: RequestFaultPoint, key: string, requestId: string | null, index: number | null): Promise<void> {
    await this.#faultInjector?.trigger({ point, key, requestId, index });
  }

  initialize(): Promise<void> {
    this.#initialization ??= this.#initialize().catch(translateRequestError); return this.#initialization;
  }
  async #initialize(): Promise<void> {
    await this.#fs.initialize();
    for (const name of ['.locks', '.transactions', '.recovery-claims']) await this.#fs.ensureDirectory(this.#fs.path(name));
    for (const entry of await this.#fs.entries(this.#fs.path('.locks'))) {
      if (!/^[a-f0-9]{64}\.lock$/.test(entry.name)) { await this.#locks.inspectTemporary(this.#fs.path('.locks'), entry.name); continue; }
      const lock: RequestLock | null = await this.#locks.read(this.#fs.path('.locks', entry.name));
      if (lock !== null && !requestOwnerAlive(lock.metadata)) { const own: RequestLock = await this.#locks.acquire(lock.metadata.key); await this.#locks.release(own); }
    }
    for (const entry of await this.#fs.entries(this.#fs.path('.transactions'))) {
      if (!await this.#fs.exists(this.#fs.path('.transactions', entry.name))) continue;
      const direct: RegExpMatchArray | null = entry.name.match(/^([a-f0-9]{64})\.(json|blocked)$/);
      if (direct !== null && await this.#locks.read(this.#locks.path(direct[1]!)) !== null) continue;
      const stage: RegExpMatchArray | null = entry.name.match(/^([a-f0-9-]{36})\.([a-f0-9-]{36})\.next(?:\.publish)?$/);
      // 살아 있는 Writer는 staging을 준비한 뒤 Journal을 게시하므로 UUID와 소유 Lock으로 준비 중임을 식별한다.
      const transactionId: string | undefined = stage?.[1] ?? entry.name.match(/^\.publish-[a-f0-9]{64}\.json-([a-f0-9-]{36})\.tmp$/)?.[1];
      if (transactionId !== undefined) {
        let preparing: boolean = false;
        for (const candidate of await this.#fs.entries(this.#fs.path('.locks'))) {
          if (!/^[a-f0-9]{64}\.lock$/.test(candidate.name)) continue;
          const lock: RequestLock | null = await this.#locks.read(this.#fs.path('.locks', candidate.name));
          if (lock?.metadata.transactionId === transactionId && requestOwnerAlive(lock.metadata)) { preparing = true; break; }
        }
        if (preparing) continue;
      }
      if (!await this.#fs.exists(this.#fs.path('.transactions', entry.name))) continue;
      requestStorageError('CODEX_REQUEST_RECOVERY_REQUIRED', `알 수 없는 Request Transaction 파일은 보존합니다. entry=${entry.name}`);
    }
    for (const entry of await this.#fs.entries(this.#fs.path('.recovery-claims'))) {
      const match: RegExpMatchArray | null = entry.name.match(/^([a-f0-9]{64})\.([a-f0-9-]{36})\.lock$/);
      if (match === null) { await this.#locks.inspectTemporary(this.#fs.path('.recovery-claims'), entry.name); continue; }
      const claim: RequestLock | null = await this.#locks.read(this.#fs.path('.recovery-claims', entry.name));
      if (claim !== null && (claim.metadata.key !== match[1] || claim.metadata.parentTransactionId !== match[2])) requestStorageError('CODEX_REQUEST_RECOVERY_REQUIRED', `Request 복구 감사 Claim 연결이 다릅니다. entry=${entry.name}`);
    }
  }

  async #snapshot(id: string): Promise<RequestSnapshot> {
    const path: string = this.#path(id);
    if (await this.#fs.kind(path) === 'missing') throw contractError('CODEX_REQUEST_NOT_FOUND', `Codex 생성 요청을 찾을 수 없습니다: ${id}`, []);
    const bytes: string = await this.#fs.readText(path); const request: CodexRequest = CodexRequestSchema.parse(JSON.parse(bytes) as unknown);
    if (request.id !== id) requestStorageError('CODEX_REQUEST_RECOVERY_REQUIRED', `Request 파일명과 ID가 다릅니다. requestId=${id}`);
    return { request, bytes };
  }
  async #snapshots(): Promise<RequestSnapshot[]> {
    const snapshots: RequestSnapshot[] = [];
    for (const entry of await this.#fs.entries(this.#fs.root())) {
      if (!entry.name.endsWith('.json')) continue;
      snapshots.push(await this.#snapshot(entry.name.slice(0, -5)));
    }
    return snapshots;
  }

  async #withKey<T>(key: string, operation: (lock: RequestLock) => Promise<T>): Promise<T> {
    await this.initialize();
    if (await this.#fs.exists(this.#block(key))) requestStorageError('CODEX_REQUEST_RECOVERY_REQUIRED', `중단된 Request 변경의 복구가 필요합니다. key=${key}`);
    const lock: RequestLock = await this.#locks.acquire(key).catch(translateRequestError);
    try {
      if (await this.#fs.exists(this.#journal(key))) requestStorageError('CODEX_REQUEST_RECOVERY_REQUIRED', `새 Lock에 이전 Request Journal이 남아 있습니다. key=${key}`);
      await this.#fault('after-lock-acquired', key, null, null);
      return await operation(lock);
    } catch (error: unknown) {
      if (await this.#fs.exists(this.#journal(key)) || error instanceof AggregateError || ['STORE_PATH_UNSAFE', 'CODEX_REQUEST_RECOVERY_REQUIRED'].includes(requestErrorCode(error))) {
        const path: string = this.#block(key);
        if (!await this.#fs.exists(path)) await this.#fs.publishExclusiveFileWithIdentity(path, JSON.stringify({ version: 1, key, transactionId: lock.metadata.transactionId, code: requestErrorCode(error) }), randomUUID());
        requestStorageError('CODEX_REQUEST_RECOVERY_REQUIRED', `Request Journal을 보존했습니다. key=${key}, cause=${error instanceof Error ? error.message : String(error)}`);
      }
      return translateRequestError(error);
    } finally {
      if (!await this.#fs.exists(this.#journal(key)) && !await this.#fs.exists(this.#block(key))) await this.#locks.release(lock).catch(translateRequestError);
    }
  }

  async list(status: CodexRequestStatus | null): Promise<CodexRequest[]> {
    await this.initialize();
    const initial: RequestSnapshot[] = await this.#snapshots();
    const knownKeys: ReadonlyMap<string, string> = new Map(initial.map((snapshot: RequestSnapshot): [string, string] => [snapshot.request.id, codexRequestKey(snapshot.request)]));
    const keys: string[] = [...new Set(knownKeys.values())].sort();
    const results: CodexRequest[] = [];
    for (const key of keys) results.push(...await this.#withKey(key, async (): Promise<CodexRequest[]> => {
      const requests: CodexRequest[] = [];
      for (const entry of await this.#fs.entries(this.#fs.root())) {
        if (!entry.name.endsWith('.json')) continue;
        const id: string = entry.name.slice(0, -5); const knownKey: string | undefined = knownKeys.get(id);
        if (knownKey !== undefined && knownKey !== key) continue;
        const snapshot: RequestSnapshot = await this.#snapshot(id); const currentKey: string = codexRequestKey(snapshot.request);
        if (knownKey !== undefined && currentKey !== knownKey) requestStorageError('CODEX_REQUEST_RECOVERY_REQUIRED', `Request의 불변 논리 Key가 변경됐습니다. requestId=${id}`);
        if (currentKey === key) requests.push(snapshot.request);
      }
      return requests;
    }));
    return results.filter((request: CodexRequest): boolean => status === null || request.status === status)
      .sort((left: CodexRequest, right: CodexRequest): number => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id));
  }
  async read(requestId: string): Promise<CodexRequest> {
    await this.initialize(); const initial: RequestSnapshot = await this.#snapshot(requestId);
    return this.#withKey(codexRequestKey(initial.request), async (): Promise<CodexRequest> => (await this.#snapshot(requestId)).request);
  }

  async create(kind: CodexRequestKind, projectId: string, targetId: string, basisHash: string, now: string): Promise<CodexRequest> {
    const candidate: CodexRequest = CodexRequestSchema.parse({ generatorBuild: generatorBuildProvenance(this.#build), id: randomUUID(), kind, projectId, targetId, basisHash,
      status: 'pending', createdAt: now, updatedAt: now, resultRevision: null, error: null });
    const key: string = codexRequestKey(candidate);
    return this.#withKey(key, async (lock: RequestLock): Promise<CodexRequest> => {
      const matching: RequestSnapshot[] = (await this.#snapshots()).filter((value: RequestSnapshot): boolean => value.request.status === 'pending' && codexRequestKey(value.request) === key);
      const duplicate: RequestSnapshot | undefined = matching.find((value: RequestSnapshot): boolean => sameGenerationBuild(value.request.generatorBuild, this.#build));
      if (matching.filter((value: RequestSnapshot): boolean => sameGenerationBuild(value.request.generatorBuild, this.#build)).length > 1) requestStorageError('CODEX_REQUEST_RECOVERY_REQUIRED', `같은 Build의 Legacy Pending이 중복돼 자동 선택할 수 없습니다. key=${key}`);
      const request: CodexRequest = duplicate?.request ?? candidate;
      const changes: RequestChangeInput[] = duplicate === undefined ? [{ id: request.id, before: null, after: serialize(request) }] : [];
      for (const prior of matching.filter((value: RequestSnapshot): boolean => value.request.id !== request.id)) {
        changes.push({ id: prior.request.id, before: prior.bytes, after: serialize({ ...prior.request, status: 'superseded', resultRevision: null, updatedAt: now,
          error: { code: 'CODEX_REQUEST_SUPERSEDED', message: `생성 계약 Build가 변경되어 ${request.id} 요청으로 대체됐습니다.` } }) });
      }
      if (changes.length > 0) await this.#commit(lock, changes);
      return request;
    });
  }
  async complete(requestId: string, resultRevision: number, now: string): Promise<CodexRequest> {
    return this.#settle(requestId, { status: 'completed', resultRevision, error: null, updatedAt: now });
  }
  async fail(requestId: string, code: string, message: string, now: string): Promise<CodexRequest> {
    return this.#settle(requestId, { status: 'failed', resultRevision: null, error: { code, message }, updatedAt: now });
  }
  async #settle(id: string, change: Pick<CodexRequest, 'status' | 'resultRevision' | 'error' | 'updatedAt'>): Promise<CodexRequest> {
    await this.initialize(); const initial: RequestSnapshot = await this.#snapshot(id);
    return this.#withKey(codexRequestKey(initial.request), async (lock: RequestLock): Promise<CodexRequest> => {
      const current: RequestSnapshot = await this.#snapshot(id); pending(current.request);
      const next: CodexRequest = CodexRequestSchema.parse({ ...current.request, ...change });
      await this.#commit(lock, [{ id, before: current.bytes, after: serialize(next) }]); return next;
    });
  }

  async #assertState(change: RequestChangeInput): Promise<'before' | 'after'> {
    const path: string = this.#path(change.id); const actual: string | null = await this.#fs.exists(path) ? await this.#fs.readText(path) : null;
    if (actual !== null && sha256Text(actual) === sha256Text(change.after)) return 'after';
    if (actual === null && change.before === null || actual !== null && change.before !== null && sha256Text(actual) === sha256Text(change.before)) return 'before';
    requestStorageError('CODEX_REQUEST_STATE_CONFLICT', `Request CAS가 현재 바이트와 일치하지 않습니다. requestId=${change.id}, expectedSha256=${change.before === null ? 'missing' : sha256Text(change.before)}, actualSha256=${actual === null ? 'missing' : sha256Text(actual)}`);
  }
  async #commit(lock: RequestLock, changes: RequestChangeInput[]): Promise<void> {
    const prepared: RequestChange[] = [];
    await this.#fault('before-state-cas', lock.metadata.key, null, null);
    for (const change of changes) if (await this.#assertState(change) !== 'before') requestStorageError('CODEX_REQUEST_STATE_CONFLICT', `새 변경 대상이 이미 게시돼 있습니다. requestId=${change.id}`);
    try {
      for (const change of changes) {
        const stage: string = this.#stage(lock.metadata.transactionId, change.id);
        const stagingIdentity: FileIdentity = await this.#fs.writeExclusiveWithIdentity(stage, change.after);
        prepared.push({ ...change, stagingIdentity });
      }
      await this.#fs.syncDirectory(this.#fs.path('.transactions'));
      const journal: RequestJournal = { version: 1, owner: lock.metadata, changes: prepared }; validateJournal(journal, lock);
      await this.#locks.verify(lock);
      for (const change of changes) if (await this.#assertState(change) !== 'before') requestStorageError('CODEX_REQUEST_STATE_CONFLICT', `Journal 게시 전 Request가 변경됐습니다. requestId=${change.id}`);
      await this.#fs.publishExclusiveFileWithIdentity(this.#journal(lock.metadata.key), stableJsonStringify(journal), lock.metadata.transactionId);
      await this.#fault('after-journal-published', lock.metadata.key, null, null);
      await this.#publishChanges(journal, (): Promise<void> => this.#locks.verify(lock), 'after-request-published');
      await this.#cleanup(journal);
      await this.#fault('after-journal-cleanup', lock.metadata.key, null, null);
    } catch (error: unknown) {
      if (!await this.#fs.exists(this.#journal(lock.metadata.key))) {
        for (const change of prepared) await this.#fs.unlinkFile(this.#stage(lock.metadata.transactionId, change.id), change.stagingIdentity);
        await this.#fs.syncDirectory(this.#fs.path('.transactions'));
      }
      throw error;
    }
  }
  #stage(transactionId: string, id: string): string { return this.#fs.path('.transactions', `${transactionId}.${id}.next`); }
  async #requireStagingProof(path: string, change: RequestChange): Promise<void> {
    if (!sameFileIdentity(await this.#fs.identity(path), change.stagingIdentity) || await this.#fs.readText(path) !== change.after) {
      requestStorageError('CODEX_REQUEST_RECOVERY_REQUIRED', `Request 파일의 staging identity·바이트 증명이 다릅니다. requestId=${change.id}, path=${path}`);
    }
  }
  async #publishChanges(journal: RequestJournal, assertOwnership: () => Promise<void>, point: 'after-request-published' | 'after-recovery-request-published'): Promise<void> {
    for (const change of journal.changes) await this.#assertState(change);
    for (const [index, change] of journal.changes.entries()) {
      await assertOwnership();
      if (await this.#assertState(change) === 'before') {
        const stage: string = this.#stage(journal.owner.transactionId, change.id);
        await this.#requireStagingProof(stage, change);
        await this.#fs.syncDirectory(dirname(stage)); await assertOwnership(); await this.#assertState(change);
        if (change.before === null) await this.#fs.hardLink(stage, this.#path(change.id));
        else {
          const publish: string = `${stage}.publish`;
          if (!await this.#fs.exists(publish)) await this.#fs.hardLink(stage, publish);
          await this.#requireStagingProof(publish, change);
          await assertOwnership();
          if (await this.#assertState(change) !== 'before') requestStorageError('CODEX_REQUEST_STATE_CONFLICT', `Request 게시 직전 상태가 변경됐습니다. requestId=${change.id}`);
          await this.#fs.replaceFile(publish, this.#path(change.id));
        }
        await this.#fs.syncDirectory(this.#fs.root());
      }
      await this.#requireStagingProof(this.#path(change.id), change);
      await this.#fault(point, journal.owner.key, change.id, index);
    }
  }
  async #cleanup(journal: RequestJournal): Promise<void> {
    for (const change of journal.changes) if (await this.#assertState(change) !== 'after') requestStorageError('CODEX_REQUEST_RECOVERY_REQUIRED', `Request Journal의 게시가 완료되지 않았습니다. requestId=${change.id}`);
    for (const change of journal.changes) {
      const stage: string = this.#stage(journal.owner.transactionId, change.id);
      for (const path of [`${stage}.publish`, stage]) {
        if (!await this.#fs.exists(path)) continue;
        await this.#requireStagingProof(path, change);
        await this.#fs.unlinkFile(path, change.stagingIdentity);
      }
    }
    await this.#fs.syncDirectory(this.#fs.path('.transactions'));
    const journalPath: string = this.#journal(journal.owner.key);
    const journalIdentity: FileIdentity = await this.#fs.identity(journalPath);
    if (await this.#fs.readText(journalPath) !== stableJsonStringify(journal)) requestStorageError('CODEX_REQUEST_RECOVERY_REQUIRED', `정리 대상 Request Journal이 변경됐습니다. key=${journal.owner.key}`);
    const temporary: string = this.#fs.path('.transactions', `.publish-${journal.owner.key}.json-${journal.owner.transactionId}.tmp`);
    if (await this.#fs.exists(temporary)) {
      if (!sameFileIdentity(await this.#fs.identity(temporary), journalIdentity)) requestStorageError('CODEX_REQUEST_RECOVERY_REQUIRED', `Request Journal 임시 파일의 identity가 다릅니다. key=${journal.owner.key}`);
      await this.#fs.unlinkFile(temporary, journalIdentity);
    }
    const block: string = this.#block(journal.owner.key);
    if (await this.#fs.exists(block)) {
      const identity: FileIdentity = await this.#fs.identity(block);
      const metadata = z.strictObject({ version: z.literal(1), key: z.string(), transactionId: z.uuid(), code: z.string() }).parse(JSON.parse(await this.#fs.readText(block)) as unknown);
      if (metadata.key !== journal.owner.key || metadata.transactionId !== journal.owner.transactionId) requestStorageError('CODEX_REQUEST_RECOVERY_REQUIRED', `Request 복구 Marker가 다른 Transaction을 가리킵니다. key=${journal.owner.key}`);
      await this.#fs.unlinkFile(block, identity);
    }
    await this.#fs.unlinkFile(journalPath, journalIdentity);
    await this.#fs.syncDirectory(this.#fs.path('.transactions'));
  }
  async #recover(lock: RequestLock, assertOwnership: () => Promise<void>): Promise<void> {
    const path: string = this.#journal(lock.metadata.key);
    if (!await this.#fs.exists(path)) {
      const ownedStaging: string[] = (await this.#fs.entries(this.#fs.path('.transactions'))).map((entry): string => entry.name)
        .filter((name: string): boolean => name.includes(lock.metadata.transactionId));
      if (ownedStaging.length > 0) requestStorageError('CODEX_REQUEST_RECOVERY_REQUIRED', `Journal 없는 Request staging을 보존합니다. key=${lock.metadata.key}, entries=${ownedStaging.join(',')}`);
      return;
    }
    try {
      const journal: RequestJournal = RequestJournalSchema.parse(JSON.parse(await this.#fs.readText(path)) as unknown);
      validateJournal(journal, lock);
      await this.#publishChanges(journal, assertOwnership, 'after-recovery-request-published'); await assertOwnership(); await this.#cleanup(journal);
    } catch (error: unknown) { requestStorageError('CODEX_REQUEST_RECOVERY_REQUIRED', `Request 복구 증명을 완료할 수 없습니다. key=${lock.metadata.key}, cause=${error instanceof Error ? error.message : String(error)}`); }
  }
}

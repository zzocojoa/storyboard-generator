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
import { ProjectSchema } from '../domain/schema.js';
import type { GenerationRecord, Project } from '../domain/schema.js';
import type { GeneratedMutation } from '../domain/media.js';
import type { ProjectStore } from '../server/store.js';
import { applyBuildHash, applyError, applyHash, assertIntentBinding, assertPreparedGeneration, readApplyEvidence } from './apply-evidence.js';
import type { AppliedGenerationEvidence } from './apply-evidence.js';
import type { ApplyIntent, ApplyStatus } from './apply-schema.js';
import { assertCodexRequestBasisAndBuild } from './work.js';

import { REQUEST_JOURNAL_VERSION, REQUEST_SCHEMA_VERSION } from './storage-contract.js';
export { REQUEST_LOCK_VERSION, REQUEST_JOURNAL_VERSION } from './storage-contract.js';
const RequestChangeSchema = z.strictObject({ id: z.uuid(), before: z.string().nullable(), after: z.string(), stagingIdentity: z.strictObject({ dev: z.number().int().nonnegative(), ino: z.number().int().nonnegative() }) });
const RequestJournalSchema = z.strictObject({ version: z.union([z.literal(1), z.literal(REQUEST_JOURNAL_VERSION)]), owner: RequestLockSchema, changes: z.array(RequestChangeSchema).min(1) });
type RequestChange = z.infer<typeof RequestChangeSchema>;
type RequestChangeInput = Pick<RequestChange, 'id' | 'before' | 'after'>;
type RequestJournal = z.infer<typeof RequestJournalSchema>;
type RequestSnapshot = { request: CodexRequest; bytes: string };
const RequestIndexSchema = CodexRequestSchema.omit({ applyIntent: true }).strip();
function translateRequestError(error: unknown): never {
  const code: string = requestErrorCode(error);
  if (code === 'STORE_PATH_UNSAFE' || code === 'EXCLUSIVE_FILE_EXISTS') requestStorageError('CODEX_REQUEST_RECOVERY_REQUIRED', `Request 저장 경로를 증명할 수 없습니다. causeCode=${code}, cause=${error instanceof Error ? error.message : String(error)}`);
  if (['EEXIST', 'ENOENT', 'ENOTEMPTY', 'EACCES', 'EIO'].includes(code)) requestStorageError('CODEX_REQUEST_STORE_UNAVAILABLE', `Request 파일 연산이 실패했습니다. causeCode=${code}, cause=${error instanceof Error ? error.message : String(error)}`);
  throw error;
}
export type RequestFaultPoint = 'after-lock-acquired' | 'before-state-cas' | 'after-journal-published' | 'after-request-published'
  | 'after-recovery-request-published' | 'after-journal-cleanup'
  | 'after-apply-ownership-acquired' | 'after-apply-intent-persisted' | 'before-project-commit'
  | 'before-request-completion' | 'after-request-completion-journal' | 'after-request-completed'
  | 'before-apply-intent-cleanup' | 'during-apply-reconciliation';
export type RequestFaultContext = { point: RequestFaultPoint; key: string; requestId: string | null; index: number | null };
export type RequestFaultInjector = { trigger(context: RequestFaultContext): void | Promise<void> };

export function codexRequestKey(request: Pick<CodexRequest, 'kind' | 'projectId' | 'targetId' | 'basisHash'>): string {
  return sha256Text(JSON.stringify([request.kind, request.projectId, request.targetId, request.basisHash]));
}
function serialize(request: CodexRequest): string { return `${JSON.stringify(CodexRequestSchema.parse(request), null, 2)}\n`; }
function pending(request: CodexRequest): void {
  if (request.status === 'applying') throw applyError('CODEX_REQUEST_APPLY_IN_PROGRESS', request, '결과 적용 여부를 먼저 정산해야 합니다.');
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
    const { applyIntent: _nextIntent, ...nextBase } = next;
    const { applyIntent: _previousIntent, ...previousBase } = previous;
    const metadataUnchanged: boolean = serialize({ ...nextBase, status: previous.status, resultRevision: previous.resultRevision, error: previous.error, updatedAt: previous.updatedAt }) === serialize(previousBase);
    const ordinary: boolean = previous.status === 'pending' && ['completed', 'failed', 'superseded'].includes(next.status)
      && applyHash(previous.applyIntent ?? null) === applyHash(next.applyIntent ?? null);
    const claiming: boolean = journal.version === 2 && previous.status === 'pending' && next.status === 'applying' && previous.applyIntent === undefined && next.applyIntent !== undefined;
    if (claiming && (next.applyIntent?.owner.transactionId !== lock.metadata.transactionId
      || next.applyIntent.owner.host !== lock.metadata.host || next.applyIntent.owner.pid !== lock.metadata.pid)) {
      requestStorageError('CODEX_REQUEST_RECOVERY_REQUIRED', `적용 의도의 소유 Process가 Request Journal Lock과 다릅니다. requestId=${next.id}`);
    }
    const completing: boolean = journal.version === 2 && previous.status === 'applying' && next.status === 'completed'
      && previous.applyIntent !== undefined && applyHash(previous.applyIntent) === applyHash(next.applyIntent ?? null);
    const releasing: boolean = journal.version === 2 && previous.status === 'applying' && next.status === 'pending' && next.applyIntent === undefined && next.resultRevision === null;
    if (!metadataUnchanged || !(ordinary || claiming || completing || releasing)) {
      requestStorageError('CODEX_REQUEST_RECOVERY_REQUIRED', `Request Journal이 Terminal 상태 또는 불변 metadata를 변경합니다. requestId=${next.id}`);
    }
    if (next.applyIntent !== undefined) assertIntentBinding(next, lock.metadata.key, next.applyIntent);
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
    const bytes: string = await this.#fs.readText(path); const raw: unknown = JSON.parse(bytes) as unknown;
    const parsed = CodexRequestSchema.safeParse(raw);
    if (!parsed.success) {
      const index = RequestIndexSchema.safeParse(raw);
      if (index.success && typeof raw === 'object' && raw !== null && 'applyIntent' in raw) throw applyError('CODEX_APPLY_EVIDENCE_CONFLICT', index.data, `적용 의도 Schema를 해석할 수 없습니다. ${parsed.error.message}`);
      throw parsed.error;
    }
    const request: CodexRequest = parsed.data;
    if (request.status === 'applying' && request.applyIntent === undefined || request.status === 'pending' && request.applyIntent !== undefined) {
      throw applyError('CODEX_APPLY_EVIDENCE_CONFLICT', request, 'Request 상태와 적용 의도 유무가 일치하지 않습니다.');
    }
    if (request.id !== id) requestStorageError('CODEX_REQUEST_RECOVERY_REQUIRED', `Request 파일명과 ID가 다릅니다. requestId=${id}`);
    return { request, bytes };
  }
  /** 상태 집계는 적용 의도를 실행·해석하지 않는다. 불명 Intent도 Applying 수에 포함하고 별도 오류 상태로 표시한다. */
  async statusRequests(): Promise<CodexRequest[]> {
    await this.initialize(); const requests: CodexRequest[] = [];
    for (const entry of await this.#fs.entries(this.#fs.root())) {
      if (!entry.name.endsWith('.json')) continue;
      const request: CodexRequest = RequestIndexSchema.parse(JSON.parse(await this.#fs.readText(this.#path(entry.name.slice(0, -5)))) as unknown);
      if (`${request.id}.json` !== entry.name) requestStorageError('CODEX_REQUEST_RECOVERY_REQUIRED', `Request 파일명과 ID가 다릅니다. requestId=${request.id}`);
      requests.push(request);
    }
    return requests.sort((left: CodexRequest, right: CodexRequest): number => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id));
  }
  async #snapshotsForKey(key: string): Promise<RequestSnapshot[]> {
    const snapshots: RequestSnapshot[] = [];
    for (const request of await this.statusRequests()) if (codexRequestKey(request) === key) snapshots.push(await this.#snapshot(request.id));
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
    const initial: RequestSnapshot[] = [];
    const indexed: CodexRequest[] = await this.statusRequests();
    for (const request of indexed) if (status === null || request.status === status) initial.push(await this.#snapshot(request.id));
    const knownKeys: ReadonlyMap<string, string> = new Map(indexed.map((request: CodexRequest): [string, string] => [request.id, codexRequestKey(request)]));
    const keys: string[] = [...new Set(initial.map((snapshot: RequestSnapshot): string => codexRequestKey(snapshot.request)))].sort();
    const results: CodexRequest[] = [];
    for (const key of keys) {
      const observed: CodexRequest[] = initial.filter((value: RequestSnapshot): boolean => codexRequestKey(value.request) === key).map((value: RequestSnapshot): CodexRequest => value.request);
      // 적용 중 상태는 원자 게시된 Request Snapshot으로 읽는다. 생성 대기 목록이 적용 소유 Lock을 기다릴 필요가 없다.
      if (observed.some((request: CodexRequest): boolean => request.status === 'applying')) { results.push(...observed); continue; }
      results.push(...await this.#withKey(key, async (): Promise<CodexRequest[]> => {
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
    }
    return results.filter((request: CodexRequest): boolean => status === null || request.status === status)
      .sort((left: CodexRequest, right: CodexRequest): number => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id));
  }
  async read(requestId: string): Promise<CodexRequest> {
    await this.initialize(); const initial: RequestSnapshot = await this.#snapshot(requestId);
    if (initial.request.status === 'applying') return initial.request;
    return this.#withKey(codexRequestKey(initial.request), async (): Promise<CodexRequest> => (await this.#snapshot(requestId)).request);
  }

  async create(kind: CodexRequestKind, projectId: string, targetId: string, basisHash: string, now: string): Promise<CodexRequest> {
    const candidate: CodexRequest = CodexRequestSchema.parse({ schemaVersion: REQUEST_SCHEMA_VERSION, generatorBuild: generatorBuildProvenance(this.#build), id: randomUUID(), kind, projectId, targetId, basisHash,
      status: 'pending', createdAt: now, updatedAt: now, resultRevision: null, error: null });
    const key: string = codexRequestKey(candidate);
    await this.initialize();
    const observed: RequestSnapshot | undefined = (await this.#snapshotsForKey(key)).find((value: RequestSnapshot): boolean => value.request.status === 'applying');
    if (observed !== undefined) throw applyError('CODEX_REQUEST_APPLY_IN_PROGRESS', observed.request, '적용 중인 요청을 먼저 정산해야 합니다.');
    return this.#withKey(key, async (lock: RequestLock): Promise<CodexRequest> => {
      const snapshots: RequestSnapshot[] = await this.#snapshotsForKey(key);
      const applying: RequestSnapshot | undefined = snapshots.find((value: RequestSnapshot): boolean => value.request.status === 'applying' && codexRequestKey(value.request) === key);
      if (applying !== undefined) throw applyError('CODEX_REQUEST_APPLY_IN_PROGRESS', applying.request, '적용 중인 요청을 새 Build로 대체할 수 없습니다.');
      const matching: RequestSnapshot[] = snapshots.filter((value: RequestSnapshot): boolean => value.request.status === 'pending' && codexRequestKey(value.request) === key);
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
    if (initial.request.status === 'applying') pending(initial.request);
    return this.#withKey(codexRequestKey(initial.request), async (lock: RequestLock): Promise<CodexRequest> => {
      const current: RequestSnapshot = await this.#snapshot(id); pending(current.request);
      const next: CodexRequest = CodexRequestSchema.parse({ ...current.request, ...change });
      await this.#commit(lock, [{ id, before: current.bytes, after: serialize(next) }]); return next;
    });
  }

  /** 논리 Key 소유권 안에서만 Project를 저장하고 같은 소유 Context로 완료한다. 공개 complete를 재진입하지 않는다. */
  async applyResult(requestId: string, kind: CodexRequestKind, store: ProjectStore, now: string,
    prepare: (request: CodexRequest, project: Project) => Promise<{ mutation: GeneratedMutation; resultSha256: string }>,
    replayHash: () => Promise<string | null>): Promise<Project> {
    const initial: CodexRequest = await this.read(requestId);
    return this.#withKey(codexRequestKey(initial), async (lock: RequestLock): Promise<Project> => {
      let snapshot: RequestSnapshot = await this.#snapshot(requestId);
      const request: CodexRequest = snapshot.request;
      if (request.kind !== kind) throw applyError('CODEX_REQUEST_KIND_MISMATCH', request, '요청과 적용 결과의 종류가 다릅니다.');
      if (request.applyIntent !== undefined) assertIntentBinding(request, lock.metadata.key, request.applyIntent);
      if (request.status === 'applying') await this.#fault('during-apply-reconciliation', lock.metadata.key, requestId, null);
      const existing = await readApplyEvidence(request, store);
      if (existing.receipt !== null) {
        const incoming: string | null = await replayHash();
        if (incoming !== null && existing.receipt.resultSha256 === null) throw applyError('CODEX_APPLY_RECEIPT_UNRESOLVED', request, 'Legacy 입력 결과의 동일성 Hash가 없습니다. 입력 없이 reconcile로 기존 Commit을 정산하세요.');
        if (incoming !== null && incoming !== existing.receipt.resultSha256) throw applyError('CODEX_APPLY_RESULT_CONFLICT', request, '같은 Request에 다른 결과를 적용할 수 없습니다.');
        await this.#completeApplied(lock, snapshot, existing.receipt, now);
        return existing.current;
      }
      if (request.status === 'completed') throw applyError('CODEX_APPLY_RECEIPT_UNRESOLVED', request, 'Completed 요청의 Commit 증거가 없습니다.');
      if (request.status === 'applying') {
        const incoming: string | null = await replayHash();
        if (request.applyIntent === undefined) throw applyError('CODEX_APPLY_RECOVERY_REQUIRED', request, '적용 의도를 해석할 수 없습니다.');
        if (incoming !== null && incoming !== request.applyIntent.resultSha256) throw applyError('CODEX_APPLY_RESULT_CONFLICT', request, '중단된 요청과 다른 결과입니다.');
        snapshot = await this.#releaseUncommitted(lock, snapshot, now);
      }
      pending(snapshot.request);
      await this.#fault('after-apply-ownership-acquired', lock.metadata.key, requestId, null);
      assertCodexRequestBasisAndBuild(snapshot.request, existing.current, this.#build);
      const prepared = await prepare(snapshot.request, existing.current);
      const record: GenerationRecord = assertPreparedGeneration(snapshot.request, existing.current, prepared.mutation.project);
      const intent: ApplyIntent = { version: 1, operationId: randomUUID(), requestId, logicalKey: lock.metadata.key,
        projectId: request.projectId, kind: request.kind, targetId: request.targetId, basisHash: request.basisHash,
        generationBuildSha256: applyBuildHash(request), resultSha256: prepared.resultSha256,
        generationRecordSha256: applyHash(record), resultProjectSha256: applyHash(ProjectSchema.parse({ ...prepared.mutation.project, revision: existing.current.revision + 1 })),
        startRevision: existing.current.revision, owner: { transactionId: lock.metadata.transactionId, host: lock.metadata.host, pid: lock.metadata.pid }, createdAt: now };
      const applying: CodexRequest = { ...snapshot.request, status: 'applying', applyIntent: intent, updatedAt: now };
      await this.#commit(lock, [{ id: requestId, before: snapshot.bytes, after: serialize(applying) }]);
      await this.#fault('after-apply-intent-persisted', lock.metadata.key, requestId, null);
      await this.#fault('before-project-commit', lock.metadata.key, requestId, null);
      const mutation: GeneratedMutation = prepared.mutation;
      try {
        await store.update(request.projectId, existing.current.revision, (): Project => mutation.project,
          mutation.relativePath === null || mutation.content === null ? [] : [{ relativePath: mutation.relativePath, content: mutation.content }]);
      } catch (error: unknown) {
        if (['PROJECT_BUSY', 'REVISION_CONFLICT'].includes(requestErrorCode(error))) {
          // 저장소가 Commit 전에 반환하는 경쟁 오류는 결과를 쓰지 않았다는 계약이므로 정상 Pending으로 되돌린다.
          await this.#releaseUncommitted(lock, await this.#snapshot(requestId), now);
          throw error;
        }
        throw Object.assign(applyError('CODEX_APPLY_RECOVERY_REQUIRED', applying, `적용 Commit 여부를 정산해야 합니다. causeCode=${requestErrorCode(error)}`), { cause: error });
      }
      const committed = await readApplyEvidence(applying, store);
      if (committed.receipt === null) throw applyError('CODEX_APPLY_RECOVERY_REQUIRED', applying, 'Project 저장 후 Commit 증거를 확인하지 못했습니다.');
      await this.#completeApplied(lock, await this.#snapshot(requestId), committed.receipt, now);
      return committed.current;
    });
  }

  async #completeApplied(lock: RequestLock, snapshot: RequestSnapshot, receipt: AppliedGenerationEvidence, now: string): Promise<void> {
    if (snapshot.request.status === 'completed') return;
    try {
      await this.#fault('before-request-completion', lock.metadata.key, snapshot.request.id, null);
      const next: CodexRequest = { ...snapshot.request, status: 'completed', resultRevision: receipt.committedRevision, error: null, updatedAt: now };
      await this.#commit(lock, [{ id: next.id, before: snapshot.bytes, after: serialize(next) }]);
      await this.#fault('after-request-completed', lock.metadata.key, next.id, null);
      // 적용 의도는 재시도 결과 Hash를 검증하는 감사 자료다. 임시 Journal만 정리하며 의도는 삭제하지 않는다.
      await this.#fault('before-apply-intent-cleanup', lock.metadata.key, next.id, null);
    } catch (error: unknown) {
      throw Object.assign(applyError('CODEX_APPLY_RECOVERY_REQUIRED', snapshot.request,
        `Project Commit은 완료됐습니다. Request 정산을 재시도하세요. committedRevision=${receipt.committedRevision}, causeCode=${requestErrorCode(error)}`),
      { committedRevision: receipt.committedRevision, cause: error });
    }
  }
  async #releaseUncommitted(lock: RequestLock, snapshot: RequestSnapshot, now: string): Promise<RequestSnapshot> {
    const { applyIntent: _intent, ...original } = snapshot.request;
    const request: CodexRequest = { ...original, status: 'pending', updatedAt: now };
    const bytes: string = serialize(request);
    await this.#commit(lock, [{ id: request.id, before: snapshot.bytes, after: bytes }]);
    return { request, bytes };
  }
  /** 새 생성이나 현재 Project 변경 없이 검증된 최초 Commit으로 Request만 정산한다. */
  async reconcileApply(requestId: string, store: ProjectStore, now: string): Promise<CodexRequest> {
    const initial: CodexRequest = await this.read(requestId);
    return this.#withKey(codexRequestKey(initial), async (lock: RequestLock): Promise<CodexRequest> => {
      const snapshot: RequestSnapshot = await this.#snapshot(requestId);
      if (snapshot.request.applyIntent !== undefined) assertIntentBinding(snapshot.request, lock.metadata.key, snapshot.request.applyIntent);
      await this.#fault('during-apply-reconciliation', lock.metadata.key, requestId, null);
      const evidence = await readApplyEvidence(snapshot.request, store);
      if (evidence.receipt !== null) await this.#completeApplied(lock, snapshot, evidence.receipt, now);
      else if (snapshot.request.status === 'applying' && snapshot.request.applyIntent !== undefined) await this.#releaseUncommitted(lock, snapshot, now);
      else if (snapshot.request.status === 'completed' || snapshot.request.status === 'applying') throw applyError('CODEX_APPLY_RECEIPT_UNRESOLVED', snapshot.request, 'Request에 필요한 적용 증거가 없습니다.');
      return (await this.#snapshot(requestId)).request;
    });
  }

  /** 적용 복구는 명시적인 제품 시작·등록 경로에서만 실행한다. 읽기 전용 Review는 이 함수를 호출하지 않는다. */
  async reconcilePendingApplies(store: ProjectStore, now: string): Promise<ApplyStatus[]> {
    const results: ApplyStatus[] = [];
    for (const request of (await this.statusRequests()).filter((candidate: CodexRequest): boolean => candidate.status === 'applying')) {
      try { await this.reconcileApply(request.id, store, now); }
      catch (error: unknown) {
        if (!['CODEX_REQUEST_STORE_BUSY', 'CODEX_REQUEST_APPLY_IN_PROGRESS', 'CODEX_APPLY_RECOVERY_REQUIRED', 'CODEX_APPLY_RECEIPT_UNRESOLVED', 'CODEX_APPLY_EVIDENCE_CONFLICT'].includes(requestErrorCode(error))) throw error;
        console.warn(JSON.stringify({ event: 'codex-apply-reconciliation-deferred', requestId: request.id, projectId: request.projectId, code: requestErrorCode(error) }));
      }
      results.push(await this.applyStatus(request.id, store));
    }
    return results;
  }

  /** Request와 실제 Version 증거의 정합성을 보고하며 Request 상태를 변경하지 않는다. */
  async applyStatus(requestId: string, store: ProjectStore): Promise<ApplyStatus> {
    let request: CodexRequest;
    try { request = await this.read(requestId); }
    catch (error: unknown) {
      if (requestErrorCode(error) !== 'CODEX_APPLY_EVIDENCE_CONFLICT') throw error;
      const index: CodexRequest | undefined = (await this.statusRequests()).find((candidate: CodexRequest): boolean => candidate.id === requestId);
      if (index === undefined) throw error;
      return { requestId, projectId: index.projectId, requestStatus: index.status, committedRevision: null, code: 'CODEX_APPLY_EVIDENCE_CONFLICT', state: 'evidence-conflict' };
    }
    const base = { requestId, projectId: request.projectId, requestStatus: request.status, committedRevision: null, code: null };
    try {
      if (request.applyIntent !== undefined) assertIntentBinding(request, codexRequestKey(request), request.applyIntent);
      const evidence = await readApplyEvidence(request, store);
      if (evidence.receipt !== null) return { ...base, committedRevision: evidence.receipt.committedRevision,
        state: request.status === 'completed' ? 'completed' : 'committed-awaiting-request-settlement' };
      if (request.status === 'completed') return { ...base, state: 'evidence-conflict', code: 'CODEX_APPLY_RECEIPT_UNRESOLVED' };
      if (request.status === 'applying') {
        const owner: RequestLock | null = await this.#locks.read(this.#locks.path(codexRequestKey(request)));
        const active: boolean = owner !== null && requestOwnerAlive(owner.metadata);
        return { ...base, state: active ? 'applying' : 'recovery-required', code: active ? 'CODEX_REQUEST_APPLY_IN_PROGRESS' : 'CODEX_APPLY_RECOVERY_REQUIRED' };
      }
      return { ...base, state: request.status };
    } catch (error: unknown) {
      const code: string = requestErrorCode(error);
      if (!['CODEX_REQUEST_APPLY_IN_PROGRESS', 'CODEX_APPLY_RECOVERY_REQUIRED', 'CODEX_APPLY_RECEIPT_UNRESOLVED', 'CODEX_APPLY_EVIDENCE_CONFLICT'].includes(code)) throw error;
      const committedRevision: number | null = error instanceof Error && 'committedRevision' in error && typeof error.committedRevision === 'number' ? error.committedRevision : null;
      return { ...base, committedRevision, state: code === 'CODEX_REQUEST_APPLY_IN_PROGRESS' ? 'applying' : code === 'CODEX_APPLY_EVIDENCE_CONFLICT' ? 'evidence-conflict' : 'recovery-required', code };
    }
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
      const journal: RequestJournal = { version: REQUEST_JOURNAL_VERSION, owner: lock.metadata, changes: prepared }; validateJournal(journal, lock);
      await this.#locks.verify(lock);
      for (const change of changes) if (await this.#assertState(change) !== 'before') requestStorageError('CODEX_REQUEST_STATE_CONFLICT', `Journal 게시 전 Request가 변경됐습니다. requestId=${change.id}`);
      await this.#fs.publishExclusiveFileWithIdentity(this.#journal(lock.metadata.key), stableJsonStringify(journal), lock.metadata.transactionId);
      await this.#fault('after-journal-published', lock.metadata.key, null, null);
      if (changes.some((change: RequestChangeInput): boolean => CodexRequestSchema.parse(JSON.parse(change.after) as unknown).status === 'completed')) {
        await this.#fault('after-request-completion-journal', lock.metadata.key, changes[0]!.id, null);
      }
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

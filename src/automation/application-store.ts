import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { RequestLockManager } from '../codex/request-lock.js';
import { contractError } from '../domain/errors.js';
import { assertGenerationRecordTransition } from '../domain/generation-records.js';
import { ProjectSchema } from '../domain/schema.js';
import type { Project } from '../domain/schema.js';
import { sha256Bytes, sha256Text } from '../importers/integrity.js';
import { parseProject } from '../io/project.js';
import { stableJsonStringify } from '../io/stable-json.js';
import { SafeStoreFilesystem } from '../server/safe-filesystem.js';
import { assertAssetCatalogTransition } from '../server/store.js';
import type { AssetWrite, ProjectStore } from '../server/store.js';
import { assertAutomaticBasis, automaticApplyEvidence, automaticHash } from './application-evidence.js';
import { AutomaticApplicationIdentitySchema, AutomaticApplicationSchema, AutomaticApplyIntentSchema, AutomaticApplyReceiptSchema } from './application-schema.js';
import type { AutomaticApplicationIdentity, AutomaticApplication, AutomaticApplyReceipt } from './application-schema.js';

export type AutomaticApplicationFault = (point: 'after-prepared' | 'after-intent' | 'after-project-commit' | 'before-receipt') => Promise<void>;
const MAX_JSON_BYTES: number = 64 * 1024 * 1024;

/** 생성 후보를 원본 밖에 보존하고, 적용 Intent와 실제 Project Version을 결속한다. */
export class AutomationApplicationStore {
  readonly #fs: SafeStoreFilesystem;
  readonly #locks: RequestLockManager;
  readonly #maxStagedBytes: number;
  readonly #fault: AutomaticApplicationFault;
  #ready: boolean = false;

  constructor(root: string, maxStagedBytes: number, fault: AutomaticApplicationFault) {
    this.#fs = new SafeStoreFilesystem(root);
    this.#maxStagedBytes = z.number().int().min(1).max(1024 * 1024 * 1024).parse(maxStagedBytes);
    this.#fault = fault;
    this.#locks = new RequestLockManager(this.#fs, async (_original, assertOwnership): Promise<void> => { await assertOwnership(); });
  }

  async initialize(): Promise<void> {
    await this.#fs.initialize();
    for (const directory of ['.locks', '.recovery-claims', 'applications', 'staging']) await this.#fs.ensureDirectory(this.#fs.path(directory));
    this.#ready = true;
  }

  #check(id: string): void {
    z.uuid().parse(id);
    if (!this.#ready) throw contractError('AUTOMATION_STORE_NOT_INITIALIZED', '자동 제작 결과 저장소를 먼저 초기화하세요.', []);
  }

  async #json(path: string): Promise<unknown> {
    const size: number = (await this.#fs.fileMetadata(path)).size;
    if (size <= 0 || size > MAX_JSON_BYTES) throw contractError('AUTOMATION_STAGED_JSON_SIZE', `저장된 자동 제작 JSON 크기를 확인하세요: path=${path}, bytes=${size}`, []);
    const bytes = await this.#fs.read(path);
    if (bytes.length !== size) throw contractError('AUTOMATION_STAGED_DATA_CHANGED', `읽는 중 자동 제작 파일 크기가 변경됐습니다: ${path}`, []);
    return JSON.parse(bytes.toString('utf8')) as unknown;
  }

  async read(id: string): Promise<AutomaticApplication> {
    this.#check(id);
    const application = AutomaticApplicationSchema.parse(await this.#json(this.#fs.path('applications', id, 'application.json')));
    if (application.id !== id) throw contractError('AUTOMATION_APPLICATION_ID_MISMATCH', `자동 제작 적용 ID가 저장 경로와 다릅니다: ${id}`, []);
    return application;
  }

  /** 게시 전 중단 흔적과 게시된 후보를 구별하며 손상된 후보를 없는 것으로 처리하지 않는다. */
  async findPrepared(id: string): Promise<AutomaticApplication | null> {
    this.#check(id);
    if (await this.#fs.kind(this.#fs.path('applications', id)) === 'missing') {
      if (await this.#fs.kind(this.#fs.path('staging', id)) !== 'missing') throw contractError('AUTOMATION_PREPARATION_INTERRUPTED', `후보 게시가 중단됐습니다. 임시 파일을 보존하세요: ${id}`, []);
      return null;
    }
    return this.read(id);
  }

  /** 반영 전 결과 파일과 원본 Snapshot을 원자 게시하며 기존 결과는 덮어쓰지 않는다. */
  async prepare(inputIdentity: AutomaticApplicationIdentity, inputBefore: Project, inputCandidate: Project, inputWrites: readonly AssetWrite[]): Promise<AutomaticApplication> {
    const identity = AutomaticApplicationIdentitySchema.parse(inputIdentity);
    this.#check(identity.id);
    if (inputWrites.reduce((sum, write): number => sum + write.content.length, 0) > this.#maxStagedBytes) throw contractError('AUTOMATION_STAGING_BUDGET', `자동 제작 임시 파일 합계가 ${this.#maxStagedBytes} bytes 한도를 넘었습니다.`, []);
    const before: Project = parseProject(structuredClone(inputBefore));
    const candidate: Project = parseProject(structuredClone(inputCandidate));
    const writes: AssetWrite[] = inputWrites.map((write): AssetWrite => ({ relativePath: write.relativePath, content: Buffer.from(write.content) }));
    if (candidate.projectId !== before.projectId || candidate.revision !== before.revision
      || automaticHash(candidate.dataset) !== automaticHash(before.dataset) || automaticHash(candidate.handoff) !== automaticHash(before.handoff)) {
      throw contractError('AUTOMATION_APPLICATION_SCOPE', '자동 제작 후보의 Project·revision·원본 입력을 변경할 수 없습니다.', []);
    }
    const records = assertGenerationRecordTransition(before, candidate).added;
    const primary = records.filter((record): boolean => record.id === identity.id && record.requestId === identity.id);
    if (primary.length !== 1) throw contractError('AUTOMATION_APPLICATION_RECORD', `적용 ID와 결속된 신규 생성 기록이 필요합니다: ${identity.id}`, []);
    const catalog = assertAssetCatalogTransition(before, candidate, writes);
    const assets: AutomaticApplication['assets'] = catalog.newAssets.map((asset) => {
      const bytes = catalog.writesByAssetId.get(asset.id)!.content;
      if (sha256Bytes(bytes) !== asset.sha256) throw contractError('AUTOMATION_STAGED_ASSET_HASH', `신규 자산의 바이트 해시가 다릅니다: ${asset.id}`, []);
      return { id: asset.id, relativePath: asset.path, hash: asset.sha256, size: bytes.length };
    });
    const next: Project = ProjectSchema.parse({ ...candidate, revision: before.revision + 1 });
    const application = AutomaticApplicationSchema.parse({ ...identity, version: 1, projectId: before.projectId, createdAt: new Date().toISOString(),
      basisRevision: before.revision, basisProjectHash: automaticHash(before), candidateProjectHash: automaticHash(next),
      records: records.map((record) => ({ id: record.id, hash: automaticHash(record) })), assets });
    const beforeJson: string = stableJsonStringify(before);
    const candidateJson: string = stableJsonStringify(candidate);
    if (Buffer.byteLength(beforeJson) > MAX_JSON_BYTES || Buffer.byteLength(candidateJson) > MAX_JSON_BYTES) throw contractError('AUTOMATION_STAGED_JSON_SIZE', '자동 제작 프로젝트 Snapshot은 각각 64MB 이하여야 합니다.', []);
    const lock = await this.#locks.acquire(sha256Text(identity.id));
    try {
      const directory = this.#fs.path('staging', identity.id);
      if (await this.#fs.exists(this.#fs.path('applications', identity.id)) || await this.#fs.exists(directory)) throw contractError('AUTOMATION_APPLICATION_EXISTS', `이미 준비했거나 준비가 중단된 적용 ID입니다. 기존 파일을 보존하고 새 시도 ID를 사용하세요: ${identity.id}`, []);
      await this.#fs.ensureDirectory(directory);
      await this.#fs.writeExclusive(this.#fs.path('staging', identity.id, 'before.json'), beforeJson);
      await this.#fs.writeExclusive(this.#fs.path('staging', identity.id, 'candidate.json'), candidateJson);
      for (const write of writes) await this.#fs.writeExclusive(this.#fs.path('staging', identity.id, `${sha256Text(write.relativePath)}.media`), write.content);
      await this.#fs.writeExclusive(this.#fs.path('staging', identity.id, 'application.json'), stableJsonStringify(application));
      await this.#fs.syncDirectory(directory);
      await this.#locks.verify(lock);
      await this.#fs.renameNewDirectory(directory, this.#fs.path('applications', identity.id));
      await this.#fs.syncDirectory(this.#fs.path('applications'));
      await this.#fs.syncDirectory(this.#fs.path('staging'));
      await this.#fault('after-prepared');
      return application;
    } finally { await this.#locks.release(lock); }
  }

  async #hasIntent(application: AutomaticApplication): Promise<boolean> {
    const path = this.#fs.path('applications', application.id, 'applying.json');
    if (!await this.#fs.exists(path)) return false;
    const intent = AutomaticApplyIntentSchema.parse(await this.#json(path));
    if (intent.applicationId !== application.id || intent.applicationHash !== automaticHash(application)) throw contractError('AUTOMATION_APPLY_EVIDENCE_CONFLICT', `적용 Intent가 준비 결과와 다릅니다: ${application.id}`, []);
    return true;
  }

  async #settle(application: AutomaticApplication, store: ProjectStore): Promise<AutomaticApplyReceipt | null> {
    const hasIntent: boolean = await this.#hasIntent(application);
    const { current, versionEvidence } = await store.generationHistorySnapshot(application.projectId);
    const receipt = automaticApplyEvidence(application, current, versionEvidence);
    const path = this.#fs.path('applications', application.id, 'receipt.json');
    if (receipt !== null && !hasIntent) throw contractError('AUTOMATION_APPLY_EVIDENCE_CONFLICT', `영속 Intent 없이 Project에 적용된 생성 기록입니다: ${application.id}`, []);
    if (await this.#fs.exists(path)) {
      const stored = AutomaticApplyReceiptSchema.parse(await this.#json(path));
      if (receipt === null || automaticHash(stored) !== automaticHash(receipt)) throw contractError('AUTOMATION_APPLY_EVIDENCE_CONFLICT', `적용 영수증과 실제 Project 이력이 다릅니다: ${application.id}`, []);
      return stored;
    }
    if (receipt !== null) {
      await this.#fault('before-receipt');
      await this.#fs.publishExclusiveFileWithIdentity(path, stableJsonStringify(receipt), randomUUID());
    }
    return receipt;
  }

  /** Commit 이후 임시 미디어가 없어도 과거 Version을 검증해 정산하며 후속 편집을 보존한다. */
  async reconcile(id: string, store: ProjectStore): Promise<AutomaticApplyReceipt | null> {
    this.#check(id);
    const lock = await this.#locks.acquire(sha256Text(id));
    try { return await this.#settle(await this.read(id), store); }
    finally { await this.#locks.release(lock); }
  }

  async apply(id: string, store: ProjectStore, signal: AbortSignal): Promise<AutomaticApplyReceipt> {
    this.#check(id);
    const lock = await this.#locks.acquire(sha256Text(id));
    try {
      const application = await this.read(id);
      const existing = await this.#settle(application, store);
      if (existing !== null) return existing;
      this.#assertNotCancelled(signal);
      const beforeInput: unknown = await this.#json(this.#fs.path('applications', id, 'before.json'));
      const before = parseProject(beforeInput);
      const candidateInput = z.looseObject({ schemaVersion: z.string() }).parse(await this.#json(this.#fs.path('applications', id, 'candidate.json')));
      const candidate = parseProject(candidateInput);
      if (automaticHash(beforeInput) !== application.basisProjectHash || automaticHash({ ...candidateInput, revision: before.revision + 1 }) !== application.candidateProjectHash) throw contractError('AUTOMATION_STAGED_PROJECT_HASH', `자동 제작 후보 또는 시작 Snapshot 내용이 변경됐습니다: ${id}`, []);
      if (candidateInput.schemaVersion !== candidate.schemaVersion || automaticHash(beforeInput) !== automaticHash(before)) throw contractError('AUTOMATION_STAGED_SCHEMA_CHANGED', `이전 저장 형식에서 준비한 미반영 결과입니다. 기존 실행을 취소하고 현재 결과에서 새 실행을 시작하세요: ${id}`, []);
      assertAutomaticBasis(before, application);
      const total: number = application.assets.reduce((sum, asset): number => sum + asset.size, 0);
      if (total > this.#maxStagedBytes) throw contractError('AUTOMATION_STAGING_BUDGET', `저장된 자동 제작 임시 파일 합계가 한도를 넘었습니다: ${total}`, []);
      const writes: AssetWrite[] = [];
      for (const asset of application.assets) {
        const path = this.#fs.path('applications', id, `${sha256Text(asset.relativePath)}.media`);
        if ((await this.#fs.fileMetadata(path)).size !== asset.size) throw contractError('AUTOMATION_STAGED_ASSET_HASH', `자동 제작 임시 자산의 크기가 다릅니다: ${asset.id}`, []);
        const bytes = await this.#fs.read(path);
        if (bytes.length !== asset.size || sha256Bytes(bytes) !== asset.hash) throw contractError('AUTOMATION_STAGED_ASSET_HASH', `자동 제작 임시 자산이 변경됐습니다: ${asset.id}`, []);
        writes.push({ relativePath: asset.relativePath, content: bytes });
      }
      assertAssetCatalogTransition(before, candidate, writes);
      const records = assertGenerationRecordTransition(before, candidate).added.map((record) => ({ id: record.id, hash: automaticHash(record) }));
      if (automaticHash(records) !== automaticHash(application.records)) throw contractError('AUTOMATION_APPLICATION_RECORD', `저장된 생성 기록 결속이 다릅니다: ${id}`, []);
      this.#assertNotCancelled(signal);
      assertAutomaticBasis(await store.read(application.projectId), application);
      await this.#locks.verify(lock);
      if (!await this.#hasIntent(application)) await this.#fs.publishExclusiveFileWithIdentity(this.#fs.path('applications', id, 'applying.json'), stableJsonStringify({ version: 1, applicationId: id, applicationHash: automaticHash(application), startedAt: new Date().toISOString() }), randomUUID());
      await this.#fault('after-intent');
      this.#assertNotCancelled(signal);
      await store.update(application.projectId, application.basisRevision, (current): Project => {
        assertAutomaticBasis(current, application);
        this.#assertNotCancelled(signal);
        return structuredClone(candidate);
      }, writes);
      await this.#fault('after-project-commit');
      const receipt = await this.#settle(application, store);
      if (receipt === null) throw contractError('AUTOMATION_APPLY_RECEIPT_MISSING', `Project 반영의 실제 완료 Version을 찾을 수 없습니다: ${id}`, []);
      return receipt;
    } finally { await this.#locks.release(lock); }
  }

  #assertNotCancelled(signal: AbortSignal): void {
    if (signal.aborted) throw contractError('AUTOMATION_CANCELLED', '자동 제작 결과 반영이 취소되었습니다. 준비된 결과는 보존합니다.', []);
  }
}

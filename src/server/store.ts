import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { dirname, join, relative, sep } from 'node:path';
import { stat } from 'node:fs/promises';
import { z } from 'zod';
import { assertAssetFreeInitialProject, assertAssetReferenceClosure } from '../domain/asset-references.js';
import { contractError } from '../domain/errors.js';
import type { ContractError } from '../domain/errors.js';
import { reviewFrameOutput } from '../domain/frame-output.js';
import { assertGenerationRecordTransition, auditGenerationRecords } from '../domain/generation-records.js';
import type { GenerationRecordAuditEntry } from '../domain/generation-records.js';
import { inspectAudioFileBytes, verifyStoredAsset } from '../domain/media-inspection.js';
import type { InspectedAudioFile } from '../domain/media-inspection.js';
import { reviewAudioPlaybackAt, reviewTextPlaybackAt } from '../domain/playback.js';
import { ProjectSchema } from '../domain/schema.js';
import type { Asset, Project } from '../domain/schema.js';
import { exportProjectJson } from '../exporters/json.js';
import { sha256Bytes, sha256Text } from '../importers/integrity.js';
import { parseProject } from '../io/project.js';
import { SafeStoreFilesystem, sameFileIdentity } from './safe-filesystem.js';
import type { FileIdentity, SafePathKind } from './safe-filesystem.js';

export { collectProjectAssetReferences } from '../domain/asset-references.js';
export type { ProjectAssetReference } from '../domain/asset-references.js';

export type ProjectSummary = {
  projectId: string; title: string; revision: number; durationMs: number; shots: number;
  frameRateNumerator: number; frameRateDenominator: number; dropFrame: boolean; startTimecode: string; sampleRate: 44100 | 48000 | 96000;
  framesWithAsset: number; framesAccepted: number; framesOutputSafe: number; framesTotal: number;
  audioWithAsset: number; audioMeasured: number; audioPlayable: number; audioRepairRequired: number; audioTotal: number;
  textPlayable: number; textTotal: number; blockedOutputCount: number; issues: number; updatedAt: string;
};
export type AssetWrite = { relativePath: string; content: Buffer };
export type AssetCatalogTransition = {
  preservedAssets: readonly Asset[];
  newAssets: readonly Asset[];
  writesByAssetId: ReadonlyMap<string, AssetWrite>;
};
export type StoredAsset = { content: Buffer; mimeType: string; asset: Asset };
export type AudioAssetRecoverySource = { content: Buffer; asset: Asset; inspection: InspectedAudioFile };
export type StorageRecoveryEvent = {
  projectId: string; transactionId: string;
  outcome: 'committed' | 'rolled-back' | 'restored-previous' | 'staging-removed' | 'stale-lock-removed'
    | 'create-committed' | 'create-rolled-back' | 'create-superseded' | 'root-create-lock-removed';
};
export type ActiveCreateState = {
  projectId: string; transactionId: string; host: string; pid: number; processInstanceId: string | null; detectedAt: string;
};
export type ActiveUpdateState = {
  projectId: string; transactionId: string; host: string; pid: number; processInstanceId: string | null; detectedAt: string;
};
export type StorageRecoveryBlock = {
  version: 1; projectId: string; directoryName: string; transactionId: string; code: string; message: string; detectedAt: string;
};
export type StorageFaultPoint = 'after-update-lock-acquired' | 'after-update-current-read' | 'after-update-under-lock-preflight'
  | 'before-update-journal-create' | 'after-update-preflight' | 'after-update-journal-prepared' | 'after-update-asset-linked'
  | 'after-update-version-linked' | 'after-update-current-published' | 'before-update-cleanup'
  | 'after-create-journal-prepared' | 'after-create-version-zero-written' | 'after-create-current-written'
  | 'after-root-create-lock-acquired' | 'after-create-target-rechecked' | 'after-create-staging-complete'
  | 'before-create-directory-publish' | 'after-create-directory-publish' | 'before-create-cleanup'
  | 'before-lock-write' | 'after-lock-file-created' | 'after-lock-write-eexist' | 'before-lock-directory-sync'
  | 'after-lock-directory-sync' | 'after-create-lock-written' | 'before-create-journal-cleanup' | 'before-create-lock-removal'
  | 'before-root-create-lock-removal';
export type StorageFaultInjector = { ownerPid: number; trigger(point: StorageFaultPoint): void | Promise<void> };
export type StorageRuntime = {
  processInstanceId?: string;
  processStartedAt?: string;
  now?: () => Date;
  processProbe?: (pid: number) => boolean;
  heartbeatFreshnessMs?: number;
};

export class SimulatedStorageCrash extends Error {
  readonly code: string = 'SIMULATED_STORAGE_CRASH';
  constructor(point: StorageFaultPoint) {
    super(`테스트 저장 중단 지점에 도달했습니다. point=${point}`);
    this.name = 'SIMULATED_STORAGE_CRASH';
  }
}

export const STORAGE_TRANSACTION_JOURNAL_VERSION: number = 3;
export const STORE_LOCK_VERSION: number = 3;
const TRANSACTIONS_DIRECTORY: string = '.transactions';
const CREATE_TRANSACTIONS_DIRECTORY: string = '.create-transactions';
const CREATE_LOCKS_DIRECTORY: string = '.create-locks';
const RECOVERY_BLOCKS_DIRECTORY: string = '.recovery-blocks';
const PROCESS_INSTANCES_DIRECTORY: string = '.process-instances';
const TRANSACTION_JOURNAL: string = 'journal.json';
const TRANSACTION_PHASE_JOURNAL: string = 'journal.phase.json';
const TRANSACTION_NEXT_PROJECT: string = 'project.next.json';
const TRANSACTION_CURRENT_PUBLISH: string = 'project.publish.json';
const TRANSACTION_PREVIOUS_PROJECT: string = 'project.previous.json';
const TRANSACTION_NEXT_VERSION: string = 'version.next.json';
const CREATE_STAGED_PROJECT_DIRECTORY: string = 'project';

const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const TransactionOwnerSchema = z.strictObject({ host: z.string().min(1), pid: z.number().int().positive(), transactionId: z.uuid() });
const LegacyFileProofSchema = z.strictObject({ relativePath: z.string().min(1), sha256: Sha256Schema });
const LegacyAssetProofSchema = LegacyFileProofSchema.extend({ assetId: z.string().min(1), stagedFileName: z.string().regex(/^asset-[0-9]+\.bin$/) });
const LegacyTransactionJournalSchema = z.strictObject({
  version: z.literal(2), operation: z.literal('update'), transactionId: z.uuid(), projectId: z.string().min(1), owner: TransactionOwnerSchema,
  expectedRevision: z.number().int().nonnegative(), nextRevision: z.number().int().positive(), previousProjectSha256: Sha256Schema,
  nextProjectSha256: Sha256Schema, versionFile: LegacyFileProofSchema,
  assets: z.array(LegacyAssetProofSchema),
});
const FileProofSchema = z.strictObject({ stagedRelativePath: z.string().min(1), finalRelativePath: z.string().min(1), sha256: Sha256Schema });
const AssetProofSchema = FileProofSchema.extend({ assetId: z.string().min(1) });
const TransactionPhaseSchema = z.enum(['prepared', 'assets-published', 'version-published', 'current-published', 'verified']);
const TransactionJournalV3Schema = z.strictObject({
  version: z.literal(3), operation: z.literal('update'), phase: TransactionPhaseSchema,
  transactionId: z.uuid(), projectId: z.string().min(1), owner: TransactionOwnerSchema,
  expectedRevision: z.number().int().nonnegative(), nextRevision: z.number().int().positive(),
  previousProject: FileProofSchema, nextProject: FileProofSchema, versionFile: FileProofSchema,
  assets: z.array(AssetProofSchema),
});
const TransactionJournalSchema = z.union([LegacyTransactionJournalSchema, TransactionJournalV3Schema]);
type TransactionJournal = z.infer<typeof TransactionJournalSchema>;
type TransactionJournalV3 = z.infer<typeof TransactionJournalV3Schema>;

const LegacyCreateJournalSchema = z.strictObject({
  version: z.literal(2), operation: z.literal('create'), transactionId: z.uuid(), projectId: z.string().min(1), owner: TransactionOwnerSchema,
  projectDirectoryName: Sha256Schema, currentFile: LegacyFileProofSchema, versionFile: LegacyFileProofSchema,
});
const CreatePhaseSchema = z.enum(['prepared', 'version-written', 'current-written', 'published', 'verified']);
const CreateJournalV3Schema = z.strictObject({
  version: z.literal(3), operation: z.literal('create'), phase: CreatePhaseSchema,
  transactionId: z.uuid(), projectId: z.string().min(1), owner: TransactionOwnerSchema, projectDirectoryName: Sha256Schema,
  currentFile: FileProofSchema, versionFile: FileProofSchema,
});
const CreateJournalSchema = z.union([LegacyCreateJournalSchema, CreateJournalV3Schema]);
type CreateJournal = z.infer<typeof CreateJournalSchema>;
type CreateJournalV3 = z.infer<typeof CreateJournalV3Schema>;

const LegacyStoreLockSchema = z.strictObject({
  version: z.literal(2), projectId: z.string().min(1), host: z.string().min(1), pid: z.number().int().positive(),
  transactionId: z.uuid(), createdAt: z.iso.datetime(),
});
const StoreLockV3Schema = z.strictObject({
  version: z.literal(3), projectId: z.string().min(1), host: z.string().min(1), pid: z.number().int().positive(),
  transactionId: z.uuid(), createdAt: z.iso.datetime(), processInstanceId: z.uuid(), processStartedAt: z.iso.datetime(),
});
const StoreLockSchema = z.union([LegacyStoreLockSchema, StoreLockV3Schema]);
type StoreLock = z.infer<typeof StoreLockSchema>;
type RecoveryLock = { metadata: StoreLock; path: string; identity: FileIdentity };
type LockAcquisitionState = { createdByThisCall: boolean; metadata: StoreLock; identity: FileIdentity | null };
const StorageRecoveryBlockSchema = z.strictObject({
  version: z.literal(1), projectId: z.string().min(1), directoryName: Sha256Schema,
  transactionId: z.string().min(1), code: z.string().min(1), message: z.string().min(1), detectedAt: z.iso.datetime(),
});
const ProcessInstanceRecordSchema = z.strictObject({
  version: z.literal(1), processInstanceId: z.uuid(), host: z.string().min(1), pid: z.number().int().positive(),
  startedAt: z.iso.datetime(), heartbeatAt: z.iso.datetime(),
});
export type ProcessInstanceRecord = z.infer<typeof ProcessInstanceRecordSchema>;

const SHARED_PROCESS_INSTANCE_ID: string = randomUUID();
const SHARED_PROCESS_STARTED_AT: string = new Date().toISOString();
const DEFAULT_HEARTBEAT_FRESHNESS_MS: number = 30_000;
const processInstanceRegistrations: Map<string, number> = new Map<string, number>();

function processRegistrationKey(root: string, processInstanceId: string): string {
  return `${root}\u0000${processInstanceId}`;
}

export function projectStoreKey(projectId: string): string { return sha256Text(projectId); }
function projectKey(projectId: string): string { return projectStoreKey(projectId); }
function transactionVersionFileName(revision: number): string { return `${String(revision).padStart(6, '0')}.json`; }
function recoveryRequired(message: string): never { throw contractError('STORE_RECOVERY_REQUIRED', message, []); }
function createRecoveryRequired(message: string, cause: unknown): never {
  const reason: string = cause instanceof Error ? cause.message : String(cause);
  throw contractError('STORE_CREATE_RECOVERY_REQUIRED', `${message}, cause=${reason}`, []);
}
function errorCode(error: unknown): string {
  return error instanceof Error && 'code' in error && typeof error.code === 'string' ? error.code : error instanceof Error ? error.name : 'UNKNOWN_ERROR';
}
function isSimulatedCrash(error: unknown): error is SimulatedStorageCrash {
  return error instanceof SimulatedStorageCrash || errorCode(error) === 'SIMULATED_STORAGE_CRASH';
}
function defaultProcessProbe(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error: unknown) { if (error instanceof Error && 'code' in error && error.code === 'ESRCH') return false; throw error; }
}
function assetFailureCode(error: unknown): string | null {
  const code: string = errorCode(error);
  return ['ASSET_FILE_MISSING', 'ASSET_HASH_MISMATCH', 'ASSET_MIME_MISMATCH', 'ASSET_CONTENT_CORRUPT', 'ASSET_PATH_UNSAFE',
    'AUDIO_ASSET_METADATA_MISSING', 'AUDIO_ASSET_METADATA_MISMATCH', 'AUDIO_ASSET_NORMALIZATION_REQUIRED', 'STORE_PATH_UNSAFE']
    .includes(code) || code.startsWith('STORED_ASSET_') || code.startsWith('STORED_AUDIO_') ? code : null;
}

type StoredAssetContractError = ContractError & { projectId: string; resourceId: string };

/** 저장된 자산을 읽는 경계의 무결성 오류를 업로드 입력 오류와 구분한다. */
export function mapStoredAssetIntegrityError(error: unknown, projectId: string, assetId: string): Error {
  const code: string = errorCode(error);
  const mappedCode: string | null = code === 'ASSET_FILE_MISSING' ? 'STORED_ASSET_FILE_MISSING'
    : code === 'ASSET_HASH_MISMATCH' ? 'STORED_ASSET_HASH_MISMATCH'
      : code === 'ASSET_MIME_MISMATCH' ? 'STORED_ASSET_MIME_MISMATCH'
        : code === 'ASSET_CONTENT_CORRUPT' ? 'STORED_ASSET_CONTENT_CORRUPT'
          : code === 'AUDIO_ASSET_METADATA_MISMATCH' && error instanceof Error && error.message.includes('길이') ? 'STORED_AUDIO_DURATION_MISMATCH'
            : code === 'AUDIO_ASSET_METADATA_MISMATCH' || code === 'AUDIO_ASSET_METADATA_MISSING'
              || code === 'AUDIO_ASSET_NORMALIZATION_REQUIRED' ? 'STORED_AUDIO_METADATA_MISMATCH' : null;
  if (mappedCode === null) return error instanceof Error ? error : new Error(String(error));
  const cause: string = error instanceof Error ? error.message : String(error);
  return Object.assign(contractError(mappedCode,
    `저장된 Asset 무결성을 확인할 수 없습니다. projectId=${projectId}, assetId=${assetId}, causeCode=${code}, cause=${cause}`, []),
  { projectId, resourceId: assetId }) satisfies StoredAssetContractError;
}

function storageProtectionRequired(error: unknown): boolean {
  return ['STORE_RECOVERY_REQUIRED', 'STORE_CREATE_RECOVERY_REQUIRED', 'STORE_PATH_UNSAFE', 'STORE_CONCURRENT_MODIFICATION',
    'STORE_LOCK_CLEANUP_REQUIRED'].includes(errorCode(error));
}

function assetDifferenceFields(current: Asset, next: Asset): string[] {
  const fields: string[] = [...new Set([...Object.keys(current), ...Object.keys(next)])].sort();
  return fields.filter((field: string): boolean => JSON.stringify(current[field as keyof Asset]) !== JSON.stringify(next[field as keyof Asset]));
}

/** Revision 사이의 Asset catalog와 write 집합이 append-only 계약을 만족하는지 검사한다. */
export function assertAssetCatalogTransition(
  current: Project, next: Project, assetWrites: readonly AssetWrite[],
): AssetCatalogTransition {
  const currentById: Map<string, Asset> = new Map<string, Asset>();
  const currentPaths: Set<string> = new Set<string>();
  for (const asset of current.assets) {
    if (currentById.has(asset.id) || currentPaths.has(asset.path)) throw contractError('DUPLICATE_ASSET_METADATA', `Current Asset ID와 경로는 각각 유일해야 합니다. assetId=${asset.id}, path=${asset.path}`, []);
    currentById.set(asset.id, asset); currentPaths.add(asset.path);
  }
  const nextById: Map<string, Asset> = new Map<string, Asset>();
  for (const asset of next.assets) {
    if (nextById.has(asset.id)) throw contractError('DUPLICATE_ASSET_METADATA', `Next Asset ID가 중복됩니다. assetId=${asset.id}`, []);
    nextById.set(asset.id, asset);
  }
  const preservedAssets: Asset[] = [];
  for (const currentAsset of current.assets) {
    const nextAsset: Asset | undefined = nextById.get(currentAsset.id);
    if (nextAsset === undefined) throw contractError('ASSET_REMOVAL_FORBIDDEN', `기존 Asset metadata는 삭제할 수 없습니다. assetId=${currentAsset.id}`, []);
    const changedFields: string[] = assetDifferenceFields(currentAsset, nextAsset);
    if (changedFields.length > 0) throw contractError('ASSET_METADATA_IMMUTABLE', `기존 Asset metadata는 변경할 수 없습니다. assetId=${currentAsset.id}, fields=${changedFields.join(',')}`, []);
    preservedAssets.push(nextAsset);
  }
  const newAssets: Asset[] = next.assets.filter((asset: Asset): boolean => !currentById.has(asset.id));
  for (const asset of newAssets) if (currentPaths.has(asset.path)) {
    throw contractError('ASSET_PATH_REUSE_FORBIDDEN', `신규 Asset은 기존 Asset 경로를 재사용할 수 없습니다. assetId=${asset.id}, path=${asset.path}`, []);
  }
  const nextPaths: Set<string> = new Set<string>();
  for (const asset of next.assets) {
    if (nextPaths.has(asset.path)) throw contractError('DUPLICATE_ASSET_METADATA', `Next Asset 경로가 중복됩니다. assetId=${asset.id}, path=${asset.path}`, []);
    nextPaths.add(asset.path);
  }
  const writesByPath: Map<string, AssetWrite> = new Map<string, AssetWrite>();
  for (const write of assetWrites) {
    if (writesByPath.has(write.relativePath)) throw contractError('DUPLICATE_ASSET_WRITE', `AssetWrite 경로가 중복됩니다. path=${write.relativePath}`, []);
    if (currentPaths.has(write.relativePath)) throw contractError('ASSET_WRITE_FOR_EXISTING_ASSET', `기존 Asset 경로에는 새 AssetWrite를 제출할 수 없습니다. path=${write.relativePath}`, []);
    writesByPath.set(write.relativePath, write);
  }
  const writesByAssetId: Map<string, AssetWrite> = new Map<string, AssetWrite>();
  for (const asset of newAssets) {
    const write: AssetWrite | undefined = writesByPath.get(asset.path);
    if (write === undefined) throw contractError('ASSET_WRITE_COUNT_MISMATCH', `새 Asset metadata에 대응하는 AssetWrite가 없습니다. assetId=${asset.id}, path=${asset.path}`, []);
    writesByAssetId.set(asset.id, write);
  }
  for (const write of assetWrites) if (!newAssets.some((asset: Asset): boolean => asset.path === write.relativePath)) {
    throw contractError('ASSET_WRITE_UNDECLARED', `신규 Asset metadata가 없는 AssetWrite입니다. path=${write.relativePath}`, []);
  }
  return { preservedAssets, newAssets, writesByAssetId };
}

type NormalizedFileProof = { stagedRelativePath: string; finalRelativePath: string; sha256: string };
type NormalizedAssetProof = NormalizedFileProof & { assetId: string };
type StagedAsset = { stagedRelativePath: string; finalPath: string; proof: NormalizedAssetProof; content: Buffer };
type NormalizedJournal = {
  version: 2 | 3; transactionId: string; projectId: string; owner: z.infer<typeof TransactionOwnerSchema>;
  expectedRevision: number; nextRevision: number; previousProject: NormalizedFileProof; nextProject: NormalizedFileProof;
  versionFile: NormalizedFileProof; assets: NormalizedAssetProof[];
};

function normalizeJournal(journal: TransactionJournal): NormalizedJournal {
  if (journal.version === 3) return journal;
  return {
    version: 2, transactionId: journal.transactionId, projectId: journal.projectId, owner: journal.owner,
    expectedRevision: journal.expectedRevision, nextRevision: journal.nextRevision,
    previousProject: { stagedRelativePath: TRANSACTION_PREVIOUS_PROJECT, finalRelativePath: 'project.json', sha256: journal.previousProjectSha256 },
    nextProject: { stagedRelativePath: TRANSACTION_NEXT_PROJECT, finalRelativePath: 'project.json', sha256: journal.nextProjectSha256 },
    versionFile: { stagedRelativePath: TRANSACTION_NEXT_VERSION, finalRelativePath: journal.versionFile.relativePath, sha256: journal.versionFile.sha256 },
    assets: journal.assets.map((asset): NormalizedAssetProof => ({ assetId: asset.assetId, stagedRelativePath: asset.stagedFileName,
      finalRelativePath: asset.relativePath, sha256: asset.sha256 })),
  };
}

/** Project snapshot과 Asset 파일을 로컬 트랜잭션으로 보존한다. */
export class ProjectStore {
  readonly #fs: SafeStoreFilesystem;
  readonly #faultInjector: StorageFaultInjector | null;
  readonly #processInstanceId: string;
  readonly #processStartedAt: string;
  readonly #now: () => Date;
  readonly #processProbe: (pid: number) => boolean;
  readonly #heartbeatFreshnessMs: number;
  readonly #recoveryEvents: StorageRecoveryEvent[] = [];
  readonly #recoveryBlocks: Map<string, StorageRecoveryBlock> = new Map<string, StorageRecoveryBlock>();
  readonly #activeCreates: Map<string, ActiveCreateState> = new Map<string, ActiveCreateState>();
  readonly #activeUpdates: Map<string, ActiveUpdateState> = new Map<string, ActiveUpdateState>();
  #initialization: Promise<void> | null = null;
  #processInstanceRegistered: boolean = false;
  #closed: boolean = false;

  constructor(root: string, faultInjector?: StorageFaultInjector, runtime?: StorageRuntime) {
    this.#fs = new SafeStoreFilesystem(root);
    this.#faultInjector = faultInjector ?? null;
    this.#processInstanceId = runtime?.processInstanceId ?? SHARED_PROCESS_INSTANCE_ID;
    this.#processStartedAt = runtime?.processStartedAt ?? SHARED_PROCESS_STARTED_AT;
    this.#now = runtime?.now ?? (() => new Date());
    this.#processProbe = runtime?.processProbe ?? defaultProcessProbe;
    this.#heartbeatFreshnessMs = runtime?.heartbeatFreshnessMs ?? DEFAULT_HEARTBEAT_FRESHNESS_MS;
  }

  #directory(projectId: string): string { return this.#fs.path(projectKey(projectId)); }
  #currentPath(projectId: string): string { return join(this.#directory(projectId), 'project.json'); }
  #versionsPath(projectId: string): string { return join(this.#directory(projectId), 'versions'); }
  #versionPath(projectId: string, revision: number): string { return join(this.#versionsPath(projectId), transactionVersionFileName(revision)); }
  #transactionsPath(projectId: string): string { return join(this.#directory(projectId), TRANSACTIONS_DIRECTORY); }
  #transactionPath(projectId: string, transactionId: string): string { return join(this.#transactionsPath(projectId), transactionId); }
  #createTransactionsPath(): string { return this.#fs.path(CREATE_TRANSACTIONS_DIRECTORY); }
  #createTransactionPath(transactionId: string): string { return join(this.#createTransactionsPath(), transactionId); }
  #createLocksPath(): string { return this.#fs.path(CREATE_LOCKS_DIRECTORY); }
  #rootCreateLockPath(projectId: string): string { return join(this.#createLocksPath(), `${projectKey(projectId)}.lock`); }
  #recoveryBlocksPath(): string { return this.#fs.path(RECOVERY_BLOCKS_DIRECTORY); }
  #recoveryBlockPath(directoryName: string): string { return join(this.#recoveryBlocksPath(), `${directoryName}.json`); }
  #processInstancesPath(): string { return this.#fs.path(PROCESS_INSTANCES_DIRECTORY); }
  #processInstancePath(processInstanceId: string): string { return join(this.#processInstancesPath(), `${processInstanceId}.json`); }
  #owner(transactionId: string): z.infer<typeof TransactionOwnerSchema> {
    return TransactionOwnerSchema.parse({ host: hostname(), pid: this.#faultInjector?.ownerPid ?? process.pid, transactionId });
  }

  #nowIso(): string { return this.#now().toISOString(); }

  #lockMetadata(projectId: string, transactionId: string, pid: number): StoreLock {
    return StoreLockV3Schema.parse({ version: STORE_LOCK_VERSION, projectId, host: hostname(), pid, transactionId,
      createdAt: this.#nowIso(), processInstanceId: this.#processInstanceId, processStartedAt: this.#processStartedAt });
  }

  async #fault(point: StorageFaultPoint): Promise<void> { await this.#faultInjector?.trigger(point); }

  async #touchProcessInstance(): Promise<void> {
    if (this.#closed) throw contractError('STORE_CLOSED', '종료된 ProjectStore는 사용할 수 없습니다.', []);
    const record: ProcessInstanceRecord = ProcessInstanceRecordSchema.parse({
      version: 1, processInstanceId: this.#processInstanceId, host: hostname(), pid: process.pid,
      startedAt: this.#processStartedAt, heartbeatAt: this.#nowIso(),
    });
    const path: string = this.#processInstancePath(this.#processInstanceId);
    if (await this.#fs.kind(path) === 'file') {
      const current: ProcessInstanceRecord = ProcessInstanceRecordSchema.parse(JSON.parse(await this.#fs.readText(path)) as unknown);
      if (current.processInstanceId !== record.processInstanceId || current.host !== record.host || current.pid !== record.pid
        || current.startedAt !== record.startedAt) {
        recoveryRequired(`Process Instance Registry 소유권이 다릅니다. processInstanceId=${this.#processInstanceId}`);
      }
      await this.#writeReplacement(path, JSON.stringify(record), randomUUID());
    } else {
      await this.#writeReplacement(path, JSON.stringify(record), randomUUID());
    }
  }

  async #registerProcessInstance(): Promise<void> {
    if (!this.#processInstanceRegistered) {
      const root: string = this.#fs.root();
      const registrationKey: string = processRegistrationKey(root, this.#processInstanceId);
      await this.#touchProcessInstance();
      processInstanceRegistrations.set(registrationKey, (processInstanceRegistrations.get(registrationKey) ?? 0) + 1);
      this.#processInstanceRegistered = true;
      return;
    }
    await this.#touchProcessInstance();
  }

  async #readProcessInstance(processInstanceId: string): Promise<ProcessInstanceRecord | null> {
    const path: string = this.#processInstancePath(processInstanceId);
    if (await this.#fs.kind(path) === 'missing') return null;
    try { return ProcessInstanceRecordSchema.parse(JSON.parse(await this.#fs.readText(path)) as unknown); }
    catch (error: unknown) {
      recoveryRequired(`Process Instance Registry를 검증할 수 없습니다. processInstanceId=${processInstanceId}, cause=${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async #ownerIsActive(lock: RecoveryLock): Promise<boolean> {
    const metadata: StoreLock = lock.metadata;
    if (metadata.host !== hostname()) recoveryRequired(`다른 Host의 Lock은 자동 복구할 수 없습니다. projectId=${metadata.projectId}, host=${metadata.host}`);
    if (!this.#processProbe(metadata.pid)) return false;
    if (metadata.version === 2) return true;
    const instance: ProcessInstanceRecord | null = await this.#readProcessInstance(metadata.processInstanceId);
    if (instance === null) recoveryRequired(`살아 있는 PID의 Process Instance Registry가 없습니다. projectId=${metadata.projectId}, processInstanceId=${metadata.processInstanceId}`);
    if (instance.host !== metadata.host || instance.pid !== metadata.pid || instance.processInstanceId !== metadata.processInstanceId
      || instance.startedAt !== metadata.processStartedAt) {
      recoveryRequired(`Lock과 Process Instance Registry가 일치하지 않습니다. projectId=${metadata.projectId}, processInstanceId=${metadata.processInstanceId}`);
    }
    const heartbeatAgeMs: number = this.#now().getTime() - Date.parse(instance.heartbeatAt);
    if (!Number.isFinite(heartbeatAgeMs) || heartbeatAgeMs < 0 || heartbeatAgeMs > this.#heartbeatFreshnessMs) {
      recoveryRequired(`살아 있는 PID의 Process Instance heartbeat가 유효하지 않습니다. projectId=${metadata.projectId}, processInstanceId=${metadata.processInstanceId}, ageMs=${heartbeatAgeMs}`);
    }
    return true;
  }

  #recordRecovery(event: StorageRecoveryEvent): void {
    this.#recoveryEvents.push(event);
    console.warn(JSON.stringify({ event: 'project-store-recovery', ...event }));
  }

  #safeAssetPath(projectId: string, asset: Asset): string { return this.#safeJournalAssetPath(projectId, asset.path); }

  #safeJournalAssetPath(projectId: string, relativePath: string): string {
    if (!relativePath.startsWith('assets/')) throw contractError('TRANSACTION_JOURNAL_PATH_UNSAFE',
      `Transaction journal의 자산 경로는 assets 아래여야 합니다. projectId=${projectId}, path=${relativePath}`, []);
    const directory: string = this.#directory(projectId);
    const assetsDirectory: string = join(directory, 'assets');
    const path: string = this.#fs.path(projectKey(projectId), relativePath);
    const child: string = relative(assetsDirectory, path);
    if (child === '' || child === '..' || child.startsWith(`..${sep}`)) throw contractError('TRANSACTION_JOURNAL_PATH_UNSAFE',
      `Transaction journal이 assets 밖의 경로를 가리킵니다. projectId=${projectId}, path=${relativePath}`, []);
    return path;
  }

  async #readProjectFile(path: string): Promise<Project> {
    return parseProject(JSON.parse(await this.#fs.readText(path)) as unknown);
  }

  async #fileSha256(path: string): Promise<string> { return sha256Bytes(await this.#fs.read(path)); }

  async #requireFileProof(path: string, expectedSha256: string, context: string): Promise<void> {
    if (await this.#fs.kind(path) !== 'file') recoveryRequired(`${context}: 증명할 정규 파일이 없습니다. path=${path}, expectedSha256=${expectedSha256}`);
    const actualSha256: string = await this.#fileSha256(path);
    if (actualSha256 !== expectedSha256) recoveryRequired(`${context}: 파일 해시가 journal과 다릅니다. path=${path}, expectedSha256=${expectedSha256}, actualSha256=${actualSha256}`);
  }

  async #writeReplacement(path: string, content: string, token: string): Promise<void> {
    const temporaryPath: string = `${path}.${token}.tmp`;
    if (await this.#fs.exists(temporaryPath)) recoveryRequired(`교체용 임시 파일이 이미 존재합니다. path=${temporaryPath}`);
    await this.#fs.writeExclusive(temporaryPath, content);
    await this.#fs.syncDirectory(dirname(path));
    await this.#fs.replaceFile(temporaryPath, path);
    await this.#fs.syncDirectory(dirname(path));
  }

  async #writeJournalPhase(projectId: string, transactionId: string, journal: TransactionJournalV3, phase: z.infer<typeof TransactionPhaseSchema>): Promise<TransactionJournalV3> {
    await this.#touchProcessInstance();
    const next: TransactionJournalV3 = TransactionJournalV3Schema.parse({ ...journal, phase });
    const transactionPath: string = this.#transactionPath(projectId, transactionId);
    const temporaryPath: string = join(transactionPath, TRANSACTION_PHASE_JOURNAL);
    await this.#fs.writeExclusive(temporaryPath, JSON.stringify(next));
    await this.#fs.syncDirectory(transactionPath);
    await this.#fs.replaceFile(temporaryPath, join(transactionPath, TRANSACTION_JOURNAL));
    await this.#fs.syncDirectory(transactionPath);
    return next;
  }

  async #writeCreateJournalPhase(transactionId: string, journal: CreateJournalV3, phase: z.infer<typeof CreatePhaseSchema>): Promise<CreateJournalV3> {
    await this.#touchProcessInstance();
    const next: CreateJournalV3 = CreateJournalV3Schema.parse({ ...journal, phase });
    const transactionPath: string = this.#createTransactionPath(transactionId);
    const temporaryPath: string = join(transactionPath, TRANSACTION_PHASE_JOURNAL);
    await this.#fs.writeExclusive(temporaryPath, JSON.stringify(next));
    await this.#fs.syncDirectory(transactionPath);
    await this.#fs.replaceFile(temporaryPath, join(transactionPath, TRANSACTION_JOURNAL));
    await this.#fs.syncDirectory(transactionPath);
    return next;
  }

  async #readTransactionJournal(projectId: string, transactionId: string): Promise<TransactionJournal> {
    const transactionPath: string = this.#transactionPath(projectId, transactionId);
    const phasePath: string = join(transactionPath, TRANSACTION_PHASE_JOURNAL);
    const journalPath: string = join(transactionPath, TRANSACTION_JOURNAL);
    try {
      if (await this.#fs.kind(phasePath) === 'file') {
        const staged: TransactionJournal = TransactionJournalSchema.parse(JSON.parse(await this.#fs.readText(phasePath)) as unknown);
        if (staged.version !== 3 || staged.projectId !== projectId || staged.transactionId !== transactionId) recoveryRequired(`Transaction phase journal 식별자가 다릅니다. projectId=${projectId}, transactionId=${transactionId}`);
        await this.#fs.replaceFile(phasePath, journalPath);
        await this.#fs.syncDirectory(transactionPath);
      }
      const journal: TransactionJournal = TransactionJournalSchema.parse(JSON.parse(await this.#fs.readText(journalPath)) as unknown);
      this.#assertJournalIdentity(projectId, transactionId, normalizeJournal(journal));
      return journal;
    } catch (error: unknown) {
      if (errorCode(error) === 'STORE_RECOVERY_REQUIRED') throw error;
      recoveryRequired(`Transaction journal을 검증할 수 없습니다. projectId=${projectId}, transactionId=${transactionId}, cause=${error instanceof Error ? error.message : String(error)}`);
    }
  }

  #assertJournalIdentity(projectId: string, transactionId: string, journal: NormalizedJournal): void {
    const versionRelativePath: string = `versions/${transactionVersionFileName(journal.nextRevision)}`;
    if (journal.projectId !== projectId || journal.transactionId !== transactionId || journal.owner.transactionId !== transactionId
      || journal.nextRevision !== journal.expectedRevision + 1
      || journal.previousProject.stagedRelativePath !== TRANSACTION_PREVIOUS_PROJECT || journal.previousProject.finalRelativePath !== 'project.json'
      || journal.nextProject.stagedRelativePath !== TRANSACTION_NEXT_PROJECT || journal.nextProject.finalRelativePath !== 'project.json'
      || journal.versionFile.stagedRelativePath !== TRANSACTION_NEXT_VERSION || journal.versionFile.finalRelativePath !== versionRelativePath
      || journal.versionFile.sha256 !== journal.nextProject.sha256) {
      recoveryRequired(`Transaction journal 식별자, revision 또는 경로가 일치하지 않습니다. projectId=${projectId}, transactionId=${transactionId}`);
    }
    const assetPaths: Set<string> = new Set<string>();
    const assetIds: Set<string> = new Set<string>();
    const stagePaths: Set<string> = new Set<string>();
    for (const asset of journal.assets) {
      this.#safeJournalAssetPath(projectId, asset.finalRelativePath);
      if (!/^asset-[0-9]+\.bin$/.test(asset.stagedRelativePath) || assetPaths.has(asset.finalRelativePath)
        || assetIds.has(asset.assetId) || stagePaths.has(asset.stagedRelativePath)) recoveryRequired(`Transaction journal Asset 증명이 중복되거나 잘못됐습니다. projectId=${projectId}, transactionId=${transactionId}`);
      assetPaths.add(asset.finalRelativePath); assetIds.add(asset.assetId); stagePaths.add(asset.stagedRelativePath);
    }
  }

  async #assertRecoverableOwner(projectId: string, transactionId: string, journal: NormalizedJournal, lock: RecoveryLock | null): Promise<void> {
    if (journal.owner.host !== hostname()) recoveryRequired(`다른 Host의 Transaction을 자동 복구할 수 없습니다. projectId=${projectId}, transactionId=${transactionId}`);
    if (lock !== null && lock.metadata.transactionId === transactionId) {
      if (lock.metadata.pid !== journal.owner.pid || lock.metadata.host !== journal.owner.host) recoveryRequired(`Lock과 journal 소유권이 다릅니다. projectId=${projectId}, transactionId=${transactionId}`);
      if (await this.#ownerIsActive(lock)) throw contractError('PROJECT_BUSY', `${projectId}: transactionId=${transactionId}, pid=${journal.owner.pid} 저장 작업이 진행 중입니다.`, []);
      return;
    }
    if (this.#processProbe(journal.owner.pid)) throw contractError('PROJECT_BUSY', `${projectId}: transactionId=${transactionId}, pid=${journal.owner.pid} 저장 작업이 진행 중입니다.`, []);
  }

  async #transactionProjects(projectId: string, transactionId: string, journal: NormalizedJournal): Promise<{ previous: Project; previousContent: string; next: Project }> {
    const transactionPath: string = this.#transactionPath(projectId, transactionId);
    const previousPath: string = join(transactionPath, journal.previousProject.stagedRelativePath);
    const nextPath: string = join(transactionPath, journal.nextProject.stagedRelativePath);
    await this.#requireFileProof(previousPath, journal.previousProject.sha256, `이전 Project 증명 실패 projectId=${projectId}, transactionId=${transactionId}`);
    const previousContent: string = await this.#fs.readText(previousPath);
    const previous: Project = parseProject(JSON.parse(previousContent) as unknown);
    const nextCandidates: string[] = [nextPath, this.#versionPath(projectId, journal.nextRevision), this.#currentPath(projectId)];
    let nextContent: string | null = null;
    for (const candidate of nextCandidates) {
      if (await this.#fs.kind(candidate) !== 'file') continue;
      if (await this.#fileSha256(candidate) === journal.nextProject.sha256) { nextContent = await this.#fs.readText(candidate); break; }
    }
    if (nextContent === null) recoveryRequired(`다음 Project 증명 실패 projectId=${projectId}, transactionId=${transactionId}`);
    const next: Project = parseProject(JSON.parse(nextContent) as unknown);
    if (previous.projectId !== projectId || previous.revision !== journal.expectedRevision || next.projectId !== projectId || next.revision !== journal.nextRevision) {
      recoveryRequired(`복구 Project revision이 journal과 일치하지 않습니다. projectId=${projectId}, transactionId=${transactionId}`);
    }
    for (const proof of journal.assets) {
      if (!next.assets.some((asset: Asset): boolean => asset.id === proof.assetId && asset.path === proof.finalRelativePath && asset.sha256 === proof.sha256)) {
        recoveryRequired(`다음 Project의 Asset metadata가 journal과 다릅니다. projectId=${projectId}, assetId=${proof.assetId}`);
      }
    }
    return { previous, previousContent, next };
  }

  async #verifyTransactionEntries(projectId: string, transactionId: string, journal: NormalizedJournal): Promise<void> {
    const transactionPath: string = this.#transactionPath(projectId, transactionId);
    const allowed: Set<string> = new Set<string>([TRANSACTION_JOURNAL, TRANSACTION_PHASE_JOURNAL, TRANSACTION_CURRENT_PUBLISH,
      journal.previousProject.stagedRelativePath, journal.nextProject.stagedRelativePath, journal.versionFile.stagedRelativePath,
      ...journal.assets.map((asset): string => asset.stagedRelativePath)]);
    const entries = await this.#fs.entries(transactionPath);
    const unknown: string[] = entries.filter((entry): boolean => !allowed.has(entry.name)).map((entry): string => entry.name);
    if (unknown.length > 0) recoveryRequired(`Transaction staging에 증명되지 않은 항목이 있습니다. projectId=${projectId}, transactionId=${transactionId}, entries=${unknown.join(',')}`);
    for (const proof of [journal.previousProject, journal.nextProject, journal.versionFile, ...journal.assets]) {
      const path: string = join(transactionPath, proof.stagedRelativePath);
      if (await this.#fs.kind(path) === 'file') await this.#requireFileProof(path, proof.sha256, `staging 파일 증명 실패 projectId=${projectId}, transactionId=${transactionId}`);
    }
  }

  async #removeVerifiedTransaction(projectId: string, transactionId: string, journal: NormalizedJournal): Promise<void> {
    await this.#verifyTransactionEntries(projectId, transactionId, journal);
    await this.#fs.removeTree(this.#transactionPath(projectId, transactionId));
    await this.#fs.syncDirectory(this.#transactionsPath(projectId));
  }

  async #deleteOwnedPublished(projectId: string, transactionId: string, journalVersion: 2 | 3,
    stagedPath: string, finalPath: string, expectedSha256: string, context: string): Promise<void> {
    if (await this.#fs.kind(finalPath) === 'missing') return;
    if (journalVersion !== 3) recoveryRequired(`${context}: v2 journal에는 게시 파일 inode 소유권 증명이 없습니다. projectId=${projectId}, transactionId=${transactionId}`);
    await this.#requireFileProof(stagedPath, expectedSha256, `${context} staging`);
    await this.#requireFileProof(finalPath, expectedSha256, `${context} final`);
    const stagedIdentity: FileIdentity = await this.#fs.identity(stagedPath);
    const finalIdentity: FileIdentity = await this.#fs.identity(finalPath);
    if (!sameFileIdentity(stagedIdentity, finalIdentity)) recoveryRequired(`${context}: 같은 해시지만 staging과 final inode가 달라 Transaction 소유 파일로 판정할 수 없습니다. projectId=${projectId}, transactionId=${transactionId}`);
    await this.#requireFileProof(finalPath, expectedSha256, `${context} 삭제 직전`);
    if (!sameFileIdentity(await this.#fs.identity(stagedPath), await this.#fs.identity(finalPath))) recoveryRequired(`${context}: 삭제 직전 파일 소유권이 바뀌었습니다.`);
    await this.#fs.unlinkFile(finalPath, finalIdentity);
  }

  async #versionProjects(projectId: string, excludedRevision: number | null): Promise<Project[]> {
    const versionsPath: string = this.#versionsPath(projectId);
    const projects: Project[] = [];
    for (const entry of await this.#fs.entries(versionsPath)) {
      if (!entry.isFile() || !/^[0-9]{6}\.json$/.test(entry.name)) recoveryRequired(`revision 저장소에 올바르지 않은 항목이 있습니다. projectId=${projectId}, entry=${entry.name}`);
      const revision: number = Number(entry.name.slice(0, 6));
      if (revision === excludedRevision) continue;
      let project: Project;
      try { project = await this.#readProjectFile(join(versionsPath, entry.name)); }
      catch (error: unknown) {
        recoveryRequired(`revision snapshot을 검증할 수 없습니다. projectId=${projectId}, entry=${entry.name}, cause=${error instanceof Error ? error.message : String(error)}`);
      }
      if (project.projectId !== projectId || project.revision !== revision) recoveryRequired(`revision 파일 이름과 Project가 다릅니다. projectId=${projectId}, entry=${entry.name}`);
      projects.push(project);
    }
    return projects;
  }

  async #allAssetReferences(projectId: string, excludedTransactionId: string, excludedRevision: number | null,
    excludedCurrentRevision: number | null): Promise<Set<string>> {
    const projects: Project[] = await this.#versionProjects(projectId, excludedRevision);
    if (await this.#fs.kind(this.#currentPath(projectId)) === 'file') {
      const current: Project = await this.#readProjectFile(this.#currentPath(projectId));
      if (current.projectId !== projectId) recoveryRequired(`현재 Project ID가 저장 경로와 다릅니다. projectId=${projectId}`);
      if (current.revision !== excludedCurrentRevision) projects.push(current);
    }
    for (const entry of await this.#fs.entries(this.#transactionsPath(projectId))) {
      if (!entry.isDirectory()) recoveryRequired(`Transaction 목록에 디렉터리가 아닌 항목이 있습니다. projectId=${projectId}, entry=${entry.name}`);
      if (entry.name === excludedTransactionId) continue;
      const journal: NormalizedJournal = normalizeJournal(await this.#readTransactionJournal(projectId, entry.name));
      const transactionProjects = await this.#transactionProjects(projectId, entry.name, journal);
      projects.push(transactionProjects.previous, transactionProjects.next);
    }
    const references: Set<string> = new Set<string>();
    for (const project of projects) for (const asset of project.assets) { references.add(`id:${asset.id}`); references.add(`path:${asset.path}`); }
    return references;
  }

  async #removePublishedTransactionFiles(projectId: string, journal: NormalizedJournal, excludeNextCurrent: boolean): Promise<void> {
    const transactionPath: string = this.#transactionPath(projectId, journal.transactionId);
    await this.#deleteOwnedPublished(projectId, journal.transactionId, journal.version,
      join(transactionPath, journal.versionFile.stagedRelativePath), this.#versionPath(projectId, journal.nextRevision), journal.versionFile.sha256,
      `revision rollback revision=${journal.nextRevision}`);
    await this.#fs.syncDirectory(this.#versionsPath(projectId));
    const references: Set<string> = await this.#allAssetReferences(projectId, journal.transactionId, journal.nextRevision,
      excludeNextCurrent ? journal.nextRevision : null);
    for (const proof of journal.assets) {
      if (references.has(`id:${proof.assetId}`) || references.has(`path:${proof.finalRelativePath}`)) recoveryRequired(`게시 Asset이 다른 저장 Project에서 참조됩니다. projectId=${projectId}, transactionId=${journal.transactionId}, assetId=${proof.assetId}`);
      await this.#deleteOwnedPublished(projectId, journal.transactionId, journal.version,
        join(transactionPath, proof.stagedRelativePath), this.#safeJournalAssetPath(projectId, proof.finalRelativePath), proof.sha256,
        `Asset rollback assetId=${proof.assetId}`);
    }
    await this.#fs.syncDirectory(join(this.#directory(projectId), 'assets'));
  }

  async #verifyCommittedTransaction(project: Project, journal: NormalizedJournal): Promise<void> {
    await this.#requireFileProof(this.#currentPath(project.projectId), journal.nextProject.sha256, `현재 Project commit 증명 projectId=${project.projectId}`);
    await this.#requireFileProof(this.#versionPath(project.projectId, journal.nextRevision), journal.versionFile.sha256, `revision commit 증명 projectId=${project.projectId}`);
    const version: Project = await this.#readProjectFile(this.#versionPath(project.projectId, journal.nextRevision));
    if (JSON.stringify(version) !== JSON.stringify(project)) recoveryRequired(`현재 Project와 revision snapshot이 다릅니다. projectId=${project.projectId}, revision=${journal.nextRevision}`);
    for (const proof of journal.assets) {
      const asset: Asset | undefined = project.assets.find((candidate: Asset): boolean => candidate.id === proof.assetId
        && candidate.path === proof.finalRelativePath && candidate.sha256 === proof.sha256);
      if (asset === undefined) recoveryRequired(`게시된 Project에 journal Asset metadata가 없습니다. projectId=${project.projectId}, assetId=${proof.assetId}`);
      const path: string = this.#safeJournalAssetPath(project.projectId, proof.finalRelativePath);
      await this.#requireFileProof(path, proof.sha256, `게시 Asset commit 증명 projectId=${project.projectId}, assetId=${proof.assetId}`);
      await verifyStoredAsset(project, asset, await this.#fs.read(path));
    }
  }

  async #restorePreviousProject(projectId: string, journal: NormalizedJournal, previousContent: string): Promise<void> {
    const currentPath: string = this.#currentPath(projectId);
    if (await this.#fs.kind(currentPath) === 'file') await this.#requireFileProof(currentPath, journal.nextProject.sha256, `복구 대상 현재 Project 증명 projectId=${projectId}`);
    await this.#writeReplacement(currentPath, previousContent, journal.transactionId);
    await this.#removePublishedTransactionFiles(projectId, journal, false);
  }

  async #readRecoveryLock(directoryName: string): Promise<RecoveryLock | null> {
    const path: string = this.#fs.path(directoryName, 'write.lock');
    if (await this.#fs.kind(path) === 'missing') return null;
    let metadata: StoreLock | null = null;
    let parseError: unknown = null;
    for (let attempt: number = 0; attempt < 3 && metadata === null; attempt += 1) {
      try { metadata = StoreLockSchema.parse(JSON.parse(await this.#fs.readText(path)) as unknown); }
      catch (error: unknown) {
        parseError = error;
        if (await this.#fs.kind(path) === 'missing') return null;
        if (attempt < 2) await new Promise<void>((resolveRetry): void => { setTimeout(resolveRetry, 0); });
      }
    }
    if (metadata === null) recoveryRequired(`Project lock을 해석할 수 없습니다. directory=${directoryName}, cause=${parseError instanceof Error ? parseError.message : String(parseError)}`);
    if (projectKey(metadata.projectId) !== directoryName) recoveryRequired(`Project lock과 저장 디렉터리가 다릅니다. projectId=${metadata.projectId}`);
    if (metadata.host !== hostname()) recoveryRequired(`다른 Host의 Project lock은 자동 삭제할 수 없습니다. projectId=${metadata.projectId}`);
    return { metadata, path, identity: await this.#fs.identity(path) };
  }

  async #readRootCreateLock(entryName: string): Promise<RecoveryLock | null> {
    if (!/^[a-f0-9]{64}\.lock$/.test(entryName)) {
      createRecoveryRequired(`Root Create lock 파일 이름이 올바르지 않습니다. entry=${entryName}`, 'invalid lock name');
    }
    const path: string = join(this.#createLocksPath(), entryName);
    const kind: SafePathKind = await this.#fs.kind(path);
    if (kind === 'missing') return null;
    if (kind !== 'file') createRecoveryRequired(`Root Create lock이 정규 파일이 아닙니다. entry=${entryName}`, 'invalid lock kind');
    let metadata: StoreLock | null = null;
    let parseError: unknown = null;
    for (let attempt: number = 0; attempt < 3 && metadata === null; attempt += 1) {
      try { metadata = StoreLockSchema.parse(JSON.parse(await this.#fs.readText(path)) as unknown); }
      catch (error: unknown) {
        parseError = error;
        if (await this.#fs.kind(path) === 'missing') return null;
        if (attempt < 2) await new Promise<void>((resolveRetry): void => { setTimeout(resolveRetry, 0); });
      }
    }
    if (metadata === null) createRecoveryRequired(`Root Create lock을 해석할 수 없습니다. entry=${entryName}`, parseError);
    if (`${projectKey(metadata.projectId)}.lock` !== entryName) {
      createRecoveryRequired(`Root Create lock과 Project ID가 다릅니다. entry=${entryName}, projectId=${metadata.projectId}`, 'project key mismatch');
    }
    try { return { metadata, path, identity: await this.#fs.identity(path) }; }
    catch (error: unknown) {
      if (await this.#fs.kind(path) === 'missing') return null;
      createRecoveryRequired(`Root Create lock identity를 확인할 수 없습니다. entry=${entryName}`, error);
    }
  }

  async #rootCreateLock(projectId: string): Promise<RecoveryLock | null> {
    const path: string = this.#rootCreateLockPath(projectId);
    if (await this.#fs.kind(path) === 'missing') return null;
    return this.#readRootCreateLock(`${projectKey(projectId)}.lock`);
  }

  #rememberActiveCreate(lock: RecoveryLock): void {
    this.#activeCreates.set(projectKey(lock.metadata.projectId), {
      projectId: lock.metadata.projectId, transactionId: lock.metadata.transactionId, host: lock.metadata.host,
      pid: lock.metadata.pid, processInstanceId: lock.metadata.version === 3 ? lock.metadata.processInstanceId : null,
      detectedAt: this.#nowIso(),
    });
  }

  #rememberActiveUpdate(lock: RecoveryLock): void {
    this.#activeUpdates.set(projectKey(lock.metadata.projectId), {
      projectId: lock.metadata.projectId, transactionId: lock.metadata.transactionId, host: lock.metadata.host,
      pid: lock.metadata.pid, processInstanceId: lock.metadata.version === 3 ? lock.metadata.processInstanceId : null,
      detectedAt: this.#nowIso(),
    });
  }

  async #acquireProjectLock(projectId: string, transactionId: string): Promise<RecoveryLock> {
    await this.#touchProcessInstance();
    const metadata: StoreLock = this.#lockMetadata(projectId, transactionId, this.#faultInjector?.ownerPid ?? process.pid);
    return this.#acquireOwnedLock(join(this.#directory(projectId), 'write.lock'), metadata);
  }

  async #acquireOwnedLock(path: string, metadata: StoreLock): Promise<RecoveryLock> {
    const state: LockAcquisitionState = { createdByThisCall: false, metadata, identity: null };
    let exclusiveWriteInProgress: boolean = false;
    try {
      await this.#fault('before-lock-write');
      exclusiveWriteInProgress = true;
      state.identity = await this.#fs.writeExclusiveWithIdentity(path, JSON.stringify(metadata));
      exclusiveWriteInProgress = false;
      state.createdByThisCall = true;
      await this.#fault('after-lock-file-created');
      const lock: RecoveryLock = { metadata, path, identity: state.identity };
      await this.#verifyOwnedLock(lock);
      await this.#fault('before-lock-directory-sync');
      await this.#fs.syncDirectory(dirname(path));
      await this.#fault('after-lock-directory-sync');
      await this.#verifyOwnedLock(lock);
      return lock;
    } catch (error: unknown) {
      if (exclusiveWriteInProgress && errorCode(error) === 'EEXIST') {
        await this.#fault('after-lock-write-eexist');
        throw contractError('PROJECT_BUSY', `${metadata.projectId}: 다른 저장 작업이 진행 중입니다.`, []);
      }
      if (isSimulatedCrash(error)) throw error;
      if (state.createdByThisCall && state.identity !== null) {
        const lock: RecoveryLock = { metadata, path, identity: state.identity };
        try { await this.#removeRecoveryLock(lock); }
        catch (cleanupError: unknown) {
          const protectedError = contractError('STORE_LOCK_CLEANUP_REQUIRED',
            `Project lock 획득 실패 후 소유 lock을 정리할 수 없습니다. projectId=${metadata.projectId}, transactionId=${metadata.transactionId}, cause=${error instanceof Error ? error.message : String(error)}, cleanup=${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`, []);
          await this.#writeRecoveryBlock(projectKey(metadata.projectId), metadata.projectId, metadata.transactionId, protectedError);
          throw protectedError;
        }
      } else if (error instanceof AggregateError) {
        const protectedError = contractError('STORE_LOCK_CLEANUP_REQUIRED',
          `Project lock 원자 생성 실패의 정리 상태를 증명할 수 없습니다. projectId=${metadata.projectId}, transactionId=${metadata.transactionId}, cause=${error.message}`, []);
        await this.#writeRecoveryBlock(projectKey(metadata.projectId), metadata.projectId, metadata.transactionId, protectedError);
        throw protectedError;
      }
      throw contractError('STORE_LOCK_ACQUISITION_FAILED',
        `Project lock을 획득할 수 없습니다. projectId=${metadata.projectId}, transactionId=${metadata.transactionId}, cause=${error instanceof Error ? error.message : String(error)}, causeCode=${errorCode(error)}`, []);
    }
  }

  async #removeRecoveryLock(lock: RecoveryLock): Promise<void> {
    await this.#verifyOwnedLock(lock);
    await this.#fs.unlinkFile(lock.path, lock.identity);
    await this.#fs.syncDirectory(dirname(lock.path));
  }

  async #verifyOwnedLock(lock: RecoveryLock): Promise<void> {
    if (await this.#fs.kind(lock.path) !== 'file') recoveryRequired(`현재 Update가 소유한 Project lock이 없습니다. projectId=${lock.metadata.projectId}, transactionId=${lock.metadata.transactionId}`);
    let current: StoreLock;
    try { current = StoreLockSchema.parse(JSON.parse(await this.#fs.readText(lock.path)) as unknown); }
    catch (error: unknown) { recoveryRequired(`현재 Update의 Project lock을 검증할 수 없습니다. projectId=${lock.metadata.projectId}, cause=${error instanceof Error ? error.message : String(error)}`); }
    if (current.projectId !== lock.metadata.projectId || current.transactionId !== lock.metadata.transactionId
      || current.host !== lock.metadata.host || current.pid !== lock.metadata.pid || JSON.stringify(current) !== JSON.stringify(lock.metadata)) {
      recoveryRequired(`현재 Update의 Project lock 소유권이 일치하지 않습니다. projectId=${lock.metadata.projectId}, transactionId=${lock.metadata.transactionId}`);
    }
    const actualIdentity: FileIdentity = await this.#fs.identity(lock.path);
    if (!sameFileIdentity(actualIdentity, lock.identity)) recoveryRequired(`현재 Update의 Project lock 파일 identity가 바뀌었습니다. projectId=${lock.metadata.projectId}, transactionId=${lock.metadata.transactionId}, expected=${lock.identity.dev}:${lock.identity.ino}, actual=${actualIdentity.dev}:${actualIdentity.ino}`);
  }

  async #recoverTransaction(projectId: string, transactionId: string, lock: RecoveryLock | null): Promise<void> {
    const transactionPath: string = this.#transactionPath(projectId, transactionId);
    const journalPath: string = join(transactionPath, TRANSACTION_JOURNAL);
    if (await this.#fs.kind(journalPath) === 'missing' && await this.#fs.kind(join(transactionPath, TRANSACTION_PHASE_JOURNAL)) === 'missing') {
      if ((await this.#fs.entries(transactionPath)).length !== 0) recoveryRequired(`journal 없는 Transaction staging을 삭제할 수 없습니다. projectId=${projectId}, transactionId=${transactionId}`);
      await this.#fs.removeEmptyDirectory(transactionPath); await this.#fs.syncDirectory(this.#transactionsPath(projectId));
      this.#recordRecovery({ projectId, transactionId, outcome: 'staging-removed' }); return;
    }
    const raw: TransactionJournal = await this.#readTransactionJournal(projectId, transactionId);
    const journal: NormalizedJournal = normalizeJournal(raw);
    await this.#assertRecoverableOwner(projectId, transactionId, journal, lock);
    await this.#verifyTransactionEntries(projectId, transactionId, journal);
    const projects = await this.#transactionProjects(projectId, transactionId, journal);
    const currentKind: SafePathKind = await this.#fs.kind(this.#currentPath(projectId));
    const current: Project | null = currentKind === 'file' ? await this.#readProjectFile(this.#currentPath(projectId)) : null;
    if (current === null) {
      await this.#removePublishedTransactionFiles(projectId, journal, false);
      await this.#writeReplacement(this.#currentPath(projectId), projects.previousContent, transactionId);
      await this.#removeVerifiedTransaction(projectId, transactionId, journal);
      this.#recordRecovery({ projectId, transactionId, outcome: 'restored-previous' }); return;
    }
    if (current.revision === journal.expectedRevision) {
      await this.#requireFileProof(this.#currentPath(projectId), journal.previousProject.sha256, `rollback 기준 Project 증명 projectId=${projectId}`);
      await this.#removePublishedTransactionFiles(projectId, journal, false);
      await this.#removeVerifiedTransaction(projectId, transactionId, journal);
      this.#recordRecovery({ projectId, transactionId, outcome: 'rolled-back' }); return;
    }
    if (current.revision === journal.nextRevision) {
      try {
        await this.#verifyCommittedTransaction(current, journal);
        await this.#removeVerifiedTransaction(projectId, transactionId, journal);
        this.#recordRecovery({ projectId, transactionId, outcome: 'committed' });
      } catch (error: unknown) {
        if (errorCode(error) !== 'STORE_RECOVERY_REQUIRED' && errorCode(error) !== 'STORE_PATH_UNSAFE') throw error;
        await this.#restorePreviousProject(projectId, journal, projects.previousContent);
        await this.#removeVerifiedTransaction(projectId, transactionId, journal);
        this.#recordRecovery({ projectId, transactionId, outcome: 'restored-previous' });
      }
      return;
    }
    if (current.revision > journal.nextRevision) {
      await this.#removeVerifiedTransaction(projectId, transactionId, journal);
      this.#recordRecovery({ projectId, transactionId, outcome: 'committed' }); return;
    }
    recoveryRequired(`현재 revision이 Transaction journal과 다릅니다. projectId=${projectId}, current=${current.revision}, expected=${journal.expectedRevision}, next=${journal.nextRevision}`);
  }

  async #projectIdForDirectory(directoryName: string, lock: RecoveryLock | null, transactionNames: readonly string[]): Promise<string> {
    const currentPath: string = this.#fs.path(directoryName, 'project.json');
    if (await this.#fs.kind(currentPath) === 'file') return (await this.#readProjectFile(currentPath)).projectId;
    if (lock !== null) return lock.metadata.projectId;
    const ids: Set<string> = new Set<string>();
    for (const transactionId of transactionNames) {
      const path: string = this.#fs.path(directoryName, TRANSACTIONS_DIRECTORY, transactionId, TRANSACTION_JOURNAL);
      if (await this.#fs.kind(path) !== 'file') continue;
      try { ids.add(TransactionJournalSchema.parse(JSON.parse(await this.#fs.readText(path)) as unknown).projectId); }
      catch (error: unknown) { recoveryRequired(`현재 Project와 journal을 해석할 수 없습니다. directory=${directoryName}, transactionId=${transactionId}`); }
    }
    if (ids.size !== 1) recoveryRequired(`저장 디렉터리의 Project ID를 결정할 수 없습니다. directory=${directoryName}`);
    const projectId: string | undefined = [...ids][0];
    if (projectId === undefined) recoveryRequired(`저장 디렉터리의 Project ID가 없습니다. directory=${directoryName}`);
    return projectId;
  }

  async #recoverProjectDirectory(directoryName: string): Promise<string> {
    const directory: string = this.#fs.path(directoryName);
    await this.#fs.requireDirectory(directory);
    const transactionsPath: string = join(directory, TRANSACTIONS_DIRECTORY);
    await this.#fs.ensureDirectory(transactionsPath);
    const entries = await this.#fs.entries(transactionsPath);
    if (entries.some((entry): boolean => !entry.isDirectory())) recoveryRequired(`Transaction 목록에 디렉터리가 아닌 항목이 있습니다. directory=${directoryName}`);
    const transactionNames: string[] = entries.map((entry): string => entry.name).sort();
    let lock: RecoveryLock | null = await this.#readRecoveryLock(directoryName);
    const projectId: string = await this.#projectIdForDirectory(directoryName, lock, transactionNames);
    if (projectKey(projectId) !== directoryName) recoveryRequired(`Project ID와 저장 디렉터리가 다릅니다. projectId=${projectId}, directory=${directoryName}`);
    if (lock !== null && await this.#ownerIsActive(lock)) {
      this.#rememberActiveUpdate(lock);
      await this.#readConsistentCurrentUnderLock(projectId, lock);
      return projectId;
    }
    for (const transactionId of transactionNames) await this.#recoverTransaction(projectId, transactionId, lock);
    if (await this.#fs.kind(this.#currentPath(projectId)) !== 'file') recoveryRequired(`복구 후에도 현재 Project가 없습니다. projectId=${projectId}`);
    if (lock === null) {
      lock = await this.#readRecoveryLock(directoryName);
      if (lock !== null && await this.#ownerIsActive(lock)) {
        this.#rememberActiveUpdate(lock);
        await this.#readConsistentCurrentUnderLock(projectId, lock);
        return projectId;
      }
    }
    if (lock !== null) {
      await this.#removeRecoveryLock(lock);
      this.#activeUpdates.delete(directoryName);
      this.#recordRecovery({ projectId, transactionId: lock.metadata.transactionId, outcome: 'stale-lock-removed' });
    }
    await this.#verifyCurrentSnapshot(projectId);
    return projectId;
  }

  async #verifyCurrentSnapshotEntries(projectId: string, allowed: ReadonlySet<string>): Promise<Project> {
    const directory: string = this.#directory(projectId);
    await this.#fs.requireDirectory(directory);
    const unknown: string[] = (await this.#fs.entries(directory)).filter((entry): boolean => !allowed.has(entry.name)).map((entry): string => entry.name);
    if (unknown.length > 0) recoveryRequired(`Project 디렉터리에 알 수 없는 항목이 있습니다. projectId=${projectId}, entries=${unknown.join(',')}`);
    await this.#fs.requireDirectory(this.#versionsPath(projectId));
    await this.#fs.requireDirectory(join(directory, 'assets'));
    await this.#fs.requireDirectory(this.#transactionsPath(projectId));
    if ((await this.#fs.entries(this.#transactionsPath(projectId))).length > 0) recoveryRequired(`Project 디렉터리에 미해결 Transaction이 있습니다. projectId=${projectId}`);
    if (await this.#fs.kind(this.#versionPath(projectId, 0)) !== 'file') recoveryRequired(`Initial revision snapshot이 없습니다. projectId=${projectId}`);
    const current: Project = await this.#readProjectFile(this.#currentPath(projectId));
    const snapshot: Project = await this.#readProjectFile(this.#versionPath(projectId, current.revision));
    if (current.projectId !== projectId || snapshot.projectId !== projectId || snapshot.revision !== current.revision
      || exportProjectJson(snapshot) !== exportProjectJson(current)) recoveryRequired(`현재 Project와 revision snapshot이 다릅니다. projectId=${projectId}, revision=${current.revision}`);
    return current;
  }

  async #verifyCurrentSnapshot(projectId: string): Promise<Project> {
    return this.#verifyCurrentSnapshotEntries(projectId, new Set<string>(['project.json', 'versions', 'assets', TRANSACTIONS_DIRECTORY]));
  }

  async #readConsistentCurrentUnderLock(projectId: string, lock: RecoveryLock): Promise<Project> {
    await this.#verifyOwnedLock(lock);
    const current: Project = await this.#readProjectFile(this.#currentPath(projectId));
    const versionPath: string = this.#versionPath(projectId, current.revision);
    if (await this.#fs.kind(versionPath) !== 'file') throw contractError('PROJECT_BUSY',
      `${projectId}: Live Update 중 Current revision snapshot이 아직 완전하지 않습니다. revision=${current.revision}`, []);
    const version: Project = await this.#readProjectFile(versionPath);
    if (version.projectId !== projectId || version.revision !== current.revision || exportProjectJson(version) !== exportProjectJson(current)) {
      throw contractError('PROJECT_BUSY', `${projectId}: Live Update 중 Current와 revision snapshot이 일치하지 않습니다.`, []);
    }
    return current;
  }

  async #verifyCurrentSnapshotUnderLock(projectId: string, lock: RecoveryLock): Promise<Project> {
    await this.#verifyOwnedLock(lock);
    return this.#verifyCurrentSnapshotEntries(projectId, new Set<string>(['project.json', 'versions', 'assets', TRANSACTIONS_DIRECTORY, 'write.lock']));
  }

  async #verifyCompleteProjectDirectory(projectId: string): Promise<Project> {
    const current: Project = await this.#verifyCurrentSnapshot(projectId);
    await this.#verifyProjectAssetFiles(projectId);
    return current;
  }

  async #verifyCompleteProjectDirectoryUnderLock(projectId: string, lock: RecoveryLock, requireAssetFree: boolean): Promise<Project> {
    const current: Project = await this.#verifyCurrentSnapshotUnderLock(projectId, lock);
    await this.#verifyProjectAssetFiles(projectId);
    if (requireAssetFree) assertAssetFreeInitialProject(current);
    await this.#verifyOwnedLock(lock);
    return current;
  }

  async #verifyProjectAssetFiles(projectId: string): Promise<void> {
    const versions: Project[] = await this.#versionProjects(projectId, null);
    for (const project of versions) for (const asset of project.assets) {
      const path: string = this.#safeAssetPath(projectId, asset);
      await this.#requireFileProof(path, asset.sha256, `Project Asset 완전성 검증 projectId=${projectId}, assetId=${asset.id}`);
      await verifyStoredAsset(project, asset, await this.#fs.read(path));
    }
  }

  async #readCreateStagingLock(transactionId: string, journal: CreateJournal): Promise<RecoveryLock | null> {
    const path: string = join(this.#createTransactionPath(transactionId), CREATE_STAGED_PROJECT_DIRECTORY, 'write.lock');
    if (await this.#fs.kind(path) === 'missing') return null;
    let metadata: StoreLock;
    try { metadata = StoreLockSchema.parse(JSON.parse(await this.#fs.readText(path)) as unknown); }
    catch (error: unknown) { recoveryRequired(`Create staging lock을 해석할 수 없습니다. transactionId=${transactionId}, cause=${error instanceof Error ? error.message : String(error)}`); }
    if (metadata.projectId !== journal.projectId || metadata.transactionId !== journal.transactionId
      || metadata.host !== journal.owner.host || metadata.pid !== journal.owner.pid) {
      recoveryRequired(`Create staging lock과 journal 소유권이 다릅니다. projectId=${journal.projectId}, transactionId=${transactionId}`);
    }
    return { metadata, path, identity: await this.#fs.identity(path) };
  }

  async #verifyCreateStaging(transactionId: string, journal: CreateJournal): Promise<void> {
    const transactionPath: string = this.#createTransactionPath(transactionId);
    const entries = await this.#fs.entries(transactionPath);
    const allowedRoot: Set<string> = new Set<string>([TRANSACTION_JOURNAL, TRANSACTION_PHASE_JOURNAL, CREATE_STAGED_PROJECT_DIRECTORY]);
    const unknownRoot: string[] = entries.filter((entry): boolean => !allowedRoot.has(entry.name)).map((entry): string => entry.name);
    if (unknownRoot.length > 0) recoveryRequired(`Create staging에 증명되지 않은 항목이 있습니다. transactionId=${transactionId}, entries=${unknownRoot.join(',')}`);
    const stagedProject: string = join(transactionPath, CREATE_STAGED_PROJECT_DIRECTORY);
    if (await this.#fs.kind(stagedProject) === 'missing') return;
    await this.#fs.requireDirectory(stagedProject);
    const unknown: string[] = (await this.#fs.entries(stagedProject)).filter((entry): boolean => !['project.json', 'versions', 'assets', TRANSACTIONS_DIRECTORY, 'write.lock'].includes(entry.name)).map((entry): string => entry.name);
    if (unknown.length > 0) recoveryRequired(`Create Project staging에 증명되지 않은 항목이 있습니다. transactionId=${transactionId}, entries=${unknown.join(',')}`);
    const currentProof: NormalizedFileProof = journal.version === 3 ? journal.currentFile
      : { stagedRelativePath: `project/${journal.currentFile.relativePath}`, finalRelativePath: journal.currentFile.relativePath, sha256: journal.currentFile.sha256 };
    const versionProof: NormalizedFileProof = journal.version === 3 ? journal.versionFile
      : { stagedRelativePath: `project/${journal.versionFile.relativePath}`, finalRelativePath: journal.versionFile.relativePath, sha256: journal.versionFile.sha256 };
    for (const proof of [currentProof, versionProof]) {
      const path: string = join(transactionPath, proof.stagedRelativePath);
      if (await this.#fs.kind(path) === 'file') await this.#requireFileProof(path, proof.sha256, `Create staging 증명 transactionId=${transactionId}`);
    }
    await this.#readCreateStagingLock(transactionId, journal);
  }

  async #verifyCompleteCreateStagingUnderLock(transactionId: string, journal: CreateJournalV3, lock: RecoveryLock): Promise<void> {
    await this.#verifyCreateStaging(transactionId, journal);
    await this.#verifyOwnedLock(lock);
    const stagedProject: string = join(this.#createTransactionPath(transactionId), CREATE_STAGED_PROJECT_DIRECTORY);
    await this.#fs.requireDirectory(join(stagedProject, 'versions'));
    await this.#fs.requireDirectory(join(stagedProject, 'assets'));
    await this.#fs.requireDirectory(join(stagedProject, TRANSACTIONS_DIRECTORY));
    const versionEntries: string[] = (await this.#fs.entries(join(stagedProject, 'versions'))).map((entry): string => entry.name);
    if (versionEntries.length !== 1 || versionEntries[0] !== transactionVersionFileName(0)) {
      recoveryRequired(`Create staging의 Initial revision 구성이 다릅니다. projectId=${journal.projectId}, entries=${versionEntries.join(',')}`);
    }
    if ((await this.#fs.entries(join(stagedProject, 'assets'))).length !== 0
      || (await this.#fs.entries(join(stagedProject, TRANSACTIONS_DIRECTORY))).length !== 0) {
      recoveryRequired(`Asset-free Create staging의 관리 디렉터리가 비어 있지 않습니다. projectId=${journal.projectId}`);
    }
    const current: Project = await this.#readProjectFile(join(stagedProject, 'project.json'));
    const versionZero: Project = await this.#readProjectFile(join(stagedProject, 'versions', transactionVersionFileName(0)));
    if (current.projectId !== journal.projectId || current.revision !== 0 || exportProjectJson(current) !== exportProjectJson(versionZero)) {
      recoveryRequired(`Create staging의 Current와 Version 0이 일치하지 않습니다. projectId=${journal.projectId}`);
    }
    assertAssetFreeInitialProject(current);
    await this.#verifyOwnedLock(lock);
  }

  async #removeCreateTransaction(transactionId: string, journal: CreateJournal): Promise<void> {
    await this.#verifyCreateStaging(transactionId, journal);
    const stagedLock: RecoveryLock | null = await this.#readCreateStagingLock(transactionId, journal);
    if (stagedLock !== null) await this.#removeRecoveryLock(stagedLock);
    await this.#fs.removeTree(this.#createTransactionPath(transactionId));
    await this.#fs.syncDirectory(this.#createTransactionsPath());
  }

  async #readCreateJournal(transactionId: string): Promise<CreateJournal> {
    const transactionPath: string = this.#createTransactionPath(transactionId);
    const phasePath: string = join(transactionPath, TRANSACTION_PHASE_JOURNAL);
    const journalPath: string = join(transactionPath, TRANSACTION_JOURNAL);
    if (await this.#fs.kind(phasePath) === 'file') {
      const staged: CreateJournal = CreateJournalSchema.parse(JSON.parse(await this.#fs.readText(phasePath)) as unknown);
      if (staged.version !== 3 || staged.transactionId !== transactionId) recoveryRequired(`Create phase journal 식별자가 다릅니다. transactionId=${transactionId}`);
      await this.#fs.replaceFile(phasePath, journalPath); await this.#fs.syncDirectory(transactionPath);
    }
    try { return CreateJournalSchema.parse(JSON.parse(await this.#fs.readText(journalPath)) as unknown); }
    catch (error: unknown) { recoveryRequired(`Create journal을 검증할 수 없습니다. transactionId=${transactionId}, cause=${error instanceof Error ? error.message : String(error)}`); }
  }

  async #recoverCreateTransaction(transactionId: string): Promise<string | null> {
    const transactionPath: string = this.#createTransactionPath(transactionId);
    if (await this.#fs.kind(transactionPath) === 'missing') return null;
    if (await this.#fs.kind(join(transactionPath, TRANSACTION_JOURNAL)) === 'missing'
      && await this.#fs.kind(join(transactionPath, TRANSACTION_PHASE_JOURNAL)) === 'missing') {
      if ((await this.#fs.entries(transactionPath)).length !== 0) recoveryRequired(`journal 없는 Create staging을 삭제할 수 없습니다. transactionId=${transactionId}`);
      await this.#fs.removeEmptyDirectory(transactionPath); await this.#fs.syncDirectory(this.#createTransactionsPath()); return null;
    }
    const journal: CreateJournal = await this.#readCreateJournal(transactionId);
    if (journal.transactionId !== transactionId || journal.owner.transactionId !== transactionId
      || journal.projectDirectoryName !== projectKey(journal.projectId)) recoveryRequired(`Create journal 식별자가 다릅니다. transactionId=${transactionId}`);
    const currentFinal: string = journal.version === 3 ? journal.currentFile.finalRelativePath : journal.currentFile.relativePath;
    const versionFinal: string = journal.version === 3 ? journal.versionFile.finalRelativePath : journal.versionFile.relativePath;
    if (currentFinal !== 'project.json' || versionFinal !== `versions/${transactionVersionFileName(0)}`) recoveryRequired(`Create journal 경로가 다릅니다. transactionId=${transactionId}`);
    if (journal.owner.host !== hostname()) recoveryRequired(`다른 Host의 Create transaction을 자동 복구할 수 없습니다. transactionId=${transactionId}`);
    const finalDirectory: string = this.#directory(journal.projectId);
    const finalExists: boolean = await this.#fs.kind(finalDirectory) !== 'missing';
    if (journal.version === 3 && finalExists) {
      const lock: RecoveryLock | null = await this.#readRecoveryLock(journal.projectDirectoryName);
      if (lock === null) {
        if (journal.phase === 'published' || journal.phase === 'verified') {
          createRecoveryRequired(`게시된 Initial Project의 create lock이 없습니다. projectId=${journal.projectId}`, 'missing write.lock');
        }
        let final: Project;
        try { final = await this.#verifyCompleteProjectDirectory(journal.projectId); }
        catch (error: unknown) { createRecoveryRequired(`동시에 게시된 Initial Project를 완전한 저장소로 증명할 수 없습니다. projectId=${journal.projectId}`, error); }
        await this.#removeCreateTransaction(transactionId, journal);
        this.#recordRecovery({ projectId: journal.projectId, transactionId, outcome: sha256Text(exportProjectJson(final)) === journal.currentFile.sha256 ? 'create-committed' : 'create-superseded' });
        return journal.projectId;
      }
      if (lock.metadata.transactionId !== journal.transactionId || lock.metadata.projectId !== journal.projectId
        || lock.metadata.host !== journal.owner.host || lock.metadata.pid !== journal.owner.pid) {
        createRecoveryRequired(`게시된 Initial Project의 create lock과 journal 소유권이 다릅니다. projectId=${journal.projectId}`, 'lock owner mismatch');
      }
      if (await this.#ownerIsActive(lock)) throw contractError('PROJECT_BUSY', `${journal.projectId}: create transactionId=${transactionId}, pid=${journal.owner.pid} 작업이 진행 중입니다.`, []);
      let final: Project;
      try { final = await this.#verifyCompleteProjectDirectoryUnderLock(journal.projectId, lock, true); }
      catch (error: unknown) { createRecoveryRequired(`게시된 Initial Project를 create lock 아래 완전한 저장소로 증명할 수 없습니다. projectId=${journal.projectId}`, error); }
      if (sha256Text(exportProjectJson(final)) !== journal.currentFile.sha256) {
        createRecoveryRequired(`게시된 Initial Project가 create journal 내용과 다릅니다. projectId=${journal.projectId}`, 'project hash mismatch');
      }
      await this.#removeCreateTransaction(transactionId, journal);
      await this.#removeRecoveryLock(lock);
      this.#recordRecovery({ projectId: journal.projectId, transactionId, outcome: 'create-committed' });
      return journal.projectId;
    }
    const stagingLock: RecoveryLock | null = await this.#readCreateStagingLock(transactionId, journal);
    if (stagingLock !== null ? await this.#ownerIsActive(stagingLock) : this.#processProbe(journal.owner.pid)) {
      throw contractError('PROJECT_BUSY', `${journal.projectId}: create transactionId=${transactionId}, pid=${journal.owner.pid} 작업이 진행 중입니다.`, []);
    }
    await this.#verifyCreateStaging(transactionId, journal);
    let outcome: StorageRecoveryEvent['outcome'] = 'create-rolled-back';
    if (finalExists) {
      let final: Project;
      try { final = await this.#verifyCompleteProjectDirectory(journal.projectId); }
      catch (error: unknown) { createRecoveryRequired(`게시된 Initial Project를 완전한 저장소로 증명할 수 없습니다. projectId=${journal.projectId}`, error); }
      const finalHash: string = sha256Text(exportProjectJson(final));
      const journalHash: string = journal.version === 3 ? journal.currentFile.sha256 : journal.currentFile.sha256;
      outcome = finalHash === journalHash ? 'create-committed' : 'create-superseded';
    }
    await this.#removeCreateTransaction(transactionId, journal);
    this.#recordRecovery({ projectId: journal.projectId, transactionId, outcome });
    return journal.projectId;
  }

  async #recoverRootCreateLock(lock: RecoveryLock): Promise<void> {
    const { projectId, transactionId } = lock.metadata;
    const matchingPath: string = this.#createTransactionPath(transactionId);
    const matchingExists: boolean = await this.#fs.kind(matchingPath) === 'directory';
    let matchingJournal: CreateJournal | undefined;
    if (matchingExists) {
      const hasJournal: boolean = await this.#fs.kind(join(matchingPath, TRANSACTION_JOURNAL)) === 'file'
        || await this.#fs.kind(join(matchingPath, TRANSACTION_PHASE_JOURNAL)) === 'file';
      if (!hasJournal) {
        if ((await this.#fs.entries(matchingPath)).length > 0) createRecoveryRequired(
          `Root Create lock과 같은 Transaction의 journal을 확인할 수 없습니다. projectId=${projectId}, transactionId=${transactionId}`, 'journal missing');
      } else {
        matchingJournal = await this.#readCreateJournal(transactionId);
        if (matchingJournal.projectId !== projectId) createRecoveryRequired(
          `Root Create lock과 Create journal의 Project ID가 다릅니다. projectId=${projectId}, transactionId=${transactionId}`, 'project mismatch');
      }
    }
    if (matchingJournal !== undefined) {
      if (matchingJournal.owner.host !== lock.metadata.host || matchingJournal.owner.pid !== lock.metadata.pid
        || matchingJournal.owner.transactionId !== lock.metadata.transactionId) {
        createRecoveryRequired(`Root Create lock과 Create journal 소유권이 다릅니다. projectId=${projectId}, transactionId=${transactionId}`, 'owner mismatch');
      }
      await this.#recoverCreateTransaction(transactionId);
    } else {
      const finalKind: SafePathKind = await this.#fs.kind(this.#directory(projectId));
      if (finalKind === 'directory') {
        const finalLock: RecoveryLock | null = await this.#readRecoveryLock(projectKey(projectId));
        if (finalLock === null) await this.#verifyCompleteProjectDirectory(projectId);
        else {
          if (finalLock.metadata.projectId !== lock.metadata.projectId || finalLock.metadata.transactionId !== lock.metadata.transactionId
            || finalLock.metadata.host !== lock.metadata.host || finalLock.metadata.pid !== lock.metadata.pid) {
            createRecoveryRequired(`Root Create lock과 Final lock 소유권이 다릅니다. projectId=${projectId}, transactionId=${transactionId}`, 'final lock mismatch');
          }
          await this.#verifyCompleteProjectDirectoryUnderLock(projectId, finalLock, true);
          await this.#removeRecoveryLock(finalLock);
        }
      }
      else if (finalKind !== 'missing') createRecoveryRequired(`Root Create lock의 Final 경로가 디렉터리가 아닙니다. projectId=${projectId}`, `kind=${finalKind}`);
    }
    await this.#verifyOwnedLock(lock);
    await this.#removeRecoveryLock(lock);
    this.#activeCreates.delete(projectKey(projectId));
    this.#recordRecovery({ projectId, transactionId, outcome: 'root-create-lock-removed' });
  }

  async #refreshActiveCreate(projectId: string): Promise<boolean> {
    const directoryName: string = projectKey(projectId);
    const lock: RecoveryLock | null = await this.#rootCreateLock(projectId);
    if (lock === null) {
      const active: ActiveCreateState | undefined = this.#activeCreates.get(directoryName);
      if (active !== undefined) {
        const transactionPath: string = this.#createTransactionPath(active.transactionId);
        if (await this.#fs.kind(transactionPath) === 'directory' && active.host === hostname() && this.#processProbe(active.pid)) return true;
        const finalLock: RecoveryLock | null = await this.#readRecoveryLock(directoryName);
        if (finalLock !== null && finalLock.metadata.host === hostname() && await this.#ownerIsActive(finalLock)) return true;
      }
      this.#activeCreates.delete(directoryName);
      return false;
    }
    if (lock.metadata.host !== hostname()) {
      throw contractError('STORE_CREATE_RECOVERY_REQUIRED', `다른 Host의 Root Create lock은 자동 복구할 수 없습니다. projectId=${projectId}`, []);
    }
    if (await this.#ownerIsActive(lock)) { this.#rememberActiveCreate(lock); return true; }
    await this.#recoverRootCreateLock(lock);
    await this.#clearRecoveryBlock(directoryName);
    return false;
  }

  async #refreshActiveUpdate(projectId: string): Promise<boolean> {
    const directoryName: string = projectKey(projectId);
    const lock: RecoveryLock | null = await this.#readRecoveryLock(directoryName);
    if (lock === null) {
      this.#activeUpdates.delete(directoryName);
      return false;
    }
    try {
      if (await this.#ownerIsActive(lock)) {
        this.#rememberActiveUpdate(lock);
        return true;
      }
      await this.#recoverProjectDirectory(directoryName);
      await this.#clearRecoveryBlock(directoryName);
      this.#activeUpdates.delete(directoryName);
      return false;
    } catch (error: unknown) {
      if (errorCode(error) === 'PROJECT_BUSY') {
        this.#rememberActiveUpdate(lock);
        return true;
      }
      await this.#writeRecoveryBlock(directoryName, projectId, lock.metadata.transactionId, error);
      throw error;
    }
  }

  async #writeRecoveryBlock(directoryName: string, projectId: string, transactionId: string, error: unknown): Promise<void> {
    const block: StorageRecoveryBlock = StorageRecoveryBlockSchema.parse({ version: 1, projectId, directoryName, transactionId,
      code: errorCode(error), message: error instanceof Error ? error.message : String(error), detectedAt: this.#nowIso() });
    const path: string = this.#recoveryBlockPath(directoryName);
    if (await this.#fs.kind(path) === 'file') await this.#writeReplacement(path, JSON.stringify(block), randomUUID());
    else await this.#fs.writeExclusive(path, JSON.stringify(block));
    await this.#fs.syncDirectory(this.#recoveryBlocksPath());
    this.#recoveryBlocks.set(directoryName, block);
    console.warn(JSON.stringify({ event: 'project-store-recovery-blocked', ...block }));
  }

  async #clearRecoveryBlock(directoryName: string): Promise<void> {
    const path: string = this.#recoveryBlockPath(directoryName);
    if (await this.#fs.kind(path) === 'file') { await this.#fs.unlinkFile(path); await this.#fs.syncDirectory(this.#recoveryBlocksPath()); }
    this.#recoveryBlocks.delete(directoryName);
  }

  async #loadRecoveryBlocks(): Promise<void> {
    this.#recoveryBlocks.clear();
    for (const entry of await this.#fs.entries(this.#recoveryBlocksPath())) {
      if (!entry.isFile() || !/^[a-f0-9]{64}\.json$/.test(entry.name)) recoveryRequired(`복구 차단 저장소에 올바르지 않은 항목이 있습니다. entry=${entry.name}`);
      const block: StorageRecoveryBlock = StorageRecoveryBlockSchema.parse(JSON.parse(await this.#fs.readText(join(this.#recoveryBlocksPath(), entry.name))) as unknown);
      if (`${block.directoryName}.json` !== entry.name) recoveryRequired(`복구 차단 파일 이름과 내용이 다릅니다. entry=${entry.name}`);
      this.#recoveryBlocks.set(block.directoryName, block);
    }
  }

  async #initialize(): Promise<void> {
    await this.#fs.initialize();
    await this.#fs.ensureDirectory(this.#createTransactionsPath());
    await this.#fs.ensureDirectory(this.#createLocksPath());
    await this.#fs.ensureDirectory(this.#recoveryBlocksPath());
    await this.#fs.ensureDirectory(this.#processInstancesPath());
    await this.#registerProcessInstance();
    await this.#loadRecoveryBlocks();
    const blockedDuringInitialization: Set<string> = new Set<string>();
    this.#activeCreates.clear();
    this.#activeUpdates.clear();
    for (const entry of await this.#fs.entries(this.#createLocksPath())) {
      const fileKey: string = /^[a-f0-9]{64}\.lock$/.test(entry.name) ? entry.name.slice(0, -5) : projectKey(`unknown:${entry.name}`);
      let lock: RecoveryLock | null = null;
      try {
        lock = await this.#readRootCreateLock(entry.name);
        if (lock === null) continue;
        const directoryName: string = projectKey(lock.metadata.projectId);
        if (lock.metadata.host !== hostname()) {
          const error = contractError('STORE_CREATE_RECOVERY_REQUIRED',
            `다른 Host의 Root Create lock은 자동 삭제할 수 없습니다. projectId=${lock.metadata.projectId}, host=${lock.metadata.host}`, []);
          await this.#writeRecoveryBlock(directoryName, lock.metadata.projectId, lock.metadata.transactionId, error);
          blockedDuringInitialization.add(directoryName);
          continue;
        }
        if (await this.#ownerIsActive(lock)) {
          this.#rememberActiveCreate(lock);
          blockedDuringInitialization.add(directoryName);
          continue;
        }
        await this.#recoverRootCreateLock(lock);
        await this.#clearRecoveryBlock(directoryName);
      } catch (error: unknown) {
        const projectId: string = lock?.metadata.projectId ?? `unknown:${fileKey}`;
        const transactionId: string = lock?.metadata.transactionId ?? 'root-create-lock';
        await this.#writeRecoveryBlock(fileKey, projectId, transactionId, error);
        blockedDuringInitialization.add(fileKey);
      }
    }
    for (const entry of await this.#fs.entries(this.#createTransactionsPath())) {
      if (!entry.isDirectory()) recoveryRequired(`Create transaction 목록에 디렉터리가 아닌 항목이 있습니다. entry=${entry.name}`);
      if (await this.#fs.kind(this.#createTransactionPath(entry.name)) === 'missing') continue;
      try {
        const journalPath: string = join(this.#createTransactionPath(entry.name), TRANSACTION_JOURNAL);
        const phasePath: string = join(this.#createTransactionPath(entry.name), TRANSACTION_PHASE_JOURNAL);
        if (await this.#fs.kind(journalPath) === 'file' || await this.#fs.kind(phasePath) === 'file') {
          const preview: CreateJournal = await this.#readCreateJournal(entry.name);
          if (blockedDuringInitialization.has(projectKey(preview.projectId))) continue;
        }
        const projectId: string | null = await this.#recoverCreateTransaction(entry.name);
        if (projectId !== null) await this.#clearRecoveryBlock(projectKey(projectId));
      } catch (error: unknown) {
        let projectId: string = `unknown:${entry.name}`;
        let journal: CreateJournal | null = null;
        try { journal = await this.#readCreateJournal(entry.name); projectId = journal.projectId; }
        catch (journalError: unknown) {
          if (errorCode(error) === 'PROJECT_BUSY') throw journalError;
        }
        const directoryName: string = projectKey(projectId);
        if (errorCode(error) === 'PROJECT_BUSY' && journal !== null) {
          this.#activeCreates.set(directoryName, { projectId, transactionId: journal.transactionId, host: journal.owner.host,
            pid: journal.owner.pid, processInstanceId: null, detectedAt: this.#nowIso() });
          blockedDuringInitialization.add(directoryName);
          continue;
        }
        await this.#writeRecoveryBlock(directoryName, projectId, entry.name, error);
        blockedDuringInitialization.add(directoryName);
      }
    }
    for (const entry of await this.#fs.entries(this.#fs.root())) {
      if ([CREATE_TRANSACTIONS_DIRECTORY, CREATE_LOCKS_DIRECTORY, RECOVERY_BLOCKS_DIRECTORY, PROCESS_INSTANCES_DIRECTORY].includes(entry.name)) continue;
      if (blockedDuringInitialization.has(entry.name)) continue;
      if (!entry.isDirectory()) {
        if (/^[a-f0-9]{64}$/.test(entry.name)) await this.#writeRecoveryBlock(entry.name, `unknown:${entry.name}`, 'directory', contractError('STORE_PATH_UNSAFE', 'Project 저장 경로가 디렉터리가 아닙니다.', []));
        continue;
      }
      let projectId: string | null = null;
      try {
        projectId = await this.#recoverProjectDirectory(entry.name);
        await this.#clearRecoveryBlock(entry.name);
      } catch (error: unknown) {
        if (projectId === null) {
          try { projectId = (await this.#readProjectFile(this.#fs.path(entry.name, 'project.json'))).projectId; } catch { projectId = `unknown:${entry.name}`; }
        }
        if (errorCode(error) === 'PROJECT_BUSY' && this.#activeUpdates.has(entry.name)) continue;
        await this.#writeRecoveryBlock(entry.name, projectId, 'recovery', error);
      }
    }
  }

  async #assertProjectCanAttemptMutation(projectId: string): Promise<void> {
    const directoryName: string = projectKey(projectId);
    const block: StorageRecoveryBlock | undefined = this.#recoveryBlocks.get(directoryName);
    if (block !== undefined || await this.#fs.kind(this.#recoveryBlockPath(directoryName)) !== 'missing') {
      throw contractError('STORE_RECOVERY_BLOCKED', `${projectId}: 저장 복구가 완료될 때까지 변경할 수 없습니다. cause=${block?.code ?? 'recovery marker'}`, []);
    }
    if (await this.#refreshActiveCreate(projectId)) throw contractError('PROJECT_BUSY', `${projectId}: Initial Create 저장 작업이 진행 중입니다.`, []);
    if (await this.#fs.kind(this.#directory(projectId)) === 'missing') throw contractError('PROJECT_NOT_FOUND', `저장된 프로젝트를 찾을 수 없습니다: ${projectId}`, []);
    if (await this.#refreshActiveUpdate(projectId)) throw contractError('PROJECT_BUSY', `${projectId}: 다른 저장 작업이 진행 중입니다.`, []);
  }

  async #assertCreateTargetAvailable(projectId: string): Promise<void> {
    const directory: string = this.#directory(projectId);
    if (await this.#fs.kind(directory) === 'missing') return;
    if (await this.#fs.kind(join(directory, 'write.lock')) === 'file') {
      throw contractError('PROJECT_BUSY', `${projectId}: Initial Create 저장 작업이 진행 중입니다.`, []);
    }
    await this.#verifyCompleteProjectDirectory(projectId);
    throw contractError('PROJECT_ALREADY_EXISTS', `같은 프로젝트 ID가 이미 저장되어 있습니다: ${projectId}`, []);
  }

  async #verifyMutationReadyUnderLock(projectId: string, lock: RecoveryLock): Promise<Project> {
    const directoryName: string = projectKey(projectId);
    if (this.#recoveryBlocks.has(directoryName) || await this.#fs.kind(this.#recoveryBlockPath(directoryName)) !== 'missing') {
      throw contractError('STORE_RECOVERY_BLOCKED', `${projectId}: 저장 복구가 완료될 때까지 변경할 수 없습니다.`, []);
    }
    return this.#verifyCurrentSnapshotUnderLock(projectId, lock);
  }

  async #preflightAssetWrites(projectId: string, next: Project, transition: AssetCatalogTransition): Promise<StagedAsset[]> {
    const result: StagedAsset[] = [];
    for (const [index, metadata] of transition.newAssets.entries()) {
      const assetWrite: AssetWrite | undefined = transition.writesByAssetId.get(metadata.id);
      if (assetWrite === undefined) throw contractError('ASSET_WRITE_COUNT_MISMATCH', `새 Asset metadata에 대응하는 AssetWrite가 없습니다. assetId=${metadata.id}`, []);
      if (sha256Bytes(assetWrite.content) !== metadata.sha256) throw contractError('ASSET_WRITE_HASH_MISMATCH', `AssetWrite 해시가 metadata와 다릅니다. assetId=${metadata.id}`, []);
      await verifyStoredAsset(next, metadata, assetWrite.content);
      const finalPath: string = this.#safeAssetPath(projectId, metadata);
      if (await this.#fs.kind(dirname(finalPath)) === 'missing') throw contractError('ASSET_PARENT_DIRECTORY_MISSING', `Asset 저장 상위 디렉터리가 없습니다. assetId=${metadata.id}, path=${metadata.path}`, []);
      await this.#fs.requireDirectory(dirname(finalPath));
      if (await this.#fs.kind(finalPath) !== 'missing') throw contractError('ASSET_FILE_EXISTS', `새 자산 경로가 이미 존재합니다. path=${finalPath}`, []);
      const stagedRelativePath: string = `asset-${index}.bin`;
      result.push({ stagedRelativePath, finalPath, content: assetWrite.content,
        proof: { assetId: metadata.id, stagedRelativePath, finalRelativePath: metadata.path, sha256: metadata.sha256 } });
    }
    return result;
  }

  async #recheckCurrentBeforeJournal(projectId: string, lock: RecoveryLock, currentRevision: number,
    currentSha256: string, committedVersion: string, stagedAssets: readonly StagedAsset[]): Promise<void> {
    await this.#verifyOwnedLock(lock);
    const currentPath: string = this.#currentPath(projectId);
    if (await this.#fs.kind(currentPath) !== 'file') throw contractError('STORE_CONCURRENT_MODIFICATION', `Journal 생성 전 Current Project가 사라졌습니다. projectId=${projectId}`, []);
    const currentContent: string = await this.#fs.readText(currentPath);
    let current: Project;
    try { current = parseProject(JSON.parse(currentContent) as unknown); }
    catch (error: unknown) { throw contractError('STORE_CONCURRENT_MODIFICATION', `Journal 생성 전 Current Project를 해석할 수 없습니다. projectId=${projectId}, cause=${error instanceof Error ? error.message : String(error)}`, []); }
    const actualSha256: string = sha256Text(currentContent);
    if (current.revision !== currentRevision || actualSha256 !== currentSha256) {
      throw contractError('STORE_CONCURRENT_MODIFICATION', `Journal 생성 전 Current Project가 변경됐습니다. projectId=${projectId}, expectedRevision=${currentRevision}, actualRevision=${current.revision}, expectedSha256=${currentSha256}, actualSha256=${actualSha256}`, []);
    }
    if (await this.#fs.kind(committedVersion) !== 'missing') throw contractError('STORE_CONCURRENT_MODIFICATION', `Journal 생성 전 다음 revision 경로가 생겼습니다. projectId=${projectId}, path=${committedVersion}`, []);
    for (const staged of stagedAssets) if (await this.#fs.kind(staged.finalPath) !== 'missing') {
      throw contractError('STORE_CONCURRENT_MODIFICATION', `Journal 생성 전 신규 Asset 경로가 생겼습니다. projectId=${projectId}, path=${staged.finalPath}`, []);
    }
    if ((await this.#fs.entries(this.#transactionsPath(projectId))).length !== 0) {
      throw contractError('STORE_CONCURRENT_MODIFICATION', `Journal 생성 전 다른 Transaction이 발견됐습니다. projectId=${projectId}`, []);
    }
  }

  async #assetForProject(project: Project, assetId: string): Promise<StoredAsset> {
    const asset: Asset | undefined = project.assets.find((value: Asset): boolean => value.id === assetId);
    if (asset === undefined) throw contractError('ASSET_NOT_FOUND', `자산을 찾을 수 없습니다. assetId=${assetId}`, []);
    try {
      const content: Buffer = await this.#rawAssetContent(project, asset);
      await verifyStoredAsset(project, asset, content);
      return { content, mimeType: asset.mimeType, asset };
    } catch (error: unknown) {
      throw mapStoredAssetIntegrityError(error, project.projectId, asset.id);
    }
  }

  async #rawAssetContent(project: Project, asset: Asset): Promise<Buffer> {
    try {
      const path: string = this.#safeAssetPath(project.projectId, asset);
      if (await this.#fs.kind(path) === 'missing') throw contractError('ASSET_FILE_MISSING', `자산 파일이 없습니다. assetId=${asset.id}, path=${asset.path}`, []);
      const content: Buffer = await this.#fs.read(path);
      const actualHash: string = sha256Bytes(content);
      if (actualHash !== asset.sha256) throw contractError('ASSET_HASH_MISMATCH', `저장 파일 해시가 Asset metadata와 다릅니다. assetId=${asset.id}, expected=${asset.sha256}, actual=${actualHash}`, []);
      return content;
    } catch (error: unknown) {
      throw mapStoredAssetIntegrityError(error, project.projectId, asset.id);
    }
  }

  async #summary(project: Project, updatedAt: string): Promise<ProjectSummary> {
    let framesOutputSafe: number = 0;
    for (const frame of project.frames) {
      const decision = reviewFrameOutput(project, frame.id, 'program-monitor');
      if (!decision.renderBitmap || decision.imageAssetId === null) continue;
      try { await this.#assetForProject(project, decision.imageAssetId); framesOutputSafe += 1; }
      catch (error: unknown) { if (assetFailureCode(error) === null) throw error; }
    }
    let audioPlayable: number = 0;
    let audioRepairRequired: number = 0;
    for (const cue of project.audioCues) {
      const playable: boolean = reviewAudioPlaybackAt(project, cue.startMs).playable.some((candidate): boolean => candidate.id === cue.id);
      if (cue.assetId === null) continue;
      try { await this.#assetForProject(project, cue.assetId); if (playable) audioPlayable += 1; }
      catch (error: unknown) { const code: string | null = assetFailureCode(error); if (code === null) throw error; if (code.startsWith('AUDIO_ASSET_') || code.startsWith('STORED_AUDIO_')) audioRepairRequired += 1; }
    }
    const textPlayable: number = project.textCues.filter((cue): boolean => reviewTextPlaybackAt(project, cue.startMs).playable.some((candidate): boolean => candidate.id === cue.id)).length;
    const blockedOutputCount: number = project.frames.length - framesOutputSafe + project.audioCues.length - audioPlayable + project.textCues.length - textPlayable;
    return { projectId: project.projectId, title: project.title, revision: project.revision,
      durationMs: project.dataset.segments.at(-1)?.endMs ?? 0, shots: project.shots.length,
      frameRateNumerator: project.handoff.timebase.fpsNumerator,
      frameRateDenominator: project.handoff.timebase.fpsDenominator,
      dropFrame: project.handoff.timebase.dropFrame, startTimecode: project.handoff.timebase.startTimecode,
      sampleRate: project.handoff.timebase.sampleRate,
      framesWithAsset: project.frames.filter((frame): boolean => frame.imageAssetId !== null).length,
      framesAccepted: project.frames.filter((frame): boolean => frame.visualReview === 'accepted').length,
      framesOutputSafe, framesTotal: project.frames.length,
      audioWithAsset: project.audioCues.filter((cue): boolean => cue.assetId !== null).length,
      audioMeasured: project.audioCues.filter((cue): boolean => cue.timingStatus === 'measured').length,
      audioPlayable, audioRepairRequired, audioTotal: project.audioCues.length, textPlayable, textTotal: project.textCues.length,
      blockedOutputCount, issues: project.importIssues.length, updatedAt };
  }

  async initialize(): Promise<void> {
    if (this.#closed) throw contractError('STORE_CLOSED', '종료된 ProjectStore는 사용할 수 없습니다.', []);
    if (this.#initialization === null) this.#initialization = this.#initialize();
    const initialization: Promise<void> = this.#initialization;
    try { await initialization; }
    catch (error: unknown) {
      if (errorCode(error) === 'PROJECT_BUSY' && this.#initialization === initialization) this.#initialization = null;
      throw error;
    }
  }

  recoveryEvents(): readonly StorageRecoveryEvent[] { return [...this.#recoveryEvents]; }
  recoveryBlocks(): readonly StorageRecoveryBlock[] { return [...this.#recoveryBlocks.values()]; }
  activeCreates(): readonly ActiveCreateState[] { return [...this.#activeCreates.values()]; }
  activeUpdates(): readonly ActiveUpdateState[] { return [...this.#activeUpdates.values()]; }
  processInstanceId(): string { return this.#processInstanceId; }

  async heartbeat(): Promise<void> {
    await this.initialize();
    await this.#touchProcessInstance();
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    if (this.#processInstanceRegistered) {
      const root: string = this.#fs.root();
      const registrationKey: string = processRegistrationKey(root, this.#processInstanceId);
      const remaining: number = Math.max(0, (processInstanceRegistrations.get(registrationKey) ?? 1) - 1);
      if (remaining === 0) {
        processInstanceRegistrations.delete(registrationKey);
        const path: string = this.#processInstancePath(this.#processInstanceId);
        if (await this.#fs.kind(path) === 'file') {
          const record: ProcessInstanceRecord = ProcessInstanceRecordSchema.parse(JSON.parse(await this.#fs.readText(path)) as unknown);
          if (record.processInstanceId === this.#processInstanceId && record.host === hostname() && record.pid === process.pid
            && record.startedAt === this.#processStartedAt) {
            await this.#fs.unlinkFile(path);
            await this.#fs.syncDirectory(this.#processInstancesPath());
          }
        }
      } else {
        processInstanceRegistrations.set(registrationKey, remaining);
      }
      this.#processInstanceRegistered = false;
    }
    this.#closed = true;
  }

  async assertMutable(projectId: string): Promise<void> {
    await this.initialize();
    await this.#assertProjectCanAttemptMutation(projectId);
  }

  async list(): Promise<ProjectSummary[]> {
    await this.initialize();
    const summaries: ProjectSummary[] = [];
    for (const entry of await this.#fs.entries(this.#fs.root())) {
      if (!entry.isDirectory() || [CREATE_TRANSACTIONS_DIRECTORY, CREATE_LOCKS_DIRECTORY, RECOVERY_BLOCKS_DIRECTORY, PROCESS_INSTANCES_DIRECTORY].includes(entry.name)) continue;
      const path: string = this.#fs.path(entry.name, 'project.json');
      if (await this.#fs.kind(path) !== 'file') continue;
      const project: Project = await this.#readProjectFile(path);
      const metadata = await stat(path);
      summaries.push(await this.#summary(project, metadata.mtime.toISOString()));
    }
    return summaries.sort((left: ProjectSummary, right: ProjectSummary): number => right.updatedAt.localeCompare(left.updatedAt));
  }

  async read(projectId: string): Promise<Project> {
    await this.initialize();
    if (await this.#fs.kind(this.#currentPath(projectId)) !== 'file') throw contractError('PROJECT_NOT_FOUND', `저장된 프로젝트를 찾을 수 없습니다: ${projectId}`, []);
    if (await this.#refreshActiveUpdate(projectId)) {
      const lock: RecoveryLock | null = await this.#readRecoveryLock(projectKey(projectId));
      if (lock === null) throw contractError('PROJECT_BUSY', `${projectId}: Live Update lock 상태가 변경됐습니다.`, []);
      return this.#readConsistentCurrentUnderLock(projectId, lock);
    }
    return this.#readProjectFile(this.#currentPath(projectId));
  }

  async generationRecordAudit(projectId: string): Promise<GenerationRecordAuditEntry[]> {
    await this.initialize();
    const current: Project = await this.read(projectId);
    return auditGenerationRecords(current, await this.#versionProjects(projectId, null));
  }

  async create(project: Project): Promise<Project> {
    const shaped: Project = ProjectSchema.parse(project);
    if (shaped.revision !== 0) throw contractError('INITIAL_PROJECT_REVISION_INVALID', `새 Project revision은 0이어야 합니다. projectId=${shaped.projectId}, revision=${shaped.revision}`, []);
    assertAssetFreeInitialProject(shaped);
    const valid: Project = parseProject(shaped);
    await this.initialize();
    const directoryName: string = projectKey(valid.projectId);
    if (this.#recoveryBlocks.has(directoryName)) throw contractError('STORE_RECOVERY_BLOCKED', `${valid.projectId}: 저장 복구가 필요합니다.`, []);
    const directory: string = this.#directory(valid.projectId);
    const transactionId: string = randomUUID();
    const owner: z.infer<typeof TransactionOwnerSchema> = this.#owner(transactionId);
    await this.#touchProcessInstance();
    const lockMetadata: StoreLock = this.#lockMetadata(valid.projectId, transactionId, owner.pid);
    const transactionPath: string = this.#createTransactionPath(transactionId);
    const stagedDirectory: string = join(transactionPath, CREATE_STAGED_PROJECT_DIRECTORY);
    const content: string = exportProjectJson(valid);
    const contentSha256: string = sha256Text(content);
    let journal: CreateJournalV3 = CreateJournalV3Schema.parse({ version: 3, operation: 'create', phase: 'prepared', transactionId,
      projectId: valid.projectId, owner, projectDirectoryName: directoryName,
      currentFile: { stagedRelativePath: 'project/project.json', finalRelativePath: 'project.json', sha256: contentSha256 },
      versionFile: { stagedRelativePath: 'project/versions/000000.json', finalRelativePath: 'versions/000000.json', sha256: contentSha256 } });
    let published: boolean = false;
    let journalPrepared: boolean = false;
    let finalLock: RecoveryLock | null = null;
    let rootLock: RecoveryLock | null = null;
    let preserveLocks: boolean = false;
    try {
      rootLock = await this.#acquireOwnedLock(this.#rootCreateLockPath(valid.projectId), lockMetadata);
      await this.#fault('after-root-create-lock-acquired');
      await this.#verifyOwnedLock(rootLock);
      if (this.#recoveryBlocks.has(directoryName) || await this.#fs.kind(this.#recoveryBlockPath(directoryName)) !== 'missing') {
        throw contractError('STORE_RECOVERY_BLOCKED', `${valid.projectId}: 저장 복구가 필요합니다.`, []);
      }
      await this.#assertCreateTargetAvailable(valid.projectId);
      await this.#fault('after-create-target-rechecked');
      await this.#fs.ensureDirectory(transactionPath);
      await this.#fs.writeExclusive(join(transactionPath, TRANSACTION_JOURNAL), JSON.stringify(journal));
      await this.#fs.syncDirectory(transactionPath); await this.#fs.syncDirectory(this.#createTransactionsPath());
      journalPrepared = true;
      await this.#fault('after-create-journal-prepared');
      await this.#fs.ensureDirectory(stagedDirectory); await this.#fs.ensureDirectory(join(stagedDirectory, 'versions'));
      await this.#fs.ensureDirectory(join(stagedDirectory, 'assets')); await this.#fs.ensureDirectory(join(stagedDirectory, TRANSACTIONS_DIRECTORY));
      await this.#fs.writeExclusive(join(transactionPath, journal.versionFile.stagedRelativePath), content);
      await this.#fs.syncDirectory(join(stagedDirectory, 'versions'));
      journal = await this.#writeCreateJournalPhase(transactionId, journal, 'version-written');
      await this.#fault('after-create-version-zero-written');
      await this.#fs.writeExclusive(join(transactionPath, journal.currentFile.stagedRelativePath), content);
      await this.#fs.syncDirectory(stagedDirectory);
      journal = await this.#writeCreateJournalPhase(transactionId, journal, 'current-written');
      await this.#fault('after-create-current-written');
      finalLock = await this.#acquireOwnedLock(join(stagedDirectory, 'write.lock'), lockMetadata);
      await this.#fault('after-create-lock-written');
      await this.#verifyCompleteCreateStagingUnderLock(transactionId, journal, finalLock);
      await this.#fault('after-create-staging-complete');
      await this.#fault('before-create-directory-publish');
      await this.#assertCreateTargetAvailable(valid.projectId);
      await this.#fs.renameNewDirectory(stagedDirectory, directory); published = true;
      finalLock = { ...finalLock, path: join(directory, 'write.lock') };
      await this.#fs.syncDirectory(this.#fs.root());
      journal = await this.#writeCreateJournalPhase(transactionId, journal, 'published');
      await this.#fault('after-create-directory-publish');
      await this.#verifyCompleteProjectDirectoryUnderLock(valid.projectId, finalLock, true);
      journal = await this.#writeCreateJournalPhase(transactionId, journal, 'verified');
      await this.#fault('before-create-cleanup');
      await this.#fault('before-create-journal-cleanup');
      await this.#removeCreateTransaction(transactionId, journal);
      await this.#fault('before-create-lock-removal');
      await this.#removeRecoveryLock(finalLock);
      finalLock = null;
      await this.#fault('before-root-create-lock-removal');
      await this.#removeRecoveryLock(rootLock);
      rootLock = null;
      this.#activeCreates.delete(directoryName);
    } catch (error: unknown) {
      if (isSimulatedCrash(error)) throw error;
      if (!published) {
        if (journalPrepared && storageProtectionRequired(error)) {
          preserveLocks = true;
          await this.#writeRecoveryBlock(directoryName, valid.projectId, transactionId, error);
          throw error;
        }
        try {
          if (await this.#fs.kind(transactionPath) !== 'missing') {
            if (journalPrepared) await this.#removeCreateTransaction(transactionId, journal);
            else { await this.#fs.removeTree(transactionPath); await this.#fs.syncDirectory(this.#createTransactionsPath()); }
            finalLock = null;
          }
        }
        catch (cleanupError: unknown) {
          preserveLocks = true;
          await this.#writeRecoveryBlock(directoryName, valid.projectId, transactionId, cleanupError);
          throw new AggregateError([error, cleanupError], `Initial Project 생성 실패 후 staging 정리도 실패했습니다. projectId=${valid.projectId}`);
        }
      } else {
        preserveLocks = true;
        await this.#writeRecoveryBlock(directoryName, valid.projectId, transactionId, error);
      }
      if (!preserveLocks && rootLock !== null) {
        try { await this.#removeRecoveryLock(rootLock); rootLock = null; this.#activeCreates.delete(directoryName); }
        catch (lockError: unknown) {
          await this.#writeRecoveryBlock(directoryName, valid.projectId, transactionId, lockError);
          throw new AggregateError([error, lockError], `Initial Project 생성 실패 후 Root Create lock 정리도 실패했습니다. projectId=${valid.projectId}`);
        }
      }
      throw error;
    }
    return valid;
  }

  async update(projectId: string, expectedRevision: number, transform: (project: Project) => Project, assetWrites: readonly AssetWrite[]): Promise<Project> {
    await this.initialize();
    await this.#assertProjectCanAttemptMutation(projectId);
    const transactionId: string = randomUUID();
    const lock: RecoveryLock = await this.#acquireProjectLock(projectId, transactionId);
    const stagingDirectory: string = this.#transactionPath(projectId, transactionId);
    let transactionPrepared: boolean = false;
    let preserveLock: boolean = false;
    try {
      await this.#fault('after-update-lock-acquired');
      const current: Project = await this.#verifyMutationReadyUnderLock(projectId, lock);
      const previousContent: string = exportProjectJson(current);
      const previousSha256: string = sha256Text(previousContent);
      await this.#fault('after-update-current-read');
      if (current.revision !== expectedRevision) throw contractError('REVISION_CONFLICT', `${projectId}: expected=${expectedRevision}, actual=${current.revision}`, []);
      const transformInput: Project = parseProject(structuredClone(current));
      const changed: Project = transform(transformInput);
      const shapedNext: Project = ProjectSchema.parse({ ...changed, projectId: current.projectId, revision: current.revision + 1 });
      const transition: AssetCatalogTransition = assertAssetCatalogTransition(current, shapedNext, assetWrites);
      assertGenerationRecordTransition(current, shapedNext);
      assertAssetReferenceClosure(shapedNext);
      const next: Project = parseProject(shapedNext);
      const committedVersion: string = this.#versionPath(projectId, next.revision);
      if (await this.#fs.kind(committedVersion) !== 'missing') throw contractError('PROJECT_VERSION_EXISTS', `Project revision snapshot이 이미 존재합니다. path=${committedVersion}`, []);
      const stagedAssets: StagedAsset[] = await this.#preflightAssetWrites(projectId, next, transition);
      await this.#fault('after-update-under-lock-preflight');
      await this.#fault('before-update-journal-create');
      await this.#recheckCurrentBeforeJournal(projectId, lock, current.revision, previousSha256, committedVersion, stagedAssets);
      await this.#fault('after-update-preflight');
      const content: string = exportProjectJson(next);
      let journal: TransactionJournalV3 = TransactionJournalV3Schema.parse({ version: 3, operation: 'update', phase: 'prepared',
        transactionId, projectId, owner: this.#owner(transactionId), expectedRevision: current.revision, nextRevision: next.revision,
        previousProject: { stagedRelativePath: TRANSACTION_PREVIOUS_PROJECT, finalRelativePath: 'project.json', sha256: previousSha256 },
        nextProject: { stagedRelativePath: TRANSACTION_NEXT_PROJECT, finalRelativePath: 'project.json', sha256: sha256Text(content) },
        versionFile: { stagedRelativePath: TRANSACTION_NEXT_VERSION, finalRelativePath: `versions/${transactionVersionFileName(next.revision)}`, sha256: sha256Text(content) },
        assets: stagedAssets.map((item: StagedAsset): NormalizedAssetProof => item.proof) });
      await this.#fs.ensureDirectory(stagingDirectory);
      await this.#fs.writeExclusive(join(stagingDirectory, TRANSACTION_PREVIOUS_PROJECT), previousContent);
      await this.#fs.writeExclusive(join(stagingDirectory, TRANSACTION_NEXT_PROJECT), content);
      await this.#fs.writeExclusive(join(stagingDirectory, TRANSACTION_NEXT_VERSION), content);
      for (const item of stagedAssets) await this.#fs.writeExclusive(join(stagingDirectory, item.stagedRelativePath), item.content);
      await this.#fs.writeExclusive(join(stagingDirectory, TRANSACTION_JOURNAL), JSON.stringify(journal));
      await this.#fs.syncDirectory(stagingDirectory); await this.#fs.syncDirectory(this.#transactionsPath(projectId));
      transactionPrepared = true;
      await this.#fault('after-update-journal-prepared');
      for (const item of stagedAssets) await this.#fs.hardLink(join(stagingDirectory, item.stagedRelativePath), item.finalPath);
      await this.#fs.syncDirectory(join(this.#directory(projectId), 'assets'));
      journal = await this.#writeJournalPhase(projectId, transactionId, journal, 'assets-published');
      await this.#fault('after-update-asset-linked');
      await this.#fs.hardLink(join(stagingDirectory, TRANSACTION_NEXT_VERSION), committedVersion);
      await this.#fs.syncDirectory(this.#versionsPath(projectId));
      journal = await this.#writeJournalPhase(projectId, transactionId, journal, 'version-published');
      await this.#fault('after-update-version-linked');
      const stagedCurrentPublish: string = join(stagingDirectory, TRANSACTION_CURRENT_PUBLISH);
      await this.#fs.hardLink(join(stagingDirectory, TRANSACTION_NEXT_PROJECT), stagedCurrentPublish);
      await this.#fs.replaceFile(stagedCurrentPublish, this.#currentPath(projectId));
      await this.#fs.syncDirectory(this.#directory(projectId));
      journal = await this.#writeJournalPhase(projectId, transactionId, journal, 'current-published');
      await this.#fault('after-update-current-published');
      await this.#verifyCommittedTransaction(next, normalizeJournal(journal));
      journal = await this.#writeJournalPhase(projectId, transactionId, journal, 'verified');
      await this.#fault('before-update-cleanup');
      await this.#removeVerifiedTransaction(projectId, transactionId, normalizeJournal(journal));
      await this.#removeRecoveryLock(lock);
      return next;
    } catch (error: unknown) {
      if (isSimulatedCrash(error)) throw error;
      try {
        if (transactionPrepared) {
          const recoveredJournal: NormalizedJournal = normalizeJournal(await this.#readTransactionJournal(projectId, transactionId));
          const projects = await this.#transactionProjects(projectId, transactionId, recoveredJournal);
          const currentAfterFailure: Project = await this.#readProjectFile(this.#currentPath(projectId));
          if (currentAfterFailure.revision === recoveredJournal.nextRevision) await this.#restorePreviousProject(projectId, recoveredJournal, projects.previousContent);
          else if (currentAfterFailure.revision === recoveredJournal.expectedRevision) {
            await this.#requireFileProof(this.#currentPath(projectId), recoveredJournal.previousProject.sha256, `실패 저장 이전 Project 증명 projectId=${projectId}`);
            await this.#removePublishedTransactionFiles(projectId, recoveredJournal, false);
          } else recoveryRequired(`실패 저장의 현재 revision을 복구할 수 없습니다. projectId=${projectId}, revision=${currentAfterFailure.revision}`);
          await this.#removeVerifiedTransaction(projectId, transactionId, recoveredJournal);
        } else if (await this.#fs.kind(stagingDirectory) !== 'missing') {
          await this.#fs.removeTree(stagingDirectory); await this.#fs.syncDirectory(this.#transactionsPath(projectId));
        }
      } catch (rollbackError: unknown) {
        preserveLock = true;
        await this.#writeRecoveryBlock(projectKey(projectId), projectId, transactionId, rollbackError);
        throw new AggregateError([error, rollbackError], `프로젝트 저장 실패 후 transaction rollback도 실패했습니다. projectId=${projectId}, transactionId=${transactionId}`);
      }
      if (storageProtectionRequired(error)) {
        preserveLock = true;
        await this.#writeRecoveryBlock(projectKey(projectId), projectId, transactionId, error);
      }
      if (!preserveLock) {
        try { await this.#removeRecoveryLock(lock); }
        catch (lockError: unknown) {
          preserveLock = true;
          await this.#writeRecoveryBlock(projectKey(projectId), projectId, transactionId, lockError);
          throw new AggregateError([error, lockError], `프로젝트 저장 실패 후 lock 정리도 실패했습니다. projectId=${projectId}, transactionId=${transactionId}`);
        }
      }
      throw error;
    }
  }

  async asset(projectId: string, assetId: string): Promise<StoredAsset> { return this.#assetForProject(await this.read(projectId), assetId); }

  async assetIntegrity(projectId: string): Promise<Record<string, string>> {
    const project: Project = await this.read(projectId); const result: Record<string, string> = {};
    for (const asset of project.assets) {
      try { await this.#assetForProject(project, asset.id); result[asset.id] = 'verified'; }
      catch (error: unknown) { const code: string | null = assetFailureCode(error); if (code === null) throw error; result[asset.id] = code; }
    }
    return result;
  }

  async audioRecoverySource(project: Project, cueId: string): Promise<AudioAssetRecoverySource> {
    const cue = project.audioCues.find((candidate): boolean => candidate.id === cueId);
    if (cue === undefined) throw contractError('AUDIO_CUE_NOT_FOUND', `오디오 큐를 찾을 수 없습니다. cueId=${cueId}`, []);
    if (cue.assetId === null) throw contractError('AUDIO_ASSET_NOT_FOUND', `복구할 오디오 자산이 없습니다. cueId=${cueId}`, []);
    const asset: Asset | undefined = project.assets.find((candidate: Asset): boolean => candidate.id === cue.assetId);
    if (asset === undefined || asset.kind !== 'audio') throw contractError('AUDIO_ASSET_NOT_FOUND', `복구할 Audio Asset을 찾을 수 없습니다. cueId=${cueId}, assetId=${cue.assetId}`, []);
    if (asset.subjectId !== cue.id) throw contractError('AUDIO_ASSET_SUBJECT_MISMATCH', `Audio Asset 대상이 Cue와 다릅니다. cueId=${cue.id}, assetId=${asset.id}`, []);
    const content: Buffer = await this.#rawAssetContent(project, asset);
    let inspection: InspectedAudioFile;
    try { inspection = inspectAudioFileBytes(content, asset.mimeType); }
    catch (error: unknown) { throw mapStoredAssetIntegrityError(error, project.projectId, asset.id); }
    const metadataMatches: boolean = asset.durationMs === inspection.durationMs && asset.audioMetadata !== undefined && asset.audioMetadata !== null
      && asset.audioMetadata.sampleRate === inspection.sampleRate && asset.audioMetadata.channels === inspection.channels && asset.audioMetadata.codec === inspection.codec;
    const timelineMatches: boolean = cue.timingStatus === 'measured' && cue.endMs - cue.startMs === inspection.durationMs;
    const formatMatches: boolean = inspection.sampleRate === project.handoff.timebase.sampleRate && inspection.codec === 'pcm_s16le';
    if (metadataMatches && timelineMatches && formatMatches) throw contractError('AUDIO_ASSET_ALREADY_NORMALIZED', `Audio Asset이 이미 현재 Project 형식과 일치합니다. cueId=${cueId}, assetId=${asset.id}`, []);
    return { content, asset, inspection };
  }

  async safeFrame(projectId: string, frameId: string): Promise<StoredAsset> {
    const project: Project = await this.read(projectId); const decision = reviewFrameOutput(project, frameId, 'program-monitor');
    if (!decision.renderBitmap || decision.imageAssetId === null) throw contractError('FRAME_OUTPUT_BLOCKED', decision.issues.map((value): string => `${value.code}: ${value.message}`).join('\n'), decision.issues);
    const stored: StoredAsset = await this.#assetForProject(project, decision.imageAssetId);
    if (stored.asset.kind !== 'image') throw contractError('FRAME_OUTPUT_BLOCKED', `프레임 출력 자산이 이미지가 아닙니다. frameId=${frameId}`, []);
    return stored;
  }

  async safeAudio(projectId: string, cueId: string): Promise<StoredAsset> {
    const project: Project = await this.read(projectId); const cue = project.audioCues.find((candidate): boolean => candidate.id === cueId);
    if (cue === undefined) throw contractError('AUDIO_CUE_NOT_FOUND', `오디오 큐를 찾을 수 없습니다. cueId=${cueId}`, []);
    const review = reviewAudioPlaybackAt(project, cue.startMs);
    if (!review.playable.some((candidate): boolean => candidate.id === cue.id)) {
      const issues = review.blocked.find((blocked): boolean => blocked.cueId === cue.id)?.issues ?? [];
      throw contractError('AUDIO_OUTPUT_BLOCKED', issues.map((value): string => `${value.code}: ${value.message}`).join('\n'), issues);
    }
    if (cue.assetId === null) throw contractError('AUDIO_ASSET_NOT_FOUND', `오디오 자산이 없습니다. cueId=${cue.id}`, []);
    let stored: StoredAsset;
    try { stored = await this.#assetForProject(project, cue.assetId); }
    catch (error: unknown) {
      const code: string | null = assetFailureCode(error); if (code === null) throw error;
      if (code.startsWith('STORED_')) throw error;
      const audioCode: string = code === 'ASSET_FILE_MISSING' ? 'AUDIO_ASSET_FILE_MISSING' : code === 'ASSET_HASH_MISMATCH' ? 'AUDIO_ASSET_HASH_MISMATCH' : code.startsWith('AUDIO_ASSET_') ? code : 'AUDIO_ASSET_CORRUPT';
      throw contractError(audioCode, `안전 오디오 출력용 자산을 검증할 수 없습니다. cueId=${cue.id}, assetId=${cue.assetId}, cause=${code}`, []);
    }
    if (stored.asset.kind !== 'audio') throw contractError('AUDIO_OUTPUT_BLOCKED', `오디오 출력 자산의 유형이 다릅니다. cueId=${cue.id}`, []);
    return stored;
  }

  async assetPath(projectId: string, assetId: string): Promise<string> {
    const project: Project = await this.read(projectId); const asset: Asset | undefined = project.assets.find((value: Asset): boolean => value.id === assetId);
    if (asset === undefined) throw contractError('ASSET_NOT_FOUND', `자산을 찾을 수 없습니다. assetId=${assetId}`, []);
    return this.#safeAssetPath(projectId, asset);
  }
}

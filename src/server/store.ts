import { randomUUID } from 'node:crypto';
import { link, mkdir, open, readdir, readFile, rename, rm, rmdir, stat, unlink } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { hostname } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { z } from 'zod';
import { contractError } from '../domain/errors.js';
import { reviewFrameOutput } from '../domain/frame-output.js';
import { inspectAudioFileBytes, verifyStoredAsset } from '../domain/media-inspection.js';
import type { InspectedAudioFile } from '../domain/media-inspection.js';
import { reviewAudioPlaybackAt, reviewTextPlaybackAt } from '../domain/playback.js';
import type { Asset, Project } from '../domain/schema.js';
import { exportProjectJson } from '../exporters/json.js';
import { sha256Bytes, sha256Text } from '../importers/integrity.js';
import { isMissingFile } from '../io/package.js';
import { parseProject, readProject } from '../io/project.js';

export type ProjectSummary = {
  projectId: string;
  title: string;
  revision: number;
  durationMs: number;
  shots: number;
  framesWithAsset: number;
  framesAccepted: number;
  framesOutputSafe: number;
  framesTotal: number;
  audioWithAsset: number;
  audioMeasured: number;
  audioPlayable: number;
  audioRepairRequired: number;
  audioTotal: number;
  textPlayable: number;
  textTotal: number;
  blockedOutputCount: number;
  issues: number;
  updatedAt: string;
};
export type AssetWrite = { relativePath: string; content: Buffer };
export type StoredAsset = { content: Buffer; mimeType: string; asset: Asset };
export type AudioAssetRecoverySource = { content: Buffer; asset: Asset; inspection: InspectedAudioFile };
export type StorageRecoveryEvent = {
  projectId: string;
  transactionId: string;
  outcome: 'committed' | 'rolled-back' | 'restored-previous' | 'staging-removed' | 'stale-lock-removed'
    | 'create-committed' | 'create-rolled-back';
};

export const STORAGE_TRANSACTION_JOURNAL_VERSION: number = 2;
const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const FileProofSchema = z.strictObject({ relativePath: z.string().min(1), sha256: Sha256Schema });
const AssetProofSchema = FileProofSchema.extend({ assetId: z.string().min(1), stagedFileName: z.string().regex(/^asset-[0-9]+\.bin$/) });
const TransactionOwnerSchema = z.strictObject({ host: z.string().min(1), pid: z.number().int().positive(), transactionId: z.uuid() });
const TransactionJournalSchema = z.strictObject({
  version: z.literal(2), operation: z.literal('update'), transactionId: z.uuid(), projectId: z.string().min(1),
  owner: TransactionOwnerSchema,
  expectedRevision: z.number().int().nonnegative(), nextRevision: z.number().int().positive(),
  previousProjectSha256: Sha256Schema, nextProjectSha256: Sha256Schema,
  versionFile: FileProofSchema,
  assets: z.array(AssetProofSchema).refine((assets): boolean => new Set(assets.map((asset): string => asset.relativePath)).size === assets.length
    && new Set(assets.map((asset): string => asset.assetId)).size === assets.length
    && new Set(assets.map((asset): string => asset.stagedFileName)).size === assets.length),
});
type TransactionJournal = z.infer<typeof TransactionJournalSchema>;
const CreateJournalSchema = z.strictObject({
  version: z.literal(2), operation: z.literal('create'), transactionId: z.uuid(), projectId: z.string().min(1),
  owner: TransactionOwnerSchema, projectDirectoryName: Sha256Schema,
  currentFile: FileProofSchema, versionFile: FileProofSchema,
});
type CreateJournal = z.infer<typeof CreateJournalSchema>;
const StoreLockSchema = z.strictObject({
  version: z.literal(2), projectId: z.string().min(1), host: z.string().min(1), pid: z.number().int().positive(),
  transactionId: z.uuid(), createdAt: z.iso.datetime(),
});
type StoreLock = z.infer<typeof StoreLockSchema>;
type AcquiredProjectLock = { handle: FileHandle; metadata: StoreLock };
type RecoveryLock = { metadata: StoreLock; path: string };

const TRANSACTIONS_DIRECTORY: string = '.transactions';
const CREATE_TRANSACTIONS_DIRECTORY: string = '.create-transactions';
const TRANSACTION_JOURNAL: string = 'journal.json';
const TRANSACTION_NEXT_PROJECT: string = 'project.next.json';
const TRANSACTION_PREVIOUS_PROJECT: string = 'project.previous.json';
const TRANSACTION_NEXT_VERSION: string = 'version.next.json';
const CREATE_STAGED_PROJECT_DIRECTORY: string = 'project';

function projectKey(projectId: string): string {
  return sha256Text(projectId);
}

function assetFailureCode(error: unknown): string | null {
  if (!(error instanceof Error) || !('code' in error) || typeof error.code !== 'string') return null;
  return ['ASSET_FILE_MISSING', 'ASSET_HASH_MISMATCH', 'ASSET_MIME_MISMATCH', 'ASSET_CONTENT_CORRUPT', 'ASSET_PATH_UNSAFE',
    'AUDIO_ASSET_METADATA_MISSING', 'AUDIO_ASSET_METADATA_MISMATCH', 'AUDIO_ASSET_NORMALIZATION_REQUIRED']
    .includes(error.code) ? error.code : null;
}

async function removeCommittedFile(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch (error: unknown) {
    if (isMissingFile(error)) return;
    throw error;
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error: unknown) {
    if (isMissingFile(error)) return false;
    throw error;
  }
}

async function writeDurableFile(path: string, content: string | Buffer): Promise<void> {
  const handle = await open(path, 'wx', 0o600);
  try {
    await handle.writeFile(content);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function recoveryRequired(message: string): never {
  throw contractError('STORE_RECOVERY_REQUIRED', message, []);
}

function transactionOwner(transactionId: string): z.infer<typeof TransactionOwnerSchema> {
  return TransactionOwnerSchema.parse({ host: hostname(), pid: process.pid, transactionId });
}

async function fileSha256(path: string): Promise<string> {
  return sha256Bytes(await readFile(path));
}

async function requireFileProof(path: string, expectedSha256: string, context: string): Promise<void> {
  if (!await pathExists(path)) recoveryRequired(`${context}: 증명할 파일이 없습니다. path=${path}, expectedSha256=${expectedSha256}`);
  const actualSha256: string = await fileSha256(path);
  if (actualSha256 !== expectedSha256) {
    recoveryRequired(`${context}: 파일 해시가 journal과 다릅니다. path=${path}, expectedSha256=${expectedSha256}, actualSha256=${actualSha256}`);
  }
}

async function removeProvenFile(path: string, expectedSha256: string, referenced: boolean, context: string): Promise<void> {
  if (!await pathExists(path)) return;
  if (referenced) recoveryRequired(`${context}: 현재 Project가 참조하는 파일은 rollback으로 삭제할 수 없습니다. path=${path}`);
  await requireFileProof(path, expectedSha256, context);
  await unlink(path);
}

async function acquireProjectLock(
  lockPath: string, directory: string, projectId: string, transactionId: string,
): Promise<AcquiredProjectLock> {
  let handle: FileHandle | null = null;
  const metadata: StoreLock = StoreLockSchema.parse({ version: 2, projectId, host: hostname(), pid: process.pid,
    transactionId, createdAt: new Date().toISOString() });
  try {
    handle = await open(lockPath, 'wx', 0o600);
    await handle.writeFile(JSON.stringify(metadata));
    await handle.sync();
    await syncDirectory(directory);
    return { handle, metadata };
  } catch (error: unknown) {
    if (handle === null && error instanceof Error && 'code' in error && error.code === 'EEXIST') {
      throw contractError('PROJECT_BUSY', `${projectId}: 다른 저장 작업이 진행 중입니다.`, []);
    }
    const errors: unknown[] = [error];
    if (handle !== null) {
      try { await handle.close(); } catch (closeError: unknown) { errors.push(closeError); }
      try { await removeCommittedFile(lockPath); } catch (unlinkError: unknown) { errors.push(unlinkError); }
      try { await syncDirectory(directory); } catch (syncError: unknown) { errors.push(syncError); }
    }
    if (errors.length > 1) throw new AggregateError(errors, `Project lock 생성 실패 후 정리도 실패했습니다. projectId=${projectId}`);
    throw error;
  }
}

async function releaseProjectLock(lock: AcquiredProjectLock, lockPath: string, directory: string, projectId: string): Promise<void> {
  const errors: unknown[] = [];
  try { await lock.handle.close(); } catch (error: unknown) { errors.push(error); }
  try {
    const current: StoreLock = StoreLockSchema.parse(JSON.parse(await readFile(lockPath, 'utf8')) as unknown);
    if (JSON.stringify(current) !== JSON.stringify(lock.metadata)) {
      recoveryRequired(`Project lock 소유권이 저장 중 바뀌었습니다. projectId=${projectId}, transactionId=${lock.metadata.transactionId}`);
    }
    await unlink(lockPath);
  } catch (error: unknown) { errors.push(error); }
  try { await syncDirectory(directory); } catch (error: unknown) { errors.push(error); }
  if (errors.length > 0) throw new AggregateError(errors, `Project lock을 완전히 해제하지 못했습니다. projectId=${projectId}`);
}

async function replaceDurableFile(path: string, content: string, transactionId: string): Promise<void> {
  const temporaryPath: string = `${path}.${transactionId}.recovery`;
  if (await pathExists(temporaryPath)) {
    const existing: string = await readFile(temporaryPath, 'utf8');
    if (existing !== content) {
      throw contractError('TRANSACTION_RECOVERY_FILE_MISMATCH', `기존 복구 파일의 내용이 이전 Project와 다릅니다. path=${temporaryPath}`, []);
    }
  } else {
    await writeDurableFile(temporaryPath, content);
    await syncDirectory(dirname(path));
  }
  await rename(temporaryPath, path);
  await syncDirectory(dirname(path));
}

function transactionVersionFileName(revision: number): string {
  return `${String(revision).padStart(6, '0')}.json`;
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: unknown) {
    if (error instanceof Error && 'code' in error && error.code === 'ESRCH') return false;
    throw error;
  }
}

export class ProjectStore {
  readonly #root: string;
  readonly #recoveryEvents: StorageRecoveryEvent[] = [];
  #initialization: Promise<void> | null = null;

  constructor(root: string) {
    this.#root = root;
  }

  #directory(projectId: string): string {
    return join(this.#root, projectKey(projectId));
  }

  #currentPath(projectId: string): string {
    return join(this.#directory(projectId), 'project.json');
  }

  #transactionsPath(projectId: string): string {
    return join(this.#directory(projectId), TRANSACTIONS_DIRECTORY);
  }

  #transactionPath(projectId: string, transactionId: string): string {
    return join(this.#transactionsPath(projectId), transactionId);
  }

  #createTransactionsPath(): string {
    return join(this.#root, CREATE_TRANSACTIONS_DIRECTORY);
  }

  #createTransactionPath(transactionId: string): string {
    return join(this.#createTransactionsPath(), transactionId);
  }

  #safeAssetPath(projectId: string, asset: Asset): string {
    const directory: string = resolve(this.#directory(projectId));
    const path: string = resolve(directory, asset.path);
    if (path === directory || !path.startsWith(`${directory}${sep}`)) {
      throw contractError('ASSET_PATH_UNSAFE', `프로젝트 밖의 자산 경로는 읽을 수 없습니다. assetId=${asset.id}, path=${asset.path}`, []);
    }
    return path;
  }

  #safeJournalAssetPath(projectId: string, relativePath: string): string {
    if (!relativePath.startsWith('assets/')) {
      throw contractError('TRANSACTION_JOURNAL_PATH_UNSAFE', `Transaction journal의 자산 경로는 assets 아래여야 합니다. projectId=${projectId}, path=${relativePath}`, []);
    }
    const directory: string = resolve(this.#directory(projectId));
    const assetsDirectory: string = resolve(directory, 'assets');
    const path: string = resolve(directory, relativePath);
    if (path === assetsDirectory || !path.startsWith(`${assetsDirectory}${sep}`)) {
      throw contractError('TRANSACTION_JOURNAL_PATH_UNSAFE', `Transaction journal이 프로젝트 밖의 경로를 가리킵니다. projectId=${projectId}, path=${relativePath}`, []);
    }
    return path;
  }

  #recordRecovery(event: StorageRecoveryEvent): void {
    this.#recoveryEvents.push(event);
    console.warn(JSON.stringify({ event: 'project-store-recovery', ...event }));
  }

  #versionPath(projectId: string, revision: number): string {
    return join(this.#directory(projectId), 'versions', transactionVersionFileName(revision));
  }

  #assertJournalIdentity(projectId: string, transactionId: string, journal: TransactionJournal): void {
    const versionRelativePath: string = `versions/${transactionVersionFileName(journal.nextRevision)}`;
    if (journal.projectId !== projectId || journal.transactionId !== transactionId
      || journal.owner.transactionId !== transactionId || journal.nextRevision !== journal.expectedRevision + 1
      || journal.versionFile.relativePath !== versionRelativePath || journal.versionFile.sha256 !== journal.nextProjectSha256) {
      recoveryRequired(`Transaction journal 식별자, revision 또는 경로가 일치하지 않습니다. projectId=${projectId}, transactionId=${transactionId}`);
    }
    for (const asset of journal.assets) this.#safeJournalAssetPath(projectId, asset.relativePath);
  }

  #assertRecoverableOwner(projectId: string, transactionId: string, journal: TransactionJournal, lock: RecoveryLock | null): void {
    if (journal.owner.host !== hostname()) {
      recoveryRequired(`다른 Host의 Transaction을 자동 복구할 수 없습니다. projectId=${projectId}, transactionId=${transactionId}, ownerHost=${journal.owner.host}, currentHost=${hostname()}`);
    }
    if (lock !== null && lock.metadata.transactionId === transactionId) {
      if (lock.metadata.pid !== journal.owner.pid || lock.metadata.host !== journal.owner.host) {
        recoveryRequired(`Lock과 journal의 Transaction 소유권이 다릅니다. projectId=${projectId}, transactionId=${transactionId}`);
      }
      return;
    }
    if (processIsAlive(journal.owner.pid)) {
      throw contractError('PROJECT_BUSY', `${projectId}: transactionId=${transactionId}, pid=${journal.owner.pid} 저장 작업이 진행 중입니다.`, []);
    }
  }

  async #readTransactionJournal(projectId: string, transactionId: string): Promise<TransactionJournal> {
    const path: string = join(this.#transactionPath(projectId, transactionId), TRANSACTION_JOURNAL);
    try {
      const journal: TransactionJournal = TransactionJournalSchema.parse(JSON.parse(await readFile(path, 'utf8')) as unknown);
      this.#assertJournalIdentity(projectId, transactionId, journal);
      return journal;
    } catch (error: unknown) {
      if (error instanceof Error && 'code' in error && error.code === 'STORE_RECOVERY_REQUIRED') throw error;
      recoveryRequired(`Transaction journal을 검증할 수 없습니다. projectId=${projectId}, transactionId=${transactionId}, cause=${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async #transactionProjects(projectId: string, transactionId: string, journal: TransactionJournal): Promise<{ previous: Project; previousContent: string; next: Project }> {
    const transactionPath: string = this.#transactionPath(projectId, transactionId);
    const previousPath: string = join(transactionPath, TRANSACTION_PREVIOUS_PROJECT);
    await requireFileProof(previousPath, journal.previousProjectSha256, `이전 Project 증명 실패 projectId=${projectId}, transactionId=${transactionId}`);
    const previousContent: string = await readFile(previousPath, 'utf8');
    const previous: Project = parseProject(JSON.parse(previousContent) as unknown);
    if (previous.projectId !== projectId || previous.revision !== journal.expectedRevision) {
      recoveryRequired(`복구용 이전 Project가 journal과 일치하지 않습니다. projectId=${projectId}, transactionId=${transactionId}`);
    }
    const stagedNextPath: string = join(transactionPath, TRANSACTION_NEXT_PROJECT);
    const versionPath: string = this.#versionPath(projectId, journal.nextRevision);
    const currentPath: string = this.#currentPath(projectId);
    const candidates: string[] = [stagedNextPath, versionPath, currentPath];
    let nextContent: string | null = null;
    for (const path of candidates) {
      if (!await pathExists(path)) continue;
      if (await fileSha256(path) !== journal.nextProjectSha256) continue;
      nextContent = await readFile(path, 'utf8');
      break;
    }
    if (nextContent === null) recoveryRequired(`다음 Project 내용을 journal 해시로 증명할 수 없습니다. projectId=${projectId}, transactionId=${transactionId}`);
    const next: Project = parseProject(JSON.parse(nextContent) as unknown);
    if (next.projectId !== projectId || next.revision !== journal.nextRevision) {
      recoveryRequired(`다음 Project가 journal과 일치하지 않습니다. projectId=${projectId}, transactionId=${transactionId}`);
    }
    for (const proof of journal.assets) {
      const asset: Asset | undefined = next.assets.find((candidate: Asset): boolean => candidate.id === proof.assetId
        && candidate.path === proof.relativePath && candidate.sha256 === proof.sha256);
      if (asset === undefined) recoveryRequired(`다음 Project의 Asset metadata가 journal 증명과 다릅니다. projectId=${projectId}, transactionId=${transactionId}, assetId=${proof.assetId}`);
    }
    return { previous, previousContent, next };
  }

  async #verifyStagedTransactionFiles(projectId: string, transactionId: string, journal: TransactionJournal): Promise<void> {
    const transactionPath: string = this.#transactionPath(projectId, transactionId);
    const proofs: Array<{ path: string; sha256: string; context: string }> = [
      { path: join(transactionPath, TRANSACTION_PREVIOUS_PROJECT), sha256: journal.previousProjectSha256, context: '이전 Project staging' },
      { path: join(transactionPath, TRANSACTION_NEXT_PROJECT), sha256: journal.nextProjectSha256, context: '다음 Project staging' },
      { path: join(transactionPath, TRANSACTION_NEXT_VERSION), sha256: journal.versionFile.sha256, context: 'revision staging' },
      ...journal.assets.map((proof): { path: string; sha256: string; context: string } => ({
        path: join(transactionPath, proof.stagedFileName), sha256: proof.sha256, context: `Asset staging assetId=${proof.assetId}`,
      })),
    ];
    for (const proof of proofs) {
      if (await pathExists(proof.path)) await requireFileProof(proof.path, proof.sha256,
        `${proof.context} 증명 실패 projectId=${projectId}, transactionId=${transactionId}`);
    }
  }

  async #removeVerifiedTransaction(projectId: string, transactionId: string, journal: TransactionJournal): Promise<void> {
    const transactionPath: string = this.#transactionPath(projectId, transactionId);
    await this.#verifyStagedTransactionFiles(projectId, transactionId, journal);
    const names: string[] = [TRANSACTION_PREVIOUS_PROJECT, TRANSACTION_NEXT_PROJECT, TRANSACTION_NEXT_VERSION,
      ...journal.assets.map((proof): string => proof.stagedFileName)];
    for (const name of names) await removeCommittedFile(join(transactionPath, name));
    await removeCommittedFile(join(transactionPath, TRANSACTION_JOURNAL));
    try {
      await rmdir(transactionPath);
    } catch (error: unknown) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOTEMPTY') {
        recoveryRequired(`Transaction staging에 소유권이 증명되지 않은 파일이 남아 있습니다. projectId=${projectId}, transactionId=${transactionId}`);
      }
      throw error;
    }
    await syncDirectory(this.#transactionsPath(projectId));
  }

  async #removePublishedTransactionFiles(projectId: string, journal: TransactionJournal, preserved: Project): Promise<void> {
    for (const proof of journal.assets) {
      const referenced: boolean = preserved.assets.some((asset: Asset): boolean => asset.id === proof.assetId || asset.path === proof.relativePath);
      await removeProvenFile(this.#safeJournalAssetPath(projectId, proof.relativePath), proof.sha256, referenced,
        `게시 Asset rollback projectId=${projectId}, transactionId=${journal.transactionId}, assetId=${proof.assetId}`);
    }
    await removeProvenFile(this.#versionPath(projectId, journal.nextRevision), journal.versionFile.sha256, false,
      `revision rollback projectId=${projectId}, transactionId=${journal.transactionId}, revision=${journal.nextRevision}`);
    await syncDirectory(join(this.#directory(projectId), 'assets'));
    await syncDirectory(join(this.#directory(projectId), 'versions'));
  }

  async #restorePreviousProject(projectId: string, transactionId: string, journal: TransactionJournal, previous: Project, previousContent: string): Promise<void> {
    const currentPath: string = this.#currentPath(projectId);
    if (await pathExists(currentPath)) {
      await requireFileProof(currentPath, journal.nextProjectSha256,
        `복구 대상 현재 Project 증명 실패 projectId=${projectId}, transactionId=${transactionId}`);
    }
    await this.#removePublishedTransactionFiles(projectId, journal, previous);
    await replaceDurableFile(currentPath, previousContent, transactionId);
  }

  async #verifyCommittedTransaction(project: Project, journal: TransactionJournal): Promise<void> {
    await requireFileProof(this.#currentPath(project.projectId), journal.nextProjectSha256,
      `현재 Project commit 증명 실패 projectId=${project.projectId}, transactionId=${journal.transactionId}`);
    await requireFileProof(this.#versionPath(project.projectId, journal.nextRevision), journal.versionFile.sha256,
      `revision commit 증명 실패 projectId=${project.projectId}, transactionId=${journal.transactionId}`);
    const version: Project = await readProject(this.#versionPath(project.projectId, journal.nextRevision));
    if (JSON.stringify(version) !== JSON.stringify(project)) {
      recoveryRequired(`현재 Project와 revision snapshot이 다릅니다. projectId=${project.projectId}, revision=${journal.nextRevision}`);
    }
    for (const proof of journal.assets) {
      const asset: Asset | undefined = project.assets.find((candidate: Asset): boolean => candidate.id === proof.assetId
        && candidate.path === proof.relativePath && candidate.sha256 === proof.sha256);
      if (asset === undefined) recoveryRequired(`게시된 Project에 journal Asset metadata가 없습니다. projectId=${project.projectId}, assetId=${proof.assetId}`);
      const path: string = this.#safeJournalAssetPath(project.projectId, proof.relativePath);
      await requireFileProof(path, proof.sha256, `게시 Asset commit 증명 실패 projectId=${project.projectId}, assetId=${proof.assetId}`);
      await verifyStoredAsset(project, asset, await readFile(path));
    }
  }

  async #readRecoveryLock(directoryName: string): Promise<RecoveryLock | null> {
    const path: string = join(this.#root, directoryName, 'write.lock');
    if (!await pathExists(path)) return null;
    let metadata: StoreLock;
    try {
      metadata = StoreLockSchema.parse(JSON.parse(await readFile(path, 'utf8')) as unknown);
    } catch (error: unknown) {
      recoveryRequired(`Project lock의 소유권을 해석할 수 없습니다. directory=${directoryName}, cause=${error instanceof Error ? error.message : String(error)}`);
    }
    if (projectKey(metadata.projectId) !== directoryName) {
      recoveryRequired(`Project lock과 저장 디렉터리가 일치하지 않습니다. projectId=${metadata.projectId}, directory=${directoryName}`);
    }
    if (metadata.host !== hostname()) {
      recoveryRequired(`다른 Host의 Project lock은 자동 삭제할 수 없습니다. projectId=${metadata.projectId}, ownerHost=${metadata.host}, currentHost=${hostname()}`);
    }
    if (processIsAlive(metadata.pid)) throw contractError('PROJECT_BUSY', `${metadata.projectId}: pid=${metadata.pid} 저장 작업이 진행 중입니다.`, []);
    return { metadata, path };
  }

  async #removeRecoveryLock(lock: RecoveryLock): Promise<void> {
    const current: StoreLock = StoreLockSchema.parse(JSON.parse(await readFile(lock.path, 'utf8')) as unknown);
    if (JSON.stringify(current) !== JSON.stringify(lock.metadata)) {
      recoveryRequired(`Project lock이 복구 중 바뀌어 삭제할 수 없습니다. projectId=${lock.metadata.projectId}, transactionId=${lock.metadata.transactionId}`);
    }
    await unlink(lock.path);
    await syncDirectory(dirname(lock.path));
    this.#recordRecovery({ projectId: lock.metadata.projectId, transactionId: lock.metadata.transactionId, outcome: 'stale-lock-removed' });
  }

  async #recoverTransaction(projectId: string, transactionId: string, lock: RecoveryLock | null): Promise<void> {
    const transactionPath: string = this.#transactionPath(projectId, transactionId);
    const journalPath: string = join(transactionPath, TRANSACTION_JOURNAL);
    if (!await pathExists(journalPath)) {
      if (lock === null || lock.metadata.transactionId !== transactionId || (await readdir(transactionPath)).length > 0) {
        recoveryRequired(`journal이 없는 staging의 Transaction 소유권을 증명할 수 없습니다. projectId=${projectId}, transactionId=${transactionId}`);
      }
      await rmdir(transactionPath);
      await syncDirectory(this.#transactionsPath(projectId));
      this.#recordRecovery({ projectId, transactionId, outcome: 'staging-removed' });
      return;
    }
    const journal: TransactionJournal = await this.#readTransactionJournal(projectId, transactionId);
    this.#assertRecoverableOwner(projectId, transactionId, journal, lock);
    await this.#verifyStagedTransactionFiles(projectId, transactionId, journal);
    const projects = await this.#transactionProjects(projectId, transactionId, journal);
    const currentPath: string = this.#currentPath(projectId);
    const current: Project | null = await pathExists(currentPath) ? await readProject(currentPath) : null;
    if (current === null) {
      await this.#restorePreviousProject(projectId, transactionId, journal, projects.previous, projects.previousContent);
      await this.#removeVerifiedTransaction(projectId, transactionId, journal);
      this.#recordRecovery({ projectId, transactionId, outcome: 'restored-previous' });
      return;
    }
    if (current.revision === journal.expectedRevision) {
      await requireFileProof(currentPath, journal.previousProjectSha256,
        `rollback 기준 Project 증명 실패 projectId=${projectId}, transactionId=${transactionId}`);
      await this.#removePublishedTransactionFiles(projectId, journal, current);
      await this.#removeVerifiedTransaction(projectId, transactionId, journal);
      this.#recordRecovery({ projectId, transactionId, outcome: 'rolled-back' });
      return;
    }
    if (current.revision === journal.nextRevision) {
      try {
        await this.#verifyCommittedTransaction(current, journal);
        await this.#removeVerifiedTransaction(projectId, transactionId, journal);
        this.#recordRecovery({ projectId, transactionId, outcome: 'committed' });
      } catch (error: unknown) {
        if (error instanceof Error && 'code' in error && error.code === 'STORE_RECOVERY_REQUIRED') {
          await this.#restorePreviousProject(projectId, transactionId, journal, projects.previous, projects.previousContent);
          await this.#removeVerifiedTransaction(projectId, transactionId, journal);
          this.#recordRecovery({ projectId, transactionId, outcome: 'restored-previous' });
          console.warn(JSON.stringify({ event: 'project-store-recovery-cause', projectId, transactionId, cause: error.message }));
        } else {
          throw error;
        }
      }
      return;
    }
    if (current.revision > journal.nextRevision) {
      await this.#removeVerifiedTransaction(projectId, transactionId, journal);
      this.#recordRecovery({ projectId, transactionId, outcome: 'committed' });
      return;
    }
    recoveryRequired(`현재 revision이 Transaction journal과 일치하지 않습니다. projectId=${projectId}, current=${current.revision}, expected=${journal.expectedRevision}, next=${journal.nextRevision}`);
  }

  async #projectIdForDirectory(directoryName: string, lock: RecoveryLock | null, transactionNames: readonly string[]): Promise<string> {
    const currentPath: string = join(this.#root, directoryName, 'project.json');
    if (await pathExists(currentPath)) return (await readProject(currentPath)).projectId;
    if (lock !== null) return lock.metadata.projectId;
    const ids: Set<string> = new Set<string>();
    for (const transactionId of transactionNames) {
      const journalPath: string = join(this.#root, directoryName, TRANSACTIONS_DIRECTORY, transactionId, TRANSACTION_JOURNAL);
      if (!await pathExists(journalPath)) continue;
      try {
        ids.add(TransactionJournalSchema.parse(JSON.parse(await readFile(journalPath, 'utf8')) as unknown).projectId);
      } catch (error: unknown) {
        recoveryRequired(`현재 Project가 없고 journal도 해석할 수 없습니다. directory=${directoryName}, transactionId=${transactionId}, cause=${error instanceof Error ? error.message : String(error)}`);
      }
    }
    if (ids.size !== 1) recoveryRequired(`현재 Project가 없는 저장 디렉터리의 소유 프로젝트를 결정할 수 없습니다. directory=${directoryName}, projectIds=${[...ids].join(',')}`);
    const [projectId] = ids;
    if (projectId === undefined) recoveryRequired(`저장 디렉터리의 Project ID가 없습니다. directory=${directoryName}`);
    return projectId;
  }

  async #recoverProjectDirectory(directoryName: string): Promise<void> {
    const transactionsPath: string = join(this.#root, directoryName, TRANSACTIONS_DIRECTORY);
    await mkdir(transactionsPath, { recursive: true });
    const transactions = await readdir(transactionsPath, { withFileTypes: true });
    const transactionNames: string[] = transactions.filter((entry): boolean => entry.isDirectory()).map((entry): string => entry.name);
    const lock: RecoveryLock | null = await this.#readRecoveryLock(directoryName);
    const projectId: string = await this.#projectIdForDirectory(directoryName, lock, transactionNames);
    if (projectKey(projectId) !== directoryName) {
      recoveryRequired(`Project ID와 저장 디렉터리가 일치하지 않습니다. projectId=${projectId}, directory=${directoryName}`);
    }
    if (lock !== null && lock.metadata.projectId !== projectId) {
      recoveryRequired(`Project lock과 현재 Project ID가 일치하지 않습니다. projectId=${projectId}, lockProjectId=${lock.metadata.projectId}`);
    }
    for (const transactionId of transactionNames) await this.#recoverTransaction(projectId, transactionId, lock);
    if (!await pathExists(this.#currentPath(projectId))) recoveryRequired(`복구 후에도 현재 Project가 없습니다. projectId=${projectId}`);
    if (lock !== null) await this.#removeRecoveryLock(lock);
  }

  async #verifyCreateStaging(transactionId: string, journal: CreateJournal): Promise<void> {
    const transactionPath: string = this.#createTransactionPath(transactionId);
    const rootEntries = await readdir(transactionPath, { withFileTypes: true });
    const unknownRoot: string[] = rootEntries.map((entry): string => entry.name)
      .filter((name: string): boolean => name !== TRANSACTION_JOURNAL && name !== CREATE_STAGED_PROJECT_DIRECTORY);
    if (unknownRoot.length > 0) recoveryRequired(`Create staging에 증명되지 않은 항목이 있습니다. transactionId=${transactionId}, entries=${unknownRoot.join(',')}`);
    const stagedProject: string = join(transactionPath, CREATE_STAGED_PROJECT_DIRECTORY);
    if (!await pathExists(stagedProject)) return;
    const entries = await readdir(stagedProject, { withFileTypes: true });
    const allowed: Set<string> = new Set<string>(['project.json', 'versions', 'assets', TRANSACTIONS_DIRECTORY]);
    const unknown: string[] = entries.map((entry): string => entry.name).filter((name: string): boolean => !allowed.has(name));
    if (unknown.length > 0) recoveryRequired(`Create Project staging에 증명되지 않은 항목이 있습니다. transactionId=${transactionId}, entries=${unknown.join(',')}`);
    const currentPath: string = join(stagedProject, journal.currentFile.relativePath);
    if (await pathExists(currentPath)) await requireFileProof(currentPath, journal.currentFile.sha256, `Create current staging transactionId=${transactionId}`);
    const versionPath: string = join(stagedProject, journal.versionFile.relativePath);
    if (await pathExists(versionPath)) await requireFileProof(versionPath, journal.versionFile.sha256, `Create version staging transactionId=${transactionId}`);
    for (const directory of ['assets', TRANSACTIONS_DIRECTORY]) {
      const path: string = join(stagedProject, directory);
      if (await pathExists(path) && (await readdir(path)).length > 0) recoveryRequired(`Create staging의 ${directory} 디렉터리가 비어 있지 않습니다. transactionId=${transactionId}`);
    }
    const versionsPath: string = join(stagedProject, 'versions');
    if (await pathExists(versionsPath)) {
      const versionEntries: string[] = await readdir(versionsPath);
      if (versionEntries.some((name: string): boolean => name !== transactionVersionFileName(0))) {
        recoveryRequired(`Create staging에 증명되지 않은 revision 파일이 있습니다. transactionId=${transactionId}, entries=${versionEntries.join(',')}`);
      }
    }
  }

  async #removeCreateTransaction(transactionId: string, journal: CreateJournal): Promise<void> {
    await this.#verifyCreateStaging(transactionId, journal);
    const stagedProject: string = join(this.#createTransactionPath(transactionId), CREATE_STAGED_PROJECT_DIRECTORY);
    if (await pathExists(stagedProject)) await rm(stagedProject, { recursive: true, force: true });
    await removeCommittedFile(join(this.#createTransactionPath(transactionId), TRANSACTION_JOURNAL));
    await rmdir(this.#createTransactionPath(transactionId));
    await syncDirectory(this.#createTransactionsPath());
  }

  async #recoverCreateTransaction(transactionId: string): Promise<void> {
    const transactionPath: string = this.#createTransactionPath(transactionId);
    const journalPath: string = join(transactionPath, TRANSACTION_JOURNAL);
    if (!await pathExists(journalPath)) {
      if ((await readdir(transactionPath)).length !== 0) recoveryRequired(`journal이 없는 Create staging을 자동 삭제할 수 없습니다. transactionId=${transactionId}`);
      await rmdir(transactionPath);
      await syncDirectory(this.#createTransactionsPath());
      return;
    }
    let journal: CreateJournal;
    try {
      journal = CreateJournalSchema.parse(JSON.parse(await readFile(journalPath, 'utf8')) as unknown);
    } catch (error: unknown) {
      recoveryRequired(`Create journal을 검증할 수 없습니다. transactionId=${transactionId}, cause=${error instanceof Error ? error.message : String(error)}`);
    }
    if (journal.transactionId !== transactionId || journal.owner.transactionId !== transactionId
      || journal.projectDirectoryName !== projectKey(journal.projectId)
      || journal.currentFile.relativePath !== 'project.json' || journal.versionFile.relativePath !== `versions/${transactionVersionFileName(0)}`) {
      recoveryRequired(`Create journal 식별자 또는 경로가 일치하지 않습니다. transactionId=${transactionId}, projectId=${journal.projectId}`);
    }
    if (journal.owner.host !== hostname()) recoveryRequired(`다른 Host의 Create transaction을 자동 복구할 수 없습니다. transactionId=${transactionId}, ownerHost=${journal.owner.host}, currentHost=${hostname()}`);
    if (processIsAlive(journal.owner.pid)) throw contractError('PROJECT_BUSY', `${journal.projectId}: create transactionId=${transactionId}, pid=${journal.owner.pid} 작업이 진행 중입니다.`, []);
    await this.#verifyCreateStaging(transactionId, journal);
    const finalDirectory: string = this.#directory(journal.projectId);
    let outcome: StorageRecoveryEvent['outcome'] = 'create-rolled-back';
    if (await pathExists(finalDirectory)) {
      const currentPath: string = this.#currentPath(journal.projectId);
      if (!await pathExists(currentPath)) recoveryRequired(`Create 게시 디렉터리에 현재 Project가 없습니다. projectId=${journal.projectId}`);
      const current: Project = await readProject(currentPath);
      if (current.projectId !== journal.projectId) recoveryRequired(`Create 게시 디렉터리의 Project ID가 다릅니다. expected=${journal.projectId}, actual=${current.projectId}`);
      if (await fileSha256(currentPath) === journal.currentFile.sha256) {
        await requireFileProof(this.#versionPath(journal.projectId, 0), journal.versionFile.sha256,
          `Create revision commit 증명 실패 projectId=${journal.projectId}`);
        outcome = 'create-committed';
      }
    }
    await this.#removeCreateTransaction(transactionId, journal);
    this.#recordRecovery({ projectId: journal.projectId, transactionId, outcome });
  }

  async #initialize(): Promise<void> {
    await mkdir(this.#root, { recursive: true });
    await mkdir(this.#createTransactionsPath(), { recursive: true });
    const creates = await readdir(this.#createTransactionsPath(), { withFileTypes: true });
    for (const entry of creates.filter((value): boolean => value.isDirectory())) await this.#recoverCreateTransaction(entry.name);
    const entries = await readdir(this.#root, { withFileTypes: true });
    for (const entry of entries.filter((value): boolean => value.isDirectory() && value.name !== CREATE_TRANSACTIONS_DIRECTORY)) {
      await this.#recoverProjectDirectory(entry.name);
    }
  }

  async #assetForProject(project: Project, assetId: string): Promise<StoredAsset> {
    const asset: Asset | undefined = project.assets.find((value: Asset): boolean => value.id === assetId);
    if (asset === undefined) throw contractError('ASSET_NOT_FOUND', `자산을 찾을 수 없습니다. assetId=${assetId}`, []);
    const content: Buffer = await this.#rawAssetContent(project, asset);
    await verifyStoredAsset(project, asset, content);
    return { content, mimeType: asset.mimeType, asset };
  }

  async #rawAssetContent(project: Project, asset: Asset): Promise<Buffer> {
    const path: string = this.#safeAssetPath(project.projectId, asset);
    let content: Buffer;
    try {
      content = await readFile(path);
    } catch (error: unknown) {
      if (isMissingFile(error)) throw contractError('ASSET_FILE_MISSING', `자산 파일이 없습니다. assetId=${asset.id}, path=${asset.path}`, []);
      throw error;
    }
    const actualHash: string = sha256Bytes(content);
    if (actualHash !== asset.sha256) {
      throw contractError('ASSET_HASH_MISMATCH', `저장 파일 해시가 Asset metadata와 다릅니다. assetId=${asset.id}, expected=${asset.sha256}, actual=${actualHash}`, []);
    }
    return content;
  }

  async #summary(project: Project, updatedAt: string): Promise<ProjectSummary> {
    let framesOutputSafe: number = 0;
    for (const frame of project.frames) {
      const decision = reviewFrameOutput(project, frame.id, 'program-monitor');
      if (!decision.renderBitmap || decision.imageAssetId === null) continue;
      try {
        await this.#assetForProject(project, decision.imageAssetId);
        framesOutputSafe += 1;
      } catch (error: unknown) {
        if (assetFailureCode(error) === null) throw error;
      }
    }
    let audioPlayable: number = 0;
    let audioRepairRequired: number = 0;
    for (const cue of project.audioCues) {
      const playable: boolean = reviewAudioPlaybackAt(project, cue.startMs).playable.some((candidate): boolean => candidate.id === cue.id);
      if (cue.assetId === null) continue;
      try {
        await this.#assetForProject(project, cue.assetId);
        if (playable) audioPlayable += 1;
      } catch (error: unknown) {
        const code: string | null = assetFailureCode(error);
        if (code === null) throw error;
        if (code.startsWith('AUDIO_ASSET_')) audioRepairRequired += 1;
      }
    }
    const textPlayable: number = project.textCues.filter((cue): boolean => reviewTextPlaybackAt(project, cue.startMs).playable
      .some((candidate): boolean => candidate.id === cue.id)).length;
    const blockedOutputCount: number = project.frames.length - framesOutputSafe + project.audioCues.length - audioPlayable
      + project.textCues.length - textPlayable;
    return { projectId: project.projectId, title: project.title, revision: project.revision,
      durationMs: project.dataset.segments.at(-1)?.endMs ?? 0, shots: project.shots.length,
      framesWithAsset: project.frames.filter((frame): boolean => frame.imageAssetId !== null).length,
      framesAccepted: project.frames.filter((frame): boolean => frame.visualReview === 'accepted').length,
      framesOutputSafe, framesTotal: project.frames.length,
      audioWithAsset: project.audioCues.filter((cue): boolean => cue.assetId !== null).length,
      audioMeasured: project.audioCues.filter((cue): boolean => cue.timingStatus === 'measured').length,
      audioPlayable, audioRepairRequired, audioTotal: project.audioCues.length, textPlayable, textTotal: project.textCues.length,
      blockedOutputCount, issues: project.importIssues.length, updatedAt };
  }

  async initialize(): Promise<void> {
    if (this.#initialization === null) this.#initialization = this.#initialize();
    try {
      await this.#initialization;
    } catch (error: unknown) {
      this.#initialization = null;
      throw error;
    }
  }

  recoveryEvents(): readonly StorageRecoveryEvent[] {
    return [...this.#recoveryEvents];
  }

  async list(): Promise<ProjectSummary[]> {
    await this.initialize();
    const entries = await readdir(this.#root, { withFileTypes: true });
    const summaries: ProjectSummary[] = [];
    for (const entry of entries.filter((value): boolean => value.isDirectory() && value.name !== CREATE_TRANSACTIONS_DIRECTORY)) {
      const path: string = join(this.#root, entry.name, 'project.json');
      try {
        const project: Project = await readProject(path);
        const metadata = await stat(path);
        summaries.push(await this.#summary(project, metadata.mtime.toISOString()));
      } catch (error: unknown) {
        if (isMissingFile(error)) continue;
        throw error;
      }
    }
    return summaries.sort((left: ProjectSummary, right: ProjectSummary): number => right.updatedAt.localeCompare(left.updatedAt));
  }

  async read(projectId: string): Promise<Project> {
    await this.initialize();
    try {
      return await readProject(this.#currentPath(projectId));
    } catch (error: unknown) {
      if (!isMissingFile(error)) throw error;
      throw contractError('PROJECT_NOT_FOUND', `저장된 프로젝트를 찾을 수 없습니다: ${projectId}`, []);
    }
  }

  async create(project: Project): Promise<Project> {
    const valid: Project = parseProject(project);
    if (valid.revision !== 0) throw contractError('INITIAL_PROJECT_REVISION_INVALID', `새 Project revision은 0이어야 합니다. projectId=${valid.projectId}, revision=${valid.revision}`, []);
    await this.initialize();
    const directory: string = this.#directory(valid.projectId);
    if (await pathExists(directory)) throw contractError('PROJECT_ALREADY_EXISTS', `같은 프로젝트 ID가 이미 저장되어 있습니다: ${valid.projectId}`, []);
    const transactionId: string = randomUUID();
    const transactionPath: string = this.#createTransactionPath(transactionId);
    const stagedDirectory: string = join(transactionPath, CREATE_STAGED_PROJECT_DIRECTORY);
    const content: string = exportProjectJson(valid);
    const contentSha256: string = sha256Text(content);
    const journal: CreateJournal = CreateJournalSchema.parse({
      version: 2, operation: 'create', transactionId, projectId: valid.projectId, owner: transactionOwner(transactionId),
      projectDirectoryName: projectKey(valid.projectId),
      currentFile: { relativePath: 'project.json', sha256: contentSha256 },
      versionFile: { relativePath: `versions/${transactionVersionFileName(0)}`, sha256: contentSha256 },
    });
    let published: boolean = false;
    try {
      await mkdir(transactionPath);
      await writeDurableFile(join(transactionPath, TRANSACTION_JOURNAL), JSON.stringify(journal));
      await syncDirectory(transactionPath);
      await syncDirectory(this.#createTransactionsPath());
      await mkdir(stagedDirectory);
      await mkdir(join(stagedDirectory, 'versions'));
      await mkdir(join(stagedDirectory, 'assets'));
      await mkdir(join(stagedDirectory, TRANSACTIONS_DIRECTORY));
      await writeDurableFile(join(stagedDirectory, journal.versionFile.relativePath), content);
      await syncDirectory(join(stagedDirectory, 'versions'));
      await writeDurableFile(join(stagedDirectory, journal.currentFile.relativePath), content);
      await syncDirectory(stagedDirectory);
      if (await pathExists(directory)) throw contractError('PROJECT_ALREADY_EXISTS', `같은 프로젝트 ID가 이미 저장되어 있습니다: ${valid.projectId}`, []);
      await rename(stagedDirectory, directory);
      published = true;
      await syncDirectory(this.#root);
      await requireFileProof(this.#currentPath(valid.projectId), contentSha256, `Initial Project 게시 검증 projectId=${valid.projectId}`);
      await requireFileProof(this.#versionPath(valid.projectId, 0), contentSha256, `Initial revision 게시 검증 projectId=${valid.projectId}`);
      await this.#removeCreateTransaction(transactionId, journal);
    } catch (error: unknown) {
      if (!published && await pathExists(transactionPath)) {
        try {
          await rm(transactionPath, { recursive: true, force: true });
          await syncDirectory(this.#createTransactionsPath());
        } catch (cleanupError: unknown) {
          throw new AggregateError([error, cleanupError], `Initial Project 생성 실패 후 staging 정리도 실패했습니다. projectId=${valid.projectId}, transactionId=${transactionId}`);
        }
      }
      throw error;
    }
    return valid;
  }

  async update(projectId: string, expectedRevision: number, transform: (project: Project) => Project, assetWrites: readonly AssetWrite[]): Promise<Project> {
    await this.initialize();
    const directory: string = this.#directory(projectId);
    const lockPath: string = join(directory, 'write.lock');
    const transactionId: string = randomUUID();
    const lock: AcquiredProjectLock = await acquireProjectLock(lockPath, directory, projectId, transactionId);
    const transactionsPath: string = this.#transactionsPath(projectId);
    const stagingDirectory: string = this.#transactionPath(projectId, transactionId);
    let transactionPrepared: boolean = false;
    let operationError: unknown = null;
    let result: Project | null = null;
    try {
      const current: Project = await this.read(projectId);
      if (current.revision !== expectedRevision) throw contractError('REVISION_CONFLICT', `${projectId}: expected=${expectedRevision}, actual=${current.revision}`, []);
      const changed: Project = transform(current);
      const next: Project = parseProject({ ...changed, projectId: current.projectId, revision: current.revision + 1 });
      const content: string = exportProjectJson(next);
      const previousContent: string = exportProjectJson(current);
      await mkdir(transactionsPath, { recursive: true });
      await mkdir(stagingDirectory);
      const stagedProject: string = join(stagingDirectory, TRANSACTION_NEXT_PROJECT);
      const stagedVersion: string = join(stagingDirectory, TRANSACTION_NEXT_VERSION);
      await writeDurableFile(join(stagingDirectory, TRANSACTION_PREVIOUS_PROJECT), previousContent);
      await writeDurableFile(stagedProject, content);
      await writeDurableFile(stagedVersion, content);
      const stagedAssets: Array<{ staged: string; final: string; proof: z.infer<typeof AssetProofSchema> }> = [];
      for (const [index, assetWrite] of assetWrites.entries()) {
        const matches: Asset[] = next.assets.filter((asset: Asset): boolean => asset.path === assetWrite.relativePath);
        const metadata: Asset | undefined = matches[0];
        if (matches.length !== 1 || metadata === undefined) throw contractError('ASSET_WRITE_UNDECLARED', `Project metadata의 자산 경로가 유일하지 않습니다. path=${assetWrite.relativePath}, matches=${matches.length}`, []);
        const final: string = this.#safeAssetPath(projectId, metadata);
        if (await pathExists(final)) throw contractError('ASSET_FILE_EXISTS', `새 자산 경로가 이미 존재합니다. path=${final}`, []);
        const stagedFileName: string = `asset-${index}.bin`;
        const staged: string = join(stagingDirectory, stagedFileName);
        await writeDurableFile(staged, assetWrite.content);
        await verifyStoredAsset(next, metadata, assetWrite.content);
        stagedAssets.push({ staged, final, proof: AssetProofSchema.parse({ assetId: metadata.id,
          relativePath: assetWrite.relativePath, sha256: sha256Bytes(assetWrite.content), stagedFileName }) });
      }
      const journal: TransactionJournal = TransactionJournalSchema.parse({ version: 2, operation: 'update', transactionId, projectId,
        owner: transactionOwner(transactionId), expectedRevision: current.revision, nextRevision: next.revision,
        previousProjectSha256: sha256Text(previousContent), nextProjectSha256: sha256Text(content),
        versionFile: { relativePath: `versions/${transactionVersionFileName(next.revision)}`, sha256: sha256Text(content) },
        assets: stagedAssets.map((item) => item.proof) });
      await writeDurableFile(join(stagingDirectory, TRANSACTION_JOURNAL), JSON.stringify(journal));
      await syncDirectory(stagingDirectory);
      await syncDirectory(transactionsPath);
      transactionPrepared = true;
      for (const item of stagedAssets) {
        await mkdir(dirname(item.final), { recursive: true });
        await link(item.staged, item.final);
        await unlink(item.staged);
      }
      await syncDirectory(join(directory, 'assets'));
      const committedVersion: string = join(directory, 'versions', transactionVersionFileName(next.revision));
      if (await pathExists(committedVersion)) throw contractError('PROJECT_VERSION_EXISTS', `Project revision snapshot이 이미 존재합니다. path=${committedVersion}`, []);
      await link(stagedVersion, committedVersion);
      await unlink(stagedVersion);
      await syncDirectory(join(directory, 'versions'));
      await rename(stagedProject, this.#currentPath(projectId));
      await syncDirectory(directory);
      await this.#verifyCommittedTransaction(next, journal);
      await this.#removeVerifiedTransaction(projectId, transactionId, journal);
      result = next;
    } catch (error: unknown) {
      operationError = error;
      try {
        if (transactionPrepared) {
          const journal: TransactionJournal = await this.#readTransactionJournal(projectId, transactionId);
          const projects = await this.#transactionProjects(projectId, transactionId, journal);
          if (await pathExists(this.#currentPath(projectId))) {
            const currentAfterFailure: Project = await readProject(this.#currentPath(projectId));
            if (currentAfterFailure.revision === journal.nextRevision) {
              await requireFileProof(this.#currentPath(projectId), journal.nextProjectSha256,
                `실패한 저장의 현재 Project 증명 projectId=${projectId}, transactionId=${transactionId}`);
              await this.#restorePreviousProject(projectId, transactionId, journal, projects.previous, projects.previousContent);
            } else if (currentAfterFailure.revision === journal.expectedRevision) {
              await requireFileProof(this.#currentPath(projectId), journal.previousProjectSha256,
                `실패한 저장의 이전 Project 증명 projectId=${projectId}, transactionId=${transactionId}`);
              await this.#removePublishedTransactionFiles(projectId, journal, currentAfterFailure);
            } else if (currentAfterFailure.revision < journal.nextRevision) {
              recoveryRequired(`실패한 저장의 현재 revision을 안전하게 복구할 수 없습니다. projectId=${projectId}, transactionId=${transactionId}, revision=${currentAfterFailure.revision}`);
            }
          } else {
            await this.#restorePreviousProject(projectId, transactionId, journal, projects.previous, projects.previousContent);
          }
          await this.#removeVerifiedTransaction(projectId, transactionId, journal);
        } else if (await pathExists(stagingDirectory)) {
          await rm(stagingDirectory, { recursive: true, force: true });
          await syncDirectory(transactionsPath);
        }
      } catch (rollbackError: unknown) {
        operationError = new AggregateError([error, rollbackError], `프로젝트 저장 실패 후 transaction rollback도 실패했습니다. projectId=${projectId}, transactionId=${transactionId}`);
      }
    }
    let lockError: unknown = null;
    try {
      await releaseProjectLock(lock, lockPath, directory, projectId);
    } catch (error: unknown) {
      lockError = error;
    }
    if (operationError !== null && lockError !== null) throw new AggregateError([operationError, lockError], `프로젝트 저장과 lock 해제가 모두 실패했습니다. projectId=${projectId}`);
    if (operationError !== null) throw operationError;
    if (lockError !== null) throw lockError;
    if (result === null) throw contractError('PROJECT_UPDATE_RESULT_MISSING', `Project 저장 결과가 없습니다. projectId=${projectId}`, []);
    return result;
  }

  async asset(projectId: string, assetId: string): Promise<StoredAsset> {
    return this.#assetForProject(await this.read(projectId), assetId);
  }

  async assetIntegrity(projectId: string): Promise<Record<string, string>> {
    const project: Project = await this.read(projectId);
    const result: Record<string, string> = {};
    for (const asset of project.assets) {
      try {
        await this.#assetForProject(project, asset.id);
        result[asset.id] = 'verified';
      } catch (error: unknown) {
        const code: string | null = assetFailureCode(error);
        if (code === null) throw error;
        result[asset.id] = code;
      }
    }
    return result;
  }

  async audioRecoverySource(project: Project, cueId: string): Promise<AudioAssetRecoverySource> {
    const cue = project.audioCues.find((candidate): boolean => candidate.id === cueId);
    if (cue === undefined) throw contractError('AUDIO_CUE_NOT_FOUND', `오디오 큐를 찾을 수 없습니다. cueId=${cueId}`, []);
    if (cue.assetId === null) throw contractError('AUDIO_ASSET_NOT_FOUND', `복구할 오디오 자산이 없습니다. cueId=${cueId}`, []);
    const asset: Asset | undefined = project.assets.find((candidate: Asset): boolean => candidate.id === cue.assetId);
    if (asset === undefined || asset.kind !== 'audio') throw contractError('AUDIO_ASSET_NOT_FOUND', `복구할 Audio Asset을 찾을 수 없습니다. cueId=${cueId}, assetId=${cue.assetId}`, []);
    if (asset.subjectId !== cue.id) throw contractError('AUDIO_ASSET_SUBJECT_MISMATCH', `Audio Asset 대상이 Cue와 다릅니다. cueId=${cue.id}, assetId=${asset.id}, subjectId=${String(asset.subjectId)}`, []);
    const content: Buffer = await this.#rawAssetContent(project, asset);
    const inspection: InspectedAudioFile = inspectAudioFileBytes(content, asset.mimeType);
    const metadataMatches: boolean = asset.durationMs === inspection.durationMs && asset.audioMetadata !== undefined && asset.audioMetadata !== null
      && asset.audioMetadata.sampleRate === inspection.sampleRate && asset.audioMetadata.channels === inspection.channels
      && asset.audioMetadata.codec === inspection.codec;
    const timelineMatches: boolean = cue.timingStatus === 'measured' && cue.endMs - cue.startMs === inspection.durationMs;
    const formatMatches: boolean = inspection.sampleRate === project.handoff.timebase.sampleRate && inspection.codec === 'pcm_s16le';
    if (metadataMatches && timelineMatches && formatMatches) {
      throw contractError('AUDIO_ASSET_ALREADY_NORMALIZED', `Audio Asset이 이미 현재 Project 형식과 일치합니다. cueId=${cueId}, assetId=${asset.id}`, []);
    }
    return { content, asset, inspection };
  }

  async safeFrame(projectId: string, frameId: string): Promise<StoredAsset> {
    const project: Project = await this.read(projectId);
    const decision = reviewFrameOutput(project, frameId, 'program-monitor');
    if (!decision.renderBitmap || decision.imageAssetId === null) {
      throw contractError('FRAME_OUTPUT_BLOCKED', decision.issues.map((value): string => `${value.code}: ${value.message}`).join('\n'), decision.issues);
    }
    const stored: StoredAsset = await this.#assetForProject(project, decision.imageAssetId);
    if (stored.asset.kind !== 'image') throw contractError('FRAME_OUTPUT_BLOCKED', `프레임 출력 자산이 이미지가 아닙니다. frameId=${frameId}`, []);
    return stored;
  }

  async safeAudio(projectId: string, cueId: string): Promise<StoredAsset> {
    const project: Project = await this.read(projectId);
    const cue = project.audioCues.find((candidate): boolean => candidate.id === cueId);
    if (cue === undefined) throw contractError('AUDIO_CUE_NOT_FOUND', `오디오 큐를 찾을 수 없습니다. cueId=${cueId}`, []);
    const review = reviewAudioPlaybackAt(project, cue.startMs);
    if (!review.playable.some((candidate): boolean => candidate.id === cue.id)) {
      const issues = review.blocked.find((blocked): boolean => blocked.cueId === cue.id)?.issues ?? [];
      throw contractError('AUDIO_OUTPUT_BLOCKED', issues.map((value): string => `${value.code}: ${value.message}`).join('\n'), issues);
    }
    if (cue.assetId === null) throw contractError('AUDIO_ASSET_NOT_FOUND', `오디오 자산이 없습니다. cueId=${cue.id}`, []);
    let stored: StoredAsset;
    try {
      stored = await this.#assetForProject(project, cue.assetId);
    } catch (error: unknown) {
      const code: string | null = assetFailureCode(error);
      if (code === null) throw error;
      const audioCode: string = code === 'ASSET_FILE_MISSING' ? 'AUDIO_ASSET_FILE_MISSING'
        : code === 'ASSET_HASH_MISMATCH' ? 'AUDIO_ASSET_HASH_MISMATCH'
          : code.startsWith('AUDIO_ASSET_') ? code : 'AUDIO_ASSET_CORRUPT';
      throw contractError(audioCode, `안전 오디오 출력용 자산을 검증할 수 없습니다. cueId=${cue.id}, assetId=${cue.assetId}, cause=${code}`, []);
    }
    if (stored.asset.kind !== 'audio') throw contractError('AUDIO_OUTPUT_BLOCKED', `오디오 출력 자산의 유형이 다릅니다. cueId=${cue.id}`, []);
    return stored;
  }

  async assetPath(projectId: string, assetId: string): Promise<string> {
    const project: Project = await this.read(projectId);
    const asset: Asset | undefined = project.assets.find((value: Asset): boolean => value.id === assetId);
    if (asset === undefined) throw contractError('ASSET_NOT_FOUND', `자산을 찾을 수 없습니다. assetId=${assetId}`, []);
    return this.#safeAssetPath(projectId, asset);
  }
}

import { randomUUID } from 'node:crypto';
import { mkdir, open, readdir, readFile, rename, rm, stat, unlink } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
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
import { parseProject, readProject, writeNewText } from '../io/project.js';

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
  outcome: 'committed' | 'rolled-back' | 'restored-previous' | 'staging-removed' | 'stale-lock-removed';
};

const TransactionJournalSchema = z.strictObject({
  version: z.literal(1), transactionId: z.uuid(), projectId: z.string().min(1),
  expectedRevision: z.number().int().nonnegative(), nextRevision: z.number().int().positive(),
  assetRelativePaths: z.array(z.string()).refine((paths: string[]): boolean => new Set(paths).size === paths.length),
});
type TransactionJournal = z.infer<typeof TransactionJournalSchema>;
const StoreLockSchema = z.strictObject({ version: z.literal(1), pid: z.number().int().positive(), createdAt: z.iso.datetime() });
type StoreLock = z.infer<typeof StoreLockSchema>;

const TRANSACTIONS_DIRECTORY: string = '.transactions';
const TRANSACTION_JOURNAL: string = 'journal.json';
const TRANSACTION_NEXT_PROJECT: string = 'project.next.json';
const TRANSACTION_PREVIOUS_PROJECT: string = 'project.previous.json';
const TRANSACTION_NEXT_VERSION: string = 'version.next.json';

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

async function acquireProjectLock(lockPath: string, directory: string, projectId: string): Promise<FileHandle> {
  let handle: FileHandle | null = null;
  try {
    handle = await open(lockPath, 'wx', 0o600);
    await handle.writeFile(JSON.stringify({ version: 1, pid: process.pid, createdAt: new Date().toISOString() } satisfies StoreLock));
    await handle.sync();
    await syncDirectory(directory);
    return handle;
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

async function releaseProjectLock(handle: FileHandle, lockPath: string, directory: string, projectId: string): Promise<void> {
  const errors: unknown[] = [];
  try { await handle.close(); } catch (error: unknown) { errors.push(error); }
  try { await removeCommittedFile(lockPath); } catch (error: unknown) { errors.push(error); }
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

  async #removeTransaction(projectId: string, transactionId: string): Promise<void> {
    await rm(this.#transactionPath(projectId, transactionId), { recursive: true, force: true });
    await syncDirectory(this.#transactionsPath(projectId));
  }

  async #removePublishedTransactionFiles(projectId: string, journal: TransactionJournal): Promise<void> {
    const paths: string[] = journal.assetRelativePaths.map((relativePath: string): string => this.#safeJournalAssetPath(projectId, relativePath));
    paths.push(join(this.#directory(projectId), 'versions', transactionVersionFileName(journal.nextRevision)));
    await Promise.all(paths.map(removeCommittedFile));
    await syncDirectory(join(this.#directory(projectId), 'assets'));
    await syncDirectory(join(this.#directory(projectId), 'versions'));
  }

  async #restorePreviousProject(projectId: string, transactionId: string, journal: TransactionJournal): Promise<void> {
    const previousPath: string = join(this.#transactionPath(projectId, transactionId), TRANSACTION_PREVIOUS_PROJECT);
    const previousContent: string = await readFile(previousPath, 'utf8');
    const previous: Project = parseProject(JSON.parse(previousContent) as unknown);
    if (previous.projectId !== projectId || previous.revision !== journal.expectedRevision) {
      throw contractError('TRANSACTION_PREVIOUS_PROJECT_INVALID', `복구용 이전 Project가 journal과 일치하지 않습니다. projectId=${projectId}, expectedRevision=${journal.expectedRevision}, actual=${previous.projectId}/${previous.revision}`, []);
    }
    await replaceDurableFile(this.#currentPath(projectId), previousContent, transactionId);
    await this.#removePublishedTransactionFiles(projectId, journal);
  }

  async #verifyCommittedTransaction(project: Project, journal: TransactionJournal): Promise<void> {
    const versionPath: string = join(this.#directory(project.projectId), 'versions', transactionVersionFileName(journal.nextRevision));
    const version: Project = await readProject(versionPath);
    if (JSON.stringify(version) !== JSON.stringify(project)) {
      throw contractError('TRANSACTION_VERSION_MISMATCH', `현재 Project와 revision snapshot이 다릅니다. projectId=${project.projectId}, revision=${journal.nextRevision}`, []);
    }
    for (const relativePath of journal.assetRelativePaths) {
      const asset: Asset | undefined = project.assets.find((candidate: Asset): boolean => candidate.path === relativePath);
      if (asset === undefined) throw contractError('TRANSACTION_ASSET_METADATA_MISSING', `게시된 Project에 journal 자산 metadata가 없습니다. projectId=${project.projectId}, path=${relativePath}`, []);
      const content: Buffer = await readFile(this.#safeJournalAssetPath(project.projectId, relativePath));
      await verifyStoredAsset(project, asset, content);
    }
  }

  async #recoverTransaction(projectId: string, transactionId: string): Promise<void> {
    const transactionPath: string = this.#transactionPath(projectId, transactionId);
    const journalPath: string = join(transactionPath, TRANSACTION_JOURNAL);
    if (!await pathExists(journalPath)) {
      await this.#removeTransaction(projectId, transactionId);
      this.#recordRecovery({ projectId, transactionId, outcome: 'staging-removed' });
      return;
    }
    let journal: TransactionJournal;
    try {
      journal = TransactionJournalSchema.parse(JSON.parse(await readFile(journalPath, 'utf8')) as unknown);
    } catch (error: unknown) {
      const message: string = error instanceof Error ? error.message : String(error);
      throw contractError('TRANSACTION_JOURNAL_CORRUPT', `Transaction journal을 읽을 수 없습니다. projectId=${projectId}, transactionId=${transactionId}, cause=${message}`, []);
    }
    if (journal.projectId !== projectId || journal.transactionId !== transactionId || journal.nextRevision !== journal.expectedRevision + 1) {
      throw contractError('TRANSACTION_JOURNAL_MISMATCH', `Transaction journal 식별자 또는 revision이 일치하지 않습니다. projectId=${projectId}, transactionId=${transactionId}`, []);
    }
    const current: Project = await readProject(this.#currentPath(projectId));
    if (current.revision === journal.expectedRevision) {
      await this.#removePublishedTransactionFiles(projectId, journal);
      await this.#removeTransaction(projectId, transactionId);
      this.#recordRecovery({ projectId, transactionId, outcome: 'rolled-back' });
      return;
    }
    if (current.revision === journal.nextRevision) {
      try {
        await this.#verifyCommittedTransaction(current, journal);
        await this.#removeTransaction(projectId, transactionId);
        this.#recordRecovery({ projectId, transactionId, outcome: 'committed' });
      } catch (error: unknown) {
        await this.#restorePreviousProject(projectId, transactionId, journal);
        await this.#removeTransaction(projectId, transactionId);
        this.#recordRecovery({ projectId, transactionId, outcome: 'restored-previous' });
        console.warn(JSON.stringify({ event: 'project-store-recovery-cause', projectId, transactionId,
          cause: error instanceof Error ? error.message : String(error) }));
      }
      return;
    }
    if (current.revision > journal.nextRevision) {
      await this.#removeTransaction(projectId, transactionId);
      this.#recordRecovery({ projectId, transactionId, outcome: 'committed' });
      return;
    }
    throw contractError('TRANSACTION_REVISION_INCONSISTENT', `현재 revision이 Transaction journal과 일치하지 않습니다. projectId=${projectId}, current=${current.revision}, expected=${journal.expectedRevision}, next=${journal.nextRevision}`, []);
  }

  async #recoverLock(projectId: string): Promise<void> {
    const lockPath: string = join(this.#directory(projectId), 'write.lock');
    if (!await pathExists(lockPath)) return;
    let lock: StoreLock;
    try {
      lock = StoreLockSchema.parse(JSON.parse(await readFile(lockPath, 'utf8')) as unknown);
    } catch (error: unknown) {
      const message: string = error instanceof Error ? error.message : String(error);
      throw contractError('PROJECT_LOCK_CORRUPT', `Project lock을 읽을 수 없습니다. projectId=${projectId}, cause=${message}`, []);
    }
    if (processIsAlive(lock.pid)) throw contractError('PROJECT_BUSY', `${projectId}: pid=${lock.pid} 저장 작업이 진행 중입니다.`, []);
    await unlink(lockPath);
    await syncDirectory(this.#directory(projectId));
    this.#recordRecovery({ projectId, transactionId: 'lock', outcome: 'stale-lock-removed' });
  }

  async #recoverProjectDirectory(directoryName: string): Promise<void> {
    const currentPath: string = join(this.#root, directoryName, 'project.json');
    if (!await pathExists(currentPath)) return;
    const project: Project = await readProject(currentPath);
    if (resolve(this.#directory(project.projectId)) !== resolve(join(this.#root, directoryName))) {
      throw contractError('PROJECT_DIRECTORY_MISMATCH', `Project ID와 저장 디렉터리가 일치하지 않습니다. projectId=${project.projectId}, directory=${directoryName}`, []);
    }
    await this.#recoverLock(project.projectId);
    const transactionsPath: string = this.#transactionsPath(project.projectId);
    await mkdir(transactionsPath, { recursive: true });
    const transactions = await readdir(transactionsPath, { withFileTypes: true });
    for (const transaction of transactions.filter((entry): boolean => entry.isDirectory())) {
      await this.#recoverTransaction(project.projectId, transaction.name);
    }
  }

  async #initialize(): Promise<void> {
    await mkdir(this.#root, { recursive: true });
    const entries = await readdir(this.#root, { withFileTypes: true });
    for (const entry of entries.filter((value): boolean => value.isDirectory())) await this.#recoverProjectDirectory(entry.name);
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
    for (const entry of entries.filter((value): boolean => value.isDirectory())) {
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
    const directory: string = this.#directory(valid.projectId);
    await this.initialize();
    try {
      await mkdir(directory);
    } catch (error: unknown) {
      if (error instanceof Error && 'code' in error && error.code === 'EEXIST') throw contractError('PROJECT_ALREADY_EXISTS', `같은 프로젝트 ID가 이미 저장되어 있습니다: ${valid.projectId}`, []);
      throw error;
    }
    await mkdir(join(directory, 'versions'), { recursive: true });
    await mkdir(join(directory, 'assets'), { recursive: true });
    await mkdir(join(directory, TRANSACTIONS_DIRECTORY), { recursive: true });
    const content: string = exportProjectJson(valid);
    await writeNewText(join(directory, 'versions', '000000.json'), content);
    await writeNewText(this.#currentPath(valid.projectId), content);
    return valid;
  }

  async update(projectId: string, expectedRevision: number, transform: (project: Project) => Project, assetWrites: readonly AssetWrite[]): Promise<Project> {
    await this.initialize();
    const directory: string = this.#directory(projectId);
    const lockPath: string = join(directory, 'write.lock');
    const lock: FileHandle = await acquireProjectLock(lockPath, directory, projectId);
    const transactionId: string = randomUUID();
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
      await mkdir(transactionsPath, { recursive: true });
      await mkdir(stagingDirectory);
      const stagedProject: string = join(stagingDirectory, TRANSACTION_NEXT_PROJECT);
      const stagedVersion: string = join(stagingDirectory, TRANSACTION_NEXT_VERSION);
      await writeDurableFile(join(stagingDirectory, TRANSACTION_PREVIOUS_PROJECT), exportProjectJson(current));
      await writeDurableFile(stagedProject, content);
      await writeDurableFile(stagedVersion, content);
      const stagedAssets: { staged: string; final: string }[] = [];
      for (const assetWrite of assetWrites) {
        const matches: Asset[] = next.assets.filter((asset: Asset): boolean => asset.path === assetWrite.relativePath);
        const metadata: Asset | undefined = matches[0];
        if (matches.length !== 1 || metadata === undefined) throw contractError('ASSET_WRITE_UNDECLARED', `Project metadata의 자산 경로가 유일하지 않습니다. path=${assetWrite.relativePath}, matches=${matches.length}`, []);
        const final: string = this.#safeAssetPath(projectId, metadata);
        if (await pathExists(final)) throw contractError('ASSET_FILE_EXISTS', `새 자산 경로가 이미 존재합니다. path=${final}`, []);
        const staged: string = join(stagingDirectory, `asset-${stagedAssets.length}.bin`);
        await writeDurableFile(staged, assetWrite.content);
        await verifyStoredAsset(next, metadata, assetWrite.content);
        stagedAssets.push({ staged, final });
      }
      const journal: TransactionJournal = TransactionJournalSchema.parse({ version: 1, transactionId, projectId,
        expectedRevision: current.revision, nextRevision: next.revision, assetRelativePaths: assetWrites.map((assetWrite: AssetWrite): string => assetWrite.relativePath) });
      await writeDurableFile(join(stagingDirectory, TRANSACTION_JOURNAL), JSON.stringify(journal));
      await syncDirectory(stagingDirectory);
      await syncDirectory(transactionsPath);
      transactionPrepared = true;
      for (const item of stagedAssets) {
        await mkdir(dirname(item.final), { recursive: true });
        await rename(item.staged, item.final);
      }
      await syncDirectory(join(directory, 'assets'));
      const committedVersion: string = join(directory, 'versions', transactionVersionFileName(next.revision));
      if (await pathExists(committedVersion)) throw contractError('PROJECT_VERSION_EXISTS', `Project revision snapshot이 이미 존재합니다. path=${committedVersion}`, []);
      await rename(stagedVersion, committedVersion);
      await syncDirectory(join(directory, 'versions'));
      await rename(stagedProject, this.#currentPath(projectId));
      await syncDirectory(directory);
      await this.#verifyCommittedTransaction(next, journal);
      await this.#removeTransaction(projectId, transactionId);
      result = next;
    } catch (error: unknown) {
      operationError = error;
      try {
        if (transactionPrepared) {
          const journal: TransactionJournal = TransactionJournalSchema.parse(JSON.parse(await readFile(join(stagingDirectory, TRANSACTION_JOURNAL), 'utf8')) as unknown);
          if (await pathExists(this.#currentPath(projectId))) {
            const currentAfterFailure: Project = await readProject(this.#currentPath(projectId));
            if (currentAfterFailure.revision === journal.nextRevision) await this.#restorePreviousProject(projectId, transactionId, journal);
            else await this.#removePublishedTransactionFiles(projectId, journal);
          }
        }
        if (await pathExists(stagingDirectory)) await this.#removeTransaction(projectId, transactionId);
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

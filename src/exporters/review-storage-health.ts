import { z } from 'zod';
import { contractError, issue } from '../domain/errors.js';
import type { Issue, Project } from '../domain/schema.js';
import { sha256Bytes, sha256Text } from '../importers/integrity.js';
import { parseProject } from '../io/project.js';
import { stableJsonStringify } from '../io/stable-json.js';
import { SafeStoreFilesystem } from '../server/safe-filesystem.js';
import { CreateJournalSchema, StorageRecoveryBlockSchema, StoreLockSchema, TransactionJournalSchema } from '../server/store.js';
import { exportProjectJson } from './json.js';

export type ReviewStorageHealth = {
  projectId: string; currentRevision: number; quiescent: boolean; activeProjectLock: boolean; activeCreateLock: boolean;
  pendingTransactionIds: string[]; pendingCreateTransactionIds: string[];
  recoveryBlocks: { path: string; code: string | null }[];
  futureVersionRevisions: number[]; invalidEvidenceEntries: string[]; issues: Issue[];
};
export type ReviewStorageSnapshot = { health: ReviewStorageHealth; evidence: Readonly<Record<string, string>> };
type EvidenceEntry = { path: string; kind: 'file' | 'directory' | 'invalid'; bytes: Buffer | null; digest: string; errorCode: string | null };
const IdentitySchema = z.object({ projectId: z.string().min(1) });

function inspectionErrorCode(error: unknown): string {
  if (error instanceof SyntaxError) return 'INVALID_JSON';
  if (error instanceof z.ZodError) return 'INVALID_STORAGE_SCHEMA';
  if (error instanceof Error && 'code' in error && typeof error.code === 'string') return error.code;
  throw error;
}
function storageIssue(projectId: string, path: string, code: string, actual: string | null): Issue {
  return issue(code, 'conflict', projectId, path, '검토 원본의 저장 작업 또는 복구 근거를 확인하고 안정된 Snapshot에서 다시 출력하세요.', 'quiescent verified storage', actual, []);
}
function rawJson(entry: EvidenceEntry): unknown {
  if (entry.bytes === null) return null;
  try { return JSON.parse(entry.bytes.toString('utf8')) as unknown; }
  catch (error: unknown) { if (!(error instanceof SyntaxError)) throw error; return null; }
}

/** symlink를 따라가지 않고 파일 바이트와 identity만 관측한다. 복구·쓰기 작업은 수행하지 않는다. */
async function evidenceTree(fs: SafeStoreFilesystem, path: string): Promise<EvidenceEntry[]> {
  try {
    const kind = await fs.kind(fs.path(path));
    if (kind === 'missing') return [];
    if (kind === 'directory') {
      const entries = (await fs.entries(fs.path(path))).sort((a, b): number => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
      const children: EvidenceEntry[][] = [];
      for (const entry of entries) children.push(await evidenceTree(fs, `${path}/${entry.name}`));
      return [{ path, kind, bytes: null, digest: 'directory', errorCode: null }, ...children.flat()];
    }
    const before = await fs.identity(fs.path(path)); const bytes: Buffer = await fs.read(fs.path(path)); const after = await fs.identity(fs.path(path));
    if (before.dev !== after.dev || before.ino !== after.ino) throw contractError('REVIEW_STORAGE_EVIDENCE_CHANGED', '검토 중 저장 근거의 파일 identity가 변경됐습니다.', []);
    return [{ path, kind, bytes, digest: `${after.dev}:${after.ino}:${sha256Bytes(bytes)}`, errorCode: null }];
  } catch (error: unknown) {
    const code: string = inspectionErrorCode(error);
    return [{ path, kind: 'invalid', bytes: null, digest: `invalid:${code}`, errorCode: code }];
  }
}
function entryOwner(entry: EvidenceEntry): string | null {
  const result = IdentitySchema.safeParse(rawJson(entry)); return result.success ? result.data.projectId : null;
}
function relevantRootEntry(entry: EvidenceEntry, projectId: string, projectKey: string): boolean {
  if (entry.path.startsWith('.recovery-blocks/') && !entry.path.startsWith('.recovery-blocks/.invalid/')) {
    const scoped = StorageRecoveryBlockSchema.safeParse(rawJson(entry));
    // 원본 ID를 못 읽었어도 검증한 파일명·폴더 key가 일치하면 다른 폴더의 복구 표시로 분리한다.
    if (scoped.success && scoped.data.directoryName !== projectKey
      && scoped.data.projectId === `unknown:${scoped.data.directoryName}`
      && entry.path === `.recovery-blocks/${scoped.data.directoryName}.json`) return false;
  }
  const owner: string | null = entryOwner(entry);
  if (owner === null || owner.startsWith('unknown:') || owner === projectId || entry.path.includes(projectKey)) return true;
  const raw: unknown = rawJson(entry);
  if (entry.path.startsWith('.create-locks/')) {
    const lock = StoreLockSchema.safeParse(raw);
    return !lock.success || entry.path !== `.create-locks/${sha256Text(lock.data.projectId)}.lock`;
  }
  if (entry.path.startsWith('.create-transactions/')) {
    const journal = CreateJournalSchema.safeParse(raw);
    return !journal.success || journal.data.projectDirectoryName !== sha256Text(journal.data.projectId)
      || entry.path !== `.create-transactions/${journal.data.transactionId}/journal.json`;
  }
  const block = StorageRecoveryBlockSchema.safeParse(raw);
  return !block.success || block.data.directoryName !== sha256Text(block.data.projectId)
    || entry.path !== `.recovery-blocks/${block.data.directoryName}.json`;
}

/** Current·Version 및 해당 프로젝트의 저장 증거를 읽기 전용으로 수집한다. 미상 증거는 안전하다고 추정하지 않는다. */
export async function inspectReviewStorageHealth(fs: SafeStoreFilesystem, project: Project): Promise<ReviewStorageSnapshot> {
  const key: string = sha256Text(project.projectId);
  const projectLock: EvidenceEntry[] = await evidenceTree(fs, `${key}/write.lock`);
  const transactions: EvidenceEntry[] = await evidenceTree(fs, `${key}/.transactions`);
  const rootLocks: EvidenceEntry[] = (await evidenceTree(fs, '.create-locks')).filter((entry): boolean => (entry.kind !== 'directory' || entry.path !== '.create-locks') && relevantRootEntry(entry, project.projectId, key));
  const createTree: EvidenceEntry[] = await evidenceTree(fs, '.create-transactions');
  const createIds: string[] = [...new Set(createTree.flatMap((entry): string[] => entry.path.split('/').length > 1 ? [entry.path.split('/')[1]!] : []))];
  const creates: EvidenceEntry[] = [...createTree.filter((entry): boolean => entry.path === '.create-transactions' && entry.kind !== 'directory'), ...createIds.flatMap((id: string): EvidenceEntry[] => {
    const entries: EvidenceEntry[] = createTree.filter((entry): boolean => entry.path === `.create-transactions/${id}` || entry.path.startsWith(`.create-transactions/${id}/`));
    const journal: EvidenceEntry | undefined = entries.find((entry): boolean => entry.path === `.create-transactions/${id}/journal.json`);
    return journal !== undefined && !relevantRootEntry(journal, project.projectId, key) ? [] : entries;
  })];
  const markers: EvidenceEntry[] = (await evidenceTree(fs, '.recovery-blocks')).filter((entry): boolean => (entry.kind !== 'directory' || !['.recovery-blocks', '.recovery-blocks/.invalid'].includes(entry.path)) && relevantRootEntry(entry, project.projectId, key));
  const versions: EvidenceEntry[] = await evidenceTree(fs, `${key}/versions`);
  const evidenceEntries: EvidenceEntry[] = [...projectLock, ...transactions, ...rootLocks, ...creates, ...markers, ...versions];
  const invalid: Set<string> = new Set(evidenceEntries.filter((entry): boolean => entry.kind === 'invalid').map((entry): string => entry.path));
  for (const entry of evidenceEntries) if ([`${key}/.transactions`, '.create-transactions', `${key}/versions`].includes(entry.path) && entry.kind !== 'directory') invalid.add(entry.path);
  const issues: Issue[] = [];
  const requireValid = (entry: EvidenceEntry, valid: boolean): void => { if (!valid) invalid.add(entry.path); };
  for (const entry of [...projectLock, ...rootLocks]) requireValid(entry, entry.kind === 'file' && StoreLockSchema.safeParse(rawJson(entry)).success
    && entryOwner(entry) === project.projectId && (entry.path === `${key}/write.lock` || entry.path === `.create-locks/${key}.lock`));
  const pendingTransactionIds: string[] = [...new Set(transactions.flatMap((entry): string[] => entry.path.split('/').length > 2 ? [entry.path.split('/')[2]!] : []))].sort();
  for (const id of pendingTransactionIds) {
    const journal: EvidenceEntry | undefined = transactions.find((entry): boolean => entry.path === `${key}/.transactions/${id}/journal.json`);
    const result = TransactionJournalSchema.safeParse(journal === undefined ? null : rawJson(journal));
    if (!result.success || result.data.projectId !== project.projectId || result.data.transactionId !== id) invalid.add(`${key}/.transactions/${id}/journal.json`);
  }
  const pendingCreateTransactionIds: string[] = [...new Set(creates.flatMap((entry): string[] => entry.path.split('/').length > 1 ? [entry.path.split('/')[1]!] : []))].sort();
  for (const id of pendingCreateTransactionIds) {
    const journal: EvidenceEntry | undefined = creates.find((entry): boolean => entry.path === `.create-transactions/${id}/journal.json`);
    const result = CreateJournalSchema.safeParse(journal === undefined ? null : rawJson(journal));
    if (!result.success || result.data.projectId !== project.projectId || result.data.transactionId !== id || result.data.projectDirectoryName !== key) invalid.add(`.create-transactions/${id}/journal.json`);
  }
  const recoveryBlocks = markers.map((entry): { path: string; code: string | null } => {
    const parsed = StorageRecoveryBlockSchema.safeParse(rawJson(entry));
    const valid: boolean = parsed.success && entry.path === `.recovery-blocks/${parsed.data.directoryName}.json` && parsed.data.directoryName === sha256Text(parsed.data.projectId);
    requireValid(entry, valid);
    return { path: entry.path, code: parsed.success ? parsed.data.code : entry.errorCode };
  });
  const futureVersionRevisions: number[] = [];
  const observedRevisions: Set<number> = new Set<number>();
  for (const entry of versions.filter((value): boolean => value.path !== `${key}/versions`)) {
    if (entry.kind !== 'file' || !new RegExp(`^${key}/versions/[0-9]{6}\\.json$`, 'u').test(entry.path)) { invalid.add(entry.path); continue; }
    try {
      const version: Project = parseProject(rawJson(entry)); const revision: number = Number(entry.path.slice(-11, -5));
      if (version.projectId !== project.projectId || version.revision !== revision) { invalid.add(entry.path); continue; }
      observedRevisions.add(revision);
      if (revision > project.revision) futureVersionRevisions.push(revision);
      if (revision === project.revision && exportProjectJson(version) !== exportProjectJson(project)) issues.push(storageIssue(project.projectId, entry.path, 'AUDIT_CURRENT_VERSION_MISMATCH', String(revision)));
    } catch (error: unknown) { inspectionErrorCode(error); invalid.add(entry.path); }
  }
  for (let revision: number = 0; revision <= project.revision; revision += 1) if (!observedRevisions.has(revision)) issues.push(storageIssue(project.projectId, `${key}/versions`, 'REVIEW_VERSION_MISSING', String(revision)));
  if (projectLock.length > 0) issues.push(storageIssue(project.projectId, `${key}/write.lock`, 'REVIEW_PROJECT_LOCK_PRESENT', null));
  if (rootLocks.length > 0) issues.push(storageIssue(project.projectId, '.create-locks', 'REVIEW_CREATE_LOCK_PRESENT', null));
  for (const id of pendingTransactionIds) issues.push(storageIssue(project.projectId, `${key}/.transactions/${id}`, 'REVIEW_TRANSACTION_PENDING', id));
  for (const id of pendingCreateTransactionIds) issues.push(storageIssue(project.projectId, `.create-transactions/${id}`, 'REVIEW_CREATE_TRANSACTION_PENDING', id));
  for (const block of recoveryBlocks) issues.push(storageIssue(project.projectId, block.path, 'REVIEW_RECOVERY_BLOCK_PRESENT', block.code));
  for (const revision of futureVersionRevisions) issues.push(storageIssue(project.projectId, `${key}/versions`, 'REVIEW_FUTURE_VERSION_PRESENT', String(revision)));
  for (const path of [...invalid].sort()) issues.push(storageIssue(project.projectId, path, 'REVIEW_STORAGE_EVIDENCE_INVALID', null));
  return { health: { projectId: project.projectId, currentRevision: project.revision, quiescent: issues.length === 0,
    activeProjectLock: projectLock.length > 0, activeCreateLock: rootLocks.length > 0, pendingTransactionIds, pendingCreateTransactionIds,
    recoveryBlocks, futureVersionRevisions: futureVersionRevisions.sort((a: number, b: number): number => a - b), invalidEvidenceEntries: [...invalid].sort(), issues },
    evidence: Object.fromEntries(evidenceEntries.map((entry): [string, string] => [entry.path, entry.digest]).sort(([a], [b]): number => a < b ? -1 : a > b ? 1 : 0)) };
}

export function assertReviewStorageUnchanged(before: ReviewStorageSnapshot, after: ReviewStorageSnapshot): void {
  if (stableJsonStringify(before) !== stableJsonStringify(after)) throw contractError('REVIEW_SOURCE_NOT_QUIESCENT', '검토 중 Lock·Transaction·Version·복구 근거가 변경됐습니다. 원본을 보존하고 다시 검토하세요.',
    [...after.health.issues, storageIssue(after.health.projectId, 'storageHealth', 'REVIEW_STORAGE_EVIDENCE_CHANGED', null)]);
}
export function assertReviewStorageQuiescent(health: ReviewStorageHealth): void {
  if (!health.quiescent) throw contractError('REVIEW_SOURCE_NOT_QUIESCENT', '저장 작업과 복구 검토가 끝난 뒤 Final Bundle을 출력하세요.', health.issues);
}

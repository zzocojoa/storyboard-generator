import { lstat, realpath } from 'node:fs/promises';
import { isAbsolute, relative, sep } from 'node:path';
import { readDiskSpace } from '../automation/disk-space.js';
import { contractError } from '../domain/errors.js';
import { ReviewBundlePublisher } from '../exporters/review-output.js';
import type { ReviewFile } from '../exporters/review-bundle.js';
import { sha256Bytes, sha256Text } from '../importers/integrity.js';
import { stableJsonStringify } from '../io/stable-json.js';
import { SafeStoreFilesystem, sameFileIdentity } from '../server/safe-filesystem.js';
import type { FileIdentity } from '../server/safe-filesystem.js';
import { BackupManifestSchema, BackupSelectionSchema } from './schema.js';
import type { BackupManifest, BackupPreview, BackupResult, BackupSelection } from './schema.js';
import { readBackupSnapshot, readProjectBackup } from './snapshot.js';
import type { BackupSnapshot } from './snapshot.js';

type Destination = { fs: SafeStoreFilesystem; output: string; identity: FileIdentity; assertUnchanged: () => Promise<void> };
function within(root: string, path: string): boolean { const child = relative(root, path); return child === '' || child !== '..' && !child.startsWith(`..${sep}`) && !isAbsolute(child); }

async function destination(selection: BackupSelection, protectedRoots: readonly string[]): Promise<Destination> {
  const input = BackupSelectionSchema.parse(selection);
  if (!isAbsolute(input.parentPath)) throw contractError('BACKUP_PATH_INVALID', '기존 상위 폴더의 절대경로를 입력하세요.', []);
  if (Buffer.byteLength(input.folderName, 'utf8') > 240) throw contractError('BACKUP_PATH_INVALID', '새 폴더 이름을 UTF-8 240바이트 이내로 입력하세요.', []);
  let parent: string;
  try { parent = await realpath(input.parentPath); }
  catch (error: unknown) {
    if (error instanceof Error && 'code' in error && ['ENOENT', 'ENOTDIR'].includes(String(error.code))) throw contractError('BACKUP_PATH_INVALID', `상위 폴더가 없습니다. 이미 있는 폴더를 지정하세요. path=${input.parentPath}, cause=${error.message}`, []);
    throw error;
  }
  const metadata = await lstat(parent);
  const fs = new SafeStoreFilesystem(parent); await fs.openExisting(); await fs.requireDirectory(parent);
  const output: string = fs.path(input.folderName);
  for (const root of protectedRoots) if (within(await realpath(root), output)) throw contractError('BACKUP_PATH_INVALID', '원본 저장소와 백업 폴더 밖의 새 위치를 선택하세요.', []);
  if (await fs.exists(output)) throw contractError('BACKUP_OUTPUT_EXISTS', `출력 폴더가 이미 있습니다. 아직 없는 새 폴더 이름을 선택하세요. path=${output}`, []);
  const identity: FileIdentity = { dev: metadata.dev, ino: metadata.ino };
  const assertUnchanged = async (): Promise<void> => {
    const current = await lstat(parent);
    if (!current.isDirectory() || !sameFileIdentity(identity, current) || await realpath(input.parentPath) !== parent) throw contractError('BACKUP_DESTINATION_CHANGED', '저장할 상위 폴더가 바뀌었습니다. 위치를 다시 확인하세요.', []);
  };
  return { fs, output, identity, assertUnchanged };
}

async function requireSpace(path: string, size: number): Promise<void> {
  const disk = await readDiskSpace(path); const required: bigint = BigInt(size) + 256n * 1024n * 1024n;
  if (disk.availableBytes < required) throw contractError('BACKUP_SPACE_LOW', `백업·복원 공간이 부족합니다. availableBytes=${disk.availableBytes}, requiredBytes=${required}, path=${path}`, []);
}

function manifestFor(snapshot: BackupSnapshot): BackupManifest {
  return BackupManifestSchema.parse({ artifactType: 'cutroom-project-backup', artifactVersion: '1.0.0', scope: 'committed-project-history',
    projectId: snapshot.project.projectId, title: snapshot.project.title, revision: snapshot.project.revision, createdAt: new Date().toISOString(), files: snapshot.entries });
}

function previewFor(snapshot: BackupSnapshot, target: Destination): BackupPreview {
  const manifest = manifestFor(snapshot);
  return { manifest, outputPath: target.output, versions: snapshot.versions, assets: snapshot.assets,
    totalBytes: snapshot.entries.reduce((total, entry): number => total + entry.size, 0),
    basisSha256: sha256Text(stableJsonStringify({ files: snapshot.entries, output: target.output, identity: target.identity, projectId: snapshot.project.projectId })) };
}

export async function previewProjectBackup(dataRoot: string, projectId: string, expectedRevision: number, selection: BackupSelection): Promise<BackupPreview> {
  const target = await destination(selection, [dataRoot]); const snapshot = await readBackupSnapshot(dataRoot, projectId);
  if (snapshot.project.revision !== expectedRevision) throw contractError('REVISION_CONFLICT', '저장된 콘티가 변경됐습니다. 새로고침 뒤 백업을 다시 확인하세요.', []);
  const preview = previewFor(snapshot, target); await requireSpace(target.fs.root(), preview.totalBytes); await target.assertUnchanged(); return preview;
}

export async function createProjectBackup(dataRoot: string, projectId: string, expectedRevision: number, selection: BackupSelection, basisSha256: string): Promise<BackupResult> {
  const target = await destination(selection, [dataRoot]); const snapshot = await readBackupSnapshot(dataRoot, projectId);
  const preview = previewFor(snapshot, target);
  if (snapshot.project.revision !== expectedRevision || preview.basisSha256 !== basisSha256) throw contractError('BACKUP_SOURCE_CHANGED', '원본 또는 저장 위치가 미리보기 이후 변경됐습니다. 백업 내용을 다시 확인하세요.', []);
  const manifestBytes = Buffer.from(stableJsonStringify(preview.manifest));
  await requireSpace(target.fs.root(), preview.totalBytes + manifestBytes.length);
  await new ReviewBundlePublisher(target.fs, target.output).publish([...snapshot.files, { path: 'backup.json', content: manifestBytes }], async (): Promise<void> => {
    await snapshot.assertUnchanged(); await target.assertUnchanged(); await requireSpace(target.fs.root(), 0);
  });
  return { outputPath: target.output, manifestSha256: sha256Bytes(manifestBytes), manifest: preview.manifest };
}

/** 기존 폴더를 합치지 않고 별도의 새 dataRoot에 원래 ID·revision·전체 파일을 복원한다. */
export async function restoreProjectBackup(backupPath: string, selection: BackupSelection, expectedManifestSha256: string): Promise<BackupResult> {
  const snapshot = await readProjectBackup(backupPath);
  if (snapshot.manifestSha256 !== expectedManifestSha256) throw contractError('BACKUP_SOURCE_CHANGED', '선택한 백업의 Manifest가 변경됐습니다. 다시 검증하세요.', []);
  const target = await destination(selection, [backupPath]); const key: string = sha256Text(snapshot.project.projectId);
  const files: ReviewFile[] = snapshot.files.map((file): ReviewFile => ({ path: `${key}/${file.path}`, content: file.content }));
  await requireSpace(target.fs.root(), files.reduce((total, file): number => total + file.content.length, 0));
  await new ReviewBundlePublisher(target.fs, target.output).publishWithDirectories(files, [`${key}/assets`, `${key}/.transactions`], async (): Promise<void> => {
    await snapshot.assertUnchanged(); await target.assertUnchanged(); await requireSpace(target.fs.root(), 0);
  });
  return { outputPath: target.output, manifestSha256: snapshot.manifestSha256, manifest: snapshot.manifest };
}

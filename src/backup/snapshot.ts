import { join } from 'node:path';
import { contractError } from '../domain/errors.js';
import type { Asset, Project } from '../domain/schema.js';
import { isSafePackagePath, sha256Bytes, sha256Text } from '../importers/integrity.js';
import { parseProject } from '../io/project.js';
import { stableJsonStringify } from '../io/stable-json.js';
import { assertReviewStorageUnchanged } from '../exporters/review-storage-health.js';
import type { ReviewStorageSnapshot } from '../exporters/review-storage-health.js';
import { SafeStoreFilesystem } from '../server/safe-filesystem.js';
import type { ReviewFile } from '../exporters/review-bundle.js';
import { BACKUP_JSON_MAX_BYTES, BACKUP_MAX_BYTES, BACKUP_MAX_FILES, BackupManifestSchema } from './schema.js';
import type { BackupFile, BackupManifest } from './schema.js';
import { inspectBackupStorageHealth } from './storage-health.js';

export type BackupSnapshot = { project: Project; files: ReviewFile[]; entries: BackupFile[]; versions: number; assets: number; assertUnchanged: () => Promise<void> };
const VERSION_PATH: RegExp = /^versions\/[0-9]{6}\.json$/u;

function fail(message: string): never { throw contractError('BACKUP_CONTENT_INVALID', message, []); }
function assetPath(path: string): boolean { return path.startsWith('assets/') && isSafePackagePath(path) && !path.includes('\\'); }
function allowedPath(path: string): boolean { return path === 'project.json' || VERSION_PATH.test(path) || assetPath(path); }
function entriesFor(files: readonly ReviewFile[]): BackupFile[] {
  return files.map((file): BackupFile => ({ path: file.path, size: file.content.length, sha256: sha256Bytes(file.content) }));
}

/** 현재본·이력·자산의 원래 바이트를 보존하며 메모리에서 이관한 Project를 다시 쓰지 않는다. */
function projectFrom(files: readonly ReviewFile[], path: string): Project {
  const file = files.find((value): boolean => value.path === path);
  if (file === undefined) return fail(`필수 백업 파일이 없습니다. path=${path}`);
  if (file.content.length > BACKUP_JSON_MAX_BYTES) return fail(`Project JSON이 읽기 한도를 넘었습니다. path=${path}, limit=${BACKUP_JSON_MAX_BYTES}`);
  return parseProject(JSON.parse(file.content.toString('utf8')) as unknown);
}

/** 저장 당시의 모든 버전과 자산 파일이 정확히 한 번 포함되는지 검사한다. Final 승인을 만들지 않는다. */
export function inspectBackupFiles(files: readonly ReviewFile[], projectId: string): { project: Project; versions: number; assets: number } {
  if (files.length > BACKUP_MAX_FILES || files.reduce((total, file): number => total + file.content.length, 0) > BACKUP_MAX_BYTES) fail('백업 파일 수 또는 전체 바이트 한도를 넘었습니다.');
  if (new Set(files.map((file): string => file.path)).size !== files.length || files.some((file): boolean => !allowedPath(file.path))) fail('중복되거나 지원하지 않는 백업 경로입니다.');
  const project = projectFrom(files, 'project.json');
  if (project.projectId !== projectId || project.revision > 999999) fail(`백업 Project ID·revision이 다릅니다. projectId=${projectId}`);
  const expected: Set<string> = new Set(['project.json']);
  const assets: Map<string, Asset> = new Map();
  for (let revision: number = 0; revision <= project.revision; revision += 1) {
    const path: string = `versions/${String(revision).padStart(6, '0')}.json`; expected.add(path);
    const version = projectFrom(files, path);
    if (version.projectId !== projectId || version.revision !== revision) fail(`Version의 Project ID·revision이 다릅니다. path=${path}`);
    if (revision === project.revision && stableJsonStringify(version) !== stableJsonStringify(project)) fail('현재본과 같은 revision의 Version 내용이 다릅니다.');
    for (const asset of version.assets) {
      if (!assetPath(asset.path)) fail(`자산 경로는 assets 내부여야 합니다. assetId=${asset.id}, path=${asset.path}`);
      const prior = assets.get(asset.path);
      if (prior !== undefined && stableJsonStringify(prior) !== stableJsonStringify(asset)) fail(`버전 사이에 자산 metadata가 변경됐습니다. path=${asset.path}`);
      assets.set(asset.path, asset); expected.add(asset.path);
    }
  }
  if (expected.size !== files.length || files.some((file): boolean => !expected.has(file.path))) fail('백업 파일 목록이 전체 Version·자산 목록과 일치하지 않습니다.');
  // 저장된 잘못된 미디어도 바이트 그대로 보관한다. 재생·출력은 복원 뒤 기존 무결성 검사를 다시 거친다.
  return { project, versions: project.revision + 1, assets: assets.size };
}

async function readPaths(fs: SafeStoreFilesystem, root: string, paths: readonly string[]): Promise<ReviewFile[]> {
  if (paths.length > BACKUP_MAX_FILES) fail('백업 파일 수 한도를 넘었습니다.');
  const result: ReviewFile[] = []; let used: number = 0;
  for (const path of [...paths].sort()) {
    if (!allowedPath(path)) fail(`지원하지 않는 백업 파일입니다. path=${path}`);
    const maximum: number = Math.min(BACKUP_MAX_BYTES - used, assetPath(path) ? BACKUP_MAX_BYTES : BACKUP_JSON_MAX_BYTES);
    if (maximum <= 0) fail('백업 전체 바이트 한도를 넘었습니다.');
    const content = await fs.readBounded(join(root, path), maximum); used += content.length;
    result.push({ path, content });
  }
  return result;
}

function quiescent(storage: ReviewStorageSnapshot): void {
  if (!storage.health.quiescent) throw contractError('BACKUP_STORAGE_NOT_QUIESCENT', '저장·복구 작업이 끝난 뒤 백업을 다시 확인하세요. 원본은 변경하지 않았습니다.', storage.health.issues);
}

/** 저장소에서 선택 Project만 읽으며 lock·복구·heartbeat·모델 호출을 만들지 않는다. */
export async function readBackupSnapshot(dataRoot: string, projectId: string): Promise<BackupSnapshot> {
  const fs = new SafeStoreFilesystem(dataRoot); await fs.openExisting();
  const root: string = fs.path(sha256Text(projectId));
  const current = await fs.readBounded(join(root, 'project.json'), BACKUP_JSON_MAX_BYTES);
  const project = parseProject(JSON.parse(current.toString('utf8')) as unknown);
  if (project.projectId !== projectId) fail(`선택 Project ID가 저장 위치와 다릅니다. projectId=${projectId}`);
  const versions = await fs.entries(join(root, 'versions'));
  if (project.revision + 2 > BACKUP_MAX_FILES || versions.length > BACKUP_MAX_FILES - 1) fail('전체 Version 수가 백업 한도를 넘었습니다.');
  let jsonBytes: number = current.length;
  const storage = await inspectBackupStorageHealth(fs.root(), project); quiescent(storage);
  const paths: Set<string> = new Set(['project.json']);
  for (const entry of versions) {
    const path: string = `versions/${entry.name}`;
    if (!VERSION_PATH.test(path)) fail(`Version 파일명을 확인하세요. path=${path}`);
    paths.add(path);
    if (jsonBytes >= BACKUP_MAX_BYTES) fail('전체 Version 바이트가 백업 한도를 넘었습니다.');
    const bytes = await fs.readBounded(join(root, path), Math.min(BACKUP_JSON_MAX_BYTES, BACKUP_MAX_BYTES - jsonBytes)); jsonBytes += bytes.length;
    const version = parseProject(JSON.parse(bytes.toString('utf8')) as unknown);
    for (const asset of version.assets) paths.add(asset.path);
  }
  const files = await readPaths(fs, root, [...paths]);
  const summary = inspectBackupFiles(files, projectId); const entries = entriesFor(files);
  if (sha256Bytes(current) !== entries.find((file): boolean => file.path === 'project.json')?.sha256) fail('백업을 읽는 동안 현재본이 변경됐습니다. 다시 확인하세요.');
  const assertUnchanged = async (): Promise<void> => {
    assertReviewStorageUnchanged(storage, await inspectBackupStorageHealth(fs.root(), project));
    for (const entry of entries) {
      const bytes = await fs.readBounded(join(root, entry.path), entry.size);
      if (bytes.length !== entry.size || sha256Bytes(bytes) !== entry.sha256) throw contractError('BACKUP_SOURCE_CHANGED', `백업 중 원본이 변경됐습니다. path=${entry.path}`, []);
    }
    assertReviewStorageUnchanged(storage, await inspectBackupStorageHealth(fs.root(), project));
  };
  await assertUnchanged(); return { ...summary, files, entries, assertUnchanged };
}

/** 전달용 Review Bundle과 구분한 백업 계약만 읽고 실제 파일 전체를 검사한다. */
export async function readProjectBackup(path: string): Promise<BackupSnapshot & { manifest: BackupManifest; manifestSha256: string }> {
  const fs = new SafeStoreFilesystem(path);
  try { await fs.openExisting(); }
  catch (error: unknown) {
    if (error instanceof Error && 'code' in error && ['ENOENT', 'ENOTDIR'].includes(String(error.code))) throw contractError('BACKUP_PATH_INVALID', `보관한 백업 폴더를 찾을 수 없습니다. 실제 저장 위치를 확인하세요. path=${path}, cause=${error.message}`, []);
    throw error;
  }
  const manifestBytes = await fs.readBounded(fs.path('backup.json'), BACKUP_JSON_MAX_BYTES);
  const manifest = BackupManifestSchema.parse(JSON.parse(manifestBytes.toString('utf8')) as unknown);
  const manifestSha256: string = sha256Bytes(manifestBytes);
  const declared: Set<string> = new Set(manifest.files.map((entry): string => entry.path));
  if (declared.size !== manifest.files.length) fail('Manifest에 중복 경로가 있습니다.');
  const allowedDirectories: Set<string> = new Set();
  for (const path of declared) {
    if (!allowedPath(path)) fail(`Manifest 파일 경로가 유효하지 않습니다. path=${path}`);
    const components = path.split('/'); components.pop();
    for (let count: number = 1; count <= components.length; count += 1) allowedDirectories.add(components.slice(0, count).join('/'));
  }
  const verifyTree = async (directory: string): Promise<void> => {
    for (const entry of await fs.entries(fs.path(directory))) {
      const child: string = directory === '' ? entry.name : `${directory}/${entry.name}`;
      if (entry.isDirectory() && allowedDirectories.has(child)) await verifyTree(child);
      else if (!(entry.isFile() && (child === 'backup.json' || declared.has(child)))) fail(`백업에 선언되지 않은 항목 또는 특수 경로가 있습니다. path=${child}`);
    }
  };
  await verifyTree('');
  const files = await readPaths(fs, fs.root(), [...declared]); const entries = entriesFor(files);
  if (entries.some((entry): boolean => stableJsonStringify(entry) !== stableJsonStringify(manifest.files.find((value): boolean => value.path === entry.path)))) fail('백업 파일 크기·해시가 Manifest와 다릅니다.');
  const summary = inspectBackupFiles(files, manifest.projectId);
  if (summary.project.revision !== manifest.revision || summary.project.title !== manifest.title) fail('백업 요약과 실제 Project가 다릅니다.');
  const assertUnchanged = async (): Promise<void> => {
    await verifyTree('');
    if (sha256Bytes(await fs.readBounded(fs.path('backup.json'), BACKUP_JSON_MAX_BYTES)) !== manifestSha256) fail('검사 중 백업 Manifest가 변경됐습니다.');
    for (const entry of entries) if (sha256Bytes(await fs.readBounded(fs.path(entry.path), entry.size)) !== entry.sha256) fail(`검사 중 백업 파일이 변경됐습니다. path=${entry.path}`);
  };
  await assertUnchanged(); return { ...summary, files, entries, manifest, manifestSha256, assertUnchanged };
}

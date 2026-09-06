import { constants } from 'node:fs';
import type { Dirent } from 'node:fs';
import { link, lstat, mkdir, open, readdir, realpath, rename, rmdir, unlink } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { contractError } from '../domain/errors.js';
import { isMissingFile } from '../io/package.js';

export type FileIdentity = { dev: number; ino: number };
export type SafePathKind = 'missing' | 'file' | 'directory';

function unsafe(path: string, reason: string): never {
  throw contractError('STORE_PATH_UNSAFE', `저장 경로를 안전하게 사용할 수 없습니다. path=${path}, reason=${reason}`, []);
}

/** 정규화된 저장 루트 아래에서 symlink를 거부하는 파일 연산만 제공한다. */
export class SafeStoreFilesystem {
  readonly #configuredRoot: string;
  #canonicalRoot: string | null = null;

  constructor(root: string) {
    this.#configuredRoot = resolve(root);
  }

  async initialize(): Promise<void> {
    await mkdir(this.#configuredRoot, { recursive: true });
    const canonicalRoot: string = await realpath(this.#configuredRoot);
    const metadata = await lstat(canonicalRoot);
    if (!metadata.isDirectory()) unsafe(canonicalRoot, 'root is not a directory');
    this.#canonicalRoot = canonicalRoot;
  }

  root(): string {
    if (this.#canonicalRoot === null) throw contractError('STORE_NOT_INITIALIZED', '저장 파일 시스템이 초기화되지 않았습니다.', []);
    return this.#canonicalRoot;
  }

  path(...segments: readonly string[]): string {
    const root: string = this.root();
    const path: string = resolve(root, ...segments);
    const child: string = relative(root, path);
    if (child === '' || (!child.startsWith(`..${sep}`) && child !== '..' && !isAbsolute(child))) return path;
    return unsafe(path, 'path escapes canonical root');
  }

  async kind(path: string): Promise<SafePathKind> {
    this.#assertWithin(path);
    try {
      await this.#assertComponents(path);
      const metadata = await lstat(path);
      if (metadata.isSymbolicLink()) unsafe(path, 'symbolic link');
      if (metadata.isFile()) return 'file';
      if (metadata.isDirectory()) return 'directory';
      return unsafe(path, 'not a regular file or directory');
    } catch (error: unknown) {
      if (isMissingFile(error)) return 'missing';
      throw error;
    }
  }

  async exists(path: string): Promise<boolean> {
    return await this.kind(path) !== 'missing';
  }

  async requireDirectory(path: string): Promise<void> {
    const kind: SafePathKind = await this.kind(path);
    if (kind !== 'directory') unsafe(path, `expected directory, actual=${kind}`);
    const canonical: string = await realpath(path);
    this.#assertWithin(canonical);
  }

  async requireFile(path: string): Promise<void> {
    const kind: SafePathKind = await this.kind(path);
    if (kind !== 'file') unsafe(path, `expected regular file, actual=${kind}`);
    const canonical: string = await realpath(path);
    this.#assertWithin(canonical);
  }

  async ensureDirectory(path: string): Promise<void> {
    const kind: SafePathKind = await this.kind(path);
    if (kind === 'directory') return;
    if (kind !== 'missing') unsafe(path, `cannot create directory over ${kind}`);
    await this.requireDirectory(dirname(path));
    try { await mkdir(path); }
    catch (error: unknown) {
      if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error;
    }
    await this.requireDirectory(path);
  }

  async entries(path: string): Promise<Dirent[]> {
    await this.requireDirectory(path);
    return readdir(path, { withFileTypes: true });
  }

  async read(path: string): Promise<Buffer> {
    await this.requireFile(path);
    const handle: FileHandle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const metadata = await handle.stat();
      if (!metadata.isFile()) unsafe(path, 'opened object is not a regular file');
      return await handle.readFile();
    } finally {
      await handle.close();
    }
  }

  async readText(path: string): Promise<string> {
    return (await this.read(path)).toString('utf8');
  }

  async writeExclusive(path: string, content: string | Buffer): Promise<void> {
    await this.#assertCreateTarget(path);
    const handle: FileHandle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try {
      await handle.writeFile(content);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await this.requireFile(path);
  }

  /** Lock처럼 원자 경쟁 판정이 필요한 파일을 O_EXCL로 만들고 생성 inode를 반환한다. */
  async writeExclusiveWithIdentity(path: string, content: string | Buffer): Promise<FileIdentity> {
    this.#assertWithin(path);
    await this.requireDirectory(dirname(path));
    const handle: FileHandle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    let identity: FileIdentity | null = null;
    let closed: boolean = false;
    try {
      const metadata = await handle.stat();
      if (!metadata.isFile()) unsafe(path, 'created object is not a regular file');
      identity = { dev: metadata.dev, ino: metadata.ino };
      await handle.writeFile(content);
      await handle.sync();
      await handle.close();
      closed = true;
      await this.requireFile(path);
      const current: FileIdentity = await this.identity(path);
      if (!sameFileIdentity(identity, current)) unsafe(path, 'exclusive file identity changed after creation');
      return identity;
    } catch (error: unknown) {
      let closeError: unknown = null;
      if (!closed) {
        try { await handle.close(); }
        catch (failure: unknown) { closeError = failure; }
      }
      if (identity === null) {
        throw new AggregateError(closeError === null ? [error] : [error, closeError], `원자 생성 파일의 소유권을 증명할 수 없습니다. path=${path}`);
      }
      try {
        await this.unlinkFile(path, identity);
        await this.syncDirectory(dirname(path));
      } catch (cleanupError: unknown) {
        throw new AggregateError(closeError === null ? [error, cleanupError] : [error, closeError, cleanupError],
          `원자 생성 파일 실패 후 소유 파일을 정리할 수 없습니다. path=${path}`);
      }
      if (closeError !== null) throw new AggregateError([error, closeError], `원자 생성 파일을 닫을 수 없습니다. path=${path}`);
      throw error;
    }
  }

  async hardLink(source: string, target: string): Promise<FileIdentity> {
    const sourceIdentity: FileIdentity = await this.identity(source);
    await this.#assertCreateTarget(target);
    await link(source, target);
    const targetIdentity: FileIdentity = await this.identity(target);
    if (!sameFileIdentity(sourceIdentity, targetIdentity)) unsafe(target, 'hard link identity mismatch');
    return targetIdentity;
  }

  async identity(path: string): Promise<FileIdentity> {
    await this.requireFile(path);
    const metadata = await lstat(path);
    return { dev: metadata.dev, ino: metadata.ino };
  }

  async unlinkFile(path: string, expectedIdentity?: FileIdentity): Promise<void> {
    if (await this.kind(path) === 'missing') return;
    const actual: FileIdentity = await this.identity(path);
    if (expectedIdentity !== undefined && !sameFileIdentity(actual, expectedIdentity)) {
      unsafe(path, `file identity changed, expected=${expectedIdentity.dev}:${expectedIdentity.ino}, actual=${actual.dev}:${actual.ino}`);
    }
    await unlink(path);
  }

  async renameNewDirectory(source: string, target: string): Promise<void> {
    await this.requireDirectory(source);
    await this.#assertCreateTarget(target);
    await rename(source, target);
    await this.requireDirectory(target);
  }

  async replaceFile(source: string, target: string): Promise<void> {
    await this.requireFile(source);
    const targetKind: SafePathKind = await this.kind(target);
    if (targetKind !== 'missing' && targetKind !== 'file') unsafe(target, `cannot replace ${targetKind}`);
    await this.requireDirectory(dirname(target));
    await rename(source, target);
    await this.requireFile(target);
  }

  async removeEmptyDirectory(path: string): Promise<void> {
    await this.requireDirectory(path);
    await rmdir(path);
  }

  async removeTree(path: string): Promise<void> {
    const kind: SafePathKind = await this.kind(path);
    if (kind === 'missing') return;
    if (kind === 'file') { await this.unlinkFile(path); return; }
    for (const entry of await this.entries(path)) {
      const child: string = join(path, entry.name);
      if (entry.isSymbolicLink()) unsafe(child, 'symbolic link inside removable tree');
      if (entry.isDirectory()) await this.removeTree(child);
      else if (entry.isFile()) await this.unlinkFile(child);
      else unsafe(child, 'unsupported filesystem entry');
    }
    await this.removeEmptyDirectory(path);
  }

  async syncDirectory(path: string): Promise<void> {
    await this.requireDirectory(path);
    const handle: FileHandle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try { await handle.sync(); } finally { await handle.close(); }
  }

  #assertWithin(path: string): void {
    const root: string = this.root();
    const absolute: string = resolve(path);
    const child: string = relative(root, absolute);
    if (child === '' || (!child.startsWith(`..${sep}`) && child !== '..' && !isAbsolute(child))) return;
    unsafe(path, 'path escapes canonical root');
  }

  async #assertComponents(path: string): Promise<void> {
    const root: string = this.root();
    const child: string = relative(root, resolve(path));
    if (child === '') return;
    let current: string = root;
    for (const segment of child.split(sep)) {
      current = join(current, segment);
      const metadata = await lstat(current);
      if (metadata.isSymbolicLink()) unsafe(current, 'symbolic link component');
    }
  }

  async #assertCreateTarget(path: string): Promise<void> {
    this.#assertWithin(path);
    await this.requireDirectory(dirname(path));
    const kind: SafePathKind = await this.kind(path);
    if (kind !== 'missing') unsafe(path, `exclusive target exists as ${kind}`);
  }
}

export function sameFileIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { hostname, tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Project } from '../src/domain/schema.js';
import { sha256Text } from '../src/importers/integrity.js';
import { SafeStoreFilesystem } from '../src/server/safe-filesystem.js';
import type { FileIdentity } from '../src/server/safe-filesystem.js';
import { ProjectStore, StoreLockSchema } from '../src/server/store.js';
import { readinessOutline } from './readiness-fixtures.js';
import { importPackage } from '../src/importers/import-package.js';
import { createSourceOutline } from '../src/proposal/outline.js';
import { nativeData, nativePackage, withNativeData } from './helpers.js';

type Fixture = { root: string; fs: SafeStoreFilesystem; store: ProjectStore; project: Project };
const fixtures: Fixture[] = [];
const observers: ProjectStore[] = [];
afterEach(async (): Promise<void> => {
  vi.restoreAllMocks();
  for (const store of observers.splice(0)) await store.close();
  for (const value of fixtures.splice(0)) { await value.store.close(); await rm(value.root, { recursive: true, force: true }); }
});
async function fixture(): Promise<Fixture> {
  const root: string = await mkdtemp(join(tmpdir(), 'atomic-lock-'));
  const store: ProjectStore = new ProjectStore(root); const project: Project = await store.create(await readinessOutline());
  const fs: SafeStoreFilesystem = new SafeStoreFilesystem(root); await fs.openExisting();
  const value: Fixture = { root: fs.root(), fs, store, project }; fixtures.push(value); return value;
}
function lockPath(value: Fixture): string { return join(value.root, sha256Text(value.project.projectId), 'write.lock'); }
function observer(value: Fixture): ProjectStore { const store: ProjectStore = new ProjectStore(value.root); observers.push(store); return store; }
async function update(value: Fixture): Promise<Project> { return value.store.update(value.project.projectId, 0, (current: Project): Project => ({ ...current, title: '원자 공개' }), []); }
async function observePublication(finalPath: string, inspect: (path: string) => Promise<void>, operation: () => Promise<Project>): Promise<void> {
  const original = SafeStoreFilesystem.prototype.writeExclusiveWithIdentity;
  let inspected: boolean = false;
  const spy = vi.spyOn(SafeStoreFilesystem.prototype, 'writeExclusiveWithIdentity').mockImplementation(async function (this: SafeStoreFilesystem, path: string, content: string | Buffer): Promise<FileIdentity> {
    const identity: FileIdentity = await original.call(this, path, content);
    if (!inspected && dirname(path) === dirname(finalPath) && String(content).includes('processInstanceId')) {
      inspected = true; await inspect(path);
    }
    return identity;
  });
  try { await operation(); expect(inspected).toBe(true); } finally { spy.mockRestore(); }
}

describe('완성된 Lock의 원자 공개', (): void => {
  it('lock_metadata_is_atomically_visible', async (): Promise<void> => {
    const value = await fixture(); const path: string = lockPath(value);
    await observePublication(path, async (): Promise<void> => { expect(await value.fs.exists(path)).toBe(false); }, (): Promise<Project> => update(value));
  });
  it('root_create_lock_metadata_is_atomically_visible', async (): Promise<void> => {
    const value = await fixture(); const payload = await nativePackage();
    const project: Project = createSourceOutline(importPackage(withNativeData(payload, { ...nativeData(payload), projectId: 'atomic-new-project' })), { proposedTextHoldMs: 2000 });
    const path: string = join(value.root, '.create-locks', `${sha256Text(project.projectId)}.lock`);
    await observePublication(path, async (): Promise<void> => { expect(await value.fs.exists(path)).toBe(false); }, (): Promise<Project> => value.store.create(project));
  });
  it('concurrent_reader_never_observes_partial_live_lock', async (): Promise<void> => {
    const value = await fixture(); const path: string = lockPath(value);
    await observePublication(path, async (temporary: string): Promise<void> => {
      expect(temporary).not.toBe(path);
      const complete: Buffer = await readFile(temporary); await writeFile(temporary, '{');
      try { const reader: ProjectStore = observer(value); await reader.initialize(); expect(reader.recoveryBlocks()).toEqual([]); expect((await reader.read(value.project.projectId)).revision).toBe(0); }
      finally { await writeFile(temporary, complete); }
    }, (): Promise<Project> => update(value));
  });
  it('status_does_not_block_project_for_partially_published_lock', async (): Promise<void> => {
    const value = await fixture(); const reader: ProjectStore = observer(value); await reader.initialize();
    await observePublication(lockPath(value), async (temporary: string): Promise<void> => {
      const complete: Buffer = await readFile(temporary); await writeFile(temporary, '{');
      try { expect((await reader.statusSnapshot()).recoveryBlocks).toEqual([]); }
      finally { await writeFile(temporary, complete); }
    }, (): Promise<Project> => update(value));
  });
  it('lock_publish_eexist_is_project_busy', async (): Promise<void> => {
    const value = await fixture(); const reader: ProjectStore = observer(value); await reader.initialize();
    const original = SafeStoreFilesystem.prototype.syncDirectory; let checked: boolean = false;
    const spy = vi.spyOn(SafeStoreFilesystem.prototype, 'syncDirectory').mockImplementation(async function (this: SafeStoreFilesystem, path: string): Promise<void> {
      await original.call(this, path);
      if (!checked && path === dirname(lockPath(value)) && await value.fs.exists(lockPath(value))) {
        checked = true; await expect(reader.update(value.project.projectId, 0, (current: Project): Project => current, [])).rejects.toMatchObject({ code: 'PROJECT_BUSY' });
      }
    });
    try { await update(value); expect(checked).toBe(true); } finally { spy.mockRestore(); }
  });
  it('failed_lock_publish_removes_only_owned_temporary_file', async (): Promise<void> => {
    const value = await fixture(); const path: string = value.fs.path('primitive.lock'); const unrelated: string = value.fs.path('unrelated.tmp');
    await writeFile(path, 'winner'); await writeFile(unrelated, 'preserve');
    await expect(value.fs.publishExclusiveFileWithIdentity(path, 'loser', randomUUID())).rejects.toMatchObject({ code: 'EXCLUSIVE_FILE_EXISTS' });
    expect(await readFile(path, 'utf8')).toBe('winner'); expect(await readFile(unrelated, 'utf8')).toBe('preserve');
    expect((await readdir(value.root)).filter((name: string): boolean => name.startsWith('.publish-'))).toEqual([]);
  });
  it('crashed_lock_temporary_file_is_detected', async (): Promise<void> => {
    const value = await fixture(); const path: string = join(dirname(lockPath(value)), `.publish-write.lock-${randomUUID()}.${randomUUID()}.tmp`);
    await writeFile(path, '{}'); const reader: ProjectStore = observer(value); await reader.initialize();
    expect(reader.recoveryBlocks()).toContainEqual(expect.objectContaining({ code: 'STORE_RECOVERY_REQUIRED' }));
    expect(await readFile(path, 'utf8')).toBe('{}');
  });
  it('unknown_lock_temporary_file_is_not_deleted', async (): Promise<void> => {
    const value = await fixture(); const path: string = join(value.root, '.create-locks', `.publish-unknown.tmp`); await writeFile(path, '{');
    const reader: ProjectStore = observer(value); await reader.initialize();
    expect(reader.recoveryBlocks().length).toBeGreaterThan(0); expect(await readFile(path, 'utf8')).toBe('{');
  });
  it('dead_known_lock_publication_is_recovered_idempotently', async (): Promise<void> => {
    const value = await fixture(); const processInstanceId: string = randomUUID(); const transactionId: string = randomUUID();
    const now: string = new Date().toISOString(); const pid: number = 2147483647;
    const path: string = join(dirname(lockPath(value)), `.publish-write.lock-${processInstanceId}.${transactionId}.tmp`);
    await writeFile(join(value.root, '.process-instances', `${processInstanceId}.json`), JSON.stringify({
      version: 1, processInstanceId, host: hostname(), pid, startedAt: now, heartbeatAt: now,
    }));
    await writeFile(path, JSON.stringify({ version: 3, projectId: value.project.projectId, host: hostname(), pid, transactionId,
      createdAt: now, processInstanceId, processStartedAt: now }));
    for (let repeat: number = 0; repeat < 2; repeat += 1) {
      const reader: ProjectStore = observer(value); await reader.initialize(); expect(reader.recoveryBlocks()).toEqual([]);
      expect(await value.fs.exists(path)).toBe(false); expect((await reader.read(value.project.projectId)).revision).toBe(0);
    }
  });
  it('atomic_lock_publication_preserves_identity', async (): Promise<void> => {
    const value = await fixture(); let linked: FileIdentity | null = null;
    await observePublication(lockPath(value), async (path: string): Promise<void> => { linked = await value.fs.identity(path); }, async (): Promise<Project> => {
      const original = SafeStoreFilesystem.prototype.syncDirectory;
      const spy = vi.spyOn(SafeStoreFilesystem.prototype, 'syncDirectory').mockImplementation(async function (this: SafeStoreFilesystem, path: string): Promise<void> {
        if (path === dirname(lockPath(value)) && linked !== null && await value.fs.exists(lockPath(value))) {
          expect(await value.fs.identity(lockPath(value))).toEqual(linked); expect(StoreLockSchema.parse(JSON.parse(await readFile(lockPath(value), 'utf8'))).version).toBe(3);
        }
        await original.call(this, path);
      });
      try { return await update(value); } finally { spy.mockRestore(); }
    });
  });
  it('atomic_lock_publication_syncs_parent_directory', async (): Promise<void> => {
    const value = await fixture(); const path: string = value.fs.path('primitive.lock'); const observations: string[][] = [];
    const original = SafeStoreFilesystem.prototype.syncDirectory;
    const spy = vi.spyOn(SafeStoreFilesystem.prototype, 'syncDirectory').mockImplementation(async function (this: SafeStoreFilesystem, directory: string): Promise<void> {
      if (directory === value.root) observations.push(await readdir(directory)); await original.call(this, directory);
    });
    try { await value.fs.publishExclusiveFileWithIdentity(path, '{}', randomUUID()); } finally { spy.mockRestore(); }
    expect(observations).toHaveLength(2); expect(observations[0]).toContain(basename(path));
    expect(observations[0]?.some((name: string): boolean => name.startsWith('.publish-'))).toBe(true);
    expect(observations[1]?.some((name: string): boolean => name.startsWith('.publish-'))).toBe(false);
  });
});

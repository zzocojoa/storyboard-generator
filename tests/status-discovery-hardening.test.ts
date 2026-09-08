import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Project } from '../src/domain/schema.js';
import { sha256Text } from '../src/importers/integrity.js';
import { ProjectStore } from '../src/server/store.js';
import { readinessOutline } from './readiness-fixtures.js';

type Fixture = { root: string; store: ProjectStore; project: Project };
const fixtures: Fixture[] = [];
afterEach(async (): Promise<void> => { for (const value of fixtures.splice(0)) { await value.store.close(); await rm(value.root, { recursive: true, force: true }); } });
async function fixture(): Promise<Fixture> {
  const root: string = await mkdtemp(join(tmpdir(), 'status-discovery-'));
  const store: ProjectStore = new ProjectStore(root, undefined, { processProbe: (pid: number): boolean => pid === process.pid });
  try { const project: Project = await store.create(await readinessOutline()); const value: Fixture = { root, store, project }; fixtures.push(value); return value; }
  catch (error: unknown) { await store.close(); await rm(root, { recursive: true, force: true }); throw error; }
}
async function lock(path: string, projectId: string, pid: number): Promise<string> {
  const transactionId: string = randomUUID(); await writeFile(path, JSON.stringify({ version: 2, projectId, host: hostname(), pid, transactionId, createdAt: '2026-09-07T00:00:00.000Z' })); return transactionId;
}
function createPath(value: Fixture, id: string): string { return join(value.root, '.create-locks', `${sha256Text(id)}.lock`); }
function updatePath(value: Fixture): string { return join(value.root, sha256Text(value.project.projectId), 'write.lock'); }

describe('초기화 이후 외부 잠금 탐지', (): void => {
  it('status_discovers_external_create_started_after_initialize', async (): Promise<void> => {
    const value = await fixture(); const transactionId: string = await lock(createPath(value, 'new-project'), 'new-project', process.pid);
    expect((await value.store.statusSnapshot()).activeCreates).toContainEqual(expect.objectContaining({ projectId: 'new-project', transactionId }));
  });
  it('status_discovers_external_update_started_after_initialize', async (): Promise<void> => {
    const value = await fixture(); const transactionId: string = await lock(updatePath(value), value.project.projectId, process.pid);
    expect((await value.store.statusSnapshot()).activeUpdates).toContainEqual(expect.objectContaining({ projectId: value.project.projectId, transactionId }));
  });
  it('status_discovers_lock_not_present_in_memory_map', async (): Promise<void> => {
    const value = await fixture(); await lock(createPath(value, 'unseen'), 'unseen', process.pid);
    expect(value.store.activeCreates()).toEqual([]); expect((await value.store.statusSnapshot()).activeCreates.map((state): string => state.projectId)).toContain('unseen');
  });
  it('malformed_locked_project_does_not_fail_global_status', async (): Promise<void> => {
    const value = await fixture(); await lock(updatePath(value), value.project.projectId, process.pid);
    await writeFile(join(value.root, sha256Text(value.project.projectId), 'project.json'), '{broken');
    const status = await value.store.statusSnapshot();
    expect(status.activeUpdateErrors).toContainEqual(expect.objectContaining({ projectId: value.project.projectId }));
    expect(status.recoveryBlocks).toContainEqual(expect.objectContaining({ projectId: value.project.projectId }));
  });
  it('status_continues_reporting_healthy_projects', async (): Promise<void> => {
    const value = await fixture(); await lock(updatePath(value), value.project.projectId, process.pid);
    await writeFile(join(value.root, sha256Text(value.project.projectId), 'project.json'), '{broken');
    await lock(createPath(value, 'healthy'), 'healthy', process.pid);
    const status = await value.store.statusSnapshot(); expect(status.activeCreates).toContainEqual(expect.objectContaining({ projectId: 'healthy' }));
    expect(status.recoveryBlocks.some((block): boolean => block.projectId === 'healthy')).toBe(false);
  });
  it('status_does_not_delete_live_external_lock', async (): Promise<void> => {
    const value = await fixture(); const path: string = createPath(value, 'alive'); await lock(path, 'alive', process.pid); const before: Buffer = await readFile(path);
    for (let repeat: number = 0; repeat < 3; repeat += 1) { await value.store.statusSnapshot(); expect(await readFile(path)).toEqual(before); }
  });
  it('recovered_external_lock_does_not_reappear', async (): Promise<void> => {
    const value = await fixture(); const path: string = createPath(value, 'dead'); await lock(path, 'dead', 999999);
    expect((await value.store.statusSnapshot()).activeCreates).toEqual([]); expect(await readdir(join(value.root, '.create-locks'))).toEqual([]);
    expect((await value.store.statusSnapshot()).recoveryBlocks).toEqual([]); expect((await value.store.statusSnapshot()).activeCreates).toEqual([]);
  });
});

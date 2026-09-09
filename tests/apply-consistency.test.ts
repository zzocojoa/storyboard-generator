import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readBuildManifest } from '../src/build.js';
import { applyCodexImage } from '../src/codex/apply.js';
import { CodexRequestStore } from '../src/codex/requests.js';
import type { RequestFaultContext } from '../src/codex/requests.js';
import type { CodexRequest } from '../src/codex/schema.js';
import { codexRequestBasis } from '../src/codex/work.js';
import { contractError } from '../src/domain/errors.js';
import type { Project } from '../src/domain/schema.js';
import { importPackage } from '../src/importers/import-package.js';
import { createSourceOutline } from '../src/proposal/outline.js';
import { ProjectStore } from '../src/server/store.js';
import { nativePackage, png } from './helpers.js';

const roots: string[] = [];
const stores: ProjectStore[] = [];
const now: string = '2026-09-09T02:00:00.000Z';
type Fixture = { root: string; project: Project; store: ProjectStore; requests: CodexRequestStore; request: CodexRequest; input: string };
async function fixture(): Promise<Fixture> {
  const root: string = await mkdtemp(join(tmpdir(), 'apply-consistency-')); roots.push(root);
  const store: ProjectStore = new ProjectStore(join(root, 'data')); stores.push(store);
  const project: Project = await store.create(createSourceOutline(importPackage(await nativePackage()), { proposedTextHoldMs: 2000 }));
  const requests: CodexRequestStore = new CodexRequestStore(join(root, 'requests'), readBuildManifest());
  const request: CodexRequest = await requests.create('image', project.projectId, 'frame-1', codexRequestBasis(project, 'image', 'frame-1'), now);
  const input: string = join(root, 'result.png'); await writeFile(input, await png(2, 2));
  return { root, project, store, requests, request, input };
}
afterEach(async (): Promise<void> => {
  vi.restoreAllMocks();
  for (const store of stores.splice(0)) await store.close();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function terminalBeforeApply(kind: 'failed' | 'superseded'): Promise<void> {
  const f: Fixture = await fixture();
  const reached = Promise.withResolvers<void>(); const release = Promise.withResolvers<void>();
  const read: (id: string) => Promise<CodexRequest> = f.requests.read.bind(f.requests);
  vi.spyOn(f.requests, 'read').mockImplementationOnce(async (id: string): Promise<CodexRequest> => {
    const snapshot: CodexRequest = await read(id); reached.resolve(); await release.promise; return snapshot;
  });
  const applying: Promise<Project> = applyCodexImage(f.request.id, f.input, f.store, f.requests, now);
  const outcome: Promise<string | null> = applying.then((): null => null, (error: unknown): string => (error as { code: string }).code);
  await reached.promise;
  if (kind === 'failed') await f.requests.fail(f.request.id, 'TEST_FAILURE', '적용보다 먼저 실패 확정', now);
  else await new CodexRequestStore(join(f.root, 'requests'), { ...readBuildManifest(), generationContractSha256: 'e'.repeat(64) })
    .create(f.request.kind, f.request.projectId, f.request.targetId, f.request.basisHash, now);
  release.resolve();
  expect(await outcome).toBe('CODEX_REQUEST_SETTLED');
  expect((await read(f.request.id)).status).toBe(kind);
  const current: Project = await f.store.read(f.project.projectId);
  expect(current.generationRecords).toHaveLength(0);
  expect(current.assets).toHaveLength(0);
  expect(current.revision).toBe(0);
}

describe('실제 Request·Project 저장소 결과 적용', (): void => {
  it('superseded_request_cannot_commit_generated_asset', async (): Promise<void> => { await terminalBeforeApply('superseded'); });
  it('failed_request_cannot_commit_generated_asset', async (): Promise<void> => { await terminalBeforeApply('failed'); });
  it('recovered_request_keeps_original_result_revision', async (): Promise<void> => {
    const f: Fixture = await fixture(); let committed: boolean = false;
    const update = f.store.update.bind(f.store);
    vi.spyOn(f.store, 'update').mockImplementationOnce(async (...args: Parameters<ProjectStore['update']>): Promise<Project> => {
      const project: Project = await update(...args); committed = true; return project;
    });
    const interrupted: CodexRequestStore = new CodexRequestStore(join(f.root, 'requests'), readBuildManifest(), {
      trigger(context: RequestFaultContext): void {
        if (committed && context.point === 'after-lock-acquired') throw contractError('TEST_SETTLEMENT_INTERRUPTED', 'Project Commit 이후 완료 기록 중단', []);
      },
    });
    await expect(applyCodexImage(f.request.id, f.input, f.store, interrupted, now)).rejects.toMatchObject({ code: 'TEST_SETTLEMENT_INTERRUPTED' });
    const applied: Project = await f.store.read(f.project.projectId); expect(applied.revision).toBe(1);
    const later: Project = await f.store.update(applied.projectId, applied.revision, (current: Project): Project => ({ ...current, title: '후속 사용자 편집' }), []);
    const recovered: Project = await applyCodexImage(f.request.id, f.input, f.store, f.requests, now);
    expect(recovered).toEqual(later);
    expect((await f.requests.read(f.request.id)).resultRevision).toBe(applied.revision);
    expect(recovered.generationRecords).toHaveLength(1); expect(recovered.assets).toHaveLength(1);
  });
});

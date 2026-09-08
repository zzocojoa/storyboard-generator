import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { hostname, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { readBuildManifest } from '../src/build.js';
import { CodexRequestStore } from '../src/codex/requests.js';
import { shotContent } from '../src/domain/edit.js';
import type { Project, Shot } from '../src/domain/schema.js';
import { importPackage } from '../src/importers/import-package.js';
import { sha256Text } from '../src/importers/integrity.js';
import { createSourceOutline } from '../src/proposal/outline.js';
import { createApp } from '../src/server/app.js';
import { ProjectStore } from '../src/server/store.js';
import { nativeData, nativePackage, TEST_AUDIO_NORMALIZATION_OPTIONS, withNativeData } from './helpers.js';
import { finalFixture, nonSourcedShot, readinessOutline, withFirstGap } from './readiness-fixtures.js';

type HttpFixture = { app: FastifyInstance; store: ProjectStore; dataRoot: string; project: Project; other: Project; lockPath: string };
const fixtures: { app: FastifyInstance; root: string }[] = [];
afterEach(async (): Promise<void> => { for (const fixture of fixtures.splice(0)) { await fixture.app.close(); await rm(fixture.root, { recursive: true, force: true }); } });

async function fixture(): Promise<HttpFixture> {
  const root: string = await mkdtemp(join(tmpdir(), 'storyboard-readiness-http-')); const dataRoot: string = join(root, 'data');
  const store: ProjectStore = new ProjectStore(dataRoot);
  try {
    const webRoot: string = join(root, 'web');
    await mkdir(join(webRoot, 'assets'), { recursive: true });
    await writeFile(join(webRoot, 'index.html'), '<div id="root"></div>');
    const base: Project = await store.create(await readinessOutline());
    const ready = await finalFixture();
    const project: Project = await store.update(base.projectId, base.revision, (): Project => ready.project,
      ready.project.assets.map((asset) => ({ relativePath: asset.path, content: ready.media.get(asset.id) as Buffer })));
    const payload = await nativePackage(); const other: Project = await store.create(createSourceOutline(importPackage(withNativeData(payload, { ...nativeData(payload), projectId: 'independent' })), { proposedTextHoldMs: 2000 }));
    const requestRoot: string = join(root, 'requests');
    const app: FastifyInstance = await createApp({ host: '127.0.0.1', port: 0, dataRoot, webRoot,
      pdfFontPath: resolve('assets/fonts/NanumGothic-Regular.ttf'), audioNormalization: TEST_AUDIO_NORMALIZATION_OPTIONS,
      codex: { requestRoot, speechVoice: 'Yuna' } }, store, new CodexRequestStore(requestRoot));
    fixtures.push({ app, root }); return { app, store, dataRoot, project, other, lockPath: join(dataRoot, sha256Text(project.projectId), 'write.lock') };
  } catch (error: unknown) {
    await store.close(); await rm(root, { recursive: true, force: true }); throw error;
  }
}
async function writeLiveLock(value: HttpFixture): Promise<string> {
  const transactionId: string = randomUUID();
  await writeFile(value.lockPath, JSON.stringify({ version: 2, projectId: value.project.projectId, host: hostname(), pid: process.pid, transactionId, createdAt: new Date().toISOString() }));
  return transactionId;
}
async function corruptObservedLock(value: HttpFixture): Promise<string> {
  const transactionId: string = await writeLiveLock(value); await value.store.statusSnapshot(); await writeFile(value.lockPath, '{broken'); return transactionId;
}

describe('HTTP Final과 Playhead', (): void => {
  it('visual_plan_http_update_increments_one_revision', async (): Promise<void> => {
    const { app, store, project, dataRoot } = await fixture();
    let current: Project = project;
    const versionsPath: string = join(dataRoot, sha256Text(project.projectId), 'versions');
    for (const mode of ['black', 'hold-previous'] as const) {
      const originalShot: Shot = current.shots[1] as Shot;
      for (const shot of [nonSourcedShot(originalShot, mode), originalShot]) {
        const before: string[] = await readdir(versionsPath);
        const response = await app.inject({ method: 'PATCH', url: `/api/projects/${project.projectId}/shots/${shot.id}/visual-plan`,
          payload: { expectedRevision: current.revision, visualPlan: { visualMode: shot.visualMode, sourceLinks: shot.sourceLinks } } });
        expect(response.statusCode).toBe(200);
        const next: Project = response.json<{ project: Project }>().project;
        expect(next.revision).toBe(current.revision + 1);
        expect(next.shots[1]?.visualMode).toBe(shot.visualMode);
        expect(next.assets).toEqual(project.assets);
        expect(next.generationRecords).toEqual(project.generationRecords);
        expect((await readdir(versionsPath)).length).toBe(before.length + 1);
        current = next;
      }
    }
    const beforeBytes: string = await readFile(join(dataRoot, sha256Text(project.projectId), 'project.json'), 'utf8');
    const beforeVersions: string[] = await readdir(versionsPath);
    const failed = await app.inject({ method: 'PATCH', url: `/api/projects/${project.projectId}/shots/shot-1/visual-plan`,
      payload: { expectedRevision: current.revision, visualPlan: { visualMode: 'hold-previous', sourceLinks: nonSourcedShot(current.shots[0]!, 'hold-previous').sourceLinks } } });
    expect(failed.statusCode).toBe(400);
    expect(failed.json().error.issues).toContainEqual(expect.objectContaining({ code: 'HOLD_PREVIOUS_SOURCE_UNAVAILABLE' }));
    expect(await readFile(join(dataRoot, sha256Text(project.projectId), 'project.json'), 'utf8')).toBe(beforeBytes);
    expect(await readdir(versionsPath)).toEqual(beforeVersions);
    const legacy = await app.inject({ method: 'PATCH', url: `/api/projects/${project.projectId}/shots/shot-1`,
      payload: { expectedRevision: current.revision, content: { ...shotContent(current.shots[0]!), visualMode: 'black' } } });
    expect(legacy.statusCode).toBe(400);
    expect(legacy.json().error).toMatchObject({ code: 'VISUAL_PLAN_ATOMIC_UPDATE_REQUIRED', mutationBlocked: false });
    expect((await store.read(project.projectId)).revision).toBe(current.revision);
  });
  it('safe_visual_output_uses_actual_playhead', async (): Promise<void> => {
    const value = await fixture(); await value.store.update(value.project.projectId, value.project.revision, (project: Project): Project => withFirstGap(project, 1000), []);
    const path: string = `/api/projects/${value.project.projectId}/output/visual`;
    const safe = await value.app.inject({ method: 'GET', url: `${path}?atMs=999` }); expect(safe.statusCode).toBe(200); expect(safe.headers['cache-control']).toBe('no-store');
    const blocked = await value.app.inject({ method: 'GET', url: `${path}?atMs=1000` }); expect(blocked.statusCode).toBe(409); expect(blocked.json().error.code).toBe('VISUAL_OUTPUT_BLOCKED');
    expect((await value.app.inject({ method: 'GET', url: `${path}?atMs=-1` })).statusCode).toBe(400);
    expect((await value.app.inject({ method: 'GET', url: `${path}?atMs=17500` })).statusCode).toBe(400);
  });
  it('status_exposes_build_provenance', async (): Promise<void> => {
    const { app } = await fixture(); expect((await app.inject({ method: 'GET', url: '/api/status' })).json().build).toEqual(readBuildManifest());
  });
  it('final_http_exports_fail_before_file_response_and_pass_after_confirmation', async (): Promise<void> => {
    const { store, app, project } = await fixture(); const draft: Project = await store.update(project.projectId, project.revision,
      (current: Project): Project => ({ ...current, textCues: current.textCues.map((cue) => ({ ...cue, timingStatus: 'proposed' })) }), []);
    for (const extension of ['csv', 'pdf']) {
      const failed = await app.inject({ method: 'GET', url: `/api/projects/${project.projectId}/export.${extension}?maturity=final` });
      expect(failed.statusCode).toBe(409); expect(failed.json().error).toMatchObject({ code: 'FINAL_OUTPUT_NOT_READY', scope: 'project', mutationBlocked: false, retryable: true });
      expect((await app.inject({ method: 'GET', url: `/api/projects/${project.projectId}/export.${extension}?maturity=draft` })).statusCode).toBe(200);
    }
    let revision: number = draft.revision;
    for (const cue of draft.textCues) {
      const response = await app.inject({ method: 'POST', url: `/api/projects/${project.projectId}/text/${cue.id}/confirm`, payload: { expectedRevision: revision } });
      expect(response.statusCode).toBe(200); revision += 1;
    }
    expect((await app.inject({ method: 'GET', url: `/api/projects/${project.projectId}/final-readiness` })).json().finalReady).toBe(true);
    for (const extension of ['csv', 'pdf']) expect((await app.inject({ method: 'GET', url: `/api/projects/${project.projectId}/export.${extension}?maturity=final` })).statusCode).toBe(200);
  });
  it('safe_audio_range_preserves_integrity_and_rejects_invalid_range', async (): Promise<void> => {
    const { app, project, dataRoot } = await fixture(); const cue = project.audioCues[0]!; const path: string = `/api/projects/${project.projectId}/output/audio/${cue.id}`;
    const full = await app.inject({ method: 'GET', url: path });
    const partial = await app.inject({ method: 'GET', url: path, headers: { range: 'bytes=44-63' } });
    expect(partial.statusCode).toBe(206); expect(partial.rawPayload).toEqual(full.rawPayload.subarray(44, 64)); expect(partial.headers['accept-ranges']).toBe('bytes');
    expect((await app.inject({ method: 'GET', url: path, headers: { range: 'bytes=999999999-' } })).statusCode).toBe(416);
    const asset = project.assets.find((item): boolean => item.id === cue.assetId)!; await writeFile(join(dataRoot, sha256Text(project.projectId), asset.path), 'broken');
    const failed = await app.inject({ method: 'GET', url: path, headers: { range: 'bytes=0-1' } }); expect(failed.statusCode).toBe(423); expect(failed.json().error.scope).toBe('asset');
  });
  it('http_audit_current_version_mismatch_blocks_only_project_mutation', async (): Promise<void> => {
    const { app, dataRoot, project } = await fixture(); const path: string = join(dataRoot, sha256Text(project.projectId), 'project.json');
    await writeFile(path, JSON.stringify({ ...project, title: '불일치 Current' }));
    const response = await app.inject({ method: 'GET', url: `/api/projects/${project.projectId}/generation-audit` });
    expect(response.statusCode).toBe(423); expect(response.json().error).toMatchObject({ code: 'AUDIT_CURRENT_VERSION_MISMATCH', scope: 'project', mutationBlocked: true });
    expect(JSON.parse(await readFile(path, 'utf8')).title).toBe('불일치 Current');
  });
});

describe('Active Update 오류 가시성', (): void => {
  it('status_does_not_hide_unverifiable_active_update', async (): Promise<void> => {
    const value = await fixture(); const transactionId: string = await corruptObservedLock(value);
    const status = await value.store.statusSnapshot(); expect(status.activeUpdates).toEqual(expect.arrayContaining([expect.objectContaining({ transactionId })]));
    expect(status.activeUpdateErrors).toEqual(expect.arrayContaining([expect.objectContaining({ projectId: value.project.projectId, transactionId })]));
  });
  it('status_converts_corrupt_update_lock_to_project_recovery_state', async (): Promise<void> => {
    const value = await fixture(); await writeFile(value.lockPath, '{corrupt'); const status = await value.store.statusSnapshot();
    expect(status.recoveryBlocks).toEqual(expect.arrayContaining([expect.objectContaining({ projectId: value.project.projectId })]));
    await expect(value.store.assertMutable(value.project.projectId)).rejects.toMatchObject({ code: 'STORE_RECOVERY_BLOCKED' });
  });
  it('foreign_active_update_remains_visible', async (): Promise<void> => {
    const value = await fixture(); const transactionId: string = await writeLiveLock(value); const lock = JSON.parse(await readFile(value.lockPath, 'utf8')) as { host: string };
    await writeFile(value.lockPath, JSON.stringify({ ...lock, host: 'foreign-host' })); const status = await value.store.statusSnapshot();
    expect(status.activeUpdates).toEqual(expect.arrayContaining([expect.objectContaining({ transactionId, host: 'foreign-host' })]));
    expect(status.activeUpdateErrors).toHaveLength(1); expect(await readFile(value.lockPath, 'utf8')).toContain('foreign-host');
  });
  it('active_update_error_is_project_scoped', async (): Promise<void> => {
    const value = await fixture(); await corruptObservedLock(value); const status = (await value.app.inject({ method: 'GET', url: '/api/status' })).json();
    expect(status.activeUpdateErrors.map((entry: { projectId: string }): string => entry.projectId)).toEqual([value.project.projectId]); expect(status.processHeartbeat.healthy).toBe(true);
  });
  it('unrelated_project_continues_during_active_update_error', async (): Promise<void> => {
    const value = await fixture(); await corruptObservedLock(value); await value.store.statusSnapshot();
    const next: Project = await value.store.update(value.other.projectId, value.other.revision, (project: Project): Project => ({ ...project, title: '독립 수정' }), []);
    expect(next.revision).toBe(1); expect((await value.store.read(value.other.projectId)).title).toBe('독립 수정');
  });
  it('status_refresh_is_idempotent_after_update_recovery', async (): Promise<void> => {
    const value = await fixture(); const transactionId: string = await corruptObservedLock(value); const first = await value.store.statusSnapshot(); const second = await value.store.statusSnapshot();
    expect(second.activeUpdateErrors).toEqual(first.activeUpdateErrors); expect(second.recoveryBlocks).toEqual(first.recoveryBlocks);
    expect(second.activeUpdates).toEqual(first.activeUpdates);
    await writeFile(value.lockPath, JSON.stringify({ version: 2, projectId: value.project.projectId, host: hostname(), pid: 2147483647, transactionId, createdAt: new Date().toISOString() }));
    const recovered = await value.store.statusSnapshot();
    expect(recovered.activeUpdates).toEqual([]); expect(recovered.activeUpdateErrors).toEqual([]); expect(recovered.recoveryBlocks).toEqual([]);
    const refreshed = await value.store.statusSnapshot();
    expect(refreshed.activeUpdates).toEqual([]); expect(refreshed.activeUpdateErrors).toEqual([]); expect(refreshed.recoveryBlocks).toEqual([]);
    await expect(readFile(value.lockPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

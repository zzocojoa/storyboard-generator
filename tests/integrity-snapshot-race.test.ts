import { realpathSync } from 'node:fs';
import { chmod, readFile, rename, stat, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Asset, Project } from '../src/domain/schema.js';
import { contractError } from '../src/domain/errors.js';
import { readReviewArchive } from '../src/exporters/review-bundle.js';
import { sha256Text } from '../src/importers/integrity.js';
import { httpErrorPolicy } from '../src/server/app.js';
import { SafeStoreFilesystem } from '../src/server/safe-filesystem.js';
import { assetFailureCode } from '../src/server/store.js';
import { closeHardeningHttpFixture, hardeningHttpFixture } from './hardening-http-fixtures.js';
import type { HardeningHttpFixture } from './hardening-http-fixtures.js';

const fixtures: HardeningHttpFixture[] = [];
afterEach(async (): Promise<void> => {
  vi.restoreAllMocks();
  for (const fixture of fixtures.splice(0)) await closeHardeningHttpFixture(fixture);
});
async function setup(): Promise<HardeningHttpFixture> {
  const fixture: HardeningHttpFixture = await hardeningHttpFixture(); fixtures.push(fixture); return fixture;
}
function pathFor(fixture: HardeningHttpFixture, asset: Asset): string {
  return join(realpathSync(fixture.dataRoot), sha256Text(fixture.project.projectId), asset.path);
}
function changeAfterRead(path: string, change: (count: number) => Promise<void>): () => number {
  const read: SafeStoreFilesystem['read'] = SafeStoreFilesystem.prototype.read;
  let count: number = 0;
  vi.spyOn(SafeStoreFilesystem.prototype, 'read').mockImplementation(async function (this: SafeStoreFilesystem, candidate: string): Promise<Buffer> {
    const bytes: Buffer = await read.call(this, candidate);
    if (candidate === path) { count += 1; await change(count); }
    return bytes;
  });
  return (): number => count;
}
function countAssetReads(): () => number {
  const spy = vi.spyOn(SafeStoreFilesystem.prototype, 'read');
  return (): number => spy.mock.calls.filter(([path]): boolean => path.includes('/assets/')).length;
}

describe('변경 중인 Integrity Snapshot과 Revision 독립 캐시', (): void => {
  it('summary_integrity_retries_when_file_changes_during_check', async (): Promise<void> => {
    const fixture: HardeningHttpFixture = await setup(); const path: string = pathFor(fixture, fixture.project.assets[0]!);
    const bytes: Buffer = await readFile(path);
    const count = changeAfterRead(path, async (attempt: number): Promise<void> => {
      if (attempt !== 1) return;
      await writeFile(`${path}.replacement`, bytes); await rename(`${path}.replacement`, path);
    });
    expect((await fixture.store.list())[0]!.finalOutputReady).toBe(true);
    expect(count()).toBe(2);
    await fixture.store.list(); expect(count()).toBe(2);
  });
  it('summary_integrity_fails_closed_when_file_keeps_changing', async (): Promise<void> => {
    const fixture: HardeningHttpFixture = await setup(); const path: string = pathFor(fixture, fixture.project.assets[0]!);
    const bytes: Buffer = await readFile(path);
    const count = changeAfterRead(path, async (): Promise<void> => {
      await writeFile(`${path}.replacement`, bytes); await rename(`${path}.replacement`, path);
    });
    expect((await fixture.store.list())[0]!.finalOutputReady).toBe(false);
    expect(count()).toBe(2);
    expect(fixture.store.summaryIntegrityCacheStatistics().entries).toBe(fixture.project.assets.length - 1);
  });
  it('summary_never_returns_verified_for_changed_during_check', async (): Promise<void> => {
    const fixture: HardeningHttpFixture = await setup(); const path: string = pathFor(fixture, fixture.project.assets[0]!);
    changeAfterRead(path, async (attempt: number): Promise<void> => { if (attempt === 1) await writeFile(path, 'damaged'); });
    expect((await fixture.store.list())[0]!.framesOutputSafe).toBeLessThan(fixture.project.frames.length);
  });
  it('summary_changed_during_check_sets_final_output_ready_false', async (): Promise<void> => {
    const fixture: HardeningHttpFixture = await setup(); const path: string = pathFor(fixture, fixture.project.assets[0]!);
    changeAfterRead(path, async (): Promise<void> => { await writeFile(path, 'damaged'); });
    expect((await fixture.store.list())[0]!.finalOutputReady).toBe(false);
  });
  it('summary_changed_during_check_excludes_safe_counts', async (): Promise<void> => {
    const fixture: HardeningHttpFixture = await setup();
    const asset: Asset = fixture.project.assets.find((candidate: Asset): boolean => candidate.kind === 'audio')!;
    const path: string = pathFor(fixture, asset);
    changeAfterRead(path, async (): Promise<void> => { await writeFile(path, 'damaged'); });
    expect((await fixture.store.list())[0]!.audioPlayable).toBe(fixture.project.audioCues.length - 1);
  });
  it('non_asset_revision_reuses_integrity_cache', async (): Promise<void> => {
    const fixture: HardeningHttpFixture = await setup(); await fixture.store.list();
    await fixture.store.update(fixture.project.projectId, fixture.project.revision, (project: Project): Project => ({ ...project, title: '제목만 변경' }), []);
    const count = countAssetReads(); await fixture.store.list(); expect(count()).toBe(0);
  });
  it('asset_catalog_append_preserves_existing_cache_entries', async (): Promise<void> => {
    const fixture: HardeningHttpFixture = await setup(); await fixture.store.list(); const original: Asset = fixture.project.assets[0]!;
    const asset: Asset = { ...original, id: 'appended-image', path: 'assets/appended-image.png', version: 2 };
    await fixture.store.update(fixture.project.projectId, fixture.project.revision, (project: Project): Project => ({ ...project, assets: [...project.assets, asset] }),
      [{ relativePath: asset.path, content: await readFile(pathFor(fixture, original)) }]);
    const count = countAssetReads(); await fixture.store.list(); expect(count()).toBe(1);
  });
  it('cache_key_does_not_depend_on_project_revision', async (): Promise<void> => {
    const fixture: HardeningHttpFixture = await setup(); await fixture.store.list();
    const updated: Project = await fixture.store.update(fixture.project.projectId, fixture.project.revision, (project: Project): Project => ({
      ...project, shots: project.shots.map((shot) => ({ ...shot, action: '수정한 행동', camera: { ...shot.camera, angle: 'high' } })),
    }), []);
    expect(updated.revision).toBe(fixture.project.revision + 1);
    const count = countAssetReads(); await fixture.store.list(); expect(count()).toBe(0);
  });
  it('cache_invalidates_on_inode_change', async (): Promise<void> => {
    const fixture: HardeningHttpFixture = await setup(); await fixture.store.list(); const path: string = pathFor(fixture, fixture.project.assets[0]!);
    const before = await stat(path); await writeFile(`${path}.replacement`, await readFile(path)); await rename(`${path}.replacement`, path);
    expect((await stat(path)).ino).not.toBe(before.ino);
    const count = countAssetReads(); await fixture.store.list(); expect(count()).toBe(1);
  });
  it('cache_invalidates_on_size_change', async (): Promise<void> => {
    const fixture: HardeningHttpFixture = await setup(); await fixture.store.list(); const path: string = pathFor(fixture, fixture.project.assets[0]!);
    await writeFile(path, 'broken');
    const count = countAssetReads(); expect((await fixture.store.list())[0]!.finalOutputReady).toBe(false); expect(count()).toBe(1);
  });
  it('cache_invalidates_on_mtime_change', async (): Promise<void> => {
    const fixture: HardeningHttpFixture = await setup(); await fixture.store.list(); const path: string = pathFor(fixture, fixture.project.assets[0]!);
    await utimes(path, new Date('2020-01-01'), new Date('2020-01-01'));
    const count = countAssetReads(); await fixture.store.list(); expect(count()).toBe(1);
  });
  it('cache_invalidates_on_ctime_change', async (): Promise<void> => {
    const fixture: HardeningHttpFixture = await setup(); await fixture.store.list(); const path: string = pathFor(fixture, fixture.project.assets[0]!);
    const before = await stat(path); await chmod(path, 0o640); const after = await stat(path);
    expect(after.mtimeMs).toBe(before.mtimeMs); expect(after.ctimeMs).not.toBe(before.ctimeMs);
    const count = countAssetReads(); await fixture.store.list(); expect(count()).toBe(1);
  });
  it('final_readiness_still_forces_asset_revalidation', async (): Promise<void> => {
    const fixture: HardeningHttpFixture = await setup(); await fixture.store.list(); const count = countAssetReads();
    await fixture.store.finalReadiness(fixture.project.projectId); expect(count()).toBe(fixture.project.assets.length);
  });
  it('safe_visual_still_forces_asset_revalidation', async (): Promise<void> => {
    const fixture: HardeningHttpFixture = await setup(); await fixture.store.list(); const count = countAssetReads();
    await fixture.store.safeVisual(fixture.project.projectId, 0, 'program-monitor'); expect(count()).toBe(1);
  });
  it('safe_frame_still_forces_asset_revalidation', async (): Promise<void> => {
    const fixture: HardeningHttpFixture = await setup(); await fixture.store.list(); const count = countAssetReads();
    await fixture.store.safeFrame(fixture.project.projectId, fixture.project.frames[0]!.id); expect(count()).toBe(1);
  });
  it('safe_audio_still_forces_asset_revalidation', async (): Promise<void> => {
    const fixture: HardeningHttpFixture = await setup(); await fixture.store.list(); const count = countAssetReads();
    await fixture.store.safeAudio(fixture.project.projectId, fixture.project.audioCues[0]!.id); expect(count()).toBe(1);
  });
  it('review_bundle_still_forces_asset_revalidation', async (): Promise<void> => {
    const fixture: HardeningHttpFixture = await setup(); await fixture.store.list(); const count = countAssetReads();
    await readReviewArchive(fixture.dataRoot, fixture.project.projectId); expect(count()).toBeGreaterThanOrEqual(fixture.project.assets.length);
  });
  it('changed_integrity_snapshot_uses_stored_asset_error_contract', (): void => {
    const error: Error = contractError('STORED_ASSET_CHANGED_DURING_CHECK', 'Asset이 검사 중 변경됐습니다.', []);
    expect(assetFailureCode(error)).toBe('STORED_ASSET_CHANGED_DURING_CHECK');
    expect(httpErrorPolicy(error)).toMatchObject({ status: 423, scope: 'asset', mutationBlocked: false });
  });
});

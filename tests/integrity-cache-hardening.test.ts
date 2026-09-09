import { readFile, rename, utimes, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readBuildManifest } from '../src/build.js';
import type { Asset, Project } from '../src/domain/schema.js';
import { readReviewArchive, writeReviewBundle } from '../src/exporters/review-bundle.js';
import { sha256Text } from '../src/importers/integrity.js';
import { SafeStoreFilesystem } from '../src/server/safe-filesystem.js';
import { closeHardeningHttpFixture, hardeningHttpFixture } from './hardening-http-fixtures.js';
import type { HardeningHttpFixture } from './hardening-http-fixtures.js';

const fixtures: HardeningHttpFixture[] = [];
afterEach(async (): Promise<void> => { vi.restoreAllMocks(); for (const value of fixtures.splice(0)) await closeHardeningHttpFixture(value); });
async function fixture(): Promise<HardeningHttpFixture> { const value = await hardeningHttpFixture(); fixtures.push(value); return value; }
function assetPath(value: HardeningHttpFixture, asset: Asset): string { return join(value.dataRoot, sha256Text(value.project.projectId), asset.path); }
function reads(): { count: () => number; clear: () => void } { const spy = vi.spyOn(SafeStoreFilesystem.prototype, 'read'); return { count: (): number => spy.mock.calls.filter(([path]): boolean => path.includes('/assets/')).length, clear: (): void => { spy.mockClear(); } }; }

describe('목록 Integrity 캐시와 강제 안전 검사', (): void => {
  it('project_list_reuses_integrity_cache_for_unchanged_asset', async (): Promise<void> => {
    const value = await fixture(); const observed = reads(); await value.store.list(); expect(observed.count()).toBeGreaterThan(0);
    observed.clear(); await value.store.list(); expect(observed.count()).toBe(0);
    expect(value.store.summaryIntegrityCacheStatistics()).toMatchObject({ entries: value.project.assets.length, hits: value.project.assets.length });
    await value.app.close(); expect(value.store.summaryIntegrityCacheStatistics()).toEqual({ entries: 0, hits: 0, misses: 0 });
  });
  it('integrity_cache_invalidates_on_inode_change', async (): Promise<void> => {
    const value = await fixture(); await value.store.list(); const path: string = assetPath(value, value.project.assets[0]!);
    const bytes: Buffer = await readFile(path); await writeFile(`${path}.replacement`, bytes); await rename(`${path}.replacement`, path);
    const observed = reads(); await value.store.list(); expect(observed.count()).toBeGreaterThan(0);
  });
  it('integrity_cache_invalidates_on_size_or_mtime_change', async (): Promise<void> => {
    const value = await fixture(); await value.store.list(); const path: string = assetPath(value, value.project.assets[0]!);
    await utimes(path, new Date('2026-01-01'), new Date('2026-01-01')); const observed = reads(); await value.store.list(); expect(observed.count()).toBeGreaterThan(0);
    observed.clear(); await writeFile(path, 'broken'); const summary = await value.store.list(); expect(observed.count()).toBeGreaterThan(0); expect(summary[0]!.finalOutputReady).toBe(false);
  });
  it('new_asset_does_not_reuse_old_cache_entry', async (): Promise<void> => {
    const value = await fixture(); await value.store.list(); const original: Asset = value.project.assets[0]!;
    const added: Asset = { ...original, id: 'new-version', path: 'assets/new-version.png', version: 2 };
    await value.store.update(value.project.projectId, value.project.revision, (project: Project): Project => ({ ...project, assets: [...project.assets, added] }), [{ relativePath: added.path, content: await readFile(assetPath(value, original)) }]);
    const observed = reads(); await value.store.list(); expect(observed.count()).toBeGreaterThan(0);
    observed.clear(); await value.store.list(); expect(observed.count()).toBe(0);
  });
  it('final_readiness_forces_asset_revalidation', async (): Promise<void> => {
    const value = await fixture(); await value.store.list(); const observed = reads(); await value.store.finalReadiness(value.project.projectId); expect(observed.count()).toBeGreaterThan(0);
  });
  it('safe_visual_forces_asset_revalidation', async (): Promise<void> => {
    const value = await fixture(); await value.store.list(); const observed = reads(); await value.store.safeVisual(value.project.projectId, 0, 'program-monitor'); expect(observed.count()).toBeGreaterThan(0);
  });
  it('safe_audio_forces_asset_revalidation', async (): Promise<void> => {
    const value = await fixture(); await value.store.list(); const observed = reads(); await value.store.safeAudio(value.project.projectId, value.project.audioCues[0]!.id); expect(observed.count()).toBeGreaterThan(0);
  });
  it('review_bundle_forces_asset_revalidation', async (): Promise<void> => {
    const value = await fixture(); await value.store.list(); const observed = reads();
    const archive = await readReviewArchive(value.dataRoot, value.project.projectId); expect(observed.count()).toBeGreaterThan(0); observed.clear();
    await writeReviewBundle(archive, { output: join(value.root, 'bundle'), maturity: 'final', fontPath: resolve('assets/fonts/NanumGothic-Regular.ttf'), createdAt: '2026-09-07T00:00:00.000Z', build: readBuildManifest() }, []);
    expect(observed.count()).toBeGreaterThan(0);
  });
  it('cached_summary_cannot_make_corrupt_asset_safe', async (): Promise<void> => {
    const value = await fixture(); expect((await value.store.list())[0]!.finalOutputReady).toBe(true);
    const asset: Asset = value.project.assets.find((asset): boolean => asset.id === value.project.frames[0]!.imageAssetId)!;
    await writeFile(assetPath(value, asset), 'corrupt');
    expect((await value.store.finalReadiness(value.project.projectId)).finalReady).toBe(false);
    await expect(value.store.safeVisual(value.project.projectId, 0, 'program-monitor')).rejects.toMatchObject({ code: 'STORED_ASSET_HASH_MISMATCH' });
  });
  it('safe_frame_and_download_force_asset_revalidation', async (): Promise<void> => {
    const value = await fixture(); await value.store.list(); const observed = reads();
    await value.store.safeFrame(value.project.projectId, value.project.frames[0]!.id); expect(observed.count()).toBeGreaterThan(0); observed.clear();
    await value.store.asset(value.project.projectId, value.project.assets[0]!.id); expect(observed.count()).toBeGreaterThan(0);
  });

});

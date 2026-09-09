import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { generatorBuildProvenance, readBuildManifest } from '../src/build.js';
import type { GenerationRecord, GeneratorBuildProvenance, Project } from '../src/domain/schema.js';
import { exportProjectJson } from '../src/exporters/json.js';
import { readReviewArchive, writeReviewBundle } from '../src/exporters/review-bundle.js';
import type { ReviewArchive, ReviewBundleOptions } from '../src/exporters/review-bundle.js';
import { sha256Bytes, sha256Text } from '../src/importers/integrity.js';
import { stableJsonStringify } from '../src/io/stable-json.js';
import { SafeStoreFilesystem } from '../src/server/safe-filesystem.js';
import { readyVisualFixture } from './readiness-fixtures.js';

type Fixture = { root: string; project: Project; archive: ReviewArchive; options: ReviewBundleOptions };
const roots: string[] = [];
afterEach(async (): Promise<void> => { vi.restoreAllMocks(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
function record(project: Project, id: string, generatorBuild: GeneratorBuildProvenance | null, assetId: string): GenerationRecord {
  return { id, provider: 'codex-app', model: 'current', modelVersion: null, generatorBuild, requestId: id, prompt: `원본 ${id}`, templateVersion: '1', seed: null, referenceHashes: [],
    resultAssetIds: [assetId], shotIds: [project.shots[0]!.id], createdAt: '2026-09-07T00:00:00.000Z' };
}
async function fixture(order: readonly number[]): Promise<Fixture> {
  const root: string = await mkdtemp(join(tmpdir(), 'review-determinism-')); roots.push(root);
  const { project: base, bytes } = await readyVisualFixture();
  const build: GeneratorBuildProvenance = generatorBuildProvenance(readBuildManifest());
  const records: GenerationRecord[] = [record(base, 'z-first', build, base.assets[0]!.id),
    record(base, 'a-second', { ...build, generationContractSha256: 'b'.repeat(64) }, base.assets[0]!.id), record(base, 'legacy', null, base.assets[1]!.id)];
  const project: Project = { ...base, revision: 2, assets: [...base.assets].reverse(), generationRecords: records };
  const directory: string = join(root, 'data', sha256Text(project.projectId));
  await mkdir(join(directory, 'versions'), { recursive: true }); await mkdir(join(directory, 'assets'));
  await writeFile(join(directory, 'project.json'), exportProjectJson(project));
  for (const revision of order) await writeFile(join(directory, 'versions', `${String(revision).padStart(6, '0')}.json`), exportProjectJson({ ...project, revision, generationRecords: records.slice(0, revision + 1) }));
  for (const asset of project.assets) await writeFile(join(directory, asset.path), bytes);
  return { root, project, archive: await readReviewArchive(join(root, 'data'), project.projectId), options: { output: join(root, 'bundle'), maturity: 'draft',
    fontPath: resolve('assets/fonts/NanumGothic-Regular.ttf'), createdAt: '2026-09-07T00:00:00.000Z', build: readBuildManifest() } };
}
async function fileHashes(output: string): Promise<Record<string, string>> {
  return Object.fromEntries(await Promise.all((await readdir(output)).sort().map(async (path: string): Promise<[string, string]> => [path, sha256Bytes(await readFile(join(output, path)))])));
}
async function assetManifest(value: Fixture): Promise<{ assets: { id: string; generation: { recordId: string; introducedRevision: number | null; generatorBuild: GeneratorBuildProvenance | null }[] }[] }> {
  return JSON.parse(await readFile(join(value.options.output, 'asset-manifest.json'), 'utf8'));
}

describe('결정적 Bundle과 생성 Build 의미', (): void => {
  it('review_bundle_is_stable_with_unsorted_directory_entries', async (): Promise<void> => {
    const value = await fixture([0, 1, 2]); const original = SafeStoreFilesystem.prototype.entries;
    vi.spyOn(SafeStoreFilesystem.prototype, 'entries').mockImplementation(async function (this: SafeStoreFilesystem, path: string) { return (await original.call(this, path)).reverse(); });
    const archive = await readReviewArchive(join(value.root, 'data'), value.project.projectId);
    expect(archive.versions.map((version): number => version.revision)).toEqual([0, 1, 2]);
    await writeReviewBundle(value.archive, value.options, []); const other: string = join(value.root, 'other');
    await writeReviewBundle(archive, { ...value.options, output: other }, []); expect(await fileHashes(other)).toEqual(await fileHashes(value.options.output));
  });
  it('source_hashes_use_canonical_key_order', async (): Promise<void> => {
    const value = await fixture([2, 0, 1]); expect(Object.keys(value.archive.sourceHashes)).toEqual(Object.keys(value.archive.sourceHashes).sort());
  });
  it('asset_manifest_uses_deterministic_asset_order', async (): Promise<void> => {
    const value = await fixture([0, 1, 2]); await writeReviewBundle(value.archive, value.options, []); const ids: string[] = (await assetManifest(value)).assets.map((asset): string => asset.id);
    expect(ids).toEqual([...ids].sort()); expect(value.archive.project.assets).toEqual(value.project.assets);
  });
  it('asset_generation_links_use_introduced_revision_order', async (): Promise<void> => {
    const value = await fixture([0, 1, 2]); await writeReviewBundle({ ...value.archive, versions: [...value.archive.versions].reverse() }, value.options, []);
    const links = (await assetManifest(value)).assets.find((asset): boolean => asset.id === 'image:frame-1')!.generation;
    expect(links.map((link) => ({ recordId: link.recordId, introducedRevision: link.introducedRevision }))).toEqual([{ recordId: 'z-first', introducedRevision: 0 }, { recordId: 'a-second', introducedRevision: 1 }]);
  });
  it('bundle_json_uses_stable_recursive_serialization', async (): Promise<void> => {
    const value = await fixture([1, 2, 0]); await writeReviewBundle(value.archive, value.options, []);
    for (const path of (await readdir(value.options.output)).filter((path): boolean => path.endsWith('.json'))) {
      const content: string = await readFile(join(value.options.output, path), 'utf8'); expect(content).toBe(stableJsonStringify(JSON.parse(content)));
    }
  });
  it('cross_platform_bundle_manifest_is_reproducible', async (): Promise<void> => {
    const value = await fixture([0, 1, 2]); await writeReviewBundle(value.archive, value.options, []);
    const windows = { ...value.archive, sourceHashes: Object.fromEntries(Object.entries(value.archive.sourceHashes).reverse().map(([path, hash]) => [path.replaceAll('/', '\\'), hash])) };
    const output: string = join(value.root, 'windows'); await writeReviewBundle(windows, { ...value.options, output }, []);
    expect(await fileHashes(output)).toEqual(await fileHashes(value.options.output));
  });
  it('bundle_bytes_are_equal_for_shuffled_version_creation_order', async (): Promise<void> => {
    let expected: Record<string, string> | null = null;
    for (const order of [[0, 1, 2], [2, 0, 1], [1, 2, 0]]) {
      const value = await fixture(order);
      for (let repeat: number = 0; repeat < 3; repeat += 1) {
        const output: string = `${value.options.output}-${repeat}`; await writeReviewBundle(value.archive, { ...value.options, output }, []);
        const actual: Record<string, string> = await fileHashes(output); if (expected === null) expected = actual; else expect(actual).toEqual(expected);
      }
    }
  }, 15_000);
  it('pdf_embedding_has_deterministic_opaque_raster_objects', async (): Promise<void> => {
    const value = await fixture([0, 1, 2]); await writeReviewBundle(value.archive, value.options, []);
    expect((await readFile(join(value.options.output, 'storyboard.pdf'))).includes(Buffer.from('/SMask'))).toBe(false);
  });
  it('bundle_builder_build_is_not_labeled_as_generation_build', async (): Promise<void> => {
    const value = await fixture([0, 1, 2]); const manifest = await writeReviewBundle(value.archive, value.options, []);
    expect(manifest).toMatchObject({ bundleBuilderBuild: value.options.build });
    expect(JSON.parse(await readFile(join(value.options.output, 'build-manifest.json'), 'utf8'))).toMatchObject({ artifactType: 'storyboard-bundle-builder-build', artifactVersion: '1.0.0', bundleBuilderBuild: value.options.build });
  });
  it('generation_build_summary_counts_known_builds', async (): Promise<void> => {
    const value = await fixture([0, 1, 2]); const manifest = await writeReviewBundle(value.archive, value.options, []);
    expect(manifest).toMatchObject({ generationBuildSummary: { knownBuilds: expect.arrayContaining([
      expect.objectContaining({ fingerprint: expect.objectContaining({ generationContractSha256: 'b'.repeat(64) }), recordCount: 1, resultAssetCount: 1 }),
      expect.objectContaining({ fingerprint: expect.objectContaining({ generationContractSha256: value.options.build.generationContractSha256 }), recordCount: 1, resultAssetCount: 1 }),
    ]) } });
  });
  it('generation_build_summary_preserves_unknown_legacy_records', async (): Promise<void> => {
    const value = await fixture([0, 1, 2]); const manifest = await writeReviewBundle(value.archive, value.options, []);
    expect(manifest).toMatchObject({ generationBuildSummary: { legacyNullRecordCount: 1, unknownFingerprintRecordCount: 1 } });
    expect((await assetManifest(value)).assets.find((asset): boolean => asset.id === 'image:frame-2')!.generation[0]!.generatorBuild).toBeNull();
  });
  it('asset_manifest_links_assets_to_actual_generation_records', async (): Promise<void> => {
    const value = await fixture([0, 1, 2]); await writeReviewBundle(value.archive, value.options, []);
    for (const asset of (await assetManifest(value)).assets) for (const link of asset.generation) {
      const original: GenerationRecord = value.project.generationRecords.find((record): boolean => record.id === link.recordId)!;
      expect(original.resultAssetIds).toContain(asset.id); expect(link.generatorBuild).toEqual(original.generatorBuild);
    }
  });
  it('unlinked_assets_are_reported_without_fabricated_build', async (): Promise<void> => {
    const value = await fixture([0, 1, 2]); const manifest = await writeReviewBundle(value.archive, value.options, []);
    expect(manifest).toMatchObject({ generationBuildSummary: { unlinkedAssetCount: 1 } });
    expect((await assetManifest(value)).assets.find((asset): boolean => asset.id === 'image:frame-3')!.generation).toEqual([]);
  });
});

import { parseProject } from '../src/io/project.js';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readBuildManifest } from '../src/build.js';
import { sha256Bytes, sha256Text } from '../src/importers/integrity.js';
import { exportProjectJson } from '../src/exporters/json.js';
import { readReviewArchive, writeReviewBundle, reviewMediaFiles } from '../src/exporters/review-bundle.js';
import type { ReviewArchive, ReviewBundleOptions } from '../src/exporters/review-bundle.js';
import { readyVisualFixture } from './readiness-fixtures.js';

const roots: string[] = [];
afterEach(async (): Promise<void> => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture(): Promise<{ archive: ReviewArchive; options: ReviewBundleOptions; current: string; before: Buffer }> {
  const root: string = await mkdtemp(join(tmpdir(), 'read-only-bundle-')); roots.push(root);
  const { project: base, bytes } = await readyVisualFixture();
  const project = { ...base, textCues: base.textCues.map((cue) => ({ ...cue, timingStatus: 'proposed' as const })) };
  const directory: string = join(root, 'data', sha256Text(project.projectId));
  await mkdir(join(directory, 'versions'), { recursive: true }); await mkdir(join(directory, 'assets'));
  const current: string = join(directory, 'project.json'); const before: Buffer = Buffer.from(exportProjectJson(project));
  await writeFile(current, before); await writeFile(join(directory, 'versions', '000000.json'), before);
  for (const asset of project.assets) await writeFile(join(directory, asset.path), bytes);
  return { archive: await readReviewArchive(join(root, 'data'), project.projectId), current, before,
    options: { output: join(root, 'review'), maturity: 'draft', fontPath: resolve('assets/fonts/NanumGothic-Regular.ttf'),
      createdAt: '2026-09-07T00:00:00.000Z', build: readBuildManifest() } };
}

describe('읽기 전용 Review Bundle', (): void => {
  it('review_bundle_contains_required_files', async (): Promise<void> => {
    const { archive, options } = await fixture(); await writeReviewBundle(archive, options, []);
    expect((await readdir(options.output)).sort()).toEqual(['asset-integrity.json', 'asset-manifest.json', 'build-manifest.json', 'bundle-manifest.json', 'final-readiness.json', 'generation-audit.json', 'project.json', 'shots.csv', 'storyboard.pdf']);
  });
  it('review_bundle_manifest_contains_file_hashes', async (): Promise<void> => {
    const { archive, options } = await fixture(); const manifest = await writeReviewBundle(archive, options, []);
    for (const file of manifest.files) { const bytes: Buffer = await readFile(join(options.output, file.path)); expect(file.sha256).toBe(sha256Bytes(bytes)); expect(file.size).toBe(bytes.length); }
  });
  it('review_bundle_does_not_modify_project', async (): Promise<void> => {
    const { archive, options, current, before } = await fixture(); await writeReviewBundle(archive, options, []);
    expect(await readFile(current)).toEqual(before); await archive.assertUnchanged();
    expect(parseProject(JSON.parse(await readFile(join(options.output, 'project.json'), 'utf8')))).toEqual(archive.project);
    const entries: string[] = await readdir(archive.sourceRoot);
    await expect(writeReviewBundle(archive, { ...options, output: join(archive.sourceRoot, 'new', 'review') }, [])).rejects.toMatchObject({ code: 'REVIEW_OUTPUT_INSIDE_SOURCE' });
    expect(await readdir(archive.sourceRoot)).toEqual(entries);
  });
  it('final_review_bundle_requires_final_readiness', async (): Promise<void> => {
    const { archive, options } = await fixture(); await expect(writeReviewBundle(archive, { ...options, maturity: 'final' }, [])).rejects.toMatchObject({ code: 'FINAL_OUTPUT_NOT_READY' });
    await expect(readdir(options.output)).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('draft_review_bundle_reports_unconfirmed_text', async (): Promise<void> => {
    const { archive, options } = await fixture(); await writeReviewBundle(archive, options, []);
    expect(await readFile(join(options.output, 'final-readiness.json'), 'utf8')).toContain('DRAFT');
    expect(await readFile(join(options.output, 'shots.csv'), 'utf8')).toContain('TIMING UNCONFIRMED');
    expect(archive.readiness.counts.textProposed).toBeGreaterThan(0);
  });
  it('review_bundle_excludes_media_by_default', async (): Promise<void> => {
    const { archive, options } = await fixture(); const result = await writeReviewBundle(archive, options, []);
    expect(result.files.some((file): boolean => file.path.startsWith('media/'))).toBe(false);
  });
  it('review_bundle_includes_media_only_when_requested', async (): Promise<void> => {
    const { archive, options } = await fixture(); const result = await writeReviewBundle(archive, options, await reviewMediaFiles(archive));
    expect(result.files.filter((file): boolean => file.path.startsWith('media/'))).toHaveLength(archive.project.assets.length);
  });
});

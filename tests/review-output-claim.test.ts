import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { hostname, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { readBuildManifest } from '../src/build.js';
import { exportProjectJson } from '../src/exporters/json.js';
import { readReviewArchive, writeReviewBundle } from '../src/exporters/review-bundle.js';
import type { ReviewArchive, ReviewBundleOptions } from '../src/exporters/review-bundle.js';
import { sha256Bytes, sha256Text } from '../src/importers/integrity.js';
import { ReviewOutputClaimSchema } from '../src/exporters/review-output.js';
import { SafeStoreFilesystem } from '../src/server/safe-filesystem.js';
import type { FileIdentity } from '../src/server/safe-filesystem.js';
import { httpErrorPolicy } from '../src/server/app.js';
import { contractError } from '../src/domain/errors.js';
import { controlledProcess } from './controlled-process.js';
import type { ControlledProcess, WorkerMessage } from './controlled-process.js';
import { readinessOutline } from './readiness-fixtures.js';

const roots: string[] = []; const children: ControlledProcess[] = [];
type Fixture = { root: string; archive: ReviewArchive; options: ReviewBundleOptions; claim: string };
afterEach(async (): Promise<void> => { vi.restoreAllMocks(); for (const child of children.splice(0)) await child.stop(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture(): Promise<Fixture> {
  const root: string = await realpath(await mkdtemp(join(tmpdir(), 'review-claim-'))); roots.push(root);
  const project = await readinessOutline(); const directory: string = join(root, 'data', sha256Text(project.projectId));
  await mkdir(join(directory, 'versions'), { recursive: true }); await mkdir(join(directory, 'assets'));
  await writeFile(join(directory, 'project.json'), exportProjectJson(project)); await writeFile(join(directory, 'versions', '000000.json'), exportProjectJson(project));
  const output: string = join(root, 'bundle');
  return { root, archive: await readReviewArchive(join(root, 'data'), project.projectId), claim: join(root, `.review-${sha256Text(output)}.claim`),
    options: { output, maturity: 'draft', fontPath: resolve('assets/fonts/NanumGothic-Regular.ttf'), createdAt: '2026-09-08T00:00:00.000Z', build: readBuildManifest() } };
}
it('review_bundle_unknown_claim_is_not_deleted', async (): Promise<void> => {
  const value = await fixture(); await writeFile(value.claim, '{');
  await expect(writeReviewBundle(value.archive, value.options, [])).rejects.toMatchObject({ code: 'REVIEW_BUNDLE_CLAIM_RECOVERY_REQUIRED' });
  expect(await readFile(value.claim, 'utf8')).toBe('{');
});
it('review_bundle_output_claim_is_atomic', async (): Promise<void> => {
  const value = await fixture(); let checks: number = 0; let inspected: boolean = false;
  const original = SafeStoreFilesystem.prototype.writeExclusiveWithIdentity;
  vi.spyOn(SafeStoreFilesystem.prototype, 'writeExclusiveWithIdentity').mockImplementation(async function (this: SafeStoreFilesystem, path: string, content: string | Buffer): Promise<FileIdentity> {
    const identity: FileIdentity = await original.call(this, path, content);
    if (path.includes('.publish-.review-') && path.includes('.claim-')) {
      inspected = true; ReviewOutputClaimSchema.parse(JSON.parse(String(content))); expect(await this.exists(value.claim)).toBe(false);
    }
    return identity;
  });
  const archive: ReviewArchive = { ...value.archive, assertUnchanged: async (): Promise<void> => {
    await value.archive.assertUnchanged(); checks += 1;
    if (checks === 2) expect(JSON.parse(await readFile(value.claim, 'utf8'))).toMatchObject({ version: 1, outputHash: sha256Text(value.options.output), pid: process.pid });
  } };
  await writeReviewBundle(archive, value.options, []); expect(checks).toBe(2); expect(inspected).toBe(true);
});

async function hashes(path: string): Promise<Record<string, string>> {
  const entries: [string, string][] = [];
  for (const entry of await readdir(path, { withFileTypes: true })) {
    if (entry.isDirectory()) for (const [name, hash] of Object.entries(await hashes(join(path, entry.name)))) entries.push([`${entry.name}/${name}`, hash]);
    else entries.push([entry.name, sha256Bytes(await readFile(join(path, entry.name)))]);
  }
  return Object.fromEntries(entries.sort(([left], [right]): number => left.localeCompare(right)));
}
async function race(): Promise<{ value: Fixture; winner: WorkerMessage; loser: WorkerMessage; sourceBefore: Record<string, string> }> {
  const value = await fixture(); const sourceBefore: Record<string, string> = await hashes(join(value.root, 'data'));
  const first: ControlledProcess = controlledProcess('tests/review-output-worker.ts', JSON.stringify({ dataRoot: join(value.root, 'data'), projectId: value.archive.project.projectId, output: value.options.output, hold: true }));
  const second: ControlledProcess = controlledProcess('tests/review-output-worker.ts', JSON.stringify({ dataRoot: join(value.root, 'data'), projectId: value.archive.project.projectId, output: value.options.output, hold: false }));
  children.push(first, second); await first.event('ready'); await second.event('ready');
  first.send('start'); await first.event('paused'); second.send('start');
  const loser: WorkerMessage = await second.event('result'); await second.exited;
  const claim: Buffer = await readFile(value.claim); expect(ReviewOutputClaimSchema.parse(JSON.parse(claim.toString('utf8'))).pid).toBe(first.child.pid);
  first.send('release'); const winner: WorkerMessage = await first.event('result'); await first.exited;
  return { value, winner, loser, sourceBefore };
}
it('concurrent_review_bundle_same_output_commits_exactly_once', async (): Promise<void> => {
  const { value, winner, loser } = await race(); expect([winner.ok, loser.ok]).toEqual([true, false]); expect(await readdir(value.options.output)).toHaveLength(11);
});
it('concurrent_review_bundle_loser_returns_review_bundle_exists', async (): Promise<void> => {
  expect((await race()).loser).toMatchObject({ ok: false, code: 'REVIEW_BUNDLE_EXISTS' });
});
it('concurrent_review_bundle_loser_does_not_replace_winner', async (): Promise<void> => {
  const { value, winner } = await race(); expect(JSON.parse(await readFile(join(value.options.output, 'bundle-manifest.json'), 'utf8'))).toEqual(winner.result);
});
it('concurrent_review_bundle_loser_does_not_delete_winner', async (): Promise<void> => {
  const { value } = await race(); const before: Record<string, string> = await hashes(value.options.output);
  await expect(writeReviewBundle(value.archive, value.options, [])).rejects.toMatchObject({ code: 'REVIEW_BUNDLE_EXISTS' });
  expect(await hashes(value.options.output)).toEqual(before);
});
it('review_bundle_source_project_remains_unchanged_during_race', async (): Promise<void> => {
  const { value, sourceBefore } = await race(); expect(await hashes(join(value.root, 'data'))).toEqual(sourceBefore);
});
async function failedBundle(): Promise<Fixture> {
  const value = await fixture(); let checks: number = 0;
  const archive: ReviewArchive = { ...value.archive, assertUnchanged: async (): Promise<void> => { checks += 1; if (checks === 2) throw contractError('TEST_REVIEW_FAILURE', '검증 중단', []); await value.archive.assertUnchanged(); } };
  await expect(writeReviewBundle(archive, value.options, [])).rejects.toMatchObject({ code: 'TEST_REVIEW_FAILURE' }); return value;
}
it('review_bundle_output_claim_is_cleaned_after_failure', async (): Promise<void> => {
  const value = await failedBundle(); await expect(readFile(value.claim)).rejects.toMatchObject({ code: 'ENOENT' });
  expect((await readdir(value.root)).filter((name: string): boolean => name.startsWith('.publish-'))).toEqual([]);
});
it('review_bundle_staging_is_cleaned_after_failure', async (): Promise<void> => {
  const value = await failedBundle(); expect(await readdir(value.root)).toEqual(['data']);
});
it('review_bundle_cross_host_claim_requires_operator_action', async (): Promise<void> => {
  const value = await fixture(); const claim: string = JSON.stringify({ version: 1, outputHash: sha256Text(value.options.output), host: `${hostname()}-foreign`, pid: process.pid, transactionId: randomUUID(), createdAt: value.options.createdAt });
  await writeFile(value.claim, claim);
  await expect(writeReviewBundle(value.archive, value.options, [])).rejects.toMatchObject({ code: 'REVIEW_BUNDLE_CLAIM_RECOVERY_REQUIRED' });
  expect(await readFile(value.claim, 'utf8')).toBe(claim);
  expect(httpErrorPolicy(contractError('REVIEW_BUNDLE_CLAIM_RECOVERY_REQUIRED', '복구 필요', []))).toMatchObject({ status: 423, operatorActionRequired: true, mutationBlocked: false });
});
it('review_bundle_final_publish_syncs_parent_directory', async (): Promise<void> => {
  const value = await fixture(); const observations: { claim: boolean; output: boolean }[] = []; const original = SafeStoreFilesystem.prototype.syncDirectory;
  vi.spyOn(SafeStoreFilesystem.prototype, 'syncDirectory').mockImplementation(async function (this: SafeStoreFilesystem, path: string): Promise<void> {
    await original.call(this, path); if (path === value.root) observations.push({ claim: await this.exists(value.claim), output: await this.exists(value.options.output) });
  });
  await writeReviewBundle(value.archive, value.options, []);
  const published: number = observations.findIndex((entry): boolean => entry.claim && entry.output);
  expect(published).toBeGreaterThan(-1); expect(observations.slice(published + 1)).toContainEqual({ claim: false, output: true });
});
it('review_bundle_existing_output_is_never_overwritten', async (): Promise<void> => {
  const value = await fixture(); await mkdir(value.options.output); await writeFile(join(value.options.output, 'owner.txt'), '기존 출력');
  const before: Record<string, string> = await hashes(value.options.output);
  await expect(writeReviewBundle(value.archive, value.options, [])).rejects.toMatchObject({ code: 'REVIEW_BUNDLE_EXISTS' }); expect(await hashes(value.options.output)).toEqual(before);
});
it('review_bundle_crashed_claim_preserves_staging_and_requires_operator', async (): Promise<void> => {
  const value = await fixture(); const child: ControlledProcess = controlledProcess('tests/review-output-worker.ts', JSON.stringify({ dataRoot: join(value.root, 'data'), projectId: value.archive.project.projectId, output: value.options.output, hold: true }));
  children.push(child); await child.event('ready'); child.send('start'); await child.event('paused'); await child.stop();
  const before: Record<string, string> = await hashes(value.root);
  await expect(writeReviewBundle(value.archive, value.options, [])).rejects.toMatchObject({ code: 'REVIEW_BUNDLE_CLAIM_RECOVERY_REQUIRED' });
  expect(await hashes(value.root)).toEqual(before);
});

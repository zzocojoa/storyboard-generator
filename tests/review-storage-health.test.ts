import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { hostname, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readBuildManifest } from '../src/build.js';
import type { Project } from '../src/domain/schema.js';
import { exportProjectJson } from '../src/exporters/json.js';
import { readReviewArchive, writeReviewBundle } from '../src/exporters/review-bundle.js';
import type { ReviewBundleOptions } from '../src/exporters/review-bundle.js';
import { sha256Bytes, sha256Text } from '../src/importers/integrity.js';
import { finalFixture } from './readiness-fixtures.js';

type Fixture = { root: string; directory: string; project: Project; options: ReviewBundleOptions };
const roots: string[] = [];
afterEach(async (): Promise<void> => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture(): Promise<Fixture> {
  const root: string = await mkdtemp(join(tmpdir(), 'review-health-')); roots.push(root);
  const { project, media } = await finalFixture();
  const directory: string = join(root, 'data', sha256Text(project.projectId));
  await mkdir(join(directory, 'versions'), { recursive: true }); await mkdir(join(directory, 'assets'));
  await writeFile(join(directory, 'project.json'), exportProjectJson(project));
  await writeFile(join(directory, 'versions/000000.json'), exportProjectJson(project));
  for (const asset of project.assets) await writeFile(join(directory, asset.path), media.get(asset.id)!);
  return { root, directory, project, options: { output: join(root, 'output'), maturity: 'final', fontPath: resolve('assets/fonts/NanumGothic-Regular.ttf'), createdAt: '2026-09-07T00:00:00.000Z', build: readBuildManifest() } };
}
async function addLock(value: Fixture, path: string): Promise<void> {
  await writeFile(path, JSON.stringify({ version: 2, projectId: value.project.projectId, host: hostname(), pid: process.pid, transactionId: randomUUID(), createdAt: value.options.createdAt }));
}
async function addTransaction(value: Fixture): Promise<string> {
  const id: string = randomUUID(); await mkdir(join(value.directory, '.transactions', id), { recursive: true });
  await writeFile(join(value.directory, '.transactions', id, 'journal.json'), '{unfinished'); return id;
}
async function finalRejected(value: Fixture): Promise<void> {
  const archive = await readReviewArchive(join(value.root, 'data'), value.project.projectId);
  await expect(writeReviewBundle(archive, value.options, [])).rejects.toMatchObject({ code: 'REVIEW_SOURCE_NOT_QUIESCENT', issues: expect.arrayContaining([expect.objectContaining({ severity: 'conflict' })]) });
  await expect(readdir(value.options.output)).rejects.toMatchObject({ code: 'ENOENT' });
}
async function hashes(root: string): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (entry.isDirectory()) for (const [path, hash] of Object.entries(await hashes(join(root, entry.name)))) result[`${entry.name}/${path}`] = hash;
    else result[entry.name] = sha256Bytes(await readFile(join(root, entry.name)));
  }
  return result;
}

describe('Review 저장 근거 읽기 전용 검사', (): void => {
  it('final_bundle_rejects_pending_transaction', async (): Promise<void> => { const value = await fixture(); await addTransaction(value); await finalRejected(value); });
  it('final_bundle_rejects_active_project_lock', async (): Promise<void> => { const value = await fixture(); await addLock(value, join(value.directory, 'write.lock')); await finalRejected(value); });
  it('final_bundle_rejects_active_create_lock', async (): Promise<void> => {
    const value = await fixture(); const path: string = join(value.root, 'data/.create-locks'); await mkdir(path);
    await addLock(value, join(path, `${sha256Text(value.project.projectId)}.lock`)); await finalRejected(value);
  });
  it('final_bundle_rejects_future_uncommitted_version', async (): Promise<void> => {
    const value = await fixture(); await writeFile(join(value.directory, 'versions/000001.json'), exportProjectJson({ ...value.project, revision: 1 })); await finalRejected(value);
  });
  it('final_bundle_rejects_recovery_blocked_store', async (): Promise<void> => {
    const value = await fixture(); const directoryName: string = sha256Text(value.project.projectId); await mkdir(join(value.root, 'data/.recovery-blocks'));
    await writeFile(join(value.root, `data/.recovery-blocks/${directoryName}.json`), JSON.stringify({ version: 1, projectId: value.project.projectId, directoryName,
      transactionId: 'review', code: 'STORE_RECOVERY_REQUIRED', message: '검토 필요', detectedAt: value.options.createdAt })); await finalRejected(value);
  });
  it('draft_bundle_reports_nonquiescent_storage', async (): Promise<void> => {
    const value = await fixture(); const id: string = await addTransaction(value);
    const archive = await readReviewArchive(join(value.root, 'data'), value.project.projectId);
    const manifest = await writeReviewBundle(archive, { ...value.options, maturity: 'draft' }, []);
    expect(manifest.label).toBe('DRAFT · SOURCE NOT QUIESCENT');
    expect(JSON.parse(await readFile(join(value.options.output, 'storage-health.json'), 'utf8'))).toMatchObject({ quiescent: false, pendingTransactionIds: [id] });
    expect(await readFile(join(value.options.output, 'shots.csv'), 'utf8')).toContain('DRAFT · SOURCE NOT QUIESCENT');
  });
  it('review_bundle_does_not_modify_recovery_evidence', async (): Promise<void> => {
    const value = await fixture(); await addTransaction(value); await addLock(value, join(value.directory, 'write.lock'));
    const before = await hashes(join(value.root, 'data')); const archive = await readReviewArchive(join(value.root, 'data'), value.project.projectId);
    await writeReviewBundle(archive, { ...value.options, maturity: 'draft' }, []); expect(await hashes(join(value.root, 'data'))).toEqual(before);
  });
  it('review_bundle_detects_transaction_created_during_export', async (): Promise<void> => {
    const value = await fixture(); const archive = await readReviewArchive(join(value.root, 'data'), value.project.projectId);
    let inserted: boolean = false;
    const during = { ...archive, loadAsset: async (id: string): Promise<Buffer> => { if (!inserted) { inserted = true; await addTransaction(value); } return archive.loadAsset(id); } };
    await expect(writeReviewBundle(during, value.options, [])).rejects.toMatchObject({ code: 'REVIEW_SOURCE_NOT_QUIESCENT' });
    await expect(readdir(value.options.output)).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('failed_final_bundle_creates_no_output_directory', async (): Promise<void> => {
    const value = await fixture(); await addLock(value, join(value.directory, 'write.lock'));
    const output: string = join(value.root, 'not-created/output'); await finalRejected({ ...value, options: { ...value.options, output } });
    await expect(readdir(join(value.root, 'not-created'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('review_storage_reports_current_version_mismatch_without_fabricating_audit', async (): Promise<void> => {
    const value = await fixture(); await writeFile(join(value.directory, 'project.json'), exportProjectJson({ ...value.project, title: 'Current 불일치' }));
    const archive = await readReviewArchive(join(value.root, 'data'), value.project.projectId);
    expect(archive.storageHealth.issues).toContainEqual(expect.objectContaining({ code: 'AUDIT_CURRENT_VERSION_MISMATCH' }));
    await expect(writeReviewBundle(archive, value.options, [])).rejects.toMatchObject({ code: 'REVIEW_SOURCE_NOT_QUIESCENT' });
    await writeReviewBundle(archive, { ...value.options, maturity: 'draft' }, []);
    expect(JSON.parse(await readFile(join(value.options.output, 'generation-audit.json'), 'utf8'))).toMatchObject({ auditAvailable: false, records: [] });
  });
  it('review_storage_reports_invalid_marker_and_create_journal', async (): Promise<void> => {
    const value = await fixture(); const id: string = randomUUID();
    await mkdir(join(value.root, `data/.create-transactions/${id}`), { recursive: true });
    await mkdir(join(value.root, 'data/.recovery-blocks/.invalid'), { recursive: true });
    await writeFile(join(value.root, 'data/.recovery-blocks/.invalid/broken.json'), '{broken');
    const archive = await readReviewArchive(join(value.root, 'data'), value.project.projectId);
    expect(archive.storageHealth.pendingCreateTransactionIds).toEqual([id]);
    expect(archive.storageHealth.invalidEvidenceEntries).toContain('.recovery-blocks/.invalid/broken.json');
    await finalRejected(value);
  });
  it('review_storage_rechecks_changes_to_existing_evidence', async (): Promise<void> => {
    const value = await fixture(); const path: string = join(value.directory, 'write.lock'); await addLock(value, path);
    const archive = await readReviewArchive(join(value.root, 'data'), value.project.projectId); await writeFile(path, '{changed');
    await expect(writeReviewBundle(archive, { ...value.options, maturity: 'draft' }, [])).rejects.toMatchObject({ code: 'REVIEW_SOURCE_NOT_QUIESCENT', issues: expect.arrayContaining([expect.objectContaining({ code: 'REVIEW_STORAGE_EVIDENCE_CHANGED' })]) });
  });
  it('review_storage_does_not_block_other_project_valid_lock', async (): Promise<void> => {
    const value = await fixture(); const directory: string = join(value.root, 'data/.create-locks'); await mkdir(directory);
    await addLock({ ...value, project: { ...value.project, projectId: 'other' } }, join(directory, `${sha256Text('other')}.lock`));
    const archive = await readReviewArchive(join(value.root, 'data'), value.project.projectId);
    expect(archive.storageHealth.quiescent).toBe(true); await writeReviewBundle(archive, value.options, []);
  });

});

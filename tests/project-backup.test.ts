import { mkdtemp, mkdir, readFile, readdir, rm, symlink, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import { createProjectBackup, previewProjectBackup, restoreProjectBackup } from '../src/backup/service.js';
import { readBackupSnapshot, readProjectBackup } from '../src/backup/snapshot.js';
import { BACKUP_JSON_MAX_BYTES, BACKUP_MAX_FILES, BackupManifestSchema } from '../src/backup/schema.js';
import { sha256Bytes, sha256Text } from '../src/importers/integrity.js';
import { registerProjectBackupRoutes } from '../src/server/project-backup-routes.js';
import { errorBody, httpErrorPolicy } from '../src/server/app.js';
import { readReviewArchive } from '../src/exporters/review-bundle.js';
import { reviewFinalReadiness } from '../src/domain/final-readiness.js';
import { ProjectStore } from '../src/server/store.js';
import type { Project } from '../src/domain/schema.js';
import { finalFixture, readinessOutline } from './readiness-fixtures.js';
import { importPackage } from '../src/importers/import-package.js';
import { createSourceOutline } from '../src/proposal/outline.js';
import { productionPackage } from './helpers.js';

const roots: string[] = [];
afterEach(async (): Promise<void> => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture(): Promise<{ root: string; dataRoot: string; project: Project; directory: string }> {
  const root = await mkdtemp(join(tmpdir(), 'cutroom-backup-')); roots.push(root);
  const { project: original, media } = await finalFixture();
  const base: Project = { ...original, generationRecords: [{ id: 'backup-record', provider: 'fixture', model: 'synthetic-image', modelVersion: null,
    requestId: null, prompt: '합성 검증 자료의 생성 기록', templateVersion: 'test-1', seed: null, referenceHashes: [],
    resultAssetIds: original.assets.map((asset): string => asset.id), shotIds: original.shots.map((shot): string => shot.id), createdAt: '2026-09-12T00:00:00.000Z', generatorBuild: null }] };
  const project: Project = { ...base, revision: 1, title: '범용 백업 검증', textCues: base.textCues.map((cue) => ({ ...cue, timingStatus: 'proposed' as const })) };
  const dataRoot = join(root, 'source'); const directory = join(dataRoot, sha256Text(project.projectId));
  await mkdir(join(directory, 'versions'), { recursive: true }); await mkdir(join(directory, 'assets'));
  // 예전 스키마의 공백·개행·버전 바이트까지 그대로 보관되는지 확인한다.
  const prior = { ...base, schemaVersion: '1.16.0' };
  await writeFile(join(directory, 'versions/000000.json'), JSON.stringify(prior, null, 3).replaceAll('\n', '\r\n'));
  const bytes = JSON.stringify(project, null, 4);
  await writeFile(join(directory, 'project.json'), bytes); await writeFile(join(directory, 'versions/000001.json'), bytes);
  for (const asset of base.assets) await writeFile(join(directory, asset.path), media.get(asset.id)!);
  return { root, dataRoot, project, directory };
}

describe('저장된 콘티의 선택 백업과 독립 저장소 복원', (): void => {
  it('project_backup_roundtrip_preserves_raw_versions_media_approvals_and_remains_editable', async (): Promise<void> => {
    const { root, dataRoot, project } = await fixture(); const selection = { parentPath: root, folderName: '콘티 백업' };
    const before = await readBackupSnapshot(dataRoot, project.projectId); const sourceEntries = await readdir(dataRoot);
    const preview = await previewProjectBackup(dataRoot, project.projectId, 1, selection);
    const result = await createProjectBackup(dataRoot, project.projectId, 1, selection, preview.basisSha256);
    const backup = await readProjectBackup(result.outputPath);
    expect(backup.entries).toEqual(before.entries); expect(backup.project).toEqual(project);
    expect(backup.manifestSha256).toBe(result.manifestSha256); expect(preview.assets).toBe(project.assets.length); expect(preview.versions).toBe(2);
    const restored = await restoreProjectBackup(result.outputPath, { parentPath: root, folderName: '복원' }, result.manifestSha256);
    const copied = await readBackupSnapshot(restored.outputPath, project.projectId);
    expect(copied.entries).toEqual(before.entries);
    for (const file of before.files) expect(await readFile(join(restored.outputPath, sha256Text(project.projectId), file.path))).toEqual(file.content);
    const store = new ProjectStore(restored.outputPath);
    try {
      await store.initialize(); expect(store.recoveryBlocks()).toEqual([]);
      expect(await store.read(project.projectId)).toEqual(project); expect((await store.list()).map((entry): string => entry.projectId)).toEqual([project.projectId]);
      const archive = await readReviewArchive(restored.outputPath, project.projectId);
      expect(archive.readiness.finalReady).toBe(false); expect(archive.readiness).toEqual(reviewFinalReadiness(project, archive.integrity));
      const next = await store.update(project.projectId, 1, (current): Project => ({ ...current, title: '복원 후 편집' }), []);
      expect(next.revision).toBe(2); expect(next.assets).toEqual(project.assets); expect(next.generationRecords).toEqual(project.generationRecords);
    } finally { await store.close(); }
    await before.assertUnchanged(); expect(await readdir(dataRoot)).toEqual(sourceEntries);
    expect((await readProjectBackup(result.outputPath)).manifest.revision).toBe(1);
  });

  it('project_backup_rejects_changed_source_missing_history_existing_and_nested_destinations', async (): Promise<void> => {
    const { root, dataRoot, project, directory } = await fixture(); const selection = { parentPath: root, folderName: 'backup' };
    await expect(previewProjectBackup(dataRoot, project.projectId, 1, { parentPath: join(root, 'missing-parent'), folderName: 'backup' })).rejects.toMatchObject({ code: 'BACKUP_PATH_INVALID' });
    await expect(readProjectBackup(join(root, 'missing-backup'))).rejects.toMatchObject({ code: 'BACKUP_PATH_INVALID' });
    const preview = await previewProjectBackup(dataRoot, project.projectId, 1, selection);
    const previous = await readFile(join(directory, 'project.json'));
    const changed = Buffer.from(JSON.stringify({ ...project, title: '바뀐 제목' }));
    await writeFile(join(directory, 'project.json'), changed); await writeFile(join(directory, 'versions/000001.json'), changed);
    await expect(createProjectBackup(dataRoot, project.projectId, 1, selection, preview.basisSha256)).rejects.toMatchObject({ code: 'BACKUP_SOURCE_CHANGED' });
    await expect(readdir(join(root, 'backup'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(previewProjectBackup(dataRoot, project.projectId, 0, selection)).rejects.toMatchObject({ code: 'REVISION_CONFLICT' });
    await writeFile(join(directory, 'project.json'), previous); await writeFile(join(directory, 'versions/000001.json'), previous);
    await expect(previewProjectBackup(dataRoot, project.projectId, 1, { parentPath: dataRoot, folderName: 'backup' })).rejects.toMatchObject({ code: 'BACKUP_PATH_INVALID' });
    await mkdir(join(root, 'exists')); await writeFile(join(root, 'exists/keep.txt'), '유지');
    await expect(previewProjectBackup(dataRoot, project.projectId, 1, { parentPath: root, folderName: 'exists' })).rejects.toMatchObject({ code: 'BACKUP_OUTPUT_EXISTS' });
    expect(await readFile(join(root, 'exists/keep.txt'), 'utf8')).toBe('유지');
    await rm(join(directory, 'versions/000000.json'));
    await expect(previewProjectBackup(dataRoot, project.projectId, 1, selection)).rejects.toMatchObject({ code: 'BACKUP_STORAGE_NOT_QUIESCENT' });
  });

  it('project_backup_verification_rejects_tampering_extra_files_symlinks_and_changed_manifest', async (): Promise<void> => {
    const { root, dataRoot, project } = await fixture(); const selection = { parentPath: root, folderName: 'backup' };
    const preview = await previewProjectBackup(dataRoot, project.projectId, 1, selection);
    const result = await createProjectBackup(dataRoot, project.projectId, 1, selection, preview.basisSha256);
    const asset = project.assets[0]!; const mediaPath = join(result.outputPath, asset.path); const bytes = await readFile(mediaPath);
    await writeFile(mediaPath, Buffer.from('바뀐 파일'));
    await expect(readProjectBackup(result.outputPath)).rejects.toMatchObject({ code: 'BACKUP_CONTENT_INVALID' });
    await writeFile(mediaPath, bytes); await writeFile(join(result.outputPath, 'extra.txt'), '미선언 파일');
    await expect(readProjectBackup(result.outputPath)).rejects.toMatchObject({ code: 'BACKUP_CONTENT_INVALID' }); await rm(join(result.outputPath, 'extra.txt'));
    await rm(mediaPath); await symlink(join(root, 'source', sha256Text(project.projectId), asset.path), mediaPath);
    await expect(readProjectBackup(result.outputPath)).rejects.toMatchObject({ code: 'BACKUP_CONTENT_INVALID' }); await rm(mediaPath); await writeFile(mediaPath, bytes);
    await expect(restoreProjectBackup(result.outputPath, { parentPath: root, folderName: 'restore' }, '0'.repeat(64))).rejects.toMatchObject({ code: 'BACKUP_SOURCE_CHANGED' });
    await expect(readdir(join(root, 'restore'))).rejects.toMatchObject({ code: 'ENOENT' });
    const manifest = BackupManifestSchema.parse(JSON.parse(await readFile(join(result.outputPath, 'backup.json'), 'utf8')) as unknown);
    await writeFile(join(result.outputPath, 'backup.json'), JSON.stringify({ ...manifest, files: [...manifest.files, { path: '../outside', size: 1, sha256: '0'.repeat(64) }] }));
    await expect(readProjectBackup(result.outputPath)).rejects.toMatchObject({ code: 'BACKUP_CONTENT_INVALID' });
  });

  it('project_backup_preserves_damaged_asset_bytes_without_claiming_media_or_final_approval', async (): Promise<void> => {
    const { root, dataRoot, project, directory } = await fixture(); const asset = project.assets[0]!;
    const damaged = Buffer.from('기존 손상 파일'); await writeFile(join(directory, asset.path), damaged);
    const selection = { parentPath: root, folderName: 'backup' }; const preview = await previewProjectBackup(dataRoot, project.projectId, 1, selection);
    const result = await createProjectBackup(dataRoot, project.projectId, 1, selection, preview.basisSha256);
    expect(result.manifest.files.find((entry): boolean => entry.path === asset.path)?.sha256).toBe(sha256Bytes(damaged));
    const restore = await restoreProjectBackup(result.outputPath, { parentPath: root, folderName: 'restore' }, result.manifestSha256);
    const archive = await readReviewArchive(restore.outputPath, project.projectId);
    expect(archive.project.assets).toEqual(project.assets); expect(archive.integrity[asset.id]).toBe('STORED_ASSET_HASH_MISMATCH'); expect(archive.readiness.finalReady).toBe(false);
  });

  it('project_backup_parallel_publish_has_one_result_and_never_overwrites_a_restore', async (): Promise<void> => {
    const { root, dataRoot, project } = await fixture(); const selection = { parentPath: root, folderName: 'backup' };
    const preview = await previewProjectBackup(dataRoot, project.projectId, 1, selection);
    const attempts = await Promise.allSettled([0, 1].map(async () => createProjectBackup(dataRoot, project.projectId, 1, selection, preview.basisSha256)));
    expect(attempts.filter((entry): boolean => entry.status === 'fulfilled')).toHaveLength(1);
    const backup = await readProjectBackup(preview.outputPath);
    const destination = { parentPath: root, folderName: 'restore' };
    const result = await restoreProjectBackup(preview.outputPath, destination, backup.manifestSha256);
    const before = await readBackupSnapshot(result.outputPath, project.projectId);
    await expect(restoreProjectBackup(preview.outputPath, destination, backup.manifestSha256)).rejects.toMatchObject({ code: 'BACKUP_OUTPUT_EXISTS' });
    await before.assertUnchanged(); expect((await readdir(root)).some((name): boolean => name.startsWith('.review-'))).toBe(false);
  });

  it('project_backup_handles_different_story_shapes_and_rejects_excessive_revision_before_scanning', async (): Promise<void> => {
    const root = await mkdtemp(join(tmpdir(), 'cutroom-backup-stories-')); roots.push(root);
    for (const source of [await readinessOutline(), createSourceOutline(importPackage(await productionPackage()), { proposedTextHoldMs: 2000 })]) {
      const dataRoot = join(root, sha256Text(source.projectId)); const store = new ProjectStore(dataRoot);
      try { await store.create(source); } finally { await store.close(); }
      const selection = { parentPath: root, folderName: `backup-${sha256Text(source.projectId).slice(0, 8)}` };
      const preview = await previewProjectBackup(dataRoot, source.projectId, 0, selection);
      const result = await createProjectBackup(dataRoot, source.projectId, 0, selection, preview.basisSha256);
      const backup = await readProjectBackup(result.outputPath); expect(backup.project).toEqual(source); expect(backup.assets).toBe(0);
      const restored = await restoreProjectBackup(result.outputPath, { parentPath: root, folderName: `restore-${sha256Text(source.projectId).slice(0, 8)}` }, result.manifestSha256);
      const opened = new ProjectStore(restored.outputPath);
      try { expect(await opened.read(source.projectId)).toEqual(source); expect(opened.recoveryBlocks()).toEqual([]); } finally { await opened.close(); }
      const current = join(dataRoot, sha256Text(source.projectId), 'project.json');
      await writeFile(current, JSON.stringify({ ...source, revision: BACKUP_MAX_FILES }));
      await expect(readBackupSnapshot(dataRoot, source.projectId)).rejects.toMatchObject({ code: 'BACKUP_CONTENT_INVALID' });
    }
  });

  it('project_backup_http_requires_local_origin_current_basis_and_selected_project_without_mutating_sources', async (): Promise<void> => {
    const { root, dataRoot, project } = await fixture(); const app = Fastify();
    app.setErrorHandler((error, request, reply): void => { const cause = error as Error; reply.code(httpErrorPolicy(cause).status).send(errorBody(cause, request)); });
    registerProjectBackupRoutes(app, dataRoot); const before = await readBackupSnapshot(dataRoot, project.projectId);
    const url = `/api/projects/${encodeURIComponent(project.projectId)}/backups`; const input = { expectedRevision: 1, selection: { parentPath: root, folderName: 'http' } };
    try {
      expect((await app.inject({ method: 'POST', url: `${url}/preview`, payload: input, headers: { origin: 'https://foreign.invalid' } })).statusCode).toBe(400);
      const preview = await app.inject({ method: 'POST', url: `${url}/preview`, payload: input }); expect(preview.statusCode).toBe(200);
      expect((await app.inject({ method: 'POST', url, payload: { ...input, basisSha256: '0'.repeat(64) } })).statusCode).toBe(409);
      const saved = await app.inject({ method: 'POST', url, payload: { ...input, basisSha256: preview.json().basisSha256 as string } }); expect(saved.statusCode).toBe(201);
      const path = saved.json().outputPath as string;
      expect((await app.inject({ method: 'POST', url: `${url}/verify`, payload: { path } })).statusCode).toBe(200);
      expect((await app.inject({ method: 'POST', url: '/api/projects/other-project/backups/verify', payload: { path } })).statusCode).toBe(400);
      await before.assertUnchanged();
    } finally { await app.close(); }
  });

  it('project_backup_bounds_storage_evidence_before_reading_oversized_version_files', async (): Promise<void> => {
    const { root, dataRoot, project, directory } = await fixture();
    await truncate(join(directory, 'versions/000000.json'), BACKUP_JSON_MAX_BYTES + 1);
    await expect(previewProjectBackup(dataRoot, project.projectId, 1, { parentPath: root, folderName: 'backup' })).rejects.toMatchObject({ code: 'BACKUP_STORAGE_NOT_QUIESCENT' });
    await expect(readdir(join(root, 'backup'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('project_backup_scopes_proven_unknown_recovery_markers_and_retains_ambiguous_evidence', async (): Promise<void> => {
    const { root, dataRoot, project } = await fixture(); const key: string = sha256Text('different-story');
    const marker = { version: 1, projectId: `unknown:${key}`, directoryName: key, transactionId: 'recovery', code: 'INVALID_PROJECT', message: '별도 프로젝트 손상', detectedAt: '2026-09-12T00:00:00.000Z' };
    const markerPath = join(dataRoot, `.recovery-blocks/${key}.json`); await mkdir(join(dataRoot, '.recovery-blocks'));
    const original = JSON.stringify(marker); await writeFile(markerPath, original);
    const selection = { parentPath: root, folderName: 'backup' };
    expect((await previewProjectBackup(dataRoot, project.projectId, 1, selection)).manifest.projectId).toBe(project.projectId);
    expect((await readReviewArchive(dataRoot, project.projectId)).storageHealth.quiescent).toBe(true);
    expect(await readFile(markerPath, 'utf8')).toBe(original);
    await writeFile(markerPath, JSON.stringify({ ...marker, projectId: 'unknown:unattributed' }));
    await expect(previewProjectBackup(dataRoot, project.projectId, 1, selection)).rejects.toMatchObject({ code: 'BACKUP_STORAGE_NOT_QUIESCENT' });
    await rm(markerPath); const own = sha256Text(project.projectId);
    await writeFile(join(dataRoot, `.recovery-blocks/${own}.json`), JSON.stringify({ ...marker, projectId: `unknown:${own}`, directoryName: own }));
    await expect(previewProjectBackup(dataRoot, project.projectId, 1, selection)).rejects.toMatchObject({ code: 'BACKUP_STORAGE_NOT_QUIESCENT' });
  });
});

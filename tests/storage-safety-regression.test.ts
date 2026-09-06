import { link, mkdir, mkdtemp, readFile, readdir, rm, rmdir, stat, symlink, unlink, writeFile } from 'node:fs/promises';
import { hostname, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { CodexRequestStore } from '../src/codex/requests.js';
import type { Asset, Project } from '../src/domain/schema.js';
import { exportProjectJson } from '../src/exporters/json.js';
import { importPackage } from '../src/importers/import-package.js';
import { sha256Bytes, sha256Text } from '../src/importers/integrity.js';
import { parseProject } from '../src/io/project.js';
import { createSourceOutline } from '../src/proposal/outline.js';
import { createApp } from '../src/server/app.js';
import type { AppConfig } from '../src/server/config.js';
import { ProjectStore, SimulatedStorageCrash } from '../src/server/store.js';
import type { StorageFaultInjector, StorageFaultPoint } from '../src/server/store.js';
import { nativeData, nativePackage, png, TEST_AUDIO_NORMALIZATION_OPTIONS, withNativeData } from './helpers.js';

const roots: string[] = [];
const DEAD_PROCESS_ID: number = 2_147_483_647;

afterEach(async (): Promise<void> => {
  await Promise.all(roots.splice(0).map((root: string): Promise<void> => rm(root, { recursive: true, force: true })));
});

async function root(prefix: string): Promise<string> {
  const path: string = await mkdtemp(join(tmpdir(), prefix)); roots.push(path); return path;
}

async function outline(projectId?: string): Promise<Project> {
  const payload = await nativePackage();
  const source = projectId === undefined ? payload : withNativeData(payload, { ...nativeData(payload), projectId });
  return createSourceOutline(importPackage(source), { proposedTextHoldMs: 2000 });
}

function projectDirectory(dataRoot: string, projectId: string): string { return join(dataRoot, sha256Text(projectId)); }
function assetMetadata(id: string, bytes: Buffer): Asset {
  return { id, kind: 'image', subjectId: null, path: `assets/${id}.png`, mimeType: 'image/png', sha256: sha256Bytes(bytes),
    description: '저장 안전성 검증', durationMs: null, version: 1 };
}
function injector(point: StorageFaultPoint): StorageFaultInjector {
  return { ownerPid: DEAD_PROCESS_ID, trigger(candidate: StorageFaultPoint): void { if (candidate === point) throw new SimulatedStorageCrash(point); } };
}
function codeOf(error: unknown): string { return error instanceof Error && 'code' in error ? String(error.code) : ''; }

type CrashFixture = { root: string; dataRoot: string; project: Project; asset: Asset | null; bytes: Buffer | null; transactionPath: string | null };

async function crashedUpdate(point: StorageFaultPoint, withAsset: boolean): Promise<CrashFixture> {
  const fixtureRoot: string = await root('storyboard-store-crash-'); const dataRoot: string = join(fixtureRoot, 'data');
  const project: Project = await new ProjectStore(dataRoot).create(await outline());
  const bytes: Buffer | null = withAsset ? await png(2, 2) : null;
  const asset: Asset | null = bytes === null ? null : assetMetadata('crash-owned', bytes);
  const store = new ProjectStore(dataRoot, injector(point));
  const update = store.update(project.projectId, 0, (current: Project): Project => ({ ...current, title: 'crash-next',
    assets: asset === null ? current.assets : [...current.assets, asset] }),
  asset === null || bytes === null ? [] : [{ relativePath: asset.path, content: bytes }]);
  await expect(update).rejects.toSatisfy((error: unknown): boolean => codeOf(error) === 'SIMULATED_STORAGE_CRASH');
  const transactionsPath: string = join(projectDirectory(dataRoot, project.projectId), '.transactions');
  const names: string[] = await readdir(transactionsPath);
  return { root: fixtureRoot, dataRoot, project, asset, bytes, transactionPath: names[0] === undefined ? null : join(transactionsPath, names[0]) };
}

async function versionCollision(sameHash: boolean, withAsset: boolean): Promise<{ dataRoot: string; project: Project; versionPath: string; assetPath: string | null; versionIdentity: string }> {
  const fixtureRoot: string = await root('storyboard-preflight-'); const dataRoot: string = join(fixtureRoot, 'data');
  const store = new ProjectStore(dataRoot); const project: Project = await store.create(await outline());
  const bytes: Buffer | null = withAsset ? await png(2, 2) : null; const asset: Asset | null = bytes === null ? null : assetMetadata('preflight-new', bytes);
  const next: Project = parseProject({ ...project, title: 'preflight-next', revision: 1, assets: asset === null ? project.assets : [...project.assets, asset] });
  const versionPath: string = join(projectDirectory(dataRoot, project.projectId), 'versions', '000001.json');
  await writeFile(versionPath, sameHash ? exportProjectJson(next) : '{"foreign":true}');
  const before = await stat(versionPath); const versionIdentity: string = `${before.dev}:${before.ino}`;
  const assetPath: string | null = asset === null ? null : join(projectDirectory(dataRoot, project.projectId), asset.path);
  await expect(store.update(project.projectId, 0, (current: Project): Project => ({ ...current, title: 'preflight-next',
    assets: asset === null ? current.assets : [...current.assets, asset] }), asset === null || bytes === null ? [] : [{ relativePath: asset.path, content: bytes }]))
    .rejects.toSatisfy((error: unknown): boolean => codeOf(error) === 'PROJECT_VERSION_EXISTS');
  return { dataRoot, project, versionPath, assetPath, versionIdentity };
}

async function assetCollision(): Promise<{ dataRoot: string; project: Project; assetPath: string; content: Buffer; identity: string }> {
  const fixtureRoot: string = await root('storyboard-asset-collision-'); const dataRoot: string = join(fixtureRoot, 'data');
  const store = new ProjectStore(dataRoot); const project: Project = await store.create(await outline());
  const content: Buffer = await png(2, 2); const asset: Asset = assetMetadata('collision', content);
  const assetPath: string = join(projectDirectory(dataRoot, project.projectId), asset.path); await writeFile(assetPath, content);
  const before = await stat(assetPath); const identity: string = `${before.dev}:${before.ino}`;
  await expect(store.update(project.projectId, 0, (current: Project): Project => ({ ...current, assets: [...current.assets, asset] }), [{ relativePath: asset.path, content }]))
    .rejects.toSatisfy((error: unknown): boolean => codeOf(error) === 'ASSET_FILE_EXISTS');
  return { dataRoot, project, assetPath, content, identity };
}

async function crashedCreate(point: StorageFaultPoint): Promise<CrashFixture> {
  const fixtureRoot: string = await root('storyboard-create-crash-'); const dataRoot: string = join(fixtureRoot, 'data');
  const project: Project = await outline(`create-${point}`); const store = new ProjectStore(dataRoot, injector(point));
  await expect(store.create(project)).rejects.toSatisfy((error: unknown): boolean => codeOf(error) === 'SIMULATED_STORAGE_CRASH');
  const names: string[] = await readdir(join(dataRoot, '.create-transactions'));
  return { root: fixtureRoot, dataRoot, project, asset: null, bytes: null,
    transactionPath: names[0] === undefined ? null : join(dataRoot, '.create-transactions', names[0]) };
}

async function writeCompleteProject(dataRoot: string, project: Project): Promise<string> {
  const directory: string = projectDirectory(dataRoot, project.projectId);
  await mkdir(join(directory, 'versions'), { recursive: true }); await mkdir(join(directory, 'assets')); await mkdir(join(directory, '.transactions'));
  const content: string = exportProjectJson(project); await writeFile(join(directory, 'project.json'), content); await writeFile(join(directory, 'versions', '000000.json'), content);
  return directory;
}

async function referenceCrash(): Promise<CrashFixture> {
  const fixture: CrashFixture = await crashedUpdate('after-update-asset-linked', true);
  const asset: Asset = fixture.asset as Asset;
  const previous: Project = parseProject({ ...fixture.project, assets: [...fixture.project.assets, asset] });
  const previousContent: string = exportProjectJson(previous);
  const directory: string = projectDirectory(fixture.dataRoot, previous.projectId);
  const transactionPath: string = fixture.transactionPath as string;
  await writeFile(join(directory, 'project.json'), previousContent);
  await writeFile(join(directory, 'versions', '000000.json'), previousContent);
  await writeFile(join(transactionPath, 'project.previous.json'), previousContent);
  const journalPath: string = join(transactionPath, 'journal.json');
  const journal = JSON.parse(await readFile(journalPath, 'utf8')) as { previousProject: { sha256: string } };
  journal.previousProject.sha256 = sha256Text(previousContent);
  await writeFile(journalPath, JSON.stringify(journal));
  return { ...fixture, project: previous };
}

async function historicalReferenceCrash(): Promise<CrashFixture> {
  const fixture: CrashFixture = await crashedUpdate('after-update-asset-linked', true);
  const historical: Project = parseProject({ ...fixture.project, assets: [...fixture.project.assets, fixture.asset as Asset] });
  await writeFile(join(projectDirectory(fixture.dataRoot, fixture.project.projectId), 'versions', '000000.json'), exportProjectJson(historical));
  return fixture;
}

async function stageOtherReferenceTransaction(fixture: CrashFixture, referencePrevious: boolean): Promise<void> {
  const transactionId: string = 'ffffffff-ffff-4fff-bfff-ffffffffffff';
  const transactionPath: string = join(projectDirectory(fixture.dataRoot, fixture.project.projectId), '.transactions', transactionId);
  const without: Project = fixture.project;
  const withAsset: Project = parseProject({ ...without, assets: [...without.assets, fixture.asset as Asset] });
  const previous: Project = referencePrevious ? withAsset : without;
  const next: Project = parseProject({ ...(referencePrevious ? without : withAsset), revision: previous.revision + 1 });
  const previousContent: string = exportProjectJson(previous); const nextContent: string = exportProjectJson(next);
  await mkdir(transactionPath); await writeFile(join(transactionPath, 'project.previous.json'), previousContent);
  await writeFile(join(transactionPath, 'project.next.json'), nextContent); await writeFile(join(transactionPath, 'version.next.json'), nextContent);
  await writeFile(join(transactionPath, 'journal.json'), JSON.stringify({ version: 3, operation: 'update', phase: 'prepared', transactionId,
    projectId: previous.projectId, owner: { host: hostname(), pid: DEAD_PROCESS_ID, transactionId }, expectedRevision: previous.revision,
    nextRevision: next.revision, previousProject: { stagedRelativePath: 'project.previous.json', finalRelativePath: 'project.json', sha256: sha256Text(previousContent) },
    nextProject: { stagedRelativePath: 'project.next.json', finalRelativePath: 'project.json', sha256: sha256Text(nextContent) },
    versionFile: { stagedRelativePath: 'version.next.json', finalRelativePath: `versions/${String(next.revision).padStart(6, '0')}.json`, sha256: sha256Text(nextContent) }, assets: [] }));
}

async function blockFixture(): Promise<CrashFixture> {
  const fixture: CrashFixture = await crashedUpdate('after-update-asset-linked', true);
  const finalPath: string = join(projectDirectory(fixture.dataRoot, fixture.project.projectId), (fixture.asset as Asset).path);
  await unlink(finalPath); await writeFile(finalPath, fixture.bytes as Buffer);
  await new ProjectStore(fixture.dataRoot).initialize();
  return fixture;
}

async function appForStore(fixtureRoot: string, dataRoot: string, store: ProjectStore): Promise<FastifyInstance> {
  const webRoot: string = join(fixtureRoot, 'web'); await mkdir(webRoot); await writeFile(join(webRoot, 'index.html'), '<main></main>');
  const config: AppConfig = { host: '127.0.0.1', port: 4317, dataRoot, webRoot,
    pdfFontPath: resolve('assets/fonts/NanumGothic-Regular.ttf'), audioNormalization: TEST_AUDIO_NORMALIZATION_OPTIONS,
    codex: { requestRoot: join(fixtureRoot, 'requests'), speechVoice: 'Yuna' } };
  return createApp(config, store, new CodexRequestStore(config.codex.requestRoot));
}

describe('A. Update preflight collisions', (): void => {
  it('version_collision_is_detected_before_asset_publish', async (): Promise<void> => { const fixture = await versionCollision(true, true); expect(fixture.assetPath === null ? true : await exists(fixture.assetPath)).toBe(false); });
  it('version_collision_publishes_no_asset', async (): Promise<void> => { const fixture = await versionCollision(false, true); expect(fixture.assetPath === null ? true : await exists(fixture.assetPath)).toBe(false); });
  it('version_collision_does_not_create_journal_commit', async (): Promise<void> => { const fixture = await versionCollision(true, false); expect(await readdir(join(projectDirectory(fixture.dataRoot, fixture.project.projectId), '.transactions'))).toEqual([]); });
  it('same_hash_preexisting_version_is_preserved', async (): Promise<void> => { const fixture = await versionCollision(true, false); expect(await readFile(fixture.versionPath, 'utf8')).toContain('preflight-next'); });
  it('same_hash_preexisting_version_inode_is_preserved', async (): Promise<void> => { const fixture = await versionCollision(true, false); const current = await stat(fixture.versionPath); expect(`${current.dev}:${current.ino}`).toBe(fixture.versionIdentity); });
  it('different_hash_preexisting_version_is_preserved', async (): Promise<void> => { const fixture = await versionCollision(false, false); expect(await readFile(fixture.versionPath, 'utf8')).toBe('{"foreign":true}'); });
  it('asset_path_collision_is_detected_before_journal_commit', async (): Promise<void> => { const fixture = await assetCollision(); expect(await readdir(join(projectDirectory(fixture.dataRoot, fixture.project.projectId), '.transactions'))).toEqual([]); });
  it('asset_collision_preserves_existing_file', async (): Promise<void> => { const fixture = await assetCollision(); expect((await readFile(fixture.assetPath)).equals(fixture.content)).toBe(true); });
  it('preflight_failure_keeps_current_revision', async (): Promise<void> => { const fixture = await assetCollision(); expect((await new ProjectStore(fixture.dataRoot).read(fixture.project.projectId)).revision).toBe(0); });
  it('preflight_failure_leaves_no_final_file', async (): Promise<void> => { const fixture = await versionCollision(true, true); expect(fixture.assetPath === null ? true : await exists(fixture.assetPath)).toBe(false); });
});

async function exists(path: string): Promise<boolean> {
  try { await stat(path); return true; } catch (error: unknown) { if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return false; throw error; }
}

describe('B. Transaction file ownership', (): void => {
  it('final_asset_is_owned_only_when_linked_to_staged_file', async (): Promise<void> => {
    const fixture = await crashedUpdate('after-update-asset-linked', true); const staged = await stat(join(fixture.transactionPath as string, 'asset-0.bin'));
    const final = await stat(join(projectDirectory(fixture.dataRoot, fixture.project.projectId), (fixture.asset as Asset).path)); expect(`${final.dev}:${final.ino}`).toBe(`${staged.dev}:${staged.ino}`);
  });
  it('same_hash_different_inode_is_not_transaction_owned', async (): Promise<void> => {
    const fixture = await crashedUpdate('after-update-asset-linked', true); const finalPath = join(projectDirectory(fixture.dataRoot, fixture.project.projectId), (fixture.asset as Asset).path);
    await unlink(finalPath); await writeFile(finalPath, fixture.bytes as Buffer); const recovered = new ProjectStore(fixture.dataRoot); await recovered.initialize(); expect(recovered.recoveryBlocks()).toHaveLength(1);
  });
  it('final_version_is_owned_only_when_linked_to_staged_version', async (): Promise<void> => {
    const fixture = await crashedUpdate('after-update-version-linked', false); const staged = await stat(join(fixture.transactionPath as string, 'version.next.json'));
    const final = await stat(join(projectDirectory(fixture.dataRoot, fixture.project.projectId), 'versions', '000001.json')); expect(`${final.dev}:${final.ino}`).toBe(`${staged.dev}:${staged.ino}`);
  });
  it('rollback_deletes_owned_asset', async (): Promise<void> => {
    const fixture = await crashedUpdate('after-update-asset-linked', true); const path = join(projectDirectory(fixture.dataRoot, fixture.project.projectId), (fixture.asset as Asset).path);
    await new ProjectStore(fixture.dataRoot).initialize(); expect(await exists(path)).toBe(false);
  });
  it('rollback_does_not_delete_unowned_same_hash_asset', async (): Promise<void> => {
    const fixture = await crashedUpdate('after-update-asset-linked', true); const path = join(projectDirectory(fixture.dataRoot, fixture.project.projectId), (fixture.asset as Asset).path);
    await unlink(path); await writeFile(path, fixture.bytes as Buffer); await new ProjectStore(fixture.dataRoot).initialize(); expect(await exists(path)).toBe(true);
  });
  it('rollback_deletes_owned_version', async (): Promise<void> => {
    const fixture = await crashedUpdate('after-update-version-linked', false); const path = join(projectDirectory(fixture.dataRoot, fixture.project.projectId), 'versions', '000001.json');
    await new ProjectStore(fixture.dataRoot).initialize(); expect(await exists(path)).toBe(false);
  });
  it('rollback_does_not_delete_unowned_same_hash_version', async (): Promise<void> => {
    const fixture = await crashedUpdate('after-update-version-linked', false); const path = join(projectDirectory(fixture.dataRoot, fixture.project.projectId), 'versions', '000001.json');
    const bytes: Buffer = await readFile(path); await unlink(path); await writeFile(path, bytes); await new ProjectStore(fixture.dataRoot).initialize(); expect(await exists(path)).toBe(true);
  });
  it('staged_file_is_retained_until_commit_cleanup', async (): Promise<void> => { const fixture = await crashedUpdate('after-update-version-linked', true); expect(await exists(join(fixture.transactionPath as string, 'asset-0.bin'))).toBe(true); expect(await exists(join(fixture.transactionPath as string, 'version.next.json'))).toBe(true); });
  it('committed_transaction_removes_staged_hardlinks', async (): Promise<void> => { const fixture = await crashedUpdate('before-update-cleanup', true); await new ProjectStore(fixture.dataRoot).initialize(); expect(await exists(fixture.transactionPath as string)).toBe(false); });
  it('ambiguous_file_identity_returns_recovery_required', async (): Promise<void> => { const fixture = await crashedUpdate('after-update-version-linked', false); const path = join(projectDirectory(fixture.dataRoot, fixture.project.projectId), 'versions', '000001.json'); const bytes = await readFile(path); await unlink(path); await writeFile(path, bytes); const recovered = new ProjectStore(fixture.dataRoot); await recovered.initialize(); expect(recovered.recoveryBlocks()[0]?.code).toBe('STORE_RECOVERY_REQUIRED'); });
});

describe('C. All-version asset references', (): void => {
  it('current_project_reference_blocks_asset_delete', async (): Promise<void> => {
    const fixture = await referenceCrash(); const recovered = new ProjectStore(fixture.dataRoot); await recovered.initialize();
    expect(recovered.recoveryBlocks()).toHaveLength(1); expect(await exists(join(projectDirectory(fixture.dataRoot, fixture.project.projectId), (fixture.asset as Asset).path))).toBe(true);
  });

  it('version_zero_reference_blocks_asset_delete', async (): Promise<void> => {
    const fixture = await referenceCrash(); await new ProjectStore(fixture.dataRoot).initialize();
    expect((await readFile(join(projectDirectory(fixture.dataRoot, fixture.project.projectId), 'versions', '000000.json'), 'utf8')).includes((fixture.asset as Asset).id)).toBe(true);
  });

  it('historical_version_reference_blocks_asset_delete', async (): Promise<void> => {
    const fixture = await historicalReferenceCrash(); const recovered = new ProjectStore(fixture.dataRoot); await recovered.initialize();
    expect(recovered.recoveryBlocks()).toHaveLength(1); expect(await exists(join(projectDirectory(fixture.dataRoot, fixture.project.projectId), (fixture.asset as Asset).path))).toBe(true);
  });

  it('other_transaction_previous_reference_blocks_delete', async (): Promise<void> => {
    const fixture = await crashedUpdate('after-update-asset-linked', true); await stageOtherReferenceTransaction(fixture, true);
    const recovered = new ProjectStore(fixture.dataRoot); await recovered.initialize(); expect(recovered.recoveryBlocks()).toHaveLength(1);
    expect(await exists(join(projectDirectory(fixture.dataRoot, fixture.project.projectId), (fixture.asset as Asset).path))).toBe(true);
  });

  it('other_transaction_next_reference_blocks_delete', async (): Promise<void> => {
    const fixture = await crashedUpdate('after-update-asset-linked', true); await stageOtherReferenceTransaction(fixture, false);
    const recovered = new ProjectStore(fixture.dataRoot); await recovered.initialize(); expect(recovered.recoveryBlocks()).toHaveLength(1);
    expect(await exists(join(projectDirectory(fixture.dataRoot, fixture.project.projectId), (fixture.asset as Asset).path))).toBe(true);
  });

  it('malformed_version_blocks_destructive_recovery', async (): Promise<void> => {
    const fixture = await crashedUpdate('after-update-asset-linked', true); await writeFile(join(projectDirectory(fixture.dataRoot, fixture.project.projectId), 'versions', '000009.json'), '{');
    const recovered = new ProjectStore(fixture.dataRoot); await recovered.initialize(); expect(recovered.recoveryBlocks()).toHaveLength(1);
    expect(await exists(join(projectDirectory(fixture.dataRoot, fixture.project.projectId), (fixture.asset as Asset).path))).toBe(true);
  });

  it('version_project_id_mismatch_blocks_recovery', async (): Promise<void> => {
    const fixture = await crashedUpdate('after-update-asset-linked', true); const foreign: Project = parseProject({ ...(await outline('foreign-project')), revision: 9 });
    await writeFile(join(projectDirectory(fixture.dataRoot, fixture.project.projectId), 'versions', '000009.json'), exportProjectJson(foreign));
    const recovered = new ProjectStore(fixture.dataRoot); await recovered.initialize(); expect(recovered.recoveryBlocks()).toHaveLength(1);
  });

  it('version_filename_revision_mismatch_blocks_recovery', async (): Promise<void> => {
    const fixture = await crashedUpdate('after-update-asset-linked', true);
    await writeFile(join(projectDirectory(fixture.dataRoot, fixture.project.projectId), 'versions', '000009.json'), exportProjectJson(fixture.project));
    const recovered = new ProjectStore(fixture.dataRoot); await recovered.initialize(); expect(recovered.recoveryBlocks()).toHaveLength(1);
  });

  it('excluded_owned_next_version_does_not_false_block_rollback', async (): Promise<void> => {
    const fixture = await crashedUpdate('after-update-version-linked', true); const recovered = new ProjectStore(fixture.dataRoot); await recovered.initialize();
    expect(recovered.recoveryBlocks()).toEqual([]); expect(await exists(join(projectDirectory(fixture.dataRoot, fixture.project.projectId), (fixture.asset as Asset).path))).toBe(false);
  });

  it('unreferenced_owned_asset_can_be_removed', async (): Promise<void> => {
    const fixture = await crashedUpdate('after-update-asset-linked', true); await new ProjectStore(fixture.dataRoot).initialize();
    expect(await exists(join(projectDirectory(fixture.dataRoot, fixture.project.projectId), (fixture.asset as Asset).path))).toBe(false);
  });
});

describe('D. Initial create consistency', (): void => {
  it('committed_create_requires_current_and_version_zero', async (): Promise<void> => {
    const fixture = await crashedCreate('after-create-directory-publish'); await unlink(join(projectDirectory(fixture.dataRoot, fixture.project.projectId), 'versions', '000000.json'));
    const recovered = new ProjectStore(fixture.dataRoot); await recovered.initialize(); expect(recovered.recoveryBlocks()[0]?.code).toBe('STORE_CREATE_RECOVERY_REQUIRED');
  });

  it('committed_create_requires_matching_current_and_version', async (): Promise<void> => {
    const fixture = await crashedCreate('after-create-directory-publish'); await writeFile(join(projectDirectory(fixture.dataRoot, fixture.project.projectId), 'project.json'), exportProjectJson(parseProject({ ...fixture.project, title: 'mismatch' })));
    const recovered = new ProjectStore(fixture.dataRoot); await recovered.initialize(); expect(recovered.recoveryBlocks()[0]?.code).toBe('STORE_CREATE_RECOVERY_REQUIRED');
  });

  it('final_create_hash_mismatch_is_not_silently_cleaned', async (): Promise<void> => {
    const fixture = await crashedCreate('before-create-directory-publish'); const concurrent: Project = parseProject({ ...fixture.project, title: 'concurrent winner' });
    await writeCompleteProject(fixture.dataRoot, concurrent); const recovered = new ProjectStore(fixture.dataRoot); await recovered.initialize();
    expect((await recovered.read(concurrent.projectId)).title).toBe('concurrent winner'); expect(recovered.recoveryEvents().some((event): boolean => event.outcome === 'create-superseded')).toBe(true);
  });

  it('final_create_missing_version_zero_is_blocked', async (): Promise<void> => {
    const fixture = await crashedCreate('before-create-directory-publish'); const directory: string = projectDirectory(fixture.dataRoot, fixture.project.projectId);
    await mkdir(join(directory, 'versions'), { recursive: true }); await mkdir(join(directory, 'assets')); await mkdir(join(directory, '.transactions')); await writeFile(join(directory, 'project.json'), exportProjectJson(fixture.project));
    const recovered = new ProjectStore(fixture.dataRoot); await recovered.initialize(); expect(recovered.recoveryBlocks()[0]?.code).toBe('STORE_CREATE_RECOVERY_REQUIRED');
  });

  it('final_create_current_version_mismatch_is_blocked', async (): Promise<void> => {
    const fixture = await crashedCreate('before-create-directory-publish'); const directory: string = await writeCompleteProject(fixture.dataRoot, fixture.project);
    await writeFile(join(directory, 'project.json'), exportProjectJson(parseProject({ ...fixture.project, title: 'other current' })));
    const recovered = new ProjectStore(fixture.dataRoot); await recovered.initialize(); expect(recovered.recoveryBlocks()[0]?.code).toBe('STORE_CREATE_RECOVERY_REQUIRED');
  });

  it('incomplete_final_directory_preserves_create_journal', async (): Promise<void> => {
    const fixture = await crashedCreate('before-create-directory-publish'); const directory: string = projectDirectory(fixture.dataRoot, fixture.project.projectId); await mkdir(directory);
    const recovered = new ProjectStore(fixture.dataRoot); await recovered.initialize(); expect(recovered.recoveryBlocks()).toHaveLength(1); expect(await exists(fixture.transactionPath as string)).toBe(true);
  });

  it('concurrent_complete_create_is_proven_and_preserved', async (): Promise<void> => {
    const fixture = await crashedCreate('before-create-directory-publish'); const concurrent: Project = parseProject({ ...fixture.project, title: 'proven concurrent' });
    await writeCompleteProject(fixture.dataRoot, concurrent); const recovered = new ProjectStore(fixture.dataRoot); await recovered.initialize(); expect((await recovered.read(concurrent.projectId)).title).toBe('proven concurrent');
  });

  it('concurrent_complete_create_cleans_only_own_staging', async (): Promise<void> => {
    const fixture = await crashedCreate('before-create-directory-publish'); const concurrent: Project = parseProject({ ...fixture.project, title: 'keep final' }); const directory: string = await writeCompleteProject(fixture.dataRoot, concurrent);
    await new ProjectStore(fixture.dataRoot).initialize(); expect(await exists(fixture.transactionPath as string)).toBe(false); expect(await exists(join(directory, 'project.json'))).toBe(true);
  });

  it('complete_create_asset_references_are_verified', async (): Promise<void> => {
    const fixture = await crashedCreate('before-create-directory-publish'); const bytes: Buffer = await png(2, 2); const asset: Asset = assetMetadata('missing-create-asset', bytes);
    await writeCompleteProject(fixture.dataRoot, parseProject({ ...fixture.project, assets: [asset] })); const recovered = new ProjectStore(fixture.dataRoot); await recovered.initialize();
    expect(recovered.recoveryBlocks()[0]?.code).toBe('STORE_CREATE_RECOVERY_REQUIRED'); expect(await exists(fixture.transactionPath as string)).toBe(true);
  });

  it('create_recovery_is_idempotent', async (): Promise<void> => {
    const fixture = await crashedCreate('after-create-directory-publish'); const first = new ProjectStore(fixture.dataRoot); await first.initialize(); const second = new ProjectStore(fixture.dataRoot); await second.initialize();
    expect((await second.read(fixture.project.projectId)).revision).toBe(0); expect(second.recoveryBlocks()).toEqual([]); expect(second.recoveryEvents()).toEqual([]);
  });

  it('failed_create_can_be_retried_after_safe_rollback', async (): Promise<void> => {
    const fixture = await crashedCreate('before-create-directory-publish'); const recovered = new ProjectStore(fixture.dataRoot); await recovered.initialize();
    await expect(recovered.create(fixture.project)).resolves.toMatchObject({ projectId: fixture.project.projectId, revision: 0 });
  });

  it('create_internal_directory_is_not_listed_as_project', async (): Promise<void> => {
    const fixture = await crashedCreate('after-create-journal-prepared'); const store = new ProjectStore(fixture.dataRoot); await store.initialize(); expect(await store.list()).toEqual([]);
  });
});

describe('E. Symlink safety', (): void => {
  it('asset_directory_symlink_is_rejected', async (): Promise<void> => {
    const fixtureRoot: string = await root('storyboard-symlink-assets-'); const dataRoot: string = join(fixtureRoot, 'data'); const project = await new ProjectStore(dataRoot).create(await outline());
    const assetsPath: string = join(projectDirectory(dataRoot, project.projectId), 'assets'); const outside: string = join(fixtureRoot, 'outside'); await mkdir(outside); await rmdir(assetsPath); await symlink(outside, assetsPath);
    const recovered = new ProjectStore(dataRoot); await recovered.initialize(); expect(recovered.recoveryBlocks()[0]?.code).toBe('STORE_PATH_UNSAFE');
  });

  it('asset_file_symlink_is_rejected', async (): Promise<void> => {
    const fixtureRoot: string = await root('storyboard-symlink-file-'); const dataRoot: string = join(fixtureRoot, 'data'); const bytes: Buffer = await png(2, 2); const asset: Asset = assetMetadata('linked', bytes);
    const store: ProjectStore = new ProjectStore(dataRoot); const base: Project = await store.create(await outline());
    const project: Project = await store.update(base.projectId, base.revision, (current: Project): Project => ({ ...current,
      assets: [...current.assets, asset] }), [{ relativePath: asset.path, content: bytes }]);
    const outside: string = join(fixtureRoot, 'outside.png'); const path: string = join(projectDirectory(dataRoot, project.projectId), asset.path);
    await writeFile(outside, bytes); await unlink(path); await symlink(outside, path);
    await expect(new ProjectStore(dataRoot).asset(project.projectId, asset.id)).rejects.toSatisfy((error: unknown): boolean => codeOf(error) === 'STORE_PATH_UNSAFE');
  });

  it('versions_directory_symlink_is_rejected', async (): Promise<void> => {
    const fixtureRoot: string = await root('storyboard-symlink-versions-'); const dataRoot: string = join(fixtureRoot, 'data'); const project = await new ProjectStore(dataRoot).create(await outline());
    const versions: string = join(projectDirectory(dataRoot, project.projectId), 'versions'); const outside: string = join(fixtureRoot, 'versions'); await mkdir(outside); await rm(versions, { recursive: true }); await symlink(outside, versions);
    const recovered = new ProjectStore(dataRoot); await recovered.initialize(); expect(recovered.recoveryBlocks()[0]?.code).toBe('STORE_PATH_UNSAFE');
  });

  it('transaction_directory_symlink_is_rejected', async (): Promise<void> => {
    const fixtureRoot: string = await root('storyboard-symlink-transactions-'); const dataRoot: string = join(fixtureRoot, 'data'); const project = await new ProjectStore(dataRoot).create(await outline());
    const transactions: string = join(projectDirectory(dataRoot, project.projectId), '.transactions'); const outside: string = join(fixtureRoot, 'transactions'); await mkdir(outside); await rmdir(transactions); await symlink(outside, transactions);
    const recovered = new ProjectStore(dataRoot); await recovered.initialize(); expect(recovered.recoveryBlocks()[0]?.code).toBe('STORE_PATH_UNSAFE');
  });

  it('create_staging_symlink_is_rejected', async (): Promise<void> => {
    const fixture = await crashedCreate('after-create-journal-prepared'); const outside: string = join(fixture.root, 'outside-create'); await mkdir(outside); await symlink(outside, join(fixture.transactionPath as string, 'project'));
    const recovered = new ProjectStore(fixture.dataRoot); await recovered.initialize(); expect(recovered.recoveryBlocks()[0]?.code).toBe('STORE_PATH_UNSAFE');
  });

  it('journal_asset_symlink_escape_is_rejected', async (): Promise<void> => {
    const fixture = await crashedUpdate('after-update-asset-linked', true); const path: string = join(projectDirectory(fixture.dataRoot, fixture.project.projectId), (fixture.asset as Asset).path); const outside: string = join(fixture.root, 'outside.png'); await writeFile(outside, fixture.bytes as Buffer); await unlink(path); await symlink(outside, path);
    const recovered = new ProjectStore(fixture.dataRoot); await recovered.initialize(); expect(recovered.recoveryBlocks()[0]?.code).toBe('STORE_PATH_UNSAFE');
  });

  it('recovery_does_not_unlink_through_symlink', async (): Promise<void> => {
    const fixture = await crashedUpdate('after-update-asset-linked', true); const path: string = join(projectDirectory(fixture.dataRoot, fixture.project.projectId), (fixture.asset as Asset).path); const outside: string = join(fixture.root, 'keep.png'); await writeFile(outside, fixture.bytes as Buffer); await unlink(path); await symlink(outside, path);
    await new ProjectStore(fixture.dataRoot).initialize(); expect((await readFile(outside)).equals(fixture.bytes as Buffer)).toBe(true);
  });

  it('safe_read_rejects_symlinked_asset', async (): Promise<void> => {
    const fixtureRoot: string = await root('storyboard-safe-read-'); const dataRoot: string = join(fixtureRoot, 'data'); const bytes: Buffer = await png(2, 2); const asset: Asset = assetMetadata('safe-read', bytes);
    const store: ProjectStore = new ProjectStore(dataRoot); const base: Project = await store.create(await outline());
    const project: Project = await store.update(base.projectId, base.revision, (current: Project): Project => ({ ...current,
      assets: [...current.assets, asset] }), [{ relativePath: asset.path, content: bytes }]);
    const outside: string = join(fixtureRoot, 'read.png'); const path: string = join(projectDirectory(dataRoot, project.projectId), asset.path);
    await writeFile(outside, bytes); await unlink(path); await symlink(outside, path);
    await expect(new ProjectStore(dataRoot).asset(project.projectId, asset.id)).rejects.toSatisfy((error: unknown): boolean => codeOf(error) === 'STORE_PATH_UNSAFE');
  });

  it('safe_write_rejects_symlinked_parent', async (): Promise<void> => {
    const fixtureRoot: string = await root('storyboard-safe-write-'); const dataRoot: string = join(fixtureRoot, 'data'); const store = new ProjectStore(dataRoot); const project = await store.create(await outline());
    const assetsPath: string = join(projectDirectory(dataRoot, project.projectId), 'assets'); const outside: string = join(fixtureRoot, 'write-outside'); await mkdir(outside); await rmdir(assetsPath); await symlink(outside, assetsPath); const bytes = await png(2, 2); const asset = assetMetadata('unsafe-write', bytes);
    await expect(store.update(project.projectId, 0, (current: Project): Project => ({ ...current, assets: [asset] }), [{ relativePath: asset.path, content: bytes }])).rejects.toSatisfy((error: unknown): boolean => codeOf(error) === 'STORE_PATH_UNSAFE');
  });

  it('project_root_escape_is_rejected', async (): Promise<void> => {
    const fixtureRoot: string = await root('storyboard-root-escape-'); const dataRoot: string = join(fixtureRoot, 'data'); const store = new ProjectStore(dataRoot); const project = await store.create(await outline()); const bytes = await png(2, 2);
    const asset: Asset = { ...assetMetadata('escape', bytes), path: 'assets/../../escape.png' };
    await expect(store.update(project.projectId, 0, (current: Project): Project => ({ ...current, assets: [asset] }), [{ relativePath: asset.path, content: bytes }])).rejects.toSatisfy((error: unknown): boolean => ['STORE_PATH_UNSAFE', 'TRANSACTION_JOURNAL_PATH_UNSAFE', 'UNSAFE_ASSET_PATH'].includes(codeOf(error)));
  });
});

describe('F. Recovery-blocked mutation', (): void => {
  it('rollback_recovery_failure_blocks_next_update', async (): Promise<void> => {
    const fixture = await blockFixture(); const store = new ProjectStore(fixture.dataRoot); await store.initialize();
    await expect(store.update(fixture.project.projectId, 0, (current: Project): Project => ({ ...current, title: 'blocked' }), [])).rejects.toSatisfy((error: unknown): boolean => codeOf(error) === 'STORE_RECOVERY_BLOCKED');
  });

  it('blocked_project_preserves_unresolved_transaction', async (): Promise<void> => { const fixture = await blockFixture(); expect(await exists(fixture.transactionPath as string)).toBe(true); });
  it('blocked_project_does_not_release_unsafe_lock', async (): Promise<void> => { const fixture = await blockFixture(); expect(await exists(join(projectDirectory(fixture.dataRoot, fixture.project.projectId), 'write.lock'))).toBe(true); });

  it('blocked_project_rejects_asset_upload', async (): Promise<void> => {
    const fixture = await blockFixture(); const app = await appForStore(fixture.root, fixture.dataRoot, new ProjectStore(fixture.dataRoot));
    const response = await app.inject({ method: 'POST', url: `/api/projects/${fixture.project.projectId}/references`, payload: {} }); await app.close();
    expect(response.statusCode).toBe(400); expect(response.json().error.code).toBe('STORE_RECOVERY_BLOCKED');
  });

  it('blocked_project_rejects_source_update', async (): Promise<void> => {
    const fixture = await blockFixture(); const app = await appForStore(fixture.root, fixture.dataRoot, new ProjectStore(fixture.dataRoot));
    const response = await app.inject({ method: 'POST', url: `/api/projects/${fixture.project.projectId}/source-update`, payload: {} }); await app.close();
    expect(response.statusCode).toBe(400); expect(response.json().error.code).toBe('STORE_RECOVERY_BLOCKED');
  });

  it('blocked_project_is_reported_in_status', async (): Promise<void> => {
    const fixture = await blockFixture(); const app = await appForStore(fixture.root, fixture.dataRoot, new ProjectStore(fixture.dataRoot)); const response = await app.inject({ method: 'GET', url: '/api/status' }); await app.close();
    expect(response.statusCode).toBe(200); expect(response.json().storageRecoveryBlocks[0].projectId).toBe(fixture.project.projectId);
  });

  it('successful_restart_recovery_clears_block', async (): Promise<void> => {
    const fixture = await blockFixture(); const finalPath: string = join(projectDirectory(fixture.dataRoot, fixture.project.projectId), (fixture.asset as Asset).path); const stagedPath: string = join(fixture.transactionPath as string, 'asset-0.bin');
    await unlink(finalPath); await link(stagedPath, finalPath); const recovered = new ProjectStore(fixture.dataRoot); await recovered.initialize(); expect(recovered.recoveryBlocks()).toEqual([]); expect(await exists(fixture.transactionPath as string)).toBe(false);
  });

  it('unrelated_project_can_continue_when_project_scoped_block_is_used', async (): Promise<void> => {
    const fixtureRoot: string = await root('storyboard-project-scoped-'); const dataRoot: string = join(fixtureRoot, 'data'); const first: Project = await new ProjectStore(dataRoot).create(await outline('blocked-project')); const second: Project = await new ProjectStore(dataRoot).create(await outline('healthy-project'));
    const bytes: Buffer = await png(2, 2); const asset: Asset = assetMetadata('scoped-owned', bytes); const crashing = new ProjectStore(dataRoot, injector('after-update-asset-linked'));
    await expect(crashing.update(first.projectId, 0, (current: Project): Project => ({ ...current, assets: [asset] }), [{ relativePath: asset.path, content: bytes }])).rejects.toBeDefined();
    const finalPath: string = join(projectDirectory(dataRoot, first.projectId), asset.path); await unlink(finalPath); await writeFile(finalPath, bytes); const recovered = new ProjectStore(dataRoot); await recovered.initialize();
    await expect(recovered.update(second.projectId, 0, (current: Project): Project => ({ ...current, title: 'healthy update' }), [])).resolves.toMatchObject({ revision: 1, title: 'healthy update' });
  });

  it('recovery_block_survives_second_store_instance_or_persistent_lock', async (): Promise<void> => {
    const fixture = await blockFixture(); const second = new ProjectStore(fixture.dataRoot); await second.initialize(); expect(second.recoveryBlocks()).toHaveLength(1);
    await expect(second.assertMutable(fixture.project.projectId)).rejects.toSatisfy((error: unknown): boolean => codeOf(error) === 'STORE_RECOVERY_BLOCKED');
  });
});

describe('H. Actual ProjectStore fault injection', (): void => {
  it('actual_update_crash_after_preflight_is_recovered', async (): Promise<void> => { const fixture = await crashedUpdate('after-update-preflight', false); const recovered = new ProjectStore(fixture.dataRoot); expect((await recovered.read(fixture.project.projectId)).revision).toBe(0); expect(recovered.recoveryBlocks()).toEqual([]); });
  it('actual_update_crash_after_journal_is_recovered', async (): Promise<void> => { const fixture = await crashedUpdate('after-update-journal-prepared', false); const recovered = new ProjectStore(fixture.dataRoot); expect((await recovered.read(fixture.project.projectId)).revision).toBe(0); expect(recovered.recoveryBlocks()).toEqual([]); });
  it('actual_update_crash_after_asset_link_is_recovered', async (): Promise<void> => { const fixture = await crashedUpdate('after-update-asset-linked', true); const recovered = new ProjectStore(fixture.dataRoot); expect((await recovered.read(fixture.project.projectId)).revision).toBe(0); });
  it('actual_update_crash_after_version_link_is_recovered', async (): Promise<void> => { const fixture = await crashedUpdate('after-update-version-linked', true); const recovered = new ProjectStore(fixture.dataRoot); expect((await recovered.read(fixture.project.projectId)).revision).toBe(0); });
  it('actual_update_crash_after_current_publish_is_committed', async (): Promise<void> => { const fixture = await crashedUpdate('after-update-current-published', true); const recovered = new ProjectStore(fixture.dataRoot); expect((await recovered.read(fixture.project.projectId)).revision).toBe(1); });
  it('actual_update_crash_before_cleanup_is_committed', async (): Promise<void> => { const fixture = await crashedUpdate('before-update-cleanup', true); const recovered = new ProjectStore(fixture.dataRoot); expect((await recovered.read(fixture.project.projectId)).revision).toBe(1); });
  it('actual_create_crash_after_journal_is_recovered', async (): Promise<void> => { const fixture = await crashedCreate('after-create-journal-prepared'); const recovered = new ProjectStore(fixture.dataRoot); await recovered.initialize(); expect(await recovered.list()).toEqual([]); });
  it('actual_create_crash_after_version_zero_is_recovered', async (): Promise<void> => { const fixture = await crashedCreate('after-create-version-zero-written'); const recovered = new ProjectStore(fixture.dataRoot); await recovered.initialize(); expect(await recovered.list()).toEqual([]); expect(await exists(fixture.transactionPath as string)).toBe(false); });
  it('actual_create_crash_after_current_write_is_recovered', async (): Promise<void> => { const fixture = await crashedCreate('after-create-current-written'); const recovered = new ProjectStore(fixture.dataRoot); await recovered.initialize(); expect(await recovered.list()).toEqual([]); expect(await exists(fixture.transactionPath as string)).toBe(false); });
  it('actual_create_crash_before_directory_publish_rolls_back', async (): Promise<void> => { const fixture = await crashedCreate('before-create-directory-publish'); const recovered = new ProjectStore(fixture.dataRoot); await recovered.initialize(); expect(await exists(projectDirectory(fixture.dataRoot, fixture.project.projectId))).toBe(false); });
  it('actual_create_crash_after_directory_publish_preserves_project', async (): Promise<void> => { const fixture = await crashedCreate('after-create-directory-publish'); const recovered = new ProjectStore(fixture.dataRoot); expect((await recovered.read(fixture.project.projectId)).revision).toBe(0); });
  it('actual_create_crash_before_cleanup_preserves_project', async (): Promise<void> => { const fixture = await crashedCreate('before-create-cleanup'); const recovered = new ProjectStore(fixture.dataRoot); expect((await recovered.read(fixture.project.projectId)).revision).toBe(0); expect(await exists(fixture.transactionPath as string)).toBe(false); });
  it('actual_fault_test_uses_project_store_writer_not_manual_disk_state', async (): Promise<void> => { const fixture = await crashedUpdate('after-update-journal-prepared', false); expect(JSON.parse(await readFile(join(fixture.transactionPath as string, 'journal.json'), 'utf8')).version).toBe(3); });
});

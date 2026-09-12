import { legacyTextProject } from './legacy-text-helpers.js';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { generatorBuildProvenance, readBuildManifest } from '../src/build.js';
import { sameGenerationBuild } from '../src/build-fingerprint.js';
import { readBuildGitState } from '../src/build-inputs.js';
import { CodexRequestStore } from '../src/codex/requests.js';
import type { GeneratorBuildProvenance, Project } from '../src/domain/schema.js';
import { parseProject } from '../src/io/project.js';
import { readyVisualFixture } from './readiness-fixtures.js';

type LegacyBuild = Omit<GeneratorBuildProvenance, 'gitStateAvailable'>;
const roots: string[] = [];
afterEach(async (): Promise<void> => { vi.unstubAllEnvs(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function temporaryRoot(): Promise<string> { const root: string = await mkdtemp(join(tmpdir(), 'git-availability-')); roots.push(root); return root; }
function legacyBuild(): LegacyBuild {
  const build = readBuildManifest();
  return { provenanceVersion: 2, headCommitSha: build.headCommitSha, commitSha: build.commitSha, worktreeDirty: false, generationInputsDirty: true,
    appVersion: build.appVersion, projectSchemaVersion: '1.8.0', builtAt: build.builtAt, sourceTreeSha256: build.sourceTreeSha256,
    generationContractSha256: build.generationContractSha256, runtimeGenerationConfigSha256: build.runtimeGenerationConfigSha256 };
}
async function legacyProject(): Promise<object> {
  const { project } = await readyVisualFixture();
  return { ...legacyTextProject(project), schemaVersion: '1.8.0', generationRecords: [{ id: 'legacy-record', provider: 'codex-app', model: 'image-gen', modelVersion: null,
    requestId: null, prompt: '보존해야 하는 과거 프롬프트', templateVersion: '1', seed: null, referenceHashes: [], resultAssetIds: [], shotIds: [],
    createdAt: '2026-09-08T00:00:00.000Z', generatorBuild: legacyBuild() }] };
}

describe('Git 확인 불가 Provenance와 1.9 이관', (): void => {
  it('build_without_git_reports_git_state_unavailable', async (): Promise<void> => {
    expect(readBuildGitState(await temporaryRoot())).toMatchObject({ gitStateAvailable: false, headCommitSha: null });
  });
  it('build_without_git_does_not_report_clean_worktree', async (): Promise<void> => {
    expect(readBuildGitState(await temporaryRoot()).worktreeDirty).toBeNull();
  });
  it('build_without_git_does_not_report_clean_generation_inputs', async (): Promise<void> => {
    expect(readBuildGitState(await temporaryRoot()).generationInputsDirty).toBeNull();
  });
  it('head_known_status_unknown_preserves_head_only', async (): Promise<void> => {
    const root: string = await temporaryRoot(); const binary: string = join(root, 'bin'); await mkdir(binary);
    await writeFile(join(binary, 'git'), `#!/bin/sh\nif [ "$1" = "rev-parse" ]; then printf '%s\\n' '${'a'.repeat(40)}'; exit 0; fi\nexit 129\n`, { mode: 0o700 });
    vi.stubEnv('PATH', `${binary}:${process.env.PATH ?? ''}`);
    expect(readBuildGitState(root)).toEqual({ gitStateAvailable: false, headCommitSha: 'a'.repeat(40), worktreeDirty: null, generationInputsDirty: null });
  });
  it('github_sha_without_git_keeps_dirty_state_unknown', async (): Promise<void> => {
    vi.stubEnv('GITHUB_SHA', 'b'.repeat(40));
    expect(readBuildGitState(await temporaryRoot())).toEqual({ gitStateAvailable: false, headCommitSha: null, worktreeDirty: null, generationInputsDirty: null });
  });
  it('current_build_manifest_uses_provenance_version_3', (): void => {
    expect(readBuildManifest()).toMatchObject({ provenanceVersion: 3, gitStateAvailable: true, projectSchemaVersion: '1.22.0' });
    expect(generatorBuildProvenance(readBuildManifest())).toHaveProperty('gitStateAvailable', true);
  });
  it('project_18_to_19_migration_is_idempotent', async (): Promise<void> => {
    const migrated: Project = parseProject(await legacyProject());
    expect(migrated.schemaVersion).toBe('1.22.0'); expect(parseProject(migrated)).toEqual(migrated);
  });
  it('project_18_to_19_preserves_original_data', async (): Promise<void> => {
    const input: object = await legacyProject(); const before: string = JSON.stringify(input); const migrated: Project = parseProject(input);
    const normalized: object = { ...legacyTextProject(migrated), schemaVersion: '1.8.0', generationRecords: migrated.generationRecords.map((record) => ({
      ...record, generatorBuild: legacyBuild(),
    })) };
    expect(normalized).toEqual(input); expect(JSON.stringify(input)).toBe(before);
    const root: string = await temporaryRoot(); const path: string = join(root, 'version.json'); await writeFile(path, before);
    parseProject(JSON.parse(await readFile(path, 'utf8')) as unknown); expect(await readFile(path, 'utf8')).toBe(before);
  });
  it('legacy_build_without_availability_flag_remains_readable', async (): Promise<void> => {
    expect(parseProject(await legacyProject()).generationRecords[0]!.generatorBuild).toMatchObject({ ...legacyBuild(), gitStateAvailable: null });
  });
  it('legacy_build_does_not_fabricate_git_availability', async (): Promise<void> => {
    const build = parseProject(await legacyProject()).generationRecords[0]!.generatorBuild;
    expect(build).toMatchObject({ provenanceVersion: 2, gitStateAvailable: null, worktreeDirty: false, generationInputsDirty: true });
  });
  it('legacy_request_build_without_availability_remains_readable', async (): Promise<void> => {
    const root: string = await temporaryRoot(); const id: string = '11111111-1111-4111-8111-111111111111';
    const bytes: string = JSON.stringify({ id, kind: 'speech', projectId: 'project', targetId: 'cue', basisHash: 'a'.repeat(64), status: 'pending',
      createdAt: '2026-09-08T00:00:00.000Z', updatedAt: '2026-09-08T00:00:00.000Z', resultRevision: null, error: null, generatorBuild: legacyBuild() });
    const path: string = join(root, `${id}.json`); await writeFile(path, bytes);
    const store: CodexRequestStore = new CodexRequestStore(root, readBuildManifest());
    expect((await store.read(id)).generatorBuild).toMatchObject({ ...legacyBuild(), gitStateAvailable: null });
    expect(await readFile(path, 'utf8')).toBe(bytes);
  });
  it('same_generation_build_ignores_audit_only_git_state', (): void => {
    const known: GeneratorBuildProvenance = generatorBuildProvenance(readBuildManifest());
    expect(sameGenerationBuild(known, { ...known, gitStateAvailable: false, headCommitSha: null, worktreeDirty: null, generationInputsDirty: null })).toBe(true);
  });
});

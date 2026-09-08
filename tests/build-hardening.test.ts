import { buildForSpeechVoice, readBuildManifest } from '../src/build.js';
import type { BuildManifest } from '../src/build.js';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { hashBuildInputs, sameGenerationBuild } from '../src/build-fingerprint.js';
import { codexRequestMetrics } from '../src/codex/metrics.js';
import { CodexRequestStore } from '../src/codex/requests.js';
import type { CodexRequest } from '../src/codex/schema.js';
import { buildCodexWork, codexRequestBasis } from '../src/codex/work.js';
import type { GenerationRecord, Project } from '../src/domain/schema.js';
import { parseProject } from '../src/io/project.js';
import { ProjectStore } from '../src/server/store.js';
import { readinessOutline } from './readiness-fixtures.js';

const execute = promisify(execFile);
const roots: string[] = [];
afterEach(async (): Promise<void> => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

async function buildFixture(): Promise<{ root: string; head: string }> {
  const root: string = await mkdtemp(join(tmpdir(), 'storyboard-build-contract-'));
  roots.push(root);
  const files: Readonly<Record<string, string>> = { 'src/example.ts': 'export const value = 1;', 'web/example.ts': 'export const view = 1;',
    'package.json': '{"version":"0.1.0"}', 'package-lock.json': '{}', 'AGENTS.md': '원문을 보존한다.',
    '.agents/skills/storyboard-workbench/SKILL.md': '현재 모델에서 실행한다.', 'schemas/example.json': '{}',
    'storyboard.config.json': '{"codex":{"speechVoice":"Yuna"}}' };
  for (const [path, content] of Object.entries(files)) {
    await mkdir(join(root, path, '..'), { recursive: true });
    await writeFile(join(root, path), content);
  }
  await execute('git', ['init', '--quiet'], { cwd: root });
  await execute('git', ['add', '.'], { cwd: root });
  await execute('git', ['-c', 'user.name=Contract Test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', '검증 기준'], { cwd: root });
  const result = await execute('git', ['rev-parse', 'HEAD'], { cwd: root });
  return { root, head: result.stdout.trim() };
}

async function runBuild(root: string): Promise<BuildManifest> {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.GITHUB_SHA;
  await execute(process.execPath, ['--import', resolve('node_modules/tsx/dist/loader.mjs'), resolve('scripts/write-build-manifest.ts')], { cwd: root, env });
  return JSON.parse(await readFile(join(root, '.build/build-manifest.json'), 'utf8')) as BuildManifest;
}

async function requestFixture(build: BuildManifest): Promise<{ root: string; store: CodexRequestStore; request: CodexRequest }> {
  const root: string = await mkdtemp(join(tmpdir(), 'storyboard-request-build-'));
  roots.push(root);
  const store: CodexRequestStore = new CodexRequestStore(root, build);
  const request: CodexRequest = await store.create('speech', 'project', 'cue', 'a'.repeat(64), '2026-09-08T00:00:00.000Z');
  return { root, store, request };
}

async function replacementRequest(root: string, build: BuildManifest): Promise<CodexRequest> {
  return new CodexRequestStore(root, build).create('speech', 'project', 'cue', 'a'.repeat(64), '2026-09-08T00:00:01.000Z');
}

describe('생성 계약 Build 식별', (): void => {
  it('head_commit_sha_is_preserved_when_worktree_is_dirty', async (): Promise<void> => {
    const { root, head } = await buildFixture();
    await writeFile(join(root, 'src/example.ts'), 'export const value = 2;');
    expect(await runBuild(root)).toMatchObject({ headCommitSha: head, worktreeDirty: true });
  });

  it('skill_change_changes_generation_contract_hash', async (): Promise<void> => {
    const { root } = await buildFixture();
    const before: BuildManifest = await runBuild(root);
    await writeFile(join(root, '.agents/skills/storyboard-workbench/SKILL.md'), '새 생성 지침');
    const after: BuildManifest = await runBuild(root);
    expect(after).toHaveProperty('generationContractSha256');
    expect(after.generationContractSha256).not.toBe(before.generationContractSha256);
  });

  it('unrelated_untracked_file_does_not_erase_head_commit', async (): Promise<void> => {
    const { root, head } = await buildFixture();
    await writeFile(join(root, 'personal.txt'), '개인 메모');
    expect(await runBuild(root)).toMatchObject({ headCommitSha: head, commitSha: head, worktreeDirty: true, generationInputsDirty: false });
  });

  it('generation_input_change_sets_generation_inputs_dirty', async (): Promise<void> => {
    const { root } = await buildFixture();
    expect(await runBuild(root)).toMatchObject({ generationInputsDirty: false });
    await mkdir(join(root, 'src/proposal'), { recursive: true });
    await writeFile(join(root, 'src/proposal/context.ts'), 'export const prompt = "생성 원문";');
    expect(await runBuild(root)).toMatchObject({ generationInputsDirty: true });
  });

  it('agents_change_changes_generation_contract_hash', async (): Promise<void> => {
    const { root } = await buildFixture();
    const before: BuildManifest = await runBuild(root);
    await writeFile(join(root, 'AGENTS.md'), '새 원문 계약');
    const after: BuildManifest = await runBuild(root);
    expect(after.generationContractSha256).not.toBe(before.generationContractSha256);
    expect(after.sourceTreeSha256).toBe(before.sourceTreeSha256);
  });

  it('speech_voice_change_changes_runtime_generation_config_hash', async (): Promise<void> => {
    const { root } = await buildFixture();
    const before: BuildManifest = await runBuild(root);
    await writeFile(join(root, 'storyboard.config.json'), JSON.stringify({ codex: { speechVoice: 'Samantha' } }));
    const after: BuildManifest = await runBuild(root);
    expect(after.runtimeGenerationConfigSha256).not.toBe(before.runtimeGenerationConfigSha256);
    expect(after.generationContractSha256).toBe(before.generationContractSha256);
  });

  it('secret_and_absolute_path_are_not_hashed_into_manifest', async (): Promise<void> => {
    const { root } = await buildFixture();
    const before: BuildManifest = await runBuild(root);
    await writeFile(join(root, 'storyboard.config.json'), JSON.stringify({ codex: { speechVoice: 'Yuna', token: 'private-token', requestRoot: '/private/request-folder' },
      apiKey: 'private-key', password: 'private-password', host: 'private-host', pid: 123, dataRoot: '/private/data-folder' }));
    const after: BuildManifest = await runBuild(root);
    expect(sameGenerationBuild(before, after)).toBe(true);
    expect(JSON.stringify(after)).not.toMatch(/private-|\/private\//u);
  });

  it('build_fingerprint_is_stable_across_path_separator', (): void => {
    const first: string = hashBuildInputs([{ path: 'src/a.ts', bytes: Buffer.from('A') }, { path: '.agents/skills/work/SKILL.md', bytes: Buffer.from('B') }]);
    const second: string = hashBuildInputs([{ path: '.agents\\skills\\work\\SKILL.md', bytes: Buffer.from('B') }, { path: 'src\\a.ts', bytes: Buffer.from('A') }]);
    expect(second).toBe(first);
    expect((): string => hashBuildInputs([{ path: '/private/a.ts', bytes: Buffer.from('A') }])).toThrow(/정규 상대경로/);
  });

  it('legacy_generator_build_migrates_without_fabrication', async (): Promise<void> => {
    const project: Project = await readinessOutline();
    const generatorBuild = { commitSha: 'b'.repeat(40), appVersion: '0.1.0', projectSchemaVersion: '1.7.0', builtAt: '2026-09-07T00:00:00.000Z', sourceTreeSha256: 'c'.repeat(64) };
    const record = { id: 'legacy-build', provider: 'codex-app', model: 'image-gen', modelVersion: null, requestId: null,
      prompt: '과거 원문', templateVersion: '1', seed: null, referenceHashes: [], resultAssetIds: [], shotIds: [], createdAt: '2026-09-07T00:00:00.000Z', generatorBuild };
    const input = { ...project, schemaVersion: '1.7.0', generationRecords: [record] };
    const before: string = JSON.stringify(input);
    const migrated: Project = parseProject(input);
    expect(migrated.generationRecords[0]?.generatorBuild).toEqual({ ...generatorBuild, provenanceVersion: 1, headCommitSha: generatorBuild.commitSha,
      worktreeDirty: null, generationInputsDirty: null, generationContractSha256: null, runtimeGenerationConfigSha256: null });
    expect(JSON.stringify(input)).toBe(before);
    expect(parseProject(migrated)).toEqual(migrated);
  });

  it('project_17_to_18_migration_preserves_original_data', async (): Promise<void> => {
    const project: Project = await readinessOutline();
    const legacy: GenerationRecord = { id: 'unknown-build', provider: 'legacy', model: 'unknown', modelVersion: null, requestId: null, prompt: '보존',
      templateVersion: '1', seed: null, referenceHashes: [], resultAssetIds: [], shotIds: [], createdAt: '2026-09-07T00:00:00.000Z', generatorBuild: null };
    const input = { ...project, schemaVersion: '1.7.0', generationRecords: [legacy] };
    const migrated: Project = parseProject(input);
    expect(migrated).toEqual({ ...input, schemaVersion: '1.8.0' });
    expect(parseProject(migrated)).toEqual(migrated);
  });

  it('pending_request_from_old_build_is_not_reused', async (): Promise<void> => {
    const root: string = await mkdtemp(join(tmpdir(), 'storyboard-old-build-'));
    roots.push(root);
    const store: CodexRequestStore = new CodexRequestStore(root, readBuildManifest());
    const request: CodexRequest = await store.create('image', 'project', 'frame', 'a'.repeat(64), '2026-09-08T00:00:00.000Z');
    await writeFile(join(root, `${request.id}.json`), JSON.stringify({ ...request, generatorBuild: { ...request.generatorBuild, sourceTreeSha256: 'b'.repeat(64) } }));
    const next: CodexRequest = await store.create('image', 'project', 'frame', 'a'.repeat(64), '2026-09-08T00:00:01.000Z');
    expect(next.id).not.toBe(request.id);
  });

  it('same_build_pending_request_is_reused', async (): Promise<void> => {
    const build: BuildManifest = readBuildManifest();
    const { root, request } = await requestFixture(build);
    const next: CodexRequest = await replacementRequest(root, { ...build, builtAt: '2026-09-08T01:00:00.000Z' });
    expect(next).toEqual(request);
    expect(await readdir(root)).toEqual([`${request.id}.json`]);
  });

  it('new_build_supersedes_old_pending_request', async (): Promise<void> => {
    const build: BuildManifest = readBuildManifest();
    const { root, store, request } = await requestFixture(build);
    const next: CodexRequest = await replacementRequest(root, { ...build, sourceTreeSha256: 'f'.repeat(64) });
    expect(next.id).not.toBe(request.id);
    expect(await store.read(request.id)).toMatchObject({ status: 'superseded', error: { code: 'CODEX_REQUEST_SUPERSEDED' } });
    expect((await store.list('pending')).map((value: CodexRequest): string => value.id)).toEqual([next.id]);
  });

  it('superseded_request_is_preserved_for_audit', async (): Promise<void> => {
    const build: BuildManifest = readBuildManifest();
    const { root, store, request } = await requestFixture(build);
    await replacementRequest(root, { ...build, generationContractSha256: 'e'.repeat(64) });
    const old: CodexRequest = await store.read(request.id);
    expect(old).toMatchObject({ id: request.id, generatorBuild: request.generatorBuild, kind: request.kind, projectId: request.projectId, targetId: request.targetId, basisHash: request.basisHash, createdAt: request.createdAt });
    expect(await readdir(root)).toHaveLength(2);
  });

  it('superseded_request_is_excluded_from_operational_failure_rate', async (): Promise<void> => {
    const build: BuildManifest = readBuildManifest();
    const { root, store } = await requestFixture(build);
    const next: CodexRequest = await replacementRequest(root, { ...build, sourceTreeSha256: 'f'.repeat(64) });
    await store.complete(next.id, 1, '2026-09-08T00:00:01.500Z');
    expect(codexRequestMetrics(await store.list(null))).toMatchObject({ totalRequests: 2, supersededRequests: 1, completedRequests: 1,
      failedRequests: 0, pendingRequests: 0, averageLatencyMs: 500, maximumLatencyMs: 500 });
  });

  it('skill_change_requires_new_request', async (): Promise<void> => {
    const build: BuildManifest = readBuildManifest();
    const { root, request } = await requestFixture(build);
    const next: CodexRequest = await replacementRequest(root, { ...build, generationContractSha256: 'd'.repeat(64) });
    expect(next.id).not.toBe(request.id);
  });

  it('speech_voice_change_requires_new_speech_request', async (): Promise<void> => {
    const { root, request } = await requestFixture(buildForSpeechVoice('Yuna'));
    const next: CodexRequest = await replacementRequest(root, buildForSpeechVoice('Samantha'));
    expect(next.id).not.toBe(request.id);
    expect(next.generatorBuild?.runtimeGenerationConfigSha256).not.toBe(request.generatorBuild?.runtimeGenerationConfigSha256);
  });

  it('legacy_pending_request_without_fingerprint_is_not_reused', async (): Promise<void> => {
    const build: BuildManifest = readBuildManifest();
    const { root, store, request } = await requestFixture(build);
    const { generatorBuild, ...legacy } = request;
    expect(generatorBuild).toBeDefined();
    await writeFile(join(root, `${request.id}.json`), JSON.stringify(legacy));
    expect((await replacementRequest(root, build)).id).not.toBe(request.id);
    expect(await store.read(request.id)).toMatchObject({ status: 'superseded' });
    expect((await store.read(request.id)).generatorBuild).toBeUndefined();
  });

  it('request_execution_rechecks_contract_and_voice_fingerprints', async (): Promise<void> => {
    const build: BuildManifest = readBuildManifest();
    const { root, store } = await requestFixture(build);
    const project: Project = await readinessOutline();
    const request: CodexRequest = await store.create('proposal', project.projectId, 'SEG-001', codexRequestBasis(project, 'proposal', 'SEG-001'), '2026-09-08T00:00:02.000Z');
    const projectStore: ProjectStore = new ProjectStore(join(root, 'data'));
    try {
      for (const changed of [{ ...build, generationContractSha256: 'a'.repeat(64) }, buildForSpeechVoice('Samantha')]) {
        await expect(buildCodexWork(request, project, projectStore, changed)).rejects.toMatchObject({ code: 'CODEX_REQUEST_BUILD_CHANGED' });
      }
      const work = await buildCodexWork(request, project, projectStore, { ...build, builtAt: '2026-09-08T01:00:00.000Z' });
      expect(work.kind).toBe('proposal');
      await expect(buildCodexWork({ ...request, status: 'superseded' }, project, projectStore, build)).rejects.toMatchObject({ code: 'CODEX_REQUEST_SETTLED' });
    } finally { await projectStore.close(); }
  });
});

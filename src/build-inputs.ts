import { execFileSync } from 'node:child_process';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { contractError } from './domain/errors.js';
import type { BuildInput } from './build-fingerprint.js';

export type BuildGitState = { gitStateAvailable: boolean; headCommitSha: string | null; worktreeDirty: boolean | null; generationInputsDirty: boolean | null };
const generationDirectories: readonly string[] = ['.agents/skills/storyboard-workbench', 'src/codex', 'src/proposal', 'src/domain', 'schemas', 'src/prompts'];
const generationFiles: readonly string[] = ['AGENTS.md', 'package-lock.json', 'package.json'];

export function isGenerationContractPath(path: string): boolean {
  const normalized: string = path.replace(/\\/gu, '/');
  return generationFiles.includes(normalized) || generationDirectories.some((directory: string): boolean => normalized === directory || normalized.startsWith(`${directory}/`));
}

async function directoryInputs(root: string, directory: string): Promise<BuildInput[]> {
  const entries = await readdir(join(root, directory), { withFileTypes: true });
  const inputs: BuildInput[][] = await Promise.all(entries.map(async (entry): Promise<BuildInput[]> => {
    const path: string = `${directory}/${entry.name}`;
    if (entry.isDirectory()) return directoryInputs(root, path);
    if (!entry.isFile()) throw contractError('INVALID_BUILD_INPUT_TYPE', `${path}: Build 입력은 일반 파일이어야 합니다.`, []);
    return [{ path, bytes: await readFile(join(root, path)) }];
  }));
  return inputs.flat();
}

export async function runtimeSourceInputs(root: string): Promise<BuildInput[]> {
  const directories: BuildInput[][] = await Promise.all(['src', 'web'].map((directory: string): Promise<BuildInput[]> => directoryInputs(root, directory)));
  const files: BuildInput[] = await Promise.all(['package.json', 'package-lock.json'].map(async (path: string): Promise<BuildInput> => ({ path, bytes: await readFile(join(root, path)) })));
  return [...directories.flat(), ...files];
}

export async function generationContractInputs(root: string, runtime: readonly BuildInput[]): Promise<BuildInput[]> {
  const additional: BuildInput[][] = await Promise.all(['.agents/skills/storyboard-workbench', 'schemas'].map((directory: string): Promise<BuildInput[]> => directoryInputs(root, directory)));
  return [...runtime.filter((input: BuildInput): boolean => isGenerationContractPath(input.path)),
    ...additional.flat(), { path: 'AGENTS.md', bytes: await readFile(join(root, 'AGENTS.md')) }];
}

export function readBuildGitState(root: string): BuildGitState {
  let headCommitSha: string;
  try {
    headCommitSha = z.string().regex(/^[a-f0-9]{40}$/u).parse(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim());
  } catch (error: unknown) {
    process.stderr.write(`${JSON.stringify({ level: 'warn', code: 'BUILD_COMMIT_UNKNOWN', message: error instanceof Error ? error.message : String(error) })}\n`);
    return { gitStateAvailable: false, headCommitSha: null, worktreeDirty: null, generationInputsDirty: null };
  }
  let status: string;
  try { status = execFileSync('git', ['status', '--porcelain=v1', '-z', '--untracked-files=all'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }); }
  catch (error: unknown) {
    process.stderr.write(`${JSON.stringify({ level: 'warn', code: 'BUILD_GIT_STATUS_UNKNOWN', message: error instanceof Error ? error.message : String(error) })}\n`);
    return { gitStateAvailable: false, headCommitSha, worktreeDirty: null, generationInputsDirty: null };
  }
  const entries: string[] = status.split('\0');
  const paths: string[] = [];
  for (let index: number = 0; index < entries.length; index += 1) {
    const entry: string = entries[index] as string;
    if (entry === '') continue;
    paths.push(entry.slice(3));
    if (entry.slice(0, 2).includes('R') || entry.slice(0, 2).includes('C')) { index += 1; paths.push(entries[index] as string); }
  }
  return { gitStateAvailable: true, headCommitSha, worktreeDirty: paths.length > 0, generationInputsDirty: paths.some(isGenerationContractPath) };
}

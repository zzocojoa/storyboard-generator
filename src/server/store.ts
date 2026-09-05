import { mkdir, open, readdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname, join, resolve, sep } from 'node:path';
import { contractError } from '../domain/errors.js';
import type { Project } from '../domain/schema.js';
import { exportProjectJson } from '../exporters/json.js';
import { sha256Text } from '../importers/integrity.js';
import { isMissingFile } from '../io/package.js';
import { parseProject, readProject, writeNewText } from '../io/project.js';

export type ProjectSummary = {
  projectId: string; title: string; revision: number; durationMs: number; shots: number;
  framesReady: number; framesTotal: number; audioReady: number; audioTotal: number; issues: number; updatedAt: string;
};
export type AssetWrite = { relativePath: string; content: Buffer };

function projectKey(projectId: string): string {
  return sha256Text(projectId);
}

function summary(project: Project, updatedAt: string): ProjectSummary {
  return { projectId: project.projectId, title: project.title, revision: project.revision,
    durationMs: project.dataset.segments.at(-1)?.endMs ?? 0, shots: project.shots.length,
    framesReady: project.frames.filter((frame): boolean => frame.imageAssetId !== null).length, framesTotal: project.frames.length,
    audioReady: project.audioCues.filter((cue): boolean => cue.assetId !== null).length, audioTotal: project.audioCues.length,
    issues: project.importIssues.length, updatedAt };
}

export class ProjectStore {
  readonly #root: string;

  constructor(root: string) {
    this.#root = root;
  }

  #directory(projectId: string): string {
    return join(this.#root, projectKey(projectId));
  }

  #currentPath(projectId: string): string {
    return join(this.#directory(projectId), 'project.json');
  }

  async initialize(): Promise<void> {
    await mkdir(this.#root, { recursive: true });
  }

  async list(): Promise<ProjectSummary[]> {
    await this.initialize();
    const entries = await readdir(this.#root, { withFileTypes: true });
    const summaries: ProjectSummary[] = [];
    for (const entry of entries.filter((value): boolean => value.isDirectory())) {
      const path: string = join(this.#root, entry.name, 'project.json');
      try {
        const project: Project = await readProject(path);
        const metadata = await stat(path);
        summaries.push(summary(project, metadata.mtime.toISOString()));
      } catch (error: unknown) {
        if (isMissingFile(error)) continue;
        throw error;
      }
    }
    return summaries.sort((left: ProjectSummary, right: ProjectSummary): number => right.updatedAt.localeCompare(left.updatedAt));
  }

  async read(projectId: string): Promise<Project> {
    try {
      return await readProject(this.#currentPath(projectId));
    } catch (error: unknown) {
      if (!isMissingFile(error)) throw error;
      throw contractError('PROJECT_NOT_FOUND', `저장된 프로젝트를 찾을 수 없습니다: ${projectId}`, []);
    }
  }

  async create(project: Project): Promise<Project> {
    const valid: Project = parseProject(project);
    const directory: string = this.#directory(valid.projectId);
    await this.initialize();
    try {
      await mkdir(directory);
    } catch (error: unknown) {
      if (error instanceof Error && 'code' in error && error.code === 'EEXIST') throw contractError('PROJECT_ALREADY_EXISTS', `같은 프로젝트 ID가 이미 저장되어 있습니다: ${valid.projectId}`, []);
      throw error;
    }
    await mkdir(join(directory, 'versions'), { recursive: true });
    await mkdir(join(directory, 'assets'), { recursive: true });
    const content: string = exportProjectJson(valid);
    await writeNewText(join(directory, 'versions', '000000.json'), content);
    await writeNewText(this.#currentPath(valid.projectId), content);
    return valid;
  }

  async update(projectId: string, expectedRevision: number, transform: (project: Project) => Project, assetWrites: readonly AssetWrite[]): Promise<Project> {
    const directory: string = this.#directory(projectId);
    await mkdir(directory, { recursive: true });
    const lockPath: string = join(directory, 'write.lock');
    let lock;
    try {
      lock = await open(lockPath, 'wx');
    } catch (error: unknown) {
      if (error instanceof Error && 'code' in error && error.code === 'EEXIST') throw contractError('PROJECT_BUSY', `${projectId}: 다른 저장 작업이 진행 중입니다.`, []);
      throw error;
    }
    try {
      const current: Project = await this.read(projectId);
      if (current.revision !== expectedRevision) throw contractError('REVISION_CONFLICT', `${projectId}: expected=${expectedRevision}, actual=${current.revision}`, []);
      const changed: Project = transform(current);
      const next: Project = parseProject({ ...changed, projectId: current.projectId, revision: current.revision + 1 });
      const content: string = exportProjectJson(next);
      const temporary: string = join(directory, `project.${randomUUID()}.tmp`);
      await writeFile(temporary, content, { encoding: 'utf8', flag: 'wx' });
      for (const asset of assetWrites) {
        const assetPath: string = join(directory, asset.relativePath);
        await mkdir(dirname(assetPath), { recursive: true });
        await writeFile(assetPath, asset.content, { flag: 'wx' });
      }
      await writeNewText(join(directory, 'versions', `${String(next.revision).padStart(6, '0')}.json`), content);
      await rename(temporary, this.#currentPath(projectId));
      return next;
    } finally {
      await lock.close();
      await unlink(lockPath);
    }
  }

  async asset(projectId: string, assetId: string): Promise<{ content: Buffer; mimeType: string }> {
    const project: Project = await this.read(projectId);
    const asset = project.assets.find((value): boolean => value.id === assetId);
    if (asset === undefined) throw contractError('ASSET_NOT_FOUND', `${assetId}: 자산을 찾을 수 없습니다.`, []);
    return { content: await readFile(await this.assetPath(projectId, assetId)), mimeType: asset.mimeType };
  }

  async assetPath(projectId: string, assetId: string): Promise<string> {
    const project: Project = await this.read(projectId);
    const asset = project.assets.find((value): boolean => value.id === assetId);
    if (asset === undefined) throw contractError('ASSET_NOT_FOUND', `${assetId}: 자산을 찾을 수 없습니다.`, []);
    const directory: string = resolve(this.#directory(projectId));
    const path: string = resolve(directory, asset.path);
    if (path !== directory && !path.startsWith(`${directory}${sep}`)) throw contractError('UNSAFE_ASSET_PATH', `${assetId}: 프로젝트 밖의 자산 경로는 읽을 수 없습니다. path=${asset.path}`, []);
    return path;
  }
}

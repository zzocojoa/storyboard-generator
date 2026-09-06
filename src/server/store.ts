import { randomUUID } from 'node:crypto';
import { mkdir, open, readdir, readFile, rename, rm, stat, unlink, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { contractError } from '../domain/errors.js';
import { reviewFrameOutput } from '../domain/frame-output.js';
import { verifyStoredAsset } from '../domain/media-inspection.js';
import { reviewAudioPlaybackAt, reviewTextPlaybackAt } from '../domain/playback.js';
import type { Asset, Project } from '../domain/schema.js';
import { exportProjectJson } from '../exporters/json.js';
import { sha256Text } from '../importers/integrity.js';
import { isMissingFile } from '../io/package.js';
import { parseProject, readProject, writeNewText } from '../io/project.js';

export type ProjectSummary = {
  projectId: string;
  title: string;
  revision: number;
  durationMs: number;
  shots: number;
  framesWithAsset: number;
  framesAccepted: number;
  framesOutputSafe: number;
  framesTotal: number;
  audioWithAsset: number;
  audioMeasured: number;
  audioPlayable: number;
  audioTotal: number;
  textPlayable: number;
  textTotal: number;
  blockedOutputCount: number;
  issues: number;
  updatedAt: string;
};
export type AssetWrite = { relativePath: string; content: Buffer };
export type StoredAsset = { content: Buffer; mimeType: string; asset: Asset };

function projectKey(projectId: string): string {
  return sha256Text(projectId);
}

function assetFailureCode(error: unknown): string | null {
  if (!(error instanceof Error) || !('code' in error) || typeof error.code !== 'string') return null;
  return ['ASSET_FILE_MISSING', 'ASSET_HASH_MISMATCH', 'ASSET_MIME_MISMATCH', 'ASSET_CONTENT_CORRUPT', 'ASSET_PATH_UNSAFE']
    .includes(error.code) ? error.code : null;
}

async function removeCommittedFile(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch (error: unknown) {
    if (isMissingFile(error)) return;
    throw error;
  }
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

  #safeAssetPath(projectId: string, asset: Asset): string {
    const directory: string = resolve(this.#directory(projectId));
    const path: string = resolve(directory, asset.path);
    if (path === directory || !path.startsWith(`${directory}${sep}`)) {
      throw contractError('ASSET_PATH_UNSAFE', `프로젝트 밖의 자산 경로는 읽을 수 없습니다. assetId=${asset.id}, path=${asset.path}`, []);
    }
    return path;
  }

  async #assetForProject(project: Project, assetId: string): Promise<StoredAsset> {
    const asset: Asset | undefined = project.assets.find((value: Asset): boolean => value.id === assetId);
    if (asset === undefined) throw contractError('ASSET_NOT_FOUND', `자산을 찾을 수 없습니다. assetId=${assetId}`, []);
    const path: string = this.#safeAssetPath(project.projectId, asset);
    let content: Buffer;
    try {
      content = await readFile(path);
    } catch (error: unknown) {
      if (isMissingFile(error)) throw contractError('ASSET_FILE_MISSING', `자산 파일이 없습니다. assetId=${assetId}, path=${asset.path}`, []);
      throw error;
    }
    await verifyStoredAsset(project, asset, content);
    return { content, mimeType: asset.mimeType, asset };
  }

  async #summary(project: Project, updatedAt: string): Promise<ProjectSummary> {
    let framesOutputSafe: number = 0;
    for (const frame of project.frames) {
      const decision = reviewFrameOutput(project, frame.id, 'program-monitor');
      if (!decision.renderBitmap || decision.imageAssetId === null) continue;
      try {
        await this.#assetForProject(project, decision.imageAssetId);
        framesOutputSafe += 1;
      } catch (error: unknown) {
        if (assetFailureCode(error) === null) throw error;
      }
    }
    let audioPlayable: number = 0;
    for (const cue of project.audioCues) {
      const playable: boolean = reviewAudioPlaybackAt(project, cue.startMs).playable.some((candidate): boolean => candidate.id === cue.id);
      if (!playable || cue.assetId === null) continue;
      try {
        await this.#assetForProject(project, cue.assetId);
        audioPlayable += 1;
      } catch (error: unknown) {
        if (assetFailureCode(error) === null) throw error;
      }
    }
    const textPlayable: number = project.textCues.filter((cue): boolean => reviewTextPlaybackAt(project, cue.startMs).playable
      .some((candidate): boolean => candidate.id === cue.id)).length;
    const blockedOutputCount: number = project.frames.length - framesOutputSafe + project.audioCues.length - audioPlayable
      + project.textCues.length - textPlayable;
    return { projectId: project.projectId, title: project.title, revision: project.revision,
      durationMs: project.dataset.segments.at(-1)?.endMs ?? 0, shots: project.shots.length,
      framesWithAsset: project.frames.filter((frame): boolean => frame.imageAssetId !== null).length,
      framesAccepted: project.frames.filter((frame): boolean => frame.visualReview === 'accepted').length,
      framesOutputSafe, framesTotal: project.frames.length,
      audioWithAsset: project.audioCues.filter((cue): boolean => cue.assetId !== null).length,
      audioMeasured: project.audioCues.filter((cue): boolean => cue.timingStatus === 'measured').length,
      audioPlayable, audioTotal: project.audioCues.length, textPlayable, textTotal: project.textCues.length,
      blockedOutputCount, issues: project.importIssues.length, updatedAt };
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
        summaries.push(await this.#summary(project, metadata.mtime.toISOString()));
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
    const transactionId: string = randomUUID();
    const stagingDirectory: string = join(directory, `.staging-${transactionId}`);
    const committedAssets: string[] = [];
    let committedVersion: string | null = null;
    try {
      const current: Project = await this.read(projectId);
      if (current.revision !== expectedRevision) throw contractError('REVISION_CONFLICT', `${projectId}: expected=${expectedRevision}, actual=${current.revision}`, []);
      const changed: Project = transform(current);
      const next: Project = parseProject({ ...changed, projectId: current.projectId, revision: current.revision + 1 });
      const content: string = exportProjectJson(next);
      await mkdir(stagingDirectory, { recursive: true });
      const stagedProject: string = join(stagingDirectory, 'project.json');
      const stagedVersion: string = join(stagingDirectory, 'version.json');
      await writeFile(stagedProject, content, { encoding: 'utf8', flag: 'wx' });
      await writeFile(stagedVersion, content, { encoding: 'utf8', flag: 'wx' });
      const stagedAssets: { staged: string; final: string }[] = [];
      for (const assetWrite of assetWrites) {
        const metadata: Asset | undefined = next.assets.find((asset: Asset): boolean => asset.path === assetWrite.relativePath);
        if (metadata === undefined) throw contractError('ASSET_WRITE_UNDECLARED', `Project metadata에 없는 자산 파일을 저장할 수 없습니다. path=${assetWrite.relativePath}`, []);
        const final: string = this.#safeAssetPath(projectId, metadata);
        const staged: string = join(stagingDirectory, `asset-${stagedAssets.length}`);
        await writeFile(staged, assetWrite.content, { flag: 'wx' });
        await verifyStoredAsset(next, metadata, assetWrite.content);
        stagedAssets.push({ staged, final });
      }
      for (const item of stagedAssets) {
        await mkdir(dirname(item.final), { recursive: true });
        try {
          await stat(item.final);
          throw contractError('ASSET_FILE_EXISTS', `새 자산 경로가 이미 존재합니다. path=${item.final}`, []);
        } catch (error: unknown) {
          if (!isMissingFile(error)) throw error;
        }
        await rename(item.staged, item.final);
        committedAssets.push(item.final);
      }
      committedVersion = join(directory, 'versions', `${String(next.revision).padStart(6, '0')}.json`);
      await rename(stagedVersion, committedVersion);
      await rename(stagedProject, this.#currentPath(projectId));
      return next;
    } catch (error: unknown) {
      const rollbackPaths: string[] = committedVersion === null ? committedAssets : [...committedAssets, committedVersion];
      const rollbackResults: PromiseSettledResult<void>[] = await Promise.allSettled(rollbackPaths.map(removeCommittedFile));
      const rollbackErrors: unknown[] = rollbackResults.flatMap((result: PromiseSettledResult<void>): unknown[] => result.status === 'rejected' ? [result.reason] : []);
      if (rollbackErrors.length > 0) {
        throw new AggregateError([error, ...rollbackErrors], `프로젝트 저장 실패 후 파일을 되돌리지 못했습니다. projectId=${projectId}, rollbackFiles=${rollbackPaths.join(',')}`);
      }
      throw error;
    } finally {
      await rm(stagingDirectory, { recursive: true, force: true });
      await lock.close();
      await unlink(lockPath);
    }
  }

  async asset(projectId: string, assetId: string): Promise<StoredAsset> {
    return this.#assetForProject(await this.read(projectId), assetId);
  }

  async assetIntegrity(projectId: string): Promise<Record<string, string>> {
    const project: Project = await this.read(projectId);
    const result: Record<string, string> = {};
    for (const asset of project.assets) {
      try {
        await this.#assetForProject(project, asset.id);
        result[asset.id] = 'verified';
      } catch (error: unknown) {
        const code: string | null = assetFailureCode(error);
        if (code === null) throw error;
        result[asset.id] = code;
      }
    }
    return result;
  }

  async safeFrame(projectId: string, frameId: string): Promise<StoredAsset> {
    const project: Project = await this.read(projectId);
    const decision = reviewFrameOutput(project, frameId, 'program-monitor');
    if (!decision.renderBitmap || decision.imageAssetId === null) {
      throw contractError('FRAME_OUTPUT_BLOCKED', decision.issues.map((value): string => `${value.code}: ${value.message}`).join('\n'), decision.issues);
    }
    const stored: StoredAsset = await this.#assetForProject(project, decision.imageAssetId);
    if (stored.asset.kind !== 'image') throw contractError('FRAME_OUTPUT_BLOCKED', `프레임 출력 자산이 이미지가 아닙니다. frameId=${frameId}`, []);
    return stored;
  }

  async safeAudio(projectId: string, cueId: string): Promise<StoredAsset> {
    const project: Project = await this.read(projectId);
    const cue = project.audioCues.find((candidate): boolean => candidate.id === cueId);
    if (cue === undefined) throw contractError('AUDIO_CUE_NOT_FOUND', `오디오 큐를 찾을 수 없습니다. cueId=${cueId}`, []);
    const review = reviewAudioPlaybackAt(project, cue.startMs);
    if (!review.playable.some((candidate): boolean => candidate.id === cue.id)) {
      const issues = review.blocked.find((blocked): boolean => blocked.cueId === cue.id)?.issues ?? [];
      throw contractError('AUDIO_OUTPUT_BLOCKED', issues.map((value): string => `${value.code}: ${value.message}`).join('\n'), issues);
    }
    if (cue.assetId === null) throw contractError('AUDIO_ASSET_NOT_FOUND', `오디오 자산이 없습니다. cueId=${cue.id}`, []);
    let stored: StoredAsset;
    try {
      stored = await this.#assetForProject(project, cue.assetId);
    } catch (error: unknown) {
      const code: string | null = assetFailureCode(error);
      if (code === null) throw error;
      const audioCode: string = code === 'ASSET_FILE_MISSING' ? 'AUDIO_ASSET_FILE_MISSING'
        : code === 'ASSET_HASH_MISMATCH' ? 'AUDIO_ASSET_HASH_MISMATCH' : 'AUDIO_ASSET_CORRUPT';
      throw contractError(audioCode, `안전 오디오 출력용 자산을 검증할 수 없습니다. cueId=${cue.id}, assetId=${cue.assetId}, cause=${code}`, []);
    }
    if (stored.asset.kind !== 'audio') throw contractError('AUDIO_OUTPUT_BLOCKED', `오디오 출력 자산의 유형이 다릅니다. cueId=${cue.id}`, []);
    return stored;
  }

  async assetPath(projectId: string, assetId: string): Promise<string> {
    const project: Project = await this.read(projectId);
    const asset: Asset | undefined = project.assets.find((value: Asset): boolean => value.id === assetId);
    if (asset === undefined) throw contractError('ASSET_NOT_FOUND', `자산을 찾을 수 없습니다. assetId=${assetId}`, []);
    return this.#safeAssetPath(projectId, asset);
  }
}

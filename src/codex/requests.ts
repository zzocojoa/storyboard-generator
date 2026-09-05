import { randomUUID } from 'node:crypto';
import { mkdir, readdir, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { contractError } from '../domain/errors.js';
import { parseJson } from '../importers/integrity.js';
import { isMissingFile, readUtf8 } from '../io/package.js';
import type { CodexRequest, CodexRequestKind, CodexRequestStatus } from './schema.js';
import { CodexRequestSchema } from './schema.js';

function requestPath(root: string, requestId: string): string {
  const id: string = CodexRequestSchema.shape.id.parse(requestId);
  return join(root, `${id}.json`);
}

function serialize(request: CodexRequest): string {
  return `${JSON.stringify(CodexRequestSchema.parse(request), null, 2)}\n`;
}

export class CodexRequestStore {
  readonly #root: string;

  constructor(root: string) {
    this.#root = root;
  }

  async initialize(): Promise<void> {
    await mkdir(this.#root, { recursive: true });
  }

  async list(status: CodexRequestStatus | null): Promise<CodexRequest[]> {
    await this.initialize();
    const entries: string[] = (await readdir(this.#root)).filter((name: string): boolean => name.endsWith('.json'));
    const requests: CodexRequest[] = await Promise.all(entries.map(async (name: string): Promise<CodexRequest> => {
      const path: string = join(this.#root, name);
      return CodexRequestSchema.parse(parseJson(await readUtf8(path), path));
    }));
    return requests.filter((request: CodexRequest): boolean => status === null || request.status === status)
      .sort((left: CodexRequest, right: CodexRequest): number => left.createdAt.localeCompare(right.createdAt));
  }

  async read(requestId: string): Promise<CodexRequest> {
    const path: string = requestPath(this.#root, requestId);
    try {
      return CodexRequestSchema.parse(parseJson(await readUtf8(path), path));
    } catch (error: unknown) {
      if (!isMissingFile(error)) throw error;
      throw contractError('CODEX_REQUEST_NOT_FOUND', `Codex 생성 요청을 찾을 수 없습니다: ${requestId}`, []);
    }
  }

  async create(kind: CodexRequestKind, projectId: string, targetId: string, basisHash: string, now: string): Promise<CodexRequest> {
    const duplicate: CodexRequest | undefined = (await this.list('pending')).find((request: CodexRequest): boolean =>
      request.kind === kind && request.projectId === projectId && request.targetId === targetId && request.basisHash === basisHash,
    );
    if (duplicate !== undefined) return duplicate;
    const request: CodexRequest = CodexRequestSchema.parse({ id: randomUUID(), kind, projectId, targetId, basisHash,
      status: 'pending', createdAt: now, updatedAt: now, resultRevision: null, error: null });
    await writeFile(requestPath(this.#root, request.id), serialize(request), { encoding: 'utf8', flag: 'wx' });
    return request;
  }

  async complete(requestId: string, resultRevision: number, now: string): Promise<CodexRequest> {
    return this.#replace(await this.read(requestId), { status: 'completed', resultRevision, error: null, updatedAt: now });
  }

  async fail(requestId: string, code: string, message: string, now: string): Promise<CodexRequest> {
    return this.#replace(await this.read(requestId), { status: 'failed', resultRevision: null, error: { code, message }, updatedAt: now });
  }

  async #replace(current: CodexRequest, change: Pick<CodexRequest, 'status' | 'resultRevision' | 'error' | 'updatedAt'>): Promise<CodexRequest> {
    if (current.status !== 'pending') throw contractError('CODEX_REQUEST_SETTLED', `${current.id}: 이미 ${current.status} 상태인 요청입니다.`, []);
    const next: CodexRequest = CodexRequestSchema.parse({ ...current, ...change });
    const path: string = requestPath(this.#root, current.id);
    const temporary: string = join(this.#root, `${current.id}.${randomUUID()}.tmp`);
    await writeFile(temporary, serialize(next), { encoding: 'utf8', flag: 'wx' });
    await rename(temporary, path);
    return next;
  }
}

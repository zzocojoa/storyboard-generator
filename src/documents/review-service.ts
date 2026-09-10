import { randomUUID } from 'node:crypto';
import type { Dirent } from 'node:fs';
import { realpath } from 'node:fs/promises';
import { z } from 'zod';
import { RequestLockManager, requestErrorCode } from '../codex/request-lock.js';
import type { RequestLock } from '../codex/request-lock.js';
import { contractError } from '../domain/errors.js';
import { sha256Text } from '../importers/integrity.js';
import { SafeStoreFilesystem } from '../server/safe-filesystem.js';
import { documentFingerprint, inspectDocuments } from './compile.js';
import { readDocumentSources } from './io.js';
import { documentReviewBasis, documentReviewPrompt, DocumentReviewInputSchema, StoredReviewInputSchema } from './review-context.js';
import type { DocumentReviewInput, StoredReviewInput } from './review-context.js';
import type { DocumentReviewEngine, ReviewEngineResult } from './review-engine.js';
import { ProductionFieldsSchema, ProductionPresetSchema, ReviewStateSchema } from './review-model.js';
import type { ProductionFields, ProductionPreset, ReviewState } from './review-model.js';
import type { DocumentSources } from './schema.js';
import { productionSettings, validateDocumentReviewResult } from './review-validation.js';

type ActiveReview = { id: string; basisHash: string; controller: AbortController; promise: Promise<void> };
const SERVICE_KEY: string = sha256Text('cutroom-document-review-service-v1');

/** 문서 검토 파일과 실행 엔진을 연결하며 기존 Project 저장소는 수정하지 않는다. */
export class DocumentReviewService {
  readonly #fs: SafeStoreFilesystem;
  readonly #engine: DocumentReviewEngine;
  readonly #locks: RequestLockManager;
  #lock: RequestLock | null = null;
  #active: ActiveReview | null = null;
  #starting: boolean = false;
  #closed: boolean = false;
  #closing: boolean = false;
  #storageFailure: Error | null = null;

  constructor(root: string, engine: DocumentReviewEngine) {
    this.#fs = new SafeStoreFilesystem(root); this.#engine = engine;
    this.#locks = new RequestLockManager(this.#fs, async (_original, assertOwnership): Promise<void> => { await assertOwnership(); });
  }

  async initialize(): Promise<void> {
    await this.#fs.initialize();
    for (const directory of ['.locks', '.recovery-claims', 'requests', 'presets']) await this.#fs.ensureDirectory(this.#fs.path(directory));
    this.#lock = await this.#locks.acquire(SERVICE_KEY);
    try {
      for (const entry of await this.#fs.entries(this.#fs.path('requests'))) {
        if (!entry.name.endsWith('.running.json')) continue;
        const id: string = z.uuid().parse(entry.name.slice(0, -'.running.json'.length));
        const state: ReviewState = await this.read(id);
        if (state.status === 'running') await this.#finish({ ...state, status: 'failed', updatedAt: new Date().toISOString(),
          error: { code: 'DOCUMENT_REVIEW_INTERRUPTED', message: '서버가 종료되어 검토가 중단되었습니다. 원본을 다시 확인하고 재시도하세요.' } });
      }
    } catch (error: unknown) { await this.#locks.release(this.#lock); this.#lock = null; throw error; }
  }

  activeRequestId(): string | null { this.#healthy(); return this.#active?.id ?? null; }

  #healthy(): void {
    if (this.#storageFailure !== null) throw this.#storageFailure;
    if (this.#closed || this.#lock === null) throw contractError('DOCUMENT_REVIEW_UNAVAILABLE', '문서 검토 서비스가 실행 중이 아닙니다.', []);
  }

  async #publish(name: string, data: object): Promise<void> {
    this.#healthy(); await this.#locks.verify(this.#lock!);
    await this.#fs.publishExclusiveFileWithIdentity(this.#fs.path(name), JSON.stringify(data, null, 2) + '\n', randomUUID());
  }

  async #finish(state: ReviewState): Promise<void> { await this.#publish(`requests/${state.id}.terminal.json`, ReviewStateSchema.parse(state)); }

  async read(id: string): Promise<ReviewState> {
    this.#healthy(); z.uuid().parse(id);
    for (const suffix of ['stale', 'terminal', 'running']) {
      const path: string = this.#fs.path('requests', `${id}.${suffix}.json`);
      if (await this.#fs.exists(path)) {
        const state: ReviewState = ReviewStateSchema.parse(JSON.parse(await this.#fs.readText(path)) as unknown);
        if (state.id !== id) throw contractError('INVALID_DOCUMENT_REVIEW_RECORD', `${id}: 저장된 요청 ID가 다릅니다.`, []);
        return state;
      }
    }
    throw contractError('DOCUMENT_REVIEW_NOT_FOUND', `${id}: 문서 검토 요청이 없습니다.`, []);
  }

  async presets(): Promise<ProductionPreset[]> {
    this.#healthy();
    const files: Dirent[] = await this.#fs.entries(this.#fs.path('presets'));
    const presets: ProductionPreset[] = [];
    for (const entry of files.filter((file: Dirent): boolean => file.name.endsWith('.json')).sort((a: Dirent, b: Dirent): number => a.name.localeCompare(b.name))) {
      const id: string = z.uuid().parse(entry.name.slice(0, -5));
      const preset: ProductionPreset = ProductionPresetSchema.parse(JSON.parse(await this.#fs.readText(this.#fs.path('presets', entry.name))) as unknown);
      if (preset.id !== id) throw contractError('INVALID_DOCUMENT_REVIEW_PRESET', `${id}: 프리셋 ID가 다릅니다.`, []);
      productionSettings(preset.fields); presets.push(preset);
    }
    return presets;
  }

  async savePreset(name: string, fields: ProductionFields): Promise<ProductionPreset> {
    productionSettings(ProductionFieldsSchema.parse(fields));
    const preset: ProductionPreset = ProductionPresetSchema.parse({ id: randomUUID(), name, fields, createdAt: new Date().toISOString() });
    await this.#publish(`presets/${preset.id}.json`, preset); return preset;
  }

  async start(value: DocumentReviewInput): Promise<ReviewState> {
    this.#healthy();
    if (this.#closing) throw contractError('DOCUMENT_REVIEW_UNAVAILABLE', '문서 검토 서비스를 종료 중입니다.', []);
    if (this.#starting) throw contractError('DOCUMENT_REVIEW_BUSY', '다른 문서 검토를 준비 중입니다. 잠시 후 다시 실행하세요.', []);
    this.#starting = true;
    try {
      const input: DocumentReviewInput = DocumentReviewInputSchema.parse(value);
      const directory: string = await realpath(input.directory);
      const sources: DocumentSources = await readDocumentSources(directory);
      if (documentFingerprint(sources) !== input.sourceFingerprint) throw contractError('INVALID_DOCUMENT_FINGERPRINT', '검토 이후 문서가 변경되었습니다. 문서 확인 단계부터 다시 실행하세요.', []);
      const preset: ProductionPreset | null = input.presetId === null ? null : (await this.presets()).find((item: ProductionPreset): boolean => item.id === input.presetId) ?? null;
      if (input.presetId !== null && preset === null) throw contractError('INVALID_DOCUMENT_REVIEW_PRESET', '선택한 제작 프리셋이 없습니다. 다시 선택하세요.', []);
      const stored: StoredReviewInput = { input: { ...input, directory }, preset };
      const basisHash: string = documentReviewBasis(stored);
      if (this.#active !== null) {
        const active: ActiveReview = this.#active;
        const current: ReviewState = await this.read(active.id);
        if (current.status === 'running') {
          if (active.basisHash === basisHash) return current;
          throw contractError('DOCUMENT_REVIEW_BUSY', '다른 문서를 검토 중입니다. 완료 후 실행하거나 진행 중인 검토를 취소하세요.', []);
        }
        await active.promise;
        this.#healthy();
      }
      const preview = inspectDocuments(sources, input.bindings).preview;
      const prompt: string = documentReviewPrompt(sources, preview, stored);
      if (Buffer.byteLength(prompt) > 2 * 1024 * 1024) throw contractError('DOCUMENT_REVIEW_INPUT_TOO_LARGE', '자동 검토 입력은 2MB 이하여야 합니다.', []);
      const now: string = new Date().toISOString();
      const state: ReviewState = { id: randomUUID(), basisHash, sourceFingerprint: input.sourceFingerprint, createdAt: now, updatedAt: now, status: 'running', model: null, result: null, error: null };
      await this.#publish(`requests/${state.id}.input.json`, stored);
      await this.#publish(`requests/${state.id}.snapshots.json`, sources);
      await this.#publish(`requests/${state.id}.running.json`, state);
      const controller: AbortController = new AbortController();
      const active: ActiveReview = { id: state.id, basisHash, controller, promise: Promise.resolve() };
      this.#active = active;
      active.promise = this.#execute(state, stored, sources, prompt, controller.signal).catch((error: unknown): void => {
        this.#storageFailure = contractError('DOCUMENT_REVIEW_STORAGE_FAILED', `검토 결과 저장 실패: ${error instanceof Error ? error.message : String(error)}`, []);
        console.error(JSON.stringify({ event: 'document-review-storage-failed', requestId: state.id, message: this.#storageFailure.message }));
      }).finally((): void => { if (this.#active === active) this.#active = null; });
      return state;
    } finally { this.#starting = false; }
  }

  async #execute(state: ReviewState, stored: StoredReviewInput, sources: DocumentSources, prompt: string, signal: AbortSignal): Promise<void> {
    let terminal: ReviewState;
    try {
      const generated: ReviewEngineResult = await this.#engine.run(prompt, signal);
      if (signal.aborted) throw contractError('DOCUMENT_REVIEW_CANCELLED', '문서 자동 검토를 취소했습니다.', []);
      const result = validateDocumentReviewResult(sources, stored.input.bindings, stored.input.production, generated.result);
      if (documentFingerprint(await readDocumentSources(stored.input.directory)) !== state.sourceFingerprint) throw contractError('INVALID_DOCUMENT_FINGERPRINT', '검토 중 원본 문서가 변경되었습니다. 문서를 다시 검토하세요.', []);
      if (signal.aborted) throw contractError('DOCUMENT_REVIEW_CANCELLED', '문서 자동 검토를 취소했습니다.', []);
      terminal = { ...state, status: 'completed', updatedAt: new Date().toISOString(), model: generated.model, result };
    } catch (error: unknown) {
      const code: string = signal.aborted ? 'DOCUMENT_REVIEW_CANCELLED' : requestErrorCode(error);
      terminal = { ...state, status: signal.aborted ? 'cancelled' : code === 'INVALID_DOCUMENT_FINGERPRINT' ? 'stale' : 'failed', updatedAt: new Date().toISOString(),
        error: { code, message: error instanceof Error ? error.message : String(error) } };
    }
    await this.#finish(terminal);
  }

  async cancel(id: string): Promise<ReviewState> {
    this.#healthy(); z.uuid().parse(id);
    if (this.#active?.id !== id) return this.read(id);
    const active: ActiveReview = this.#active; active.controller.abort(); await active.promise;
    return this.read(id);
  }

  /** 결과를 폼에 반영하기 직전에 선택 문서와 요청의 실제 기준을 다시 확인한다. */
  async validate(id: string, input: DocumentReviewInput): Promise<ReviewState> {
    const state: ReviewState = await this.read(id);
    if (state.status !== 'completed') throw contractError('DOCUMENT_REVIEW_NOT_COMPLETED', `${id}: 검토 상태가 ${state.status}입니다.`, []);
    const stored: StoredReviewInput = StoredReviewInputSchema.parse(JSON.parse(await this.#fs.readText(this.#fs.path('requests', `${id}.input.json`))) as unknown);
    const directory: string = await realpath(input.directory);
    if (documentReviewBasis({ input: { ...DocumentReviewInputSchema.parse(input), directory }, preset: stored.preset }) !== state.basisHash
      || directory !== stored.input.directory) throw contractError('DOCUMENT_REVIEW_BASIS_CHANGED', '요청 뒤 연결·설정 또는 입력 폴더가 변경되었습니다. 현재 값으로 다시 검토하세요.', []);
    if (documentFingerprint(await readDocumentSources(stored.input.directory)) !== state.sourceFingerprint) {
      const stale: ReviewState = { ...state, status: 'stale', updatedAt: new Date().toISOString(), error: { code: 'INVALID_DOCUMENT_FINGERPRINT', message: '검토 이후 원본 문서가 변경되었습니다. 문서 확인 단계부터 다시 실행하세요.' } };
      if (!await this.#fs.exists(this.#fs.path('requests', `${id}.stale.json`))) await this.#publish(`requests/${id}.stale.json`, stale);
      throw contractError('INVALID_DOCUMENT_FINGERPRINT', stale.error!.message, []);
    }
    return state;
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closing = true;
    if (this.#active !== null) { this.#active.controller.abort(); await this.#active.promise; }
    if (this.#lock !== null) { await this.#locks.release(this.#lock); this.#lock = null; }
    this.#closed = true;
    if (this.#storageFailure !== null) throw this.#storageFailure;
  }
}

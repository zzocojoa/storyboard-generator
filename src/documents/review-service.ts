import { randomUUID } from 'node:crypto';
import type { Dirent } from 'node:fs';
import { realpath } from 'node:fs/promises';
import { z } from 'zod';
import { RequestLockManager, requestErrorCode } from '../codex/request-lock.js';
import type { RequestLock } from '../codex/request-lock.js';
import { contractError } from '../domain/errors.js';
import { SnapshotSchema } from '../domain/schema.js';
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
import { DOCUMENT_FILES } from './schema.js';
import { verifyIdentityEvidence } from './identity.js';
import type { IdentityBasis, SavedIdentityPreview } from './identity-schema.js';
import type { DocumentBindings } from './schema.js';
import { productionSettings, validateDocumentReviewResult } from './review-validation.js';

type ActiveReview = { id: string; basisHash: string; controller: AbortController; promise: Promise<void> };
type PreparedReview = { stored: StoredReviewInput; sources: DocumentSources; basisHash: string };
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
    const state: ReviewState | null = await this.#readExisting(id);
    if (state === null) throw contractError('DOCUMENT_REVIEW_NOT_FOUND', `${id}: 문서 검토 요청이 없습니다. 같은 요청 재전송으로 접수 여부를 확인하세요.`, []);
    return state;
  }

  async #readExisting(id: string): Promise<ReviewState | null> {
    this.#healthy(); z.uuid().parse(id);
    for (const suffix of ['stale', 'terminal', 'running']) {
      const path: string = this.#fs.path('requests', `${id}.${suffix}.json`);
      if (await this.#fs.exists(path)) {
        const state: ReviewState = ReviewStateSchema.parse(JSON.parse(await this.#fs.readText(path)) as unknown);
        if (state.id !== id) throw contractError('INVALID_DOCUMENT_REVIEW_RECORD', `${id}: 저장된 요청 ID가 다릅니다.`, []);
        return state;
      }
    }
    return null;
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

  async #identitySources(input: IdentityBasis): Promise<DocumentSources> {
    const sources: DocumentSources = await readDocumentSources(input.directory);
    if (documentFingerprint(sources) !== input.sourceFingerprint) throw contractError('INVALID_IDENTITY_BASIS', '원본 문서가 변경됐습니다. 문서 확인부터 다시 진행하세요.', []);
    return sources;
  }

  /** 과거 모델의 판단 대신 현재 문서에 다시 검증한 인물 원본 사본만 재사용한다. */
  async #savedIdentity(state: ReviewState, sources: DocumentSources, bindings: DocumentBindings): Promise<SavedIdentityPreview | null> {
    if (state.status !== 'completed' || state.sourceFingerprint !== documentFingerprint(sources)) return null;
    const stored: StoredReviewInput = StoredReviewInputSchema.parse(JSON.parse(await this.#fs.readText(this.#fs.path('requests', `${state.id}.input.json`))) as unknown);
    if (documentReviewBasis(stored) !== state.basisHash || stored.input.sourceFingerprint !== state.sourceFingerprint) {
      throw contractError('INVALID_DOCUMENT_REVIEW_RECORD', `${state.id}: 저장된 검토 입력과 완료 기록의 기준이 다릅니다.`, []);
    }
    if (stored.input.identityEvidence === undefined) return null;
    const evidence = stored.input.identityEvidence;
    return { reviewId: state.id, evidence, matches: verifyIdentityEvidence(sources, bindings, evidence) };
  }

  async findSavedIdentity(input: IdentityBasis): Promise<SavedIdentityPreview | null> {
    this.#healthy();
    const sources: DocumentSources = await this.#identitySources(input);
    const states: ReviewState[] = [];
    for (const entry of await this.#fs.entries(this.#fs.path('requests'))) {
      if (!entry.name.endsWith('.terminal.json')) continue;
      const state: ReviewState = await this.read(z.uuid().parse(entry.name.slice(0, -'.terminal.json'.length)));
      if (state.status === 'completed' && state.sourceFingerprint === input.sourceFingerprint) states.push(state);
    }
    for (const state of states.sort((a: ReviewState, b: ReviewState): number => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id))) {
      const result: SavedIdentityPreview | null = await this.#savedIdentity(state, sources, input.bindings);
      if (result !== null) return result;
    }
    return null;
  }

  async validateSavedIdentity(id: string, input: IdentityBasis): Promise<SavedIdentityPreview> {
    const result: SavedIdentityPreview | null = await this.#savedIdentity(await this.read(id), await this.#identitySources(input), input.bindings);
    if (result === null) throw contractError('SAVED_IDENTITY_NOT_AVAILABLE', `${id}: 현재 문서에 재사용할 검증된 인물 원본이 없습니다. 보충 파일을 지정하세요.`, []);
    return result;
  }

  async #withStartLock(operation: () => Promise<ReviewState>): Promise<ReviewState> {
    this.#healthy();
    if (this.#closing) throw contractError('DOCUMENT_REVIEW_UNAVAILABLE', '문서 검토 서비스를 종료 중입니다.', []);
    if (this.#starting) throw contractError('DOCUMENT_REVIEW_BUSY', '다른 문서 검토를 준비 중입니다. 잠시 후 다시 실행하세요.', []);
    this.#starting = true;
    try { return await operation(); } finally { this.#starting = false; }
  }

  async #prepare(value: DocumentReviewInput): Promise<PreparedReview> {
    const input: DocumentReviewInput = DocumentReviewInputSchema.parse(value);
    const directory: string = await realpath(input.directory);
    const sources: DocumentSources = await readDocumentSources(directory);
    if (documentFingerprint(sources) !== input.sourceFingerprint) throw contractError('INVALID_DOCUMENT_FINGERPRINT', '검토 이후 문서가 변경되었습니다. 문서 확인 단계부터 다시 실행하세요.', []);
    const preset: ProductionPreset | null = input.presetId === null ? null : (await this.presets()).find((item: ProductionPreset): boolean => item.id === input.presetId) ?? null;
    if (input.presetId !== null && preset === null) throw contractError('INVALID_DOCUMENT_REVIEW_PRESET', '선택한 제작 프리셋이 없습니다. 다시 선택하세요.', []);
    const stored: StoredReviewInput = { input: { ...input, directory }, preset };
    return { stored, sources, basisHash: documentReviewBasis(stored) };
  }

  async #running(): Promise<ReviewState | null> {
    if (this.#active === null) return null;
    const active: ActiveReview = this.#active;
    const current: ReviewState = await this.read(active.id);
    if (current.status === 'running') return current;
    await active.promise; this.#healthy();
    return null;
  }

  async start(value: DocumentReviewInput): Promise<ReviewState> {
    return this.#withStartLock(async (): Promise<ReviewState> => {
      const prepared: PreparedReview = await this.#prepare(value);
      const current: ReviewState | null = await this.#running();
      if (current !== null) {
        if (current.basisHash === prepared.basisHash) return current;
        throw contractError('DOCUMENT_REVIEW_BUSY', '다른 문서를 검토 중입니다. 완료 후 실행하거나 진행 중인 검토를 취소하세요.', []);
      }
      return this.#create(randomUUID(), prepared);
    });
  }

  /** 접수 전에 보관한 ID를 재사용한다. 같은 입력은 저장된 상태를 반환하고 새 모델 실행을 만들지 않는다. */
  async startIdentified(id: string, value: DocumentReviewInput): Promise<ReviewState> {
    z.uuid().parse(id);
    return this.#withStartLock(async (): Promise<ReviewState> => {
      const prepared: PreparedReview = await this.#prepare(value);
      const state: ReviewState | null = await this.#readExisting(id);
      const inputPath: string = this.#fs.path('requests', `${id}.input.json`);
      const snapshotsPath: string = this.#fs.path('requests', `${id}.snapshots.json`);
      const hasInput: boolean = await this.#fs.exists(inputPath);
      const hasSnapshots: boolean = await this.#fs.exists(snapshotsPath);
      if (state !== null) {
        if (!hasInput || !hasSnapshots) throw contractError('DOCUMENT_REVIEW_START_INCOMPLETE', `${id}: 검토 입력 또는 원본 사본이 없습니다. 저장 기록을 보존하고 확인하세요.`, []);
        const stored: StoredReviewInput = StoredReviewInputSchema.parse(JSON.parse(await this.#fs.readText(inputPath)) as unknown);
        const sources: DocumentSources = z.record(z.enum(DOCUMENT_FILES.map((file) => file.key)), SnapshotSchema).parse(JSON.parse(await this.#fs.readText(snapshotsPath)) as unknown);
        if (documentReviewBasis(stored) !== state.basisHash || stored.input.sourceFingerprint !== state.sourceFingerprint || documentFingerprint(sources) !== state.sourceFingerprint) {
          throw contractError('INVALID_DOCUMENT_REVIEW_RECORD', `${id}: 저장된 입력·원본 사본·요청 기준이 다릅니다. 기록을 확인하세요.`, []);
        }
        if (state.basisHash !== prepared.basisHash) throw contractError('DOCUMENT_REVIEW_ID_CONFLICT', `${id}: 같은 요청 ID에 다른 입력을 보낼 수 없습니다. 현재 값으로 새 검토를 시작하세요.`, []);
        return state;
      }
      if (hasInput || hasSnapshots) throw contractError('DOCUMENT_REVIEW_START_INCOMPLETE', `${id}: 검토 접수 기록이 불완전합니다. 기존 파일을 보존하고 저장 기록을 확인하세요.`, []);
      if (await this.#running() !== null) throw contractError('DOCUMENT_REVIEW_BUSY', '다른 요청을 검토 중입니다. 기존 검토에 다시 연결하거나 완료 후 재전송하세요.', []);
      return this.#create(id, prepared);
    });
  }

  async #create(id: string, prepared: PreparedReview): Promise<ReviewState> {
    const { stored, sources, basisHash } = prepared;
    const input: DocumentReviewInput = stored.input;
    const preview = inspectDocuments(sources, input.bindings).preview;
    const prompt: string = documentReviewPrompt(sources, preview, stored);
    if (Buffer.byteLength(prompt) > 2 * 1024 * 1024) throw contractError('DOCUMENT_REVIEW_INPUT_TOO_LARGE', '자동 검토 입력은 2MB 이하여야 합니다.', []);
    const now: string = new Date().toISOString();
    const state: ReviewState = { id, basisHash, sourceFingerprint: input.sourceFingerprint, createdAt: now, updatedAt: now, status: 'running', model: null, result: null, error: null };
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
  }

  async #execute(state: ReviewState, stored: StoredReviewInput, sources: DocumentSources, prompt: string, signal: AbortSignal): Promise<void> {
    let terminal: ReviewState;
    try {
      const generated: ReviewEngineResult = await this.#engine.run(prompt, signal);
      if (signal.aborted) throw contractError('DOCUMENT_REVIEW_CANCELLED', '문서 자동 검토를 취소했습니다.', []);
      if (stored.input.identityEvidence !== undefined) verifyIdentityEvidence(sources, stored.input.bindings, stored.input.identityEvidence);
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

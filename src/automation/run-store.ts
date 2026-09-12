import { assertSpeechRetakeIntent } from './speech-retake.js';
import { assertReferenceRetakeIntent, referenceRetakeSegments } from './reference-retake.js';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { RequestLockManager } from '../codex/request-lock.js';
import type { RequestLock } from '../codex/request-lock.js';
import { contractError } from '../domain/errors.js';
import { HashSchema } from '../domain/schema.js';
import type { Project } from '../domain/schema.js';
import { sha256Text } from '../importers/integrity.js';
import { parseProject } from '../io/project.js';
import { stableJsonStringify } from '../io/stable-json.js';
import { SafeStoreFilesystem } from '../server/safe-filesystem.js';
import { automaticHash } from './application-evidence.js';
import { AutomationRunCreatedSchema, AutomationRunEventSchema } from './run-schema.js';
import type { AutomationRun, AutomationRunCreated, AutomationRunEvent } from './run-schema.js';
import { createAutomationRun, reduceAutomationRun, runTerminal } from './run-state.js';

const RunEnvelopeSchema = z.strictObject({ version: z.literal(1), runId: z.uuid(), sequence: z.number().int().nonnegative(), previousHash: HashSchema.nullable(), event: AutomationRunEventSchema });
const RunHeadSchema = z.strictObject({ sequence: z.number().int().nonnegative(), hash: HashSchema });
export type AutomationRunSnapshot = { sequence: number; hash: string; run: AutomationRun };
export type AutomationRunStoreFault = (point: 'after-event' | 'after-head') => Promise<void>;
const MAX_EVENT_BYTES: number = 2 * 1024 * 1024;
const MAX_PROJECT_BYTES: number = 64 * 1024 * 1024;
const MAX_RUN_EVENTS: number = 100000;
const EVENT_READ_BATCH: number = 8;

/** 실행 이벤트는 덮어쓰지 않고 이전 해시와 결속한다. HEAD 게시 중단은 연속 이벤트로만 복구한다. */
export class AutomationRunStore {
  readonly #fs: SafeStoreFilesystem;
  readonly #locks: RequestLockManager;
  readonly #fault: AutomationRunStoreFault;
  #ready: boolean = false;

  constructor(root: string, fault: AutomationRunStoreFault) {
    this.#fs = new SafeStoreFilesystem(root); this.#fault = fault;
    this.#locks = new RequestLockManager(this.#fs, async (_original, assertOwnership): Promise<void> => { await assertOwnership(); });
  }

  async initialize(): Promise<void> {
    await this.#fs.initialize();
    for (const name of ['.locks', '.recovery-claims', 'runs', 'creating']) await this.#fs.ensureDirectory(this.#fs.path(name));
    this.#ready = true;
  }
  #check(id: string): void {
    z.uuid().parse(id);
    if (!this.#ready) throw contractError('AUTOMATION_STORE_NOT_INITIALIZED', '자동 실행 저장소를 먼저 초기화하세요.', []);
  }
  #eventFile(sequence: number): string { return `${String(sequence).padStart(9, '0')}.json`; }
  async #json(path: string, maxBytes: number): Promise<unknown> {
    const size: number = (await this.#fs.fileMetadata(path)).size;
    if (size <= 0 || size > maxBytes) throw contractError('AUTOMATION_RUN_FILE_SIZE', `자동 실행 저장 파일 크기가 허용 범위를 벗어났습니다: path=${path}, bytes=${size}`, []);
    const bytes = await this.#fs.read(path);
    if (bytes.length !== size) throw contractError('AUTOMATION_RUN_FILE_CHANGED', `자동 실행 파일을 읽는 중 크기가 바뀌었습니다: ${path}`, []);
    return JSON.parse(bytes.toString('utf8')) as unknown;
  }
  async #head(id: string, snapshot: AutomationRunSnapshot): Promise<void> {
    const directory = this.#fs.path('runs', id);
    const temporary = this.#fs.path('runs', id, `.head-${randomUUID()}.tmp`);
    await this.#fs.writeExclusive(temporary, stableJsonStringify({ sequence: snapshot.sequence, hash: snapshot.hash }));
    await this.#fs.replaceFile(temporary, this.#fs.path('runs', id, 'head.json'));
    await this.#fs.syncDirectory(directory);
  }
  async #read(id: string): Promise<AutomationRunSnapshot> {
    const directory = this.#fs.path('runs', id);
    const head = RunHeadSchema.parse(await this.#json(this.#fs.path('runs', id, 'head.json'), MAX_EVENT_BYTES));
    const entries = (await this.#fs.entries(directory)).filter((entry): boolean => /^[0-9]{9}\.json$/u.test(entry.name)).sort((left, right): number => left.name.localeCompare(right.name));
    if (entries.length === 0 || entries.length > MAX_RUN_EVENTS || head.sequence >= entries.length) throw contractError('AUTOMATION_RUN_HISTORY_MISSING', `자동 실행 HEAD 또는 이력이 사라졌습니다. 기존 파일을 보존하세요: ${id}`, []);
    let snapshot: AutomationRunSnapshot | null = null;
    for (let offset: number = 0; offset < entries.length; offset += EVENT_READ_BATCH) {
      // 독립 파일 읽기만 제한 병렬화한다. 해시·순번·상태 전이는 원래 순서대로 모두 검사한다.
      const envelopes = await Promise.all(entries.slice(offset, offset + EVENT_READ_BATCH).map(async (entry, index) => {
        const sequence: number = offset + index;
        if (entry.name !== this.#eventFile(sequence)) throw contractError('AUTOMATION_RUN_HISTORY_GAP', `자동 실행 이벤트 순서에 공백이 있습니다: runId=${id}, sequence=${sequence}`, []);
        return RunEnvelopeSchema.parse(await this.#json(this.#fs.path('runs', id, entry.name), MAX_EVENT_BYTES));
      }));
      for (const [index, envelope] of envelopes.entries()) {
        const sequence: number = offset + index;
        if (envelope.runId !== id || envelope.sequence !== sequence || envelope.previousHash !== (snapshot?.hash ?? null)) throw contractError('AUTOMATION_RUN_HISTORY_HASH', `자동 실행 이벤트의 ID·순서·연결 해시가 다릅니다: runId=${id}, sequence=${sequence}`, []);
        if (sequence === 0 && (envelope.event.type !== 'created' || envelope.event.id !== id)) throw contractError('AUTOMATION_RUN_HISTORY_HASH', `자동 실행 시작 이벤트가 다릅니다: ${id}`, []);
        const run: AutomationRun = snapshot === null ? createAutomationRun(AutomationRunCreatedSchema.parse(envelope.event)) : reduceAutomationRun(snapshot.run, envelope.event);
        snapshot = { sequence, hash: automaticHash(envelope), run };
        if (head.sequence === sequence && head.hash !== snapshot.hash) throw contractError('AUTOMATION_RUN_HISTORY_HASH', `자동 실행 HEAD의 해시가 다릅니다: ${id}`, []);
      }
    }
    if (snapshot === null) throw contractError('AUTOMATION_RUN_HISTORY_MISSING', `자동 실행 이력을 찾을 수 없습니다: ${id}`, []);
    if (snapshot.sequence > head.sequence) await this.#head(id, snapshot);
    return snapshot;
  }

  async read(id: string): Promise<AutomationRunSnapshot> {
    this.#check(id); const lock = await this.#locks.acquire(sha256Text(`run:${id}`));
    try { return await this.#read(id); } finally { await this.#locks.release(lock); }
  }

  /** 모델 실행 동안에는 별도 Worker 소유권만 보유하고 Project·이벤트 Lock은 짧게 획득한다. */
  async withWorker(id: string, operation: (assertOwnership: () => Promise<void>) => Promise<AutomationRunSnapshot>): Promise<AutomationRunSnapshot> {
    this.#check(id);
    const lock = await this.#locks.acquire(sha256Text(`worker:${id}`));
    try { return await operation(async (): Promise<void> => { await this.#locks.verify(lock); }); }
    finally { await this.#locks.release(lock); }
  }

  async list(): Promise<AutomationRunSnapshot[]> {
    if (!this.#ready) throw contractError('AUTOMATION_STORE_NOT_INITIALIZED', '자동 실행 저장소를 먼저 초기화하세요.', []);
    const result: AutomationRunSnapshot[] = [];
    for (const entry of await this.#fs.entries(this.#fs.path('runs'))) result.push(await this.read(z.uuid().parse(entry.name)));
    return result.sort((left, right): number => right.run.createdAt.localeCompare(left.run.createdAt) || left.run.id.localeCompare(right.run.id));
  }

  async create(input: AutomationRunCreated, inputProject: Project): Promise<AutomationRunSnapshot> {
    const event = AutomationRunCreatedSchema.parse(input); this.#check(event.id);
    const project = parseProject(structuredClone(inputProject));
    if (event.projectId !== project.projectId || event.revision !== project.revision || event.projectHash !== automaticHash(project)
      || event.segmentIds.some((id): boolean => !project.dataset.segments.some((segment): boolean => segment.id === id))) throw contractError('AUTOMATION_RUN_INPUT', '자동 실행의 시작 Snapshot과 선택 구간이 현재 프로젝트와 다릅니다.', []);
    if (event.purpose?.kind === 'speech-retake') {
      const cue = assertSpeechRetakeIntent(project, event.purpose);
      const unit = project.dataset.units.find((value): boolean => value.id === cue.unitId)!;
      if (event.segmentIds.length !== 1 || event.segmentIds[0] !== unit.segmentId) throw contractError('AUTOMATION_RUN_INPUT', '선택 발화의 원본 구간만 재생성 실행 범위에 포함하세요.', []);
    }
    if (event.purpose?.kind === 'reference-retake') {
      assertReferenceRetakeIntent(project, event.purpose);
      if (automaticHash([...event.segmentIds].sort()) !== automaticHash(referenceRetakeSegments(project, event.purpose.resourceId).sort())) throw contractError('AUTOMATION_RUN_INPUT', '선택 기준 이미지를 사용하는 모든 구간을 재생성 영향 범위에 포함하세요.', []);
    }
    const content = stableJsonStringify(project);
    if (Buffer.byteLength(content) > MAX_PROJECT_BYTES) throw contractError('AUTOMATION_RUN_FILE_SIZE', '자동 실행의 시작 프로젝트 Snapshot은 64MB 이하여야 합니다.', []);
    const run = createAutomationRun(event);
    const lock = await this.#locks.acquire(sha256Text(`project:${project.projectId}`));
    let runLock: RequestLock | null = null;
    try {
      if ((await this.list()).some((value): boolean => value.run.projectId === project.projectId && !runTerminal(value.run))) throw contractError('AUTOMATION_RUN_ACTIVE', `이 프로젝트의 이전 자동 실행을 이어가거나 취소하세요: ${project.projectId}`, []);
      runLock = await this.#locks.acquire(sha256Text(`run:${event.id}`));
      const directory = this.#fs.path('creating', event.id);
      if (await this.#fs.exists(directory) || await this.#fs.exists(this.#fs.path('runs', event.id))) throw contractError('AUTOMATION_RUN_EXISTS', `이미 존재하거나 생성이 중단된 실행 ID입니다: ${event.id}`, []);
      const envelope = RunEnvelopeSchema.parse({ version: 1, runId: event.id, sequence: 0, previousHash: null, event });
      const snapshot = { sequence: 0, hash: automaticHash(envelope), run };
      await this.#fs.ensureDirectory(directory);
      await this.#fs.writeExclusive(this.#fs.path('creating', event.id, 'project.json'), content);
      await this.#fs.writeExclusive(this.#fs.path('creating', event.id, this.#eventFile(0)), stableJsonStringify(envelope));
      await this.#fs.writeExclusive(this.#fs.path('creating', event.id, 'head.json'), stableJsonStringify({ sequence: 0, hash: snapshot.hash }));
      await this.#fs.syncDirectory(directory);
      await this.#locks.verify(lock);
      await this.#fs.renameNewDirectory(directory, this.#fs.path('runs', event.id));
      await this.#fs.syncDirectory(this.#fs.path('runs')); await this.#fs.syncDirectory(this.#fs.path('creating'));
      return snapshot;
    } finally {
      try { if (runLock !== null) await this.#locks.release(runLock); }
      finally { await this.#locks.release(lock); }
    }
  }

  async initialProject(id: string): Promise<Project> {
    const snapshot = await this.read(id);
    const input: unknown = await this.#json(this.#fs.path('runs', id, 'project.json'), MAX_PROJECT_BYTES);
    if (automaticHash(input) !== snapshot.run.initialProjectHash) throw contractError('AUTOMATION_RUN_INPUT', `저장된 시작 Snapshot이 변경됐습니다: ${id}`, []);
    const project = parseProject(input);
    if (project.projectId !== snapshot.run.projectId || project.revision !== snapshot.run.initialRevision) throw contractError('AUTOMATION_RUN_INPUT', `저장된 시작 Snapshot의 Project·revision이 다릅니다: ${id}`, []);
    return project;
  }

  async append(id: string, expectedSequence: number, rawEvent: AutomationRunEvent): Promise<AutomationRunSnapshot> {
    this.#check(id); z.number().int().nonnegative().parse(expectedSequence);
    const event = AutomationRunEventSchema.parse(rawEvent);
    const lock = await this.#locks.acquire(sha256Text(`run:${id}`));
    try {
      const current = await this.#read(id);
      if (current.sequence !== expectedSequence) throw contractError('AUTOMATION_RUN_REVISION_CONFLICT', `자동 실행 상태가 바뀌었습니다: runId=${id}, expected=${expectedSequence}, actual=${current.sequence}`, []);
      if (current.sequence + 1 >= MAX_RUN_EVENTS) throw contractError('AUTOMATION_RUN_EVENT_BUDGET', '자동 실행 이력 개수 한도에 도달했습니다.', []);
      const run = reduceAutomationRun(current.run, event);
      const envelope = RunEnvelopeSchema.parse({ version: 1, runId: id, sequence: current.sequence + 1, previousHash: current.hash, event });
      const content = stableJsonStringify(envelope);
      if (Buffer.byteLength(content) > MAX_EVENT_BYTES) throw contractError('AUTOMATION_RUN_FILE_SIZE', '자동 실행 이벤트는 2MB 이하여야 합니다.', []);
      await this.#locks.verify(lock);
      await this.#fs.publishExclusiveFileWithIdentity(this.#fs.path('runs', id, this.#eventFile(envelope.sequence)), content, randomUUID());
      await this.#fault('after-event');
      const snapshot = { sequence: envelope.sequence, hash: automaticHash(envelope), run };
      await this.#head(id, snapshot); await this.#fault('after-head');
      return snapshot;
    } finally { await this.#locks.release(lock); }
  }
}

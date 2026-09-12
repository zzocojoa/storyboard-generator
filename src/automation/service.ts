import { automationAudioProduction } from './run-schema.js';
import { assertSpeakerVoices } from '../domain/speech-voice.js';
import type { InstalledSpeechVoice } from '../domain/speech-voice.js';
import { randomUUID } from 'node:crypto';
import { sameGenerationBuild } from '../build-fingerprint.js';
import { contractError } from '../domain/errors.js';
import { stableJsonStringify } from '../io/stable-json.js';
import type { AutomationDiskReport } from './disk-space-schema.js';
import { automaticHash } from './application-evidence.js';
import { AutomationRunExecutor } from './run-executor.js';
import type { AutomationRunExecutionServices } from './run-executor.js';
import { automationSpeakerVoices, AutomationSettingsSchema } from './run-schema.js';
import type { AutomationSettings } from './run-schema.js';
import { runTerminal } from './run-state.js';
import { requiredAutomationSpeechVoices } from './speech-settings.js';
import type { AutomationRunSnapshot } from './run-store.js';
import { automationView } from './run-view.js';
import type { AutomationView } from './run-view.js';
import { createSpeechRetakeIntent } from './speech-retake.js';
import type { SpeechRetakeInput } from './speech-retake-schema.js';

type ActiveExecution = { controller: AbortController; finished: Promise<void> };
type ServiceProblem = NonNullable<AutomationView['serviceError']>;
export type AutomationServiceOptions = { listSpeechVoices?: () => Promise<InstalledSpeechVoice[]>; services: AutomationRunExecutionServices; onError: (id: string, problem: ServiceProblem) => void };
function problemFor(error: unknown): ServiceProblem {
  return { code: error instanceof Error && 'code' in error && typeof error.code === 'string' ? error.code : 'AUTOMATION_SERVICE_FAILED',
    message: error instanceof Error ? error.message : String(error) };
}
function stoppedSignal(): AbortSignal { const controller = new AbortController(); controller.abort(); return controller.signal; }

/** HTTP 응답 수명과 생성 작업을 분리한다. 중단 요청은 Worker 종료를 기다린 뒤 이력을 변경한다. */
export class AutomationService {
  readonly #options: AutomationServiceOptions;
  readonly #executor: AutomationRunExecutor;
  readonly #active: Map<string, ActiveExecution> = new Map();
  readonly #progress: Map<string, string> = new Map();
  readonly #errors: Map<string, ServiceProblem> = new Map();
  readonly #controls: Set<string> = new Set();
  #closed: boolean = false;

  constructor(options: AutomationServiceOptions) {
    this.#options = options;
    this.#executor = new AutomationRunExecutor({ ...options.services, onProgress: async (id, jobId, progress): Promise<void> => {
      this.#progress.set(id, progress.message); await options.services.onProgress(id, jobId, progress);
    } });
  }
  async initialize(): Promise<void> {
    await this.#options.services.runs.initialize(); await this.#options.services.applications.initialize(); await this.#options.services.speechCache.initialize();
    // 재시작은 새 생성 호출을 시작하지 않는다. 실제 Commit만 정산하고 사용자가 재개한다.
    for (const snapshot of await this.#options.services.runs.list()) {
      if (runTerminal(snapshot.run)) continue;
      try { await this.#executor.run(snapshot.run.id, stoppedSignal()); }
      catch (error: unknown) { this.#recordError(snapshot.run.id, error); }
    }
  }
  #recordError(id: string, error: unknown): void { const problem = problemFor(error); this.#errors.set(id, problem); this.#options.onError(id, problem); }
  #assertOpen(): void { if (this.#closed) throw contractError('AUTOMATION_SERVICE_CLOSED', '자동 제작 서비스가 종료 중입니다. 서버를 다시 실행하세요.', []); }
  #view(snapshot: AutomationRunSnapshot): AutomationView {
    return automationView(snapshot.run, this.#active.has(snapshot.run.id), this.#progress.get(snapshot.run.id) ?? null, this.#errors.get(snapshot.run.id) ?? null);
  }
  async list(projectId: string): Promise<AutomationView[]> {
    return (await this.#options.services.runs.list()).filter((snapshot): boolean => snapshot.run.projectId === projectId).map((snapshot): AutomationView => this.#view(snapshot));
  }
  async speechVoices(): Promise<InstalledSpeechVoice[]> {
    this.#assertOpen();
    if (this.#options.listSpeechVoices === undefined) throw contractError('AUTOMATION_SPEECH_CATALOG_UNAVAILABLE', '설치 음성 목록을 조회하는 실행 환경이 연결되지 않았습니다. 서버의 로컬 음성 설정을 확인하세요.', []);
    return this.#options.listSpeechVoices();
  }
  async inspectStorage(projectId: string, maxStagedBytes: number): Promise<AutomationDiskReport> {
    this.#assertOpen(); await this.#options.services.projects.read(projectId);
    return this.#options.services.diskSpace.inspectGeneration(maxStagedBytes);
  }
  async read(projectId: string, id: string): Promise<AutomationView> {
    const snapshot = await this.#options.services.runs.read(id);
    if (snapshot.run.projectId !== projectId) throw contractError('AUTOMATION_RUN_PROJECT', '선택한 프로젝트의 자동 실행이 아닙니다.', []);
    return this.#view(snapshot);
  }
  #launch(id: string): void {
    this.#assertOpen();
    if (this.#active.has(id)) throw contractError('AUTOMATION_SERVICE_BUSY', '자동 실행이 이미 진행 중입니다.', []);
    this.#errors.delete(id); this.#progress.delete(id);
    const controller = new AbortController();
    const finished = this.#executor.run(id, controller.signal).then((): void => {}, (error: unknown): void => { this.#recordError(id, error); })
      .finally((): void => { this.#active.delete(id); this.#progress.delete(id); });
    this.#active.set(id, { controller, finished });
  }
  async start(projectId: string, expectedRevision: number, segmentIds: string[], settings: AutomationSettings): Promise<AutomationView> {
    this.#assertOpen();
    const options = AutomationSettingsSchema.parse(settings);
    await this.#options.services.projects.assertMutable(projectId);
    const project = await this.#options.services.projects.read(projectId);
    if (project.revision !== expectedRevision) throw contractError('REVISION_CONFLICT', `${projectId}: expected=${expectedRevision}, actual=${project.revision}`, []);
    if (automationAudioProduction(options) === 'guide-voice') assertSpeakerVoices(project, automationSpeakerVoices(options));
    const requiredVoices = requiredAutomationSpeechVoices(project, segmentIds, options);
    if (requiredVoices.length > 0 && this.#options.listSpeechVoices !== undefined) {
      const installed = await this.speechVoices();
      for (const voice of requiredVoices) {
        if (!installed.some((entry): boolean => entry.name === voice.name)) throw contractError('SPEECH_VOICE_NOT_INSTALLED', `설치 음성 목록에 없습니다: ${voice.name}. 음성 설정을 변경하거나 시스템에 설치한 뒤 다시 시작하세요.`, []);
      }
    }
    if (automaticHash(await this.#options.services.projects.read(projectId)) !== automaticHash(project)) throw contractError('REVISION_CONFLICT', '음성 설정을 확인하는 동안 프로젝트가 변경되었습니다. 현재 프로젝트에서 다시 시작하세요.', []);
    await this.#options.services.diskSpace.assertPreservation(Buffer.byteLength(stableJsonStringify(project)));
    const snapshot = await this.#options.services.runs.create({ type: 'created', id: randomUUID(), projectId, revision: project.revision, projectHash: automaticHash(project),
      segmentIds, settings: options, generatorBuild: this.#options.services.generatorBuild, at: new Date().toISOString() }, project);
    // Create 도중 서버 종료가 시작되어도 시작 이력은 남고 다음 시작에서 일시 중지된다.
    this.#launch(snapshot.run.id);
    return this.#view(snapshot);
  }
  async startSpeechRetake(projectId: string, expectedRevision: number, input: SpeechRetakeInput, settings: AutomationSettings): Promise<AutomationView> {
    this.#assertOpen();
    const options = AutomationSettingsSchema.parse(settings);
    await this.#options.services.projects.assertMutable(projectId);
    const project = await this.#options.services.projects.read(projectId);
    if (project.revision !== expectedRevision) throw contractError('REVISION_CONFLICT', `${projectId}: expected=${expectedRevision}, actual=${project.revision}`, []);
    const purpose = createSpeechRetakeIntent(project, input);
    const installed = await this.speechVoices();
    if (!installed.some((voice): boolean => voice.name === purpose.voice.name)) throw contractError('SPEECH_VOICE_NOT_INSTALLED', `설치 음성 목록에 없습니다: ${purpose.voice.name}`, []);
    if (purpose.previousAssetId !== null) await this.#options.services.projects.asset(projectId, purpose.previousAssetId);
    if (automaticHash(await this.#options.services.projects.read(projectId)) !== automaticHash(project)) throw contractError('REVISION_CONFLICT', '재생성 기준을 확인하는 동안 프로젝트가 변경되었습니다. 현재 결과에서 다시 요청하세요.', []);
    const cue = project.audioCues.find((value): boolean => value.id === purpose.cueId)!;
    const unit = project.dataset.units.find((value): boolean => value.id === cue.unitId)!;
    await this.#options.services.diskSpace.assertPreservation(Buffer.byteLength(stableJsonStringify(project)));
    const snapshot = await this.#options.services.runs.create({ type: 'created', id: randomUUID(), projectId, revision: project.revision, projectHash: automaticHash(project),
      segmentIds: [unit.segmentId], purpose, settings: options, generatorBuild: this.#options.services.generatorBuild, at: new Date().toISOString() }, project);
    this.#launch(snapshot.run.id);
    return this.#view(snapshot);
  }
  async #control(projectId: string, id: string, operation: () => Promise<void>): Promise<AutomationView> {
    this.#assertOpen(); await this.read(projectId, id);
    if (this.#controls.has(id)) throw contractError('AUTOMATION_SERVICE_BUSY', '이 실행의 중단·재개 처리가 진행 중입니다.', []);
    this.#controls.add(id);
    try { await operation(); return await this.read(projectId, id); } finally { this.#controls.delete(id); }
  }
  async #stop(id: string): Promise<void> {
    const active = this.#active.get(id);
    if (active !== undefined) { active.controller.abort(); await active.finished; }
    // 비정상 종료로 남은 실행도 Worker 소유권 아래에서 정산한다.
    await this.#executor.run(id, stoppedSignal());
  }
  async pause(projectId: string, id: string): Promise<AutomationView> {
    return this.#control(projectId, id, async (): Promise<void> => { await this.#stop(id); });
  }
  async cancel(projectId: string, id: string): Promise<AutomationView> {
    return this.#control(projectId, id, async (): Promise<void> => { await this.#stop(id); await this.#executor.cancel(id); this.#errors.delete(id); });
  }
  async resume(projectId: string, id: string): Promise<AutomationView> {
    return this.#control(projectId, id, async (): Promise<void> => {
      if (this.#active.has(id)) throw contractError('AUTOMATION_SERVICE_BUSY', '현재 실행이 끝나거나 중단될 때까지 기다리세요.', []);
      await this.#executor.run(id, stoppedSignal());
      const snapshot = await this.#options.services.runs.read(id);
      if (!sameGenerationBuild(snapshot.run.generatorBuild, this.#options.services.generatorBuild)) throw contractError('AUTOMATION_BUILD_CHANGED', '실행 당시의 생성 코드와 설정이 바뀌었습니다. 기존 실행을 취소하고 현재 결과에서 새 실행을 시작하세요.', []);
      await this.#options.services.projects.assertMutable(projectId);
      const project = await this.#options.services.projects.read(projectId);
      await this.#options.services.runs.append(id, snapshot.sequence, { type: 'resumed', revision: project.revision, projectHash: automaticHash(project), at: new Date(Math.max(Date.now(), Date.parse(snapshot.run.updatedAt))).toISOString() });
      this.#launch(id);
    });
  }
  async close(): Promise<void> {
    this.#closed = true;
    const active = [...this.#active.values()];
    for (const execution of active) execution.controller.abort();
    await Promise.all(active.map((execution): Promise<void> => execution.finished));
  }
}

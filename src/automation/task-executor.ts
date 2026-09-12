import { audioCuesInSegment } from '../domain/audio-source.js';
import { planAutomaticAudioInstructions } from './plan-audio-instructions.js';
import type { TextFontSource } from '../rendering/text-font-source.js';
import { tmpdir } from 'node:os';
import { readInstalledSpeechVoices } from '../codex/speech-voices.js';
import type { InstalledSpeechVoice } from '../domain/speech-voice.js';
import { planAutomaticVoiceCasting } from './plan-voice-casting.js';
import { resolvedAutomationSpeakerVoices } from './speech-settings.js';
import { automationAudioProduction } from './run-schema.js';
import { assertSpeakerVoices } from '../domain/speech-voice.js';
import { automationSpeakerVoices } from './run-schema.js';
import { planAutomaticAudioMix } from './plan-audio-mix.js';
import { CodexImageEngine } from '../codex/image-engine.js';
import type { ImageGenerationEngine } from '../codex/image-engine.js';
import { LocalSpeechEngine } from '../codex/speech-engine.js';
import type { SpeechGenerationEngine } from '../codex/speech-engine.js';
import { CodexStructuredEngine } from '../codex/structured-engine.js';
import type { StructuredGenerationEngine } from '../codex/structured-engine.js';
import { contractError } from '../domain/errors.js';
import { MAX_IMAGE_BYTES } from '../domain/media-inspection.js';
import type { Issue, Project } from '../domain/schema.js';
import type { ProjectStore } from '../server/store.js';
import { readSelectedTextFont } from '../rendering/text-font-source.js';
import { inspectAutomaticText, recordAutomaticTextReview } from './text-review.js';
import { automaticHash } from './application-evidence.js';
import { createAutomaticFrameBasis, generateAutomaticFrame } from './frame-image.js';
import type { LoadedReference } from './image-references.js';
import type { PlannedAssetWrite, StagedSpeech } from './plan-audio.js';
import { createSegmentPlanBasis } from './plan-basis.js';
import type { AutomaticPlanProvenance } from './plan-compiler.js';
import { planAutomaticProduction } from './plan-production.js';
import { planAutomaticTextLayout } from './plan-text-layout.js';
import type { ProductionPlanProgress } from './plan-production.js';
import { planAutomaticSegment } from './plan-segment.js';
import type { AutomaticPlanProgress } from './plan-segment.js';
import { planSourceRepair } from './plan-repair.js';
import { createSourceRepairBasis } from './repair-basis.js';
import { createProductionPlanBasis } from './production-basis.js';
import { createProductionReferenceBasis, generateAutomaticReference } from './production-reference.js';
import { automationDensity, AutomationSettingsSchema, AutomationTaskSchema } from './run-schema.js';
import { inspectStoryboardDensity, recordStoryboardDensityReview } from './density.js';
import type { AutomationSettings, AutomationTask } from './run-schema.js';
import { assertSpeechRetakeIntent, compileSpeechRetake } from './speech-retake.js';
import { stageSelectedSpeech } from './stage-speech.js';

export type AutomationEngines = { model: StructuredGenerationEngine; image: ImageGenerationEngine; speech: SpeechGenerationEngine; voiceCatalog?: (signal: AbortSignal) => Promise<InstalledSpeechVoice[]> };
export type AutomationRuntimePaths = { codexExecutable: string; sayExecutable: string; audioConvertExecutable: string };
export type AutomaticTaskCandidate = { project: Project; writes: PlannedAssetWrite[]; exceptions: Issue[] };
export type AutomaticTaskProgress = ProductionPlanProgress | AutomaticPlanProgress | { phase: 'image'; message: string };
export type AutomaticTaskServices = {
  store: ProjectStore; engines: AutomationEngines; textFontPath: TextFontSource;
  onProgress: (progress: AutomaticTaskProgress) => Promise<void>;
  onSpeechReady: (speech: StagedSpeech) => Promise<void>;
};
export type AutomaticTaskInput = {
  project: Project; task: AutomationTask; settings: AutomationSettings; remainingBytes: number;
  provenance: Omit<AutomaticPlanProvenance, 'model' | 'turnId' | 'prompt'>;
};

/** 실행에서 고정한 모델과 남은 시간을 실제 App Server·로컬 음성 엔진에 전달한다. */
export function createAutomationEngines(paths: AutomationRuntimePaths, settings: AutomationSettings, remainingMs: number): AutomationEngines {
  AutomationSettingsSchema.parse(settings);
  if (!Number.isSafeInteger(remainingMs) || remainingMs <= 0 || remainingMs > settings.maxActiveMs) throw contractError('AUTOMATION_TIME_BUDGET', `유효한 남은 실행 시간이 필요합니다: remainingMs=${remainingMs}`, []);
  return { voiceCatalog: async (signal): Promise<InstalledSpeechVoice[]> => readInstalledSpeechVoices(paths.sayExecutable, tmpdir(), AbortSignal.any([signal, AbortSignal.timeout(Math.min(5000, remainingMs))])),
    model: new CodexStructuredEngine({ executable: paths.codexExecutable, model: settings.model, timeoutMs: remainingMs }),
    image: new CodexImageEngine({ executable: paths.codexExecutable, model: settings.model, timeoutMs: remainingMs }),
    speech: new LocalSpeechEngine({ sayExecutable: paths.sayExecutable, convertExecutable: paths.audioConvertExecutable, timeoutMs: remainingMs }) };
}

async function loadReferences(store: ProjectStore, projectId: string, ids: readonly string[], signal: AbortSignal): Promise<LoadedReference[]> {
  const references: LoadedReference[] = [];
  for (const assetId of ids) {
    if (signal.aborted) throw contractError('AUTOMATION_CANCELLED', '기준 이미지 로드가 중단되었습니다.', []);
    const loaded = await store.asset(projectId, assetId);
    if (references.reduce((sum, reference): number => sum + reference.bytes.length, loaded.content.length) > MAX_IMAGE_BYTES) throw contractError('CODEX_IMAGE_REFERENCES_LIMIT', '선택 기준 이미지의 바이트 합계가 20MB를 초과했습니다.', []);
    references.push({ assetId, bytes: loaded.content });
  }
  return references;
}

/** 실제 저장 자산을 검증하며 작업 종류별 후보를 만든다. 원자 게시와 실행 이력은 실행 관리자가 담당한다. */
export async function executeAutomaticTask(input: AutomaticTaskInput, services: AutomaticTaskServices, signal: AbortSignal): Promise<AutomaticTaskCandidate> {
  const project: Project = structuredClone(input.project);
  const task: AutomationTask = AutomationTaskSchema.parse(input.task);
  const settings: AutomationSettings = AutomationSettingsSchema.parse(input.settings);
  if (automationAudioProduction(settings) === 'guide-voice') assertSpeakerVoices(project, automationSpeakerVoices(settings));
  const provenance = structuredClone(input.provenance);
  const remainingBytes: number = input.remainingBytes;
  if (!Number.isSafeInteger(remainingBytes) || remainingBytes < 0 || remainingBytes > settings.maxStagedBytes) throw contractError('AUTOMATION_STAGING_BUDGET', '남은 자동 제작 저장 예산이 유효하지 않습니다.', []);
  if (signal.aborted) throw contractError('AUTOMATION_CANCELLED', '자동 제작 작업이 중단되었습니다.', []);
  if (automaticHash(await services.store.read(project.projectId)) !== automaticHash(project)) throw contractError('AUTOMATION_STALE_PLAN', '작업을 시작하기 전에 프로젝트가 변경되었습니다.', []);
  let candidate: AutomaticTaskCandidate;
  switch (task.kind) {
    case 'audio-instructions': {
      candidate = { project: await planAutomaticAudioInstructions(project, task.segmentId, { provenance, maxCorrections: settings.maxModelCorrections },
        { model: services.engines.model, onProgress: services.onProgress }, signal), writes: [], exceptions: [] };
      break;
    }
    case 'speech-retake': {
      const cue = assertSpeechRetakeIntent(project, task);
      if (services.engines.voiceCatalog === undefined) throw contractError('AUTOMATION_VOICE_CATALOG_UNAVAILABLE', '발화 재생성에 설치 음성 목록 조회가 필요합니다.', []);
      const catalog = await services.engines.voiceCatalog(signal);
      if (!catalog.some((voice): boolean => voice.name === task.voice.name)) throw contractError('SPEECH_VOICE_NOT_INSTALLED', `설치 음성 목록에 없습니다: ${task.voice.name}`, []);
      const previous = cue.assetId === null ? null : { cueId: cue.id, assetId: cue.assetId, bytes: (await services.store.asset(project.projectId, cue.assetId)).content };
      await services.onProgress({ phase: 'speech', completed: 0, total: 1, attempt: 0, message: `${cue.id}: 선택한 발화만 새 음성으로 생성` });
      const speech = await stageSelectedSpeech(project, cue, task.voice, task.pronunciation, Math.min(remainingBytes, 512 * 1024 * 1024),
        { speech: services.engines.speech, onProgress: services.onProgress, onSpeechReady: services.onSpeechReady }, signal);
      candidate = compileSpeechRetake(project, task, speech, previous, provenance);
      if (cue.assetId !== null) await services.store.asset(project.projectId, cue.assetId);
      break;
    }
    case 'voice-casting': {
      if (services.engines.voiceCatalog === undefined) throw contractError('AUTOMATION_VOICE_CATALOG_UNAVAILABLE', '자동 음성 배정에 설치 목록 조회 연결이 필요합니다.', []);
      candidate = { project: await planAutomaticVoiceCasting(project, task.segmentIds, settings, provenance, { model: services.engines.model, catalog: services.engines.voiceCatalog, onProgress: services.onProgress }, signal), writes: [], exceptions: [] };
      break;
    }
    case 'audio-mix': {
      if (!('audioMixPlanning' in settings) || settings.audioMixPlanning !== 'automatic') throw contractError('AUTOMATION_AUDIO_MIX_NOT_SELECTED', '이 실행에는 음량 자동 계획이 선택되지 않았습니다.', []);
      const result = await planAutomaticAudioMix(project, task.segmentId, { provenance, maxCorrections: settings.maxModelCorrections },
        { model: services.engines.model, onProgress: services.onProgress, loadAudio: async (assetId, audioSignal): Promise<Buffer> => {
          if (audioSignal.aborted) throw contractError('AUTOMATION_CANCELLED', '음량 분석 파일 로드가 중단되었습니다.', []);
          return (await services.store.asset(project.projectId, assetId)).content;
        } }, signal);
      candidate = { ...result, writes: [] }; break;
    }
    case 'text-layout': {
      if (!('textLayoutPlanning' in settings) || settings.textLayoutPlanning !== 'automatic') throw contractError('AUTOMATION_TEXT_LAYOUT_NOT_SELECTED', '이 실행에는 글자 배치 자동 계획이 선택되지 않았습니다.', []);
      candidate = { project: await planAutomaticTextLayout(project, { provenance, maxCorrections: settings.maxModelCorrections },
        { model: services.engines.model, fontPath: services.textFontPath, onProgress: services.onProgress }, signal), writes: [], exceptions: [] };
      break;
    }
    case 'production': {
      const result = await planAutomaticProduction(project, createProductionPlanBasis(project, task.segmentIds), { provenance, maxCorrections: settings.maxModelCorrections }, { model: services.engines.model, onProgress: services.onProgress }, signal);
      candidate = { project: result.project, writes: [], exceptions: [] };
      break;
    }
    case 'reference': {
      if (remainingBytes < MAX_IMAGE_BYTES) throw contractError('AUTOMATION_STAGING_BUDGET', '기준 이미지 한 장의 최대 바이트를 수용할 저장 예산이 필요합니다.', []);
      const basis = createProductionReferenceBasis(project, task.resourceId);
      const references = await loadReferences(services.store, project.projectId, basis.referenceAssetIds, signal);
      await services.onProgress({ phase: 'image', message: `${task.resourceId}: 제작 기준 이미지 생성` });
      const result = await generateAutomaticReference(project, basis, references, provenance, services.engines.image, signal);
      candidate = { ...result, exceptions: [] };
      break;
    }
    case 'segment': {
      if (remainingBytes < 1) throw contractError('AUTOMATION_STAGING_BUDGET', '구간 계획과 가이드 음성을 준비할 저장 예산이 없습니다.', []);
      const result = await planAutomaticSegment(project, createSegmentPlanBasis(project, task.segmentId, task.replaceShotIds), {
        provenance, audioProduction: automationAudioProduction(settings), voice: settings.voice, speakerVoices: resolvedAutomationSpeakerVoices(project, [task.segmentId], settings), density: automationDensity(settings), maxCorrections: settings.maxModelCorrections, maxFrames: settings.maxFramesPerSegment, maxStagedAudioBytes: Math.min(remainingBytes, 512 * 1024 * 1024),
      }, { textFontPath: services.textFontPath, model: services.engines.model, speech: services.engines.speech, onProgress: services.onProgress, onSpeechReady: services.onSpeechReady,
        loadExistingAudio: async (assetId, audioSignal): Promise<Buffer> => {
          if (audioSignal.aborted) throw contractError('AUTOMATION_CANCELLED', '기존 음원 확인이 중단되었습니다.', []);
          return (await services.store.asset(project.projectId, assetId)).content;
        } }, signal);
      for (const cue of audioCuesInSegment(project, task.segmentId).filter((value): boolean => value.assetId !== null)) {
        if (signal.aborted) throw contractError('AUTOMATION_CANCELLED', '계획 후 기존 음원 재확인이 중단되었습니다.', []);
        await services.store.asset(project.projectId, cue.assetId!);
      }
      candidate = result;
      break;
    }
    case 'image': {
      if (remainingBytes < MAX_IMAGE_BYTES) throw contractError('AUTOMATION_STAGING_BUDGET', '프레임 이미지 한 장의 최대 바이트를 수용할 저장 예산이 필요합니다.', []);
      const basis = createAutomaticFrameBasis(project, task.frameId);
      const references = await loadReferences(services.store, project.projectId, basis.referenceAssetIds, signal);
      await services.onProgress({ phase: 'image', message: `${task.frameId}: 현재 시점의 콘티 그림 생성` });
      const result = await generateAutomaticFrame(project, basis, references, provenance, services.engines.image, signal);
      candidate = { ...result, exceptions: [] };
      break;
    }
    case 'repair': {
      const basis = createSourceRepairBasis(project, task.segmentId);
      candidate = await planSourceRepair(project, basis, { provenance, audioProduction: automationAudioProduction(settings), voice: settings.voice, speakerVoices: resolvedAutomationSpeakerVoices(project, [task.segmentId], settings), maxCorrections: settings.maxModelCorrections,
        maxFrames: settings.maxFramesPerSegment, maxAudioBytes: Math.min(remainingBytes, 512 * 1024 * 1024) }, {
        model: services.engines.model, speech: services.engines.speech, onProgress: services.onProgress, onSpeechReady: services.onSpeechReady,
        loadExistingAudio: async (assetId, audioSignal): Promise<Buffer> => {
          if (audioSignal.aborted) throw contractError('AUTOMATION_CANCELLED', '기존 음원 확인이 중단되었습니다.', []);
          return (await services.store.asset(project.projectId, assetId)).content;
        },
      }, signal);
      break;
    }
  }
  if (task.kind === 'repair') {
    const textReview = inspectAutomaticText(project, candidate.project, task.segmentId, await readSelectedTextFont(project.textTypography, services.textFontPath));
    candidate = { ...candidate, project: recordAutomaticTextReview(project, candidate.project, provenance.generationId, textReview), exceptions: [...candidate.exceptions, ...textReview.issues] };
    const density = automationDensity(settings);
    if (density !== null) candidate = { ...candidate, project: recordStoryboardDensityReview(project, candidate.project, provenance.generationId, inspectStoryboardDensity(candidate.project, [task.segmentId], density)) };
    for (const cue of audioCuesInSegment(project, task.segmentId).filter((value): boolean => value.assetId !== null)) {
      if (signal.aborted) throw contractError('AUTOMATION_CANCELLED', '연결 보완 후 기존 음원 확인이 중단되었습니다.', []);
      await services.store.asset(project.projectId, cue.assetId!);
    }
  }
  if (signal.aborted) throw contractError('AUTOMATION_CANCELLED', '자동 제작 결과 검증 중 중단되었습니다.', []);
  if (candidate.writes.reduce((sum, write): number => sum + write.content.length, 0) > remainingBytes) throw contractError('AUTOMATION_STAGING_BUDGET', '실제 생성 결과가 남은 저장 예산을 초과했습니다.', []);
  if (automaticHash(await services.store.read(project.projectId)) !== automaticHash(project)) throw contractError('AUTOMATION_STALE_PLAN', '생성 중 프로젝트가 변경되었습니다. 사용자의 편집을 보존했습니다.', []);
  return candidate;
}

import type { AudioProduction } from './run-schema.js';
import type { SpeakerVoice } from '../domain/speech-voice.js';
import { z } from 'zod';
import type { SpeechGenerationEngine, SpeechVoice } from '../codex/speech-engine.js';
import type { StructuredGenerationEngine, StructuredGenerationResult } from '../codex/structured-engine.js';
import { contractError } from '../domain/errors.js';
import type { Project } from '../domain/schema.js';
import { loadExistingAudioFiles } from './existing-audio.js';
import type { ExistingAudioLoader } from './existing-audio.js';
import { AutomaticPlanProvenanceSchema } from './plan-compiler.js';
import type { AutomaticPlanProvenance } from './plan-compiler.js';
import type { PlanCorrection } from './plan-context.js';
import type { AutomaticPlanProgress } from './plan-segment.js';
import { assertSourceRepairBasis } from './repair-basis.js';
import type { SourceRepairBasis } from './repair-basis.js';
import { compileSourceRepair } from './repair-compiler.js';
import type { SourceRepairCandidate } from './repair-compiler.js';
import { sourceRepairContext } from './repair-context.js';
import type { StagedSpeech } from './plan-audio.js';
import { stageMissingSpeech } from './stage-speech.js';

export type SourceRepairOptions = { audioProduction?: AudioProduction; provenance: Omit<AutomaticPlanProvenance, 'model' | 'turnId' | 'prompt'>; voice: SpeechVoice; speakerVoices?: SpeakerVoice[]; maxCorrections: number; maxFrames: number; maxAudioBytes: number };
export type SourceRepairServices = { model: StructuredGenerationEngine; speech: SpeechGenerationEngine; loadExistingAudio: ExistingAudioLoader; onProgress: (progress: AutomaticPlanProgress) => Promise<void>; onSpeechReady: (speech: StagedSpeech) => Promise<void> };

function assertActive(signal: AbortSignal): void {
  if (signal.aborted) throw contractError('AUTOMATION_CANCELLED', '미정 연결 보완이 중단되었습니다. 기존 편집은 보존했습니다.', []);
}

function repairCorrection(error: unknown, previousOutput: unknown): PlanCorrection | null {
  if (error instanceof z.ZodError) return { code: 'AUTOMATION_REPAIR_SCHEMA', message: error.message, previousOutput };
  if (!(error instanceof Error) || !('code' in error) || typeof error.code !== 'string') return null;
  const codes: readonly string[] = ['AUTOMATION_REPAIR_INVALID', 'AUTOMATION_REPAIR_SCOPE', 'AUTOMATION_REPAIR_AUDIO_SCOPE', 'AUTOMATION_REPAIR_AUDIO_WINDOW', 'AUTOMATION_SPEECH_DURATION', 'AUTOMATION_PREPARED_AUDIO_WINDOW', 'AUTOMATION_PREPARED_AUDIO_DURATION', 'AUTOMATION_REPAIR_AUDIO_VERSION', 'AUTOMATION_SOURCE_INTERVAL', 'AUTOMATION_UNKNOWN_SOURCE', 'AUTOMATION_FRAME_BUDGET', 'CODEX_PLAN_INVALID_JSON'];
  return codes.includes(error.code) ? { code: error.code, message: error.message, previousOutput } : null;
}

/** 컷 재설계와 별도로 실제 음원과 미정 링크를 검토하고 보정 횟수를 제한한다. */
export async function planSourceRepair(inputProject: Project, inputBasis: SourceRepairBasis, inputOptions: SourceRepairOptions, services: SourceRepairServices, signal: AbortSignal): Promise<SourceRepairCandidate> {
  const project: Project = structuredClone(inputProject);
  const basis: SourceRepairBasis = structuredClone(inputBasis);
  const options: SourceRepairOptions = structuredClone(inputOptions);
  assertSourceRepairBasis(project, basis);
  z.number().int().min(0).max(3).parse(options.maxCorrections);
  z.number().int().min(1).max(2048).parse(options.maxFrames);
  AutomaticPlanProvenanceSchema.omit({ model: true, turnId: true, prompt: true }).parse(options.provenance);
  assertActive(signal);
  const files = await loadExistingAudioFiles(project, basis.segmentId, options.maxAudioBytes, services.loadExistingAudio, async (cueId, completed, total): Promise<void> => {
    await services.onProgress({ phase: 'audio-check', completed, total, attempt: 0, message: `${cueId}: 편집된 컷의 기존 WAV 검증` });
  }, signal);
  const speech: StagedSpeech[] = options.audioProduction === 'instructions-only' ? [] : await stageMissingSpeech(project, basis.speechCueIds, options.voice, options.speakerVoices ?? [],
    options.maxAudioBytes - files.reduce((sum, file): number => sum + file.bytes.length, 0), services, signal);
  let correction: PlanCorrection | null = null;
  for (let attempt: number = 0; attempt <= options.maxCorrections; attempt += 1) {
    assertActive(signal);
    const context = sourceRepairContext(project, basis, files, speech, correction, options.maxFrames);
    await services.onProgress({ phase: 'planning', completed: 0, total: basis.targets.length, attempt, message: `${basis.segmentId}: 기존 컷을 유지하며 미정 연결 보완` });
    assertActive(signal);
    let output: StructuredGenerationResult | null = null;
    let candidate: SourceRepairCandidate;
    try {
      output = await services.model.run(context, signal);
      assertActive(signal);
      candidate = compileSourceRepair(project, basis, output.result, files, speech, { ...options.provenance, model: output.model, turnId: output.turnId, prompt: context.prompt }, options.maxFrames);
    } catch (error: unknown) {
      const next: PlanCorrection | null = repairCorrection(error, output?.result ?? null);
      if (next === null || attempt === options.maxCorrections) throw error;
      correction = next;
      await services.onProgress({ phase: 'correction', completed: 0, total: basis.targets.length, attempt: attempt + 1, message: `${next.code}: ${next.message}` });
      continue;
    }
    await services.onProgress({ phase: 'validated', completed: basis.targets.length, total: basis.targets.length, attempt, message: `${basis.segmentId}: 컷을 보존한 연결 검토 완료` });
    assertActive(signal);
    return candidate;
  }
  throw contractError('AUTOMATION_PLAN_ATTEMPTS_EXHAUSTED', '미정 연결 보정 횟수를 초과했습니다.', []);
}

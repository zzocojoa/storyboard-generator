import type { TextFontSource } from '../rendering/text-font-source.js';
import type { AudioProduction } from './run-schema.js';
import type { SpeakerVoice } from '../domain/speech-voice.js';
import { z } from 'zod';
import type { SpeechGenerationEngine, SpeechVoice } from '../codex/speech-engine.js';
import type { StructuredGenerationEngine, StructuredGenerationResult } from '../codex/structured-engine.js';
import { contractError } from '../domain/errors.js';
import type { Project } from '../domain/schema.js';
import { readSelectedTextFont } from '../rendering/text-font-source.js';
import { assertTextReviewDuration, inspectAutomaticText, recordAutomaticTextReview } from './text-review.js';
import type { AutomaticTextReview } from './text-review.js';
import type { ExistingAudioFile, StagedSpeech } from './plan-audio.js';
import { loadExistingAudioFiles } from './existing-audio.js';
import { stageMissingSpeech } from './stage-speech.js';
import { assertSegmentPlanBasis } from './plan-basis.js';
import { AutomaticPlanProvenanceSchema, compileAutomaticSegmentPlan } from './plan-compiler.js';
import type { AutomaticCandidate, AutomaticPlanProvenance } from './plan-compiler.js';
import { automaticSegmentContext } from './plan-context.js';
import type { PlanCorrection } from './plan-context.js';
import type { SegmentPlanBasis } from './plan-schema.js';
import { inspectStoryboardDensity, recordStoryboardDensityReview, StoryboardDensitySchema } from './density.js';
import type { StoryboardDensity, StoryboardDensityReview } from './density.js';

export type AutomaticPlanProgress = { phase: 'audio-check' | 'speech' | 'planning' | 'correction' | 'validated'; completed: number; total: number; attempt: number; message: string };
export type AutomaticPlanOptions = { audioProduction?: AudioProduction; voice: SpeechVoice; speakerVoices?: SpeakerVoice[]; density: StoryboardDensity | null; maxCorrections: number; maxFrames: number; maxStagedAudioBytes: number; provenance: Omit<AutomaticPlanProvenance, 'model' | 'turnId' | 'prompt'> };
export type AutomaticPlanServices = { textFontPath: TextFontSource; speech: SpeechGenerationEngine; model: StructuredGenerationEngine; loadExistingAudio: (assetId: string, signal: AbortSignal) => Promise<Buffer>; onProgress: (progress: AutomaticPlanProgress) => Promise<void>; onSpeechReady: (speech: StagedSpeech) => Promise<void> };

function assertNotCancelled(signal: AbortSignal): void {
  if (signal.aborted) throw contractError('AUTOMATION_CANCELLED', '자동 제작이 취소되었습니다. 검증 후보는 프로젝트에 반영하지 않았습니다.', []);
}

function correctionFor(error: unknown, previousOutput: unknown): PlanCorrection | null {
  if (error instanceof z.ZodError) return { code: 'AUTOMATION_PLAN_SCHEMA', message: error.message, previousOutput };
  if (!(error instanceof Error) || !('code' in error) || typeof error.code !== 'string') return null;
  const correctable: readonly string[] = ['AUTOMATION_PRODUCTION_REFERENCE_SCOPE', 'AUTOMATION_CANDIDATE_INVALID', 'AUTOMATION_SOURCE_INTERVAL', 'AUTOMATION_FRAME_COLLISION', 'AUTOMATION_FRAME_BUDGET', 'AUTOMATION_UNKNOWN_SOURCE', 'AUTOMATION_DUPLICATE_DECISION', 'AUTOMATION_MAPPING_SCOPE', 'AUTOMATION_CANONICAL_SOURCE', 'AUTOMATION_CONFIRMED_MAPPING', 'AUTOMATION_PLACEMENT_INFORMATION_SCOPE', 'AUTOMATION_CONFIRMED_INFORMATION', 'AUTOMATION_TEXT_AUTHORITY', 'AUTOMATION_TEXT_TIMING_COVERAGE', 'AUTOMATION_CONFIRMED_TEXT', 'AUTOMATION_CANONICAL_TIMING', 'AUTOMATION_AUDIO_SCOPE', 'AUTOMATION_EXISTING_AUDIO', 'AUTOMATION_SPEECH_DURATION', 'AUTOMATION_PREPARED_AUDIO_WINDOW', 'AUTOMATION_PREPARED_AUDIO_DURATION', 'AUTOMATION_REPAIR_AUDIO_VERSION', 'AUTOMATION_PLAN_SCOPE', 'CODEX_PLAN_INVALID_JSON'];
  return [...correctable, 'AUTOMATION_TEXT_DURATION_REDUCED', 'AUTOMATION_TEXT_CONTENT_CHANGED', 'AUTOMATION_TEXT_CORRECTION_SCOPE'].includes(error.code) ? { code: error.code, message: error.message, previousOutput } : null;
}

/** 실측 음성을 먼저 준비한 다음 유한한 계획 보정을 수행한다. 저장 반영은 실행 관리자의 책임이다. */
export async function planAutomaticSegment(inputProject: Project, inputBasis: SegmentPlanBasis, inputOptions: AutomaticPlanOptions, services: AutomaticPlanServices, signal: AbortSignal): Promise<AutomaticCandidate> {
  const project: Project = structuredClone(inputProject);
  const basis: SegmentPlanBasis = structuredClone(inputBasis);
  const options: AutomaticPlanOptions = structuredClone(inputOptions);
  z.number().int().min(0).max(3).parse(options.maxCorrections);
  z.number().int().min(1).max(2048).parse(options.maxFrames);
  z.number().int().min(1).max(512 * 1024 * 1024).parse(options.maxStagedAudioBytes);
  StoryboardDensitySchema.nullable().parse(options.density);
  AutomaticPlanProvenanceSchema.omit({ model: true, turnId: true, prompt: true }).parse(options.provenance);
  assertSegmentPlanBasis(project, basis);
  assertNotCancelled(signal);
  const font = await readSelectedTextFont(project.textTypography, services.textFontPath);
  const sourceIds: Set<string> = new Set(project.dataset.units.filter((unit): boolean => unit.segmentId === basis.segmentId).map((unit): string => unit.id));
  const existing: ExistingAudioFile[] = await loadExistingAudioFiles(project, basis.segmentId, options.maxStagedAudioBytes, services.loadExistingAudio, async (cueId, completed, total): Promise<void> => {
    await services.onProgress({ phase: 'audio-check', completed, total, attempt: 0, message: `${cueId}: 기존 WAV와 저장한 시각 확인` });
  }, signal);
  const existingBytes: number = existing.reduce((sum, file): number => sum + file.bytes.length, 0);
  const cues = project.audioCues.filter((cue): boolean => cue.unitId !== null && sourceIds.has(cue.unitId) && cue.assetId === null && cue.timingStatus !== 'measured' && ['dialogue', 'voiceover', 'panel'].includes(cue.kind));
  const staged: StagedSpeech[] = options.audioProduction === 'instructions-only' ? [] : await stageMissingSpeech(project, cues.map((cue): string => cue.id), options.voice, options.speakerVoices ?? [], options.maxStagedAudioBytes - existingBytes, services, signal);
  let correction: PlanCorrection | null = null;
  let textReview: AutomaticTextReview | null = null;
  let densityReview: StoryboardDensityReview | null = null;
  for (let attempt: number = 0; attempt <= options.maxCorrections; attempt += 1) {
    assertNotCancelled(signal);
    const context = automaticSegmentContext(project, basis, staged, existing, correction, options.maxFrames, { fontSha256: font.sha256, previousReview: textReview }, options.density === null ? null : { policy: options.density, previousReview: densityReview });
    await services.onProgress({ phase: 'planning', completed: staged.length, total: cues.length, attempt, message: `${basis.segmentId}: 원문·컷·글자·음향 배치 계획` });
    assertNotCancelled(signal);
    let output: StructuredGenerationResult | null = null;
    let candidate: AutomaticCandidate;
    try {
      output = await services.model.run(context, signal);
      assertNotCancelled(signal);
      candidate = compileAutomaticSegmentPlan(project, basis, output.result, staged, existing, { ...options.provenance, model: output.model, turnId: output.turnId, prompt: context.prompt }, options.maxFrames);
      if (textReview !== null) assertTextReviewDuration(candidate.project, textReview);
    } catch (error: unknown) {
      const next: PlanCorrection | null = correctionFor(error, output?.result ?? null);
      if (next === null || attempt === options.maxCorrections) throw error;
      correction = next;
      await services.onProgress({ phase: 'correction', completed: staged.length, total: cues.length, attempt: attempt + 1, message: `${next.code}: ${next.message}` });
      continue;
    }
    textReview = inspectAutomaticText(project, candidate.project, basis.segmentId, font);
    densityReview = options.density === null ? null : inspectStoryboardDensity(candidate.project, [basis.segmentId], options.density);
    if (textReview.correctionCueIds.length > 0 && attempt < options.maxCorrections) {
      correction = { code: 'AUTOMATION_TEXT_LAYOUT_REVIEW', message: textReview.issues.map((value): string => `${value.code}: ${value.message}`).join('\n'), previousOutput: output!.result };
      await services.onProgress({ phase: 'correction', completed: staged.length, total: cues.length, attempt: attempt + 1, message: correction.message });
      continue;
    }
    if (densityReview !== null && densityReview.longHolds.length > 0 && attempt < options.maxCorrections) {
      correction = { code: 'AUTOMATION_DENSITY_REVIEW', message: densityReview.longHolds.map((hold): string => `${hold.shotId}: ${hold.startMs}..${hold.endMs}ms 한 그림 표시 ${hold.durationMs}ms. 원문의 상태 변화에 맞게 보완하거나 의도된 유지의 이유를 남기세요.`).join('\n'), previousOutput: output!.result };
      await services.onProgress({ phase: 'correction', completed: staged.length, total: cues.length, attempt: attempt + 1, message: correction.message });
      continue;
    }
    if ((await readSelectedTextFont(project.textTypography, services.textFontPath)).sha256 !== font.sha256) throw contractError('AUTOMATION_TEXT_FONT_CHANGED', '계획 중 출력 글꼴이 변경됐습니다. 현재 글꼴로 새 계획을 시작하세요.', []);
    candidate = { ...candidate, project: recordAutomaticTextReview(project, candidate.project, options.provenance.generationId, textReview), exceptions: [...candidate.exceptions, ...textReview.issues] };
    if (densityReview !== null) candidate = { ...candidate, project: recordStoryboardDensityReview(project, candidate.project, options.provenance.generationId, densityReview) };
    await services.onProgress({ phase: 'validated', completed: staged.length, total: cues.length, attempt, message: `${basis.segmentId}: 검증 초안 준비 완료 · 글자 배치 검토 ${textReview.issues.length}건 · 긴 그림 표시 검토 ${densityReview?.longHolds.length ?? 0}건` });
    assertNotCancelled(signal);
    return candidate;
  }
  throw contractError('AUTOMATION_PLAN_ATTEMPTS_EXHAUSTED', '자동 계획 시도 횟수를 초과했습니다.', []);
}

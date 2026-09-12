import { assertSpeechPronunciation } from '../codex/speech-pronunciation.js';
import { z } from 'zod';
import { contractError } from '../domain/errors.js';
import { assertGenerationRecordTransition } from '../domain/generation-records.js';
import { GeneratorBuildProvenanceSchema, IdSchema, ProjectSchema } from '../domain/schema.js';
import type { GenerationRecord, GeneratorBuildProvenance, Issue, Project } from '../domain/schema.js';
import { sha256Text } from '../importers/integrity.js';
import { stableJsonStringify } from '../io/stable-json.js';
import { compilePlannedAudio } from './plan-audio.js';
import type { ExistingAudioEvidence, ExistingAudioFile, PlannedAssetWrite, StagedSpeech } from './plan-audio.js';
import { assertSegmentPlanBasis } from './plan-basis.js';
import { AutomaticSegmentPlanSchema } from './plan-schema.js';
import type { AutomaticSegmentPlan, SegmentPlanBasis } from './plan-schema.js';
import { compilePlannedShots } from './plan-shots.js';
import { compilePlannedText } from './plan-text.js';
import { assertAutomaticCandidate } from './plan-validation.js';

export type AutomaticPlanProvenance = { generationId: string; model: string; turnId: string; prompt: string; createdAt: string; generatorBuild: GeneratorBuildProvenance };
export type AutomaticCandidate = { project: Project; writes: PlannedAssetWrite[]; exceptions: Issue[]; plan: AutomaticSegmentPlan; basis: SegmentPlanBasis };
export const AutomaticPlanProvenanceSchema = z.strictObject({ generationId: IdSchema.max(80), model: z.string().trim().min(1), turnId: z.string().trim().min(1), prompt: z.string(), createdAt: z.iso.datetime(), generatorBuild: GeneratorBuildProvenanceSchema });

function planRecord(project: Project, plan: AutomaticSegmentPlan, basis: SegmentPlanBasis, existingAudio: readonly ExistingAudioEvidence[], provenance: AutomaticPlanProvenance): GenerationRecord {
  return { id: provenance.generationId, provider: 'codex-app', model: provenance.model, modelVersion: null,
    requestId: provenance.generationId, prompt: stableJsonStringify({ input: provenance.prompt, output: plan, turnId: provenance.turnId, basis, existingAudio }),
    templateVersion: 'automatic-segment-plan-1.0.0', seed: null, referenceHashes: [basis.projectHash, ...existingAudio.map((value): string => value.inspection.sha256)], resultAssetIds: [],
    shotIds: project.shots.filter((shot): boolean => shot.segmentId === plan.segmentId).map((shot): string => shot.id), createdAt: provenance.createdAt, generatorBuild: provenance.generatorBuild };
}

export function automaticSpeechRecords(project: Project, speech: readonly StagedSpeech[], provenance: AutomaticPlanProvenance): GenerationRecord[] {
  return speech.map((staged): GenerationRecord => {
    const cue = project.audioCues.find((value): boolean => value.id === staged.cueId);
    const unit = project.dataset.units.find((value): boolean => value.id === staged.result.unitId);
    if (cue?.assetId === null || cue === undefined || unit === undefined) throw contractError('AUTOMATION_SPEECH_RECORD', `음성 결과의 적용 대상을 찾을 수 없습니다: ${staged.cueId}`, []);
    assertSpeechPronunciation(unit.text, undefined, staged.result.pronunciation);
    return { id: `${provenance.generationId}:speech:${sha256Text(cue.id).slice(0, 16)}`, provider: 'macos-speech', model: `say:${staged.result.voice.name}`, modelVersion: null,
      requestId: null, prompt: stableJsonStringify({ sourceText: unit.text, sourceTextHash: staged.result.sourceTextHash, voice: staged.result.voice, cacheEvidence: staged.result.cacheEvidence ?? null }),
      templateVersion: 'automatic-guide-speech-1.0.0', seed: null, referenceHashes: [staged.result.sourceTextHash], resultAssetIds: [cue.assetId],
      shotIds: project.shots.filter((shot): boolean => shot.sourceLinks.some((link): boolean => link.unitId === unit.id)).map((shot): string => shot.id), createdAt: staged.result.cacheEvidence?.generatedAt ?? provenance.createdAt, generatorBuild: provenance.generatorBuild };
  });
}

/** 파일이나 저장 상태를 바꾸지 않고, 미정 입력과 실측 음성을 함께 검증한 원자적 후보를 반환한다. */
export function compileAutomaticSegmentPlan(
  project: Project, basis: SegmentPlanBasis, input: unknown, speech: readonly StagedSpeech[], existing: readonly ExistingAudioFile[], provenance: AutomaticPlanProvenance, maxFrames: number,
): AutomaticCandidate {
  assertSegmentPlanBasis(project, basis);
  const plan: AutomaticSegmentPlan = AutomaticSegmentPlanSchema.parse(input);
  AutomaticPlanProvenanceSchema.parse(provenance);
  if (plan.segmentId !== basis.segmentId) throw contractError('AUTOMATION_PLAN_SCOPE', `다른 구간의 계획입니다: expected=${basis.segmentId}, actual=${plan.segmentId}`, []);
  if (project.generationRecords.some((record): boolean => record.id === provenance.generationId || record.requestId === provenance.generationId)) throw contractError('AUTOMATION_DUPLICATE_GENERATION', `이미 반영한 생성 ID입니다: ${provenance.generationId}`, []);
  const planned = compilePlannedShots(project, plan, provenance.generationId, maxFrames);
  const text = compilePlannedText(project, plan, provenance.generationId);
  const audio = compilePlannedAudio(project, plan, speech, existing, provenance.generationId);
  const replaced: Set<string> = new Set(basis.replaceShotIds);
  const candidate: Project = ProjectSchema.parse({ ...project, ...text, assets: audio.assets, audioCues: audio.audioCues,
    shots: [...project.shots.filter((shot): boolean => !replaced.has(shot.id)), ...planned.shots].sort((left, right): number => left.startMs - right.startMs),
    frames: [...project.frames.filter((frame): boolean => !replaced.has(frame.shotId)), ...planned.frames] });
  const next: Project = ProjectSchema.parse({ ...candidate, generationRecords: [...project.generationRecords, planRecord(candidate, plan, basis, audio.existingAudio, provenance), ...automaticSpeechRecords(candidate, speech, provenance)] });
  assertGenerationRecordTransition(project, next);
  assertAutomaticCandidate(project, next, basis.segmentId);
  return { project: next, writes: audio.writes, exceptions: audio.exceptions, plan, basis: { ...basis, replaceShotIds: [...basis.replaceShotIds] } };
}

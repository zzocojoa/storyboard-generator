import { SpeechVoiceSchema, SpeakerVoicesSchema } from '../domain/speech-voice.js';
import type { SpeakerVoice } from '../domain/speech-voice.js';
import { z } from 'zod';
import { GeneratorBuildProvenanceSchema, HashSchema, IdSchema } from '../domain/schema.js';
import { AutomaticApplyReceiptSchema } from './application-schema.js';
import { StoryboardDensitySchema } from './density.js';
import type { StoryboardDensity } from './density.js';
import { SpeechRetakeIntentSchema } from './speech-retake-schema.js';

export const LegacyAutomationSettingsSchema = z.strictObject({
  model: z.string().trim().min(1).nullable(),
  voice: SpeechVoiceSchema,
  productionBatchSize: z.number().int().min(1).max(256),
  maxModelCorrections: z.number().int().min(0).max(3),
  maxFramesPerSegment: z.number().int().min(1).max(2048),
  maxAttemptsPerJob: z.number().int().min(1).max(4),
  maxImageAttempts: z.number().int().min(1).max(8192),
  maxJobs: z.number().int().min(1).max(8192),
  maxStagedBytes: z.number().int().min(1).max(1024 * 1024 * 1024),
  maxActiveMs: z.number().int().min(1000).max(24 * 60 * 60 * 1000),
});
const DensityAutomationSettingsSchema = LegacyAutomationSettingsSchema.extend({ density: StoryboardDensitySchema });
const TextAutomationSettingsSchema = DensityAutomationSettingsSchema.extend({ textLayoutPlanning: z.enum(['automatic', 'preserve']) });
const MixAutomationSettingsSchema = TextAutomationSettingsSchema.extend({ audioMixPlanning: z.enum(['automatic', 'preserve']) });
export const CurrentAutomationSettingsSchema = MixAutomationSettingsSchema.extend({ speakerVoices: SpeakerVoicesSchema, voicePlanning: z.enum(['automatic', 'configured']).optional(), audioProduction: z.enum(['instructions-only', 'guide-voice']).optional() });
const SpeakerAutomationSettingsSchema = LegacyAutomationSettingsSchema.extend({ speakerVoices: SpeakerVoicesSchema, voicePlanning: z.enum(['automatic', 'configured']).optional(), density: StoryboardDensitySchema.optional(), textLayoutPlanning: z.enum(['automatic', 'preserve']).optional(), audioMixPlanning: z.enum(['automatic', 'preserve']).optional() });
// 콘티 전용 실행은 사용하지 않는 음성 초안을 보존한다. 음성 제작으로 전환하면 기존 엄격한 검사를 적용한다.
const InstructionsOnlyAutomationSettingsSchema = CurrentAutomationSettingsSchema.extend({
  audioProduction: z.literal('instructions-only'),
  voice: z.strictObject({ name: z.string(), rateWordsPerMinute: z.number() }),
  speakerVoices: z.array(z.strictObject({ speakerId: IdSchema.nullable(), voice: z.strictObject({ name: z.string(), rateWordsPerMinute: z.number() }) })).max(1024),
});
export const AutomationSettingsSchema = z.union([InstructionsOnlyAutomationSettingsSchema, CurrentAutomationSettingsSchema, SpeakerAutomationSettingsSchema, MixAutomationSettingsSchema, TextAutomationSettingsSchema, DensityAutomationSettingsSchema, LegacyAutomationSettingsSchema]);

export function automationSpeakerVoices(settings: AutomationSettings): SpeakerVoice[] {
  return 'speakerVoices' in settings ? structuredClone(settings.speakerVoices) : [];
}

export type AudioProduction = 'instructions-only' | 'guide-voice';

/** 이전 실행은 기존 음성 제작 계약으로 재개하며 신규 실행은 명시한 선택을 따른다. */
export function automationAudioProduction(settings: AutomationSettings): AudioProduction {
  return 'audioProduction' in settings && settings.audioProduction !== undefined ? settings.audioProduction : 'guide-voice';
}

export function automaticVoicePlanning(settings: AutomationSettings): boolean {
  return 'voicePlanning' in settings && settings.voicePlanning === 'automatic';
}

/** 이전 실행의 설정·해시를 재작성하지 않고 명시된 상세도만 읽는다. */
export function automationDensity(settings: AutomationSettings): StoryboardDensity | null {
  return 'density' in settings && settings.density !== undefined ? structuredClone(settings.density) : null;
}
export const AutomationTaskSchema = z.discriminatedUnion('kind', [
  SpeechRetakeIntentSchema,
  z.strictObject({ kind: z.literal('voice-casting'), segmentIds: z.array(IdSchema).min(1).max(8192) }),
  z.strictObject({ kind: z.literal('text-layout') }),
  z.strictObject({ kind: z.literal('audio-mix'), segmentId: IdSchema }),
  z.strictObject({ kind: z.literal('audio-instructions'), segmentId: IdSchema }),
  z.strictObject({ kind: z.literal('production'), segmentIds: z.array(IdSchema).min(1).max(256) }),
  z.strictObject({ kind: z.literal('reference'), resourceId: IdSchema }),
  z.strictObject({ kind: z.literal('segment'), segmentId: IdSchema, replaceShotIds: z.array(IdSchema).max(256) }),
  z.strictObject({ kind: z.literal('repair'), segmentId: IdSchema }),
  z.strictObject({ kind: z.literal('image'), frameId: IdSchema }),
]);
export const AutomationJobDefinitionSchema = z.strictObject({ id: z.uuid(), task: AutomationTaskSchema, dependsOn: z.array(z.uuid()).max(8192) });
const At = z.iso.datetime();
const JobAttempt = { jobId: z.uuid(), attemptId: z.uuid(), at: At };
const Problem = z.strictObject({ code: z.string().min(1).max(200), message: z.string().min(1).max(16000) });

export const AutomationRunCreatedSchema = z.strictObject({
  type: z.literal('created'), id: z.uuid(), projectId: IdSchema, revision: z.number().int().nonnegative(), projectHash: HashSchema,
  segmentIds: z.array(IdSchema).min(1).max(8192), settings: AutomationSettingsSchema, generatorBuild: GeneratorBuildProvenanceSchema, at: At,
  purpose: SpeechRetakeIntentSchema.optional(),
});
export const AutomationRunEventSchema = z.discriminatedUnion('type', [
  AutomationRunCreatedSchema,
  z.strictObject({ type: z.literal('jobs-added'), jobs: z.array(AutomationJobDefinitionSchema).min(1).max(8192), at: At }),
  z.strictObject({ type: z.literal('attempt-started'), ...JobAttempt, revision: z.number().int().nonnegative(), projectHash: HashSchema }),
  z.strictObject({ type: z.literal('result-prepared'), ...JobAttempt, applicationHash: HashSchema, stagedBytes: z.number().int().nonnegative() }),
  z.strictObject({ type: z.literal('apply-started'), ...JobAttempt }),
  z.strictObject({ type: z.literal('attempt-committed'), ...JobAttempt, receipt: AutomaticApplyReceiptSchema }),
  z.strictObject({ type: z.literal('attempt-failed'), ...JobAttempt, problem: Problem }),
  z.strictObject({ type: z.literal('apply-uncommitted'), ...JobAttempt, problem: Problem }),
  z.strictObject({ type: z.literal('paused'), reason: z.string().min(1).max(2000), at: At }),
  z.strictObject({ type: z.literal('resumed'), revision: z.number().int().nonnegative(), projectHash: HashSchema, at: At }),
  z.strictObject({ type: z.literal('cancelled'), at: At }),
  z.strictObject({ type: z.literal('needs-attention'), problem: Problem, at: At }),
  z.strictObject({ type: z.literal('review-ready'), at: At }),
]);
export type AutomationSettings = z.infer<typeof AutomationSettingsSchema>;
export type AutomationTask = z.infer<typeof AutomationTaskSchema>;
export type AutomationJobDefinition = z.infer<typeof AutomationJobDefinitionSchema>;
export type AutomationRunEvent = z.infer<typeof AutomationRunEventSchema>;
export type AutomationRunCreated = z.infer<typeof AutomationRunCreatedSchema>;
export type AutomationProblem = z.infer<typeof Problem>;
export type AutomationAttempt = {
  id: string; status: 'running' | 'prepared' | 'applying' | 'completed' | 'failed' | 'interrupted';
  revision: number; projectHash: string; startedAt: string; finishedAt: string | null;
  applicationHash: string | null; stagedBytes: number; committedRevision: number | null; problem: AutomationProblem | null;
};
export type AutomationJob = AutomationJobDefinition & { attempts: AutomationAttempt[] };
export type AutomationRun = Omit<AutomationRunCreated, 'type' | 'at' | 'revision' | 'projectHash'> & {
  status: 'running' | 'paused' | 'cancelled' | 'needs-attention' | 'review-ready';
  initialRevision: number; initialProjectHash: string; revision: number; projectHash: string; settingsHash: string;
  createdAt: string; updatedAt: string; activeMs: number; imageAttempts: number; stagedBytes: number;
  jobs: AutomationJob[]; problem: AutomationProblem | null;
};

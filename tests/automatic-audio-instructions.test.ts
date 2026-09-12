import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';
import { expect, it } from 'vitest';
import { z } from 'zod';
import { automaticHash } from '../src/automation/application-evidence.js';
import { automaticAudioInstructionTargets } from '../src/automation/audio-instruction-targets.js';
import { nextAutomaticWork } from '../src/automation/job-graph.js';
import { compileAudioInstructionPlan, planAutomaticAudioInstructions } from '../src/automation/plan-audio-instructions.js';
import { createSegmentPlanBasis } from '../src/automation/plan-basis.js';
import { automaticSegmentContext } from '../src/automation/plan-context.js';
import { createSourceRepairBasis } from '../src/automation/repair-basis.js';
import { sourceRepairContext } from '../src/automation/repair-context.js';
import type { AutomaticAudioInstructionPlan } from '../src/automation/plan-audio-instructions.js';
import { createAutomationRun, reduceAutomationRun } from '../src/automation/run-state.js';
import { executeAutomaticTask } from '../src/automation/task-executor.js';
import type { StructuredGenerationEngine } from '../src/codex/structured-engine.js';
import { confirmAudioInstruction, updateAudioInstruction } from '../src/domain/audio-instructions.js';
import { audioCueSource } from '../src/domain/audio-source.js';
import type { AudioSource } from '../src/domain/audio-source.js';
import type { Project } from '../src/domain/schema.js';
import { reviewAudioPlaybackAt } from '../src/domain/playback.js';
import { reviewInformationEmission } from '../src/domain/emission.js';
import { reviewFinalReadiness } from '../src/domain/final-readiness.js';
import { parseProject } from '../src/io/project.js';
import { createCsvProjection } from '../src/exporters/csv.js';
import { redactReviewJson, reviewRedactionPatterns } from '../src/exporters/review-redaction.js';
import { sha256Text } from '../src/importers/integrity.js';
import { errorBody, httpErrorPolicy } from '../src/server/app.js';
import { registerAudioInstructionRoutes } from '../src/server/audio-instruction-routes.js';
import { ProjectStore } from '../src/server/store.js';
import { issueDestination } from '../web/src/workspace-navigation.js';
import { audioInstructionFixture } from './audio-instruction-helpers.js';
import { initial } from './automatic-executor-helpers.js';
import { settings } from './automatic-executor-helpers.js';
import { TEST_TEXT_FONT_PATH } from './helpers.js';
import { automaticPlanProvenance } from './automatic-plan-helpers.js';

function proposed(): AutomaticAudioInstructionPlan {
  return { schemaVersion: '1.0.0', segmentId: 'demonstration', summary: '음악 없이 원문의 물소리를 준비한다.', decisions: [
    { instructionId: 'ambient-instruction', resolution: 'required', cueIds: [], informationIds: ['reveal:동작'], sourceEvidence: [], sharedScope: null, reason: '물을 주는 행동의 소리이며 별도 WAV가 필요하다.' },
    { instructionId: 'music-instruction', resolution: 'none', cueIds: [], informationIds: [], sourceEvidence: [], sharedScope: null, reason: '원문에 배경 음악 없음이 명시됐다.' },
  ] };
}

it('audio_instruction_planner_covers_each_source_preserves_originals_and_never_confirms_human_review', async (): Promise<void> => {
  const project = await audioInstructionFixture(); const before = automaticHash(project);
  const next = compileAudioInstructionPlan(project, 'demonstration', proposed(), automaticPlanProvenance());
  expect(parseProject(next)).toEqual(next); expect(automaticHash(project)).toBe(before);
  for (const key of ['dataset', 'sources', 'shots', 'frames', 'textCues', 'assets'] as const) expect(next[key]).toEqual(project[key]);
  expect(next.audioInstructionDecisions).toHaveLength(2);
  expect(next.audioInstructionDecisions!.every((value): boolean => value.origin === 'automatic' && value.reviewStatus === 'proposed')).toBe(true);
  expect(next.generationRecords.at(-1)?.templateVersion).toBe('automatic-audio-instructions-1.1.0');
  const cue = next.audioCues.find((value): boolean => value.instructionId === 'ambient-instruction')!;
  expect(cue.assetId).toBeNull(); expect(cue.timingStatus).toBe('proposed');
  expect(reviewAudioPlaybackAt(next, cue.startMs).playable).not.toContainEqual(cue);
  expect(reviewFinalReadiness(next, {}).finalReady).toBe(false);
  expect(automaticAudioInstructionTargets(next, 'demonstration')).toEqual([]);
  const contexts = [
    automaticSegmentContext(next, createSegmentPlanBasis(next, 'demonstration', next.shots.filter((shot): boolean => shot.segmentId === 'demonstration').map((shot): string => shot.id)), [], [], null, 32, { fontSha256: 'a'.repeat(64), previousReview: null }, null),
    sourceRepairContext(next, createSourceRepairBasis(next, 'demonstration'), [], [], null, 32),
  ];
  for (const input of contexts) {
    const context: { audioInstructionDecisions: Project['audioInstructionDecisions']; audioSources: Array<{ cueId: string; source: AudioSource }> } = JSON.parse(input.prompt.split('입력 스냅샷:\n')[1]!);
    expect(context.audioInstructionDecisions).toEqual(next.audioInstructionDecisions);
    expect(context.audioSources).toContainEqual({ cueId: cue.id, source: audioCueSource(next, cue) });
    expect(context.audioSources.find((entry): boolean => entry.cueId === cue.id)?.source).toMatchObject({ unitId: null, instructionId: 'ambient-instruction', text: '물 흐르는 소리', informationIds: ['reveal:동작'] });
    expect(context.audioSources.every((entry): boolean => entry.source.segmentId === 'demonstration')).toBe(true);
  }
  const confirmed = confirmAudioInstruction(next, 'ambient-instruction');
  expect(reviewFinalReadiness(confirmed, {}).finalReady).toBe(false);
  expect(() => compileAudioInstructionPlan(next, 'demonstration', proposed(), automaticPlanProvenance())).toThrow();
});

it('audio_instruction_model_scope_correction_is_bounded_and_rejects_foreign_cues_and_absent_decisions', async (): Promise<void> => {
  const project = await audioInstructionFixture(); let calls: number = 0; const prompts: string[] = [];
  const model: StructuredGenerationEngine = { run: async (input) => { prompts.push(input.prompt); calls += 1;
    return { model: 'synthetic-test', turnId: `turn-${calls}`, result: z.json().parse(calls === 1 ? { ...proposed(), decisions: proposed().decisions.slice(0, 1) } : proposed()) }; } };
  const result = await planAutomaticAudioInstructions(project, 'demonstration', { maxCorrections: 1, provenance: automaticPlanProvenance() },
    { model, onProgress: async (): Promise<void> => {} }, new AbortController().signal);
  expect(calls).toBe(2); expect(prompts[1]).toContain('미판정 음향 지시 전체'); expect(result.audioInstructionDecisions).toHaveLength(2);
  for (const cueId of ['unknown', project.audioCues.find((cue): boolean => cue.kind === 'voiceover')!.id]) {
    const input = proposed(); input.decisions[0]!.cueIds = [cueId];
    expect(() => compileAudioInstructionPlan(project, 'demonstration', input, automaticPlanProvenance())).toThrowError(expect.objectContaining({ code: 'INVALID_AUDIO_INSTRUCTION' }));
  }
  const stopped = new AbortController(); stopped.abort();
  await expect(planAutomaticAudioInstructions(project, 'demonstration', { maxCorrections: 1, provenance: automaticPlanProvenance() }, { model, onProgress: async (): Promise<void> => {} }, stopped.signal)).rejects.toMatchObject({ code: 'AUTOMATION_CANCELLED' });
  expect(calls).toBe(2);
});

it('audio_instruction_jobs_precede_cut_or_repair_and_remain_inside_selected_unprotected_segments', async (): Promise<void> => {
  const project = await audioInstructionFixture(); const run = createAutomationRun(initial(project));
  const work = nextAutomaticWork(run, project);
  expect(work).toMatchObject({ kind: 'register', jobs: [{ task: { kind: 'audio-instructions', segmentId: 'demonstration' } }] });
  expect(() => reduceAutomationRun(run, { type: 'jobs-added', at: run.createdAt, jobs: [{ id: randomUUID(), task: { kind: 'audio-instructions', segmentId: 'missing' }, dependsOn: [] }] })).toThrow();
  const locked = { ...project, shots: project.shots.map((shot) => ({ ...shot, lockedFields: ['timing' as const] })) };
  expect(automaticAudioInstructionTargets(locked, 'demonstration')).toEqual([]);
  const manual = updateAudioInstruction(project, { ...proposed().decisions[1]! }, 'unused');
  expect(automaticAudioInstructionTargets(manual, 'demonstration').map((value): string => value.id)).toEqual(['ambient-instruction']);
});

it('audio_instruction_information_is_carried_to_existing_audio_and_export_review_and_navigation', async (): Promise<void> => {
  const project = await audioInstructionFixture(); const sound = project.audioCues.find((cue): boolean => cue.unitId === '효과음')!;
  const next = updateAudioInstruction(project, { ...proposed().decisions[0]!, cueIds: [sound.id], reason: '연결 근거 contact@example.com' }, 'unused');
  expect(audioCueSource(next, sound)?.informationIds).toEqual(expect.arrayContaining(['reveal:동작', 'reveal:효과음']));
  expect(reviewInformationEmission(next, { entityId: sound.id, channel: 'audio-playback', informationIds: ['reveal:동작'], atMs: sound.startMs }).map((value): string => value.code)).not.toContain('INFORMATION_WITHOUT_OUTPUT_SOURCE');
  const table = createCsvProjection(next, {}, { maturity: 'draft', channel: 'csv-export' }); const column = table[0]!.indexOf('audio_instruction_decisions');
  expect(column).toBeGreaterThan(-1); expect(table[2]![column]).toContain('ambient-instruction');
  const redacted = redactReviewJson(next, '', reviewRedactionPatterns([]));
  expect(JSON.stringify(redacted.value)).not.toContain('contact@example.com');
  expect(redacted.entries.some((entry): boolean => entry.fieldPath.includes('audioInstructionDecisions') && entry.category === 'email')).toBe(true);
  const issue = reviewFinalReadiness(next, {}).issues.find((value): boolean => value.code === 'AUDIO_INSTRUCTION_REVIEW_REQUIRED')!;
  expect(issueDestination(next, issue)).toMatchObject({ segmentId: 'demonstration', page: 'audio' });
});

it('audio_instruction_http_persists_decision_and_separate_confirmation_with_revision_and_source_protection', async (): Promise<void> => {
  const root = await mkdtemp(join(tmpdir(), 'cutroom-instruction-http-')); const store = new ProjectStore(root); const app = Fastify();
  registerAudioInstructionRoutes(app, store); app.setErrorHandler((error: Error, request, reply): void => { reply.status(httpErrorPolicy(error).status).send(errorBody(error, request)); });
  try {
    const project = await audioInstructionFixture(); await store.create(project);
    const { instructionId, ...decision } = proposed().decisions[0]!;
    const url = `/api/projects/${encodeURIComponent(project.projectId)}/audio-instructions/${instructionId}`;
    const response = await app.inject({ method: 'PATCH', url, payload: { expectedRevision: 0, decision } });
    expect(response.statusCode).toBe(200); const saved = await store.read(project.projectId);
    expect(saved.revision).toBe(1); expect(saved.audioInstructionDecisions![0]?.reviewStatus).toBe('proposed');
    const path = join(root, sha256Text(project.projectId), 'project.json'); const snapshot = await readFile(path);
    expect((await app.inject({ method: 'POST', url: `${url}/confirm`, payload: { expectedRevision: 0 } })).statusCode).toBe(409);
    expect(await readFile(path)).toEqual(snapshot);
    expect((await app.inject({ method: 'POST', url: `${url}/confirm`, payload: { expectedRevision: 1 } })).statusCode).toBe(200);
    const confirmed = await store.read(project.projectId); expect(confirmed.audioInstructionDecisions![0]?.reviewStatus).toBe('confirmed');
    expect(confirmed.dataset).toEqual(project.dataset); expect(confirmed.sources).toEqual(project.sources);
    expect(confirmed.audioCues.find((cue): boolean => cue.instructionId === instructionId)?.assetId).toBeNull();
  } finally { await app.close(); await store.close(); await rm(root, { recursive: true, force: true }); }
});

it('audio_instruction_executor_uses_the_model_and_atomic_candidate_without_speech_or_media_generation', async (): Promise<void> => {
  const root = await mkdtemp(join(tmpdir(), 'cutroom-instruction-executor-')); const store = new ProjectStore(root);
  try {
    const project = await audioInstructionFixture(); await store.create(project); let calls: number = 0;
    const candidate = await executeAutomaticTask({ project, task: { kind: 'audio-instructions', segmentId: 'demonstration' }, settings, remainingBytes: 1024, provenance: automaticPlanProvenance() },
      { store, textFontPath: TEST_TEXT_FONT_PATH, engines: { model: { run: async (input) => {
        calls += 1; expect(input.prompt).toContain('배경 음악 없음'); return { model: 'executor-test', turnId: 'instruction-turn', result: z.json().parse(proposed()) };
      } }, image: { run: async (): Promise<never> => { throw new Error('음향 지시 검토에서 이미지를 만들면 안 됩니다.'); } },
      speech: { run: async (): Promise<never> => { throw new Error('음향 지시를 읽어 음성을 만들면 안 됩니다.'); } } },
      onProgress: async (): Promise<void> => {}, onSpeechReady: async (): Promise<never> => { throw new Error('음향 지시는 가이드 발화가 아닙니다.'); } }, new AbortController().signal);
    expect(calls).toBe(1); expect(candidate.writes).toEqual([]); expect(candidate.project.generationRecords.at(-1)?.model).toBe('executor-test');
    expect(await store.read(project.projectId)).toEqual(project);
    const saved = await store.update(project.projectId, project.revision, () => candidate.project, candidate.writes);
    expect(saved.revision).toBe(1); expect(saved.audioInstructionDecisions).toEqual(candidate.project.audioInstructionDecisions);
    expect(await store.read(project.projectId)).toEqual(saved); expect(saved.sources).toEqual(project.sources);
  } finally { await store.close(); await rm(root, { recursive: true, force: true }); }
});

import { speechPronunciationEvidence } from '../src/codex/speech-pronunciation.js';
import type { SpeechGenerationInput } from '../src/codex/speech-engine.js';
import { randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import { automaticHash } from '../src/automation/application-evidence.js';
import { compileAutomaticSegmentPlan } from '../src/automation/plan-compiler.js';
import { createSegmentPlanBasis } from '../src/automation/plan-basis.js';
import { AutomationRunExecutor } from '../src/automation/run-executor.js';
import { AutomationService } from '../src/automation/service.js';
import { createAutomationRun, reduceAutomationRun } from '../src/automation/run-state.js';
import { nextAutomaticWork } from '../src/automation/job-graph.js';
import { compileSpeechRetake, createSpeechRetakeIntent } from '../src/automation/speech-retake.js';
import type { StagedSpeech } from '../src/automation/plan-audio.js';
import { inspectAudioFileBytes } from '../src/domain/media-inspection.js';
import type { Project } from '../src/domain/schema.js';
import { registerAutomationRoutes } from '../src/server/automation-routes.js';
import { errorBody, httpErrorPolicy } from '../src/server/app.js';
import { automaticPlanProject, automaticPlanProvenance, demonstrationPlan, existingPlanAudio, stagedPlanSpeech } from './automatic-plan-helpers.js';
import { createExecutionHarness, initial, settings } from './automatic-executor-helpers.js';
import { pcmWav } from './helpers.js';

const voice = { name: 'Eddy (한국어(대한민국))', rateWordsPerMinute: 160 };
const catalog = [{ name: voice.name, locale: 'ko_KR', sample: '안녕하세요.' }];
async function candidate() {
  const project = await automaticPlanProject();
  return compileAutomaticSegmentPlan(project, createSegmentPlanBasis(project, 'demonstration', ['shot-2']), demonstrationPlan(project), [stagedPlanSpeech(project)], [], automaticPlanProvenance(), 64);
}
function speech(project: Project, durationMs: number): StagedSpeech {
  const original = stagedPlanSpeech(project); const bytes = pcmWav(durationMs, project.handoff.timebase.sampleRate, 1, 16);
  return { ...original, result: { ...original.result, voice, bytes, inspection: inspectAudioFileBytes(bytes, 'audio/wav') } };
}
function provenance() { const { model: _model, turnId: _turn, prompt: _prompt, ...value } = automaticPlanProvenance(); return { ...value, generationId: randomUUID() }; }

describe('선택 발화 자동 재생성', (): void => {
  it('speech_retake_pronunciation_binds_exact_reading_preserves_source_and_rejects_substituted_evidence', async (): Promise<void> => {
    const before = await candidate(); const project = before.project; const staged = speech(project, 2600);
    const cue = project.audioCues.find((value): boolean => value.id === staged.cueId)!;
    const text = project.dataset.units.find((value): boolean => value.id === cue.unitId)!.text;
    const pronunciation = [{ sourceText: text.slice(0, 2), occurrence: 1, readAs: '읽는 방법' }];
    const intent = createSpeechRetakeIntent(project, { cueId: cue.id, voice, latestEndMs: 9000, pronunciation });
    const evidence = speechPronunciationEvidence(text, pronunciation)!;
    const file = existingPlanAudio(project, before.writes)[0]!;
    expect(() => compileSpeechRetake(project, intent, staged, file, provenance())).toThrowError(expect.objectContaining({ code: 'SPEECH_PRONUNCIATION_MISMATCH' }));
    const result = { ...staged, result: { ...staged.result, pronunciation: evidence } };
    const next = compileSpeechRetake(project, intent, result, file, provenance());
    expect(next.project.dataset).toEqual(project.dataset); expect(next.project.textCues).toEqual(project.textCues);
    expect(next.project.generationRecords.at(-1)?.templateVersion).toBe('automatic-speech-retake-1.1.0');
    expect(JSON.parse(next.project.generationRecords.at(-1)!.prompt)).toMatchObject({ sourceText: text, pronunciation: evidence, intent });
    expect(() => compileSpeechRetake(project, intent, { ...result, result: { ...result.result, pronunciation: { ...evidence, spokenTextHash: 'a'.repeat(64) } } }, file, provenance())).toThrowError(expect.objectContaining({ code: 'SPEECH_PRONUNCIATION_MISMATCH' }));
    const unrequested = createSpeechRetakeIntent(project, { cueId: cue.id, voice, latestEndMs: 9000 });
    expect(() => compileSpeechRetake(project, unrequested, result, file, provenance())).toThrowError(expect.objectContaining({ code: 'SPEECH_PRONUNCIATION_MISMATCH' }));
  });

  it('speech_retake_preserves_originals_other_cues_and_reviews_while_appending_measured_version', async (): Promise<void> => {
    const before = await candidate(); const project = before.project; const frozen = automaticHash(project);
    const staged = speech(project, 2600); const cue = project.audioCues.find((value): boolean => value.id === staged.cueId)!;
    const intent = createSpeechRetakeIntent(project, { cueId: cue.id, voice, latestEndMs: 9000 });
    const next = compileSpeechRetake(project, intent, staged, existingPlanAudio(project, before.writes)[0]!, provenance());
    expect(automaticHash(project)).toBe(frozen); expect(next.project.dataset).toEqual(project.dataset);
    for (const field of ['shots', 'frames', 'textCues', 'textMappingDecisions', 'profile'] as const) expect(next.project[field]).toEqual(project[field]);
    expect(next.project.audioCues.find((value): boolean => value.id === cue.id)).toMatchObject({ startMs: 5000, endMs: 7600, timingStatus: 'measured' });
    expect(next.project.audioCues.filter((value): boolean => value.id !== cue.id)).toEqual(project.audioCues.filter((value): boolean => value.id !== cue.id));
    expect(next.project.assets.slice(0, -1)).toEqual(project.assets); expect(next.project.assets.at(-1)?.version).toBe(2);
    expect(next.project.generationRecords.slice(0, -1)).toEqual(project.generationRecords);
    expect(next.project.generationRecords.at(-1)).toMatchObject({ provider: 'macos-speech', model: `say:${voice.name}` });
    expect(next.writes[0]?.content).toEqual(staged.result.bytes);
  });

  it('speech_retake_rejects_stale_source_wrong_voice_corrupt_previous_and_overlong_or_overlapping_audio', async (): Promise<void> => {
    const before = await candidate(); const project = before.project; const staged = speech(project, 2600);
    const cue = project.audioCues.find((value): boolean => value.id === staged.cueId)!;
    const input = { cueId: cue.id, voice, latestEndMs: 7600 };
    const intent = createSpeechRetakeIntent(project, input); const file = existingPlanAudio(project, before.writes)[0]!;
    expect(() => compileSpeechRetake(project, intent, speech(project, 2700), file, provenance())).toThrowError(expect.objectContaining({ code: 'AUTOMATION_RETAKE_TOO_LONG' }));
    expect(() => compileSpeechRetake(project, intent, staged, { ...file, bytes: Buffer.from('broken') }, provenance())).toThrow();
    expect(() => compileSpeechRetake(project, intent, { ...staged, result: { ...staged.result, voice: { ...voice, name: 'Yuna' } } }, file, provenance())).toThrowError(expect.objectContaining({ code: 'AUTOMATION_RETAKE_RESULT' }));
    const edited = { ...project, dataset: { ...project.dataset, units: project.dataset.units.map((unit) => unit.id === cue.unitId ? { ...unit, text: '제작자가 고친 원문' } : unit) } };
    expect(() => compileSpeechRetake(edited, intent, staged, file, provenance())).toThrowError(expect.objectContaining({ code: 'AUTOMATION_RETAKE_STALE' }));
    expect(() => compileSpeechRetake({ ...project, projectId: 'another-story' }, intent, staged, file, provenance())).toThrowError(expect.objectContaining({ code: 'AUTOMATION_RETAKE_STALE' }));
    const overlapping = { ...project, audioCues: [...project.audioCues, { ...cue, id: 'next-voice', startMs: 7500, endMs: 9800, assetId: null, timingStatus: 'proposed' as const }] };
    expect(() => compileSpeechRetake(overlapping, createSpeechRetakeIntent(overlapping, input), staged, file, provenance())).toThrowError(expect.objectContaining({ code: 'AUTOMATION_RETAKE_OVERLAP' }));
    expect(() => createSpeechRetakeIntent(project, { ...input, latestEndMs: 99999 })).toThrowError(expect.objectContaining({ code: 'AUTOMATION_RETAKE_WINDOW' }));
  });

  it('speech_retake_respects_protected_shots_shared_audio_and_information_gates', async (): Promise<void> => {
    const before = await candidate(); const project = before.project; const staged = speech(project, 2600);
    const input = { cueId: staged.cueId, voice, latestEndMs: 9000 };
    for (const protectedProject of [
      { ...project, shots: project.shots.map((shot) => ({ ...shot, approvalStatus: 'approved' as const })) },
      { ...project, shots: project.shots.map((shot) => ({ ...shot, lockedFields: ['timing' as const] })) },
    ]) expect(() => createSpeechRetakeIntent(protectedProject, input)).toThrowError(expect.objectContaining({ code: 'AUTOMATION_RETAKE_PROTECTED' }));
    const frame = project.frames.find((value): boolean => project.shots.some((shot): boolean => shot.id === value.shotId && shot.segmentId === 'demonstration'))!;
    const reviewed: Project = { ...project, assets: [...project.assets, { id: 'reviewed-image', kind: 'image', subjectId: frame.id, path: 'assets/reviewed.png', mimeType: 'image/png', sha256: 'a'.repeat(64), durationMs: null, version: 1, description: '승인 그림 메타데이터 검증' }],
      frames: project.frames.map((value) => value.id === frame.id ? { ...value, imageAssetId: 'reviewed-image', visualReview: 'accepted' as const } : value) };
    const afterReview = compileSpeechRetake(reviewed, createSpeechRetakeIntent(reviewed, input), staged, existingPlanAudio(project, before.writes)[0]!, provenance());
    expect(afterReview.project.frames).toEqual(reviewed.frames);
    const early = { ...project, dataset: { ...project.dataset, informationRules: project.dataset.informationRules.map((rule) => ({ ...rule, baseNotBeforeMs: 6000 })) } };
    expect(() => compileSpeechRetake(early, createSpeechRetakeIntent(early, input), staged, existingPlanAudio(project, before.writes)[0]!, provenance())).toThrowError(expect.objectContaining({ code: 'AUTOMATION_RETAKE_INVALID' }));
    expect(() => createSpeechRetakeIntent(project, { ...input, cueId: project.audioCues.find((cue): boolean => cue.kind === 'sfx')!.id })).toThrowError(expect.objectContaining({ code: 'AUTOMATION_RETAKE_TARGET' }));
  });

  it('speech_retake_run_binds_one_task_and_keeps_legacy_hashes_without_expanding_production', async (): Promise<void> => {
    const project = (await candidate()).project; const cueId = stagedPlanSpeech(project).cueId;
    const created = initial(project); const legacy = createAutomationRun(created);
    expect(legacy.settingsHash).toBe(automaticHash({ settings: created.settings, generatorBuild: created.generatorBuild }));
    const purpose = createSpeechRetakeIntent(project, { cueId, voice, latestEndMs: 9000 });
    const run = createAutomationRun({ ...created, purpose }); const work = nextAutomaticWork(run, project);
    expect(work.kind).toBe('register'); if (work.kind !== 'register') throw new Error('작업 등록이 필요합니다.');
    expect(work.jobs.map((job) => job.task)).toEqual([purpose]);
    expect(run.settingsHash).not.toBe(legacy.settingsHash);
    expect(() => reduceAutomationRun(run, { type: 'jobs-added', at: created.at, jobs: [{ ...work.jobs[0]!, task: { kind: 'text-layout' } }] })).toThrow();
    expect(() => reduceAutomationRun(legacy, { type: 'jobs-added', at: created.at, jobs: work.jobs })).toThrow();
    expect(() => reduceAutomationRun(run, { type: 'jobs-added', at: created.at, jobs: [{ ...work.jobs[0]!, task: { ...purpose, voice: { ...voice, rateWordsPerMinute: 170 } } }] })).toThrow();
  });

  it('speech_retake_service_http_runs_only_selected_voice_and_preserves_both_versions', async (): Promise<void> => {
    const h = await createExecutionHarness(async (): Promise<void> => {});
    const model = vi.fn(h.engine.model.run); const image = vi.fn(h.engine.image.run);
    const synth = vi.fn(async () => speech(await h.services.projects.read(h.source.projectId), 2600).result);
    const service = new AutomationService({ services: { ...h.services, engines: () => ({ ...h.engine, voiceCatalog: async () => catalog, model: { run: model }, image: { run: image }, speech: { run: synth } }) }, listSpeechVoices: async () => catalog, onError: vi.fn() });
    const app = Fastify(); registerAutomationRoutes(app, service, 'Yuna');
    app.setErrorHandler((error: Error, request, reply): void => { reply.code(httpErrorPolicy(error).status).send(errorBody(error, request)); });
    try {
      await service.initialize(); await service.cancel(h.source.projectId, h.id);
      const first = await candidate(); const project = await h.services.projects.update(h.source.projectId, 0, () => first.project, first.writes);
      const file = (await h.services.projects.asset(project.projectId, project.audioCues.find((cue): boolean => cue.unitId === '안내-1')!.assetId!)).content;
      const base = `/api/projects/${encodeURIComponent(project.projectId)}/automation/speech-retakes`;
      const input = { cueId: stagedPlanSpeech(project).cueId, voice, latestEndMs: 9000 };
      const payload = { expectedRevision: project.revision, input, settings };
      expect((await app.inject({ method: 'POST', url: base, headers: { origin: 'https://foreign.example' }, payload })).statusCode).toBe(400);
      expect((await app.inject({ method: 'POST', url: base, payload: { ...payload, expectedRevision: 0 } })).statusCode).toBe(409);
      const uninstalled = await app.inject({ method: 'POST', url: base, payload: { ...payload, input: { ...input, voice: { ...voice, name: 'uninstalled' } } } });
      expect(uninstalled.statusCode).toBe(400); expect(uninstalled.json().error.code).toBe('SPEECH_VOICE_NOT_INSTALLED');
      const badReading = await app.inject({ method: 'POST', url: base, payload: { ...payload, input: { ...input, pronunciation: [{ sourceText: '원문에 없는 표현', occurrence: 1, readAs: '아무 값' }] } } });
      expect(badReading.statusCode).toBe(400); expect(badReading.json().error.code).toBe('SPEECH_PRONUNCIATION_SOURCE_MISSING');
      expect(synth).not.toHaveBeenCalled();
      const response = await app.inject({ method: 'POST', url: base, payload }); expect(response.statusCode).toBe(202);
      const id: string = response.json().run.id;
      await vi.waitFor(async (): Promise<void> => { expect((await service.read(project.projectId, id)).status).toBe('review-ready'); }, { timeout: 4000, interval: 50 });
      const current = await h.services.projects.read(project.projectId);
      expect(current.revision).toBe(2); expect(current.assets).toHaveLength(project.assets.length + 1);
      expect((await h.services.projects.asset(project.projectId, project.assets[0]!.id)).content).toEqual(file);
      expect(synth).toHaveBeenCalledOnce(); expect(model).not.toHaveBeenCalled(); expect(image).not.toHaveBeenCalled();
      expect(synth.mock.calls[0]).toBeDefined(); expect((await service.read(project.projectId, id)).jobs.map((job) => job.task.kind)).toEqual(['speech-retake']);
    } finally { await app.close(); await service.close(); await h.close(); }
  });

  it('speech_retake_restart_reuses_cached_synthesis_and_commits_exactly_once', async (): Promise<void> => {
    const h = await createExecutionHarness(async (): Promise<void> => {}); const abort = new AbortController();
    const synth = vi.fn(async (input: SpeechGenerationInput) => ({ ...speech(await h.services.projects.read(h.source.projectId), 2600).result, pronunciation: speechPronunciationEvidence(input.unit.text, input.pronunciation)! }));
    const services = { ...h.services, engines: () => ({ ...h.engine, voiceCatalog: async () => catalog, speech: { run: synth } }), onSpeechReady: async (): Promise<void> => { abort.abort(); } };
    const executor = new AutomationRunExecutor(services);
    try {
      await executor.cancel(h.id);
      const first = await candidate(); const project = await h.services.projects.update(h.source.projectId, 0, () => first.project, first.writes);
      const target = stagedPlanSpeech(project); const text = project.dataset.units.find((unit): boolean => unit.id === target.result.unitId)!.text;
      const intent = createSpeechRetakeIntent(project, { cueId: target.cueId, voice, latestEndMs: 9000, pronunciation: [{ sourceText: text.slice(0, 2), occurrence: 1, readAs: '발음 검토' }] });
      const created = { ...initial(project), generatorBuild: h.services.generatorBuild, purpose: intent };
      await h.services.runs.create(created, project);
      const paused = await executor.run(created.id, abort.signal); expect(paused.run.status).toBe('paused'); expect(synth).toHaveBeenCalledOnce();
      expect((await h.services.projects.read(project.projectId)).revision).toBe(1);
      const restarted = new AutomationRunExecutor({ ...services, onSpeechReady: async (): Promise<void> => {} });
      await restarted.run(created.id, AbortSignal.abort()); const snapshot = await h.services.runs.read(created.id);
      await h.services.runs.append(created.id, snapshot.sequence, { type: 'resumed', revision: project.revision, projectHash: automaticHash(project), at: new Date().toISOString() });
      const result = await restarted.run(created.id, new AbortController().signal);
      expect(result.run.status).toBe('review-ready'); expect(synth).toHaveBeenCalledOnce();
      expect(synth.mock.calls[0]?.[0].pronunciation).toEqual(intent.pronunciation);
      expect(JSON.parse((await h.services.projects.read(project.projectId)).generationRecords.at(-1)!.prompt).pronunciation.replacements).toEqual(intent.pronunciation);
      expect((await h.services.projects.read(project.projectId)).revision).toBe(2);
      await restarted.run(created.id, new AbortController().signal); expect((await h.services.projects.read(project.projectId)).revision).toBe(2);
    } finally { await h.close(); }
  });
});

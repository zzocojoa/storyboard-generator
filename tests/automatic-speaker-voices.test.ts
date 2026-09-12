import Fastify from 'fastify';
import { z } from 'zod';
import { describe, expect, it, vi } from 'vitest';
import { automaticHash } from '../src/automation/application-evidence.js';
import { AutomationRunExecutor } from '../src/automation/run-executor.js';
import { AutomationService } from '../src/automation/service.js';
import { executeAutomaticTask } from '../src/automation/task-executor.js';
import type { SpeechGenerationInput, SpeechGenerationResult } from '../src/codex/speech-engine.js';
import { contractError } from '../src/domain/errors.js';
import type { InstalledSpeechVoice, SpeakerVoice } from '../src/domain/speech-voice.js';
import { errorBody, httpErrorPolicy } from '../src/server/app.js';
import { registerAutomationRoutes } from '../src/server/automation-routes.js';
import { createExecutionHarness, initial, settings } from './automatic-executor-helpers.js';
import { automaticPlanProvenance, stagedPlanSpeech } from './automatic-plan-helpers.js';
import { manualMissingSpeechProject, missingSpeechPlan } from './automatic-missing-speech-helpers.js';

const choices: SpeakerVoice[] = [{ speakerId: 'CHAR-01', voice: { name: 'Test Korean', rateWordsPerMinute: 160 } }];
const catalog: InstalledSpeechVoice[] = [{ name: 'Yuna', locale: 'ko_KR', sample: '안녕하세요' }, { name: 'Test Korean', locale: 'ko_KR', sample: '검토 음성' }];

describe('자동 실행의 화자 음성', (): void => {
  it('automatic_speaker_voice_preflight_rejects_missing_voices_and_foreign_speakers_without_creating_runs', async (): Promise<void> => {
    const h = await createExecutionHarness(async (): Promise<void> => {});
    const list = vi.fn(async (): Promise<InstalledSpeechVoice[]> => structuredClone(catalog));
    const service = new AutomationService({ services: h.services, listSpeechVoices: list, onError: vi.fn() });
    const app = Fastify(); registerAutomationRoutes(app, service, 'Yuna');
    app.setErrorHandler((error: Error, request, reply): void => { reply.code(httpErrorPolicy(error).status).send(errorBody(error, request)); });
    try {
      await service.initialize(); await service.cancel(h.source.projectId, h.id);
      const before = await h.services.projects.read(h.source.projectId);
      const response = await app.inject({ method: 'GET', url: '/api/automation/speech-voices' });
      expect(response.statusCode).toBe(200); expect(response.json()).toEqual({ voices: catalog });
      await expect(service.start(h.source.projectId, 0, ['demonstration'], { ...settings, speakerVoices: [{ ...choices[0]!, speakerId: 'foreign' }] })).rejects.toMatchObject({ code: 'AUTOMATION_SPEAKER_NOT_SPOKEN' });
      list.mockResolvedValueOnce([catalog[0]!]);
      await expect(service.start(h.source.projectId, 0, ['demonstration'], { ...settings, speakerVoices: choices })).rejects.toMatchObject({ code: 'SPEECH_VOICE_NOT_INSTALLED' });
      list.mockRejectedValueOnce(contractError('SPEECH_COMMAND_FAILED', '목록 명령 실패', []));
      await expect(service.start(h.source.projectId, 0, ['demonstration'], settings)).rejects.toMatchObject({ code: 'SPEECH_COMMAND_FAILED' });
      expect(await service.list(h.source.projectId)).toHaveLength(1); expect(await h.services.projects.read(h.source.projectId)).toEqual(before);
      list.mockImplementationOnce(async () => { await h.services.projects.update(h.source.projectId, 0, (project) => ({ ...project, title: '동시에 수정한 제목' }), []); return catalog; });
      await expect(service.start(h.source.projectId, 0, ['demonstration'], { ...settings, speakerVoices: choices })).rejects.toMatchObject({ code: 'REVISION_CONFLICT' });
      expect(await service.list(h.source.projectId)).toHaveLength(1);
    } finally { await service.close(); await app.close(); await h.close(); }
  });

  it('automatic_speaker_voice_survives_restart_reuses_measured_cache_and_records_actual_voice', async (): Promise<void> => {
    const h = await createExecutionHarness(async (): Promise<void> => {});
    try {
      await new AutomationRunExecutor(h.services).cancel(h.id);
      const created = { ...initial(h.source), settings: { ...settings, speakerVoices: choices } };
      await h.services.runs.create(created, h.source);
      const speech = vi.fn(async (input: SpeechGenerationInput): Promise<SpeechGenerationResult> => ({ ...stagedPlanSpeech(h.source).result, voice: { ...input.voice } }));
      h.engine.speech.run = speech;
      const first = new AbortController(); const model = h.engine.model.run;
      h.engine.model.run = async (input, signal) => { const output = await model(input, signal); if (speech.mock.calls.length > 0) first.abort(); return output; };
      const paused = await new AutomationRunExecutor(h.services).run(created.id, first.signal);
      expect(paused.run.status).toBe('paused'); expect(speech).toHaveBeenCalledTimes(1);
      expect(speech.mock.calls[0]![0].voice).toEqual(choices[0]!.voice);
      expect((await h.services.projects.read(h.source.projectId)).audioCues.every((cue): boolean => cue.assetId === null)).toBe(true);
      h.engine.model.run = model;
      const service = new AutomationService({ services: h.services, listSpeechVoices: async () => catalog, onError: vi.fn() });
      try {
        await service.initialize(); expect(speech).toHaveBeenCalledTimes(1);
        const current = await h.services.projects.read(h.source.projectId); const snapshot = await h.services.runs.read(created.id);
        await h.services.runs.append(created.id, snapshot.sequence, { type: 'resumed', revision: current.revision, projectHash: automaticHash(current), at: new Date().toISOString() });
        const completed = await new AutomationRunExecutor(h.services).run(created.id, new AbortController().signal);
        expect(completed.run.status).toBe('review-ready'); expect(completed.run.settings).toEqual(created.settings);
        expect(speech).toHaveBeenCalledTimes(1);
        const saved = await h.services.projects.read(h.source.projectId); const record = saved.generationRecords.find((entry): boolean => entry.provider === 'macos-speech')!;
        expect(JSON.parse(record.prompt)).toMatchObject({ voice: choices[0]!.voice, cacheEvidence: { reused: true } });
        expect(record.model).toBe('say:Test Korean'); expect(saved.dataset).toEqual(h.source.dataset);
        expect(saved.audioCues.find((cue): boolean => cue.unitId === '안내-1')).toMatchObject({ timingStatus: 'measured', startMs: 5000, endMs: 7300 });
        expect(saved.frames.every((frame): boolean => frame.visualReview === 'pending')).toBe(true);
      } finally { await service.close(); }
    } finally { await h.close(); }
  });

  it('automatic_speaker_voice_repair_uses_override_and_preserves_manual_direction_and_source', async (): Promise<void> => {
    const h = await createExecutionHarness(async (): Promise<void> => {});
    try {
      const manual = await manualMissingSpeechProject();
      const project = await h.services.projects.update(h.source.projectId, 0, (current) => ({ ...current, shots: manual.shots }), []);
      const before = structuredClone(project); const { model: _model, turnId: _turnId, prompt: _prompt, ...provenance } = automaticPlanProvenance();
      const speech = vi.fn(async (input: SpeechGenerationInput): Promise<SpeechGenerationResult> => ({ ...stagedPlanSpeech(project).result, voice: { ...input.voice } }));
      const candidate = await executeAutomaticTask({ project, task: { kind: 'repair', segmentId: 'demonstration' }, settings: { ...settings, speakerVoices: choices }, remainingBytes: settings.maxStagedBytes, provenance },
        { store: h.services.projects, textFontPath: h.services.textFontPath, onProgress: async (): Promise<void> => {}, onSpeechReady: async (): Promise<void> => {}, engines: { ...h.engine, speech: { run: speech }, model: { run: async () => ({ model: 'test', turnId: 'repair', result: z.json().parse(missingSpeechPlan(project, 2300)) }) } } }, new AbortController().signal);
      expect(speech.mock.calls[0]![0].voice).toEqual(choices[0]!.voice);
      expect(JSON.parse(candidate.project.generationRecords.find((record): boolean => record.provider === 'macos-speech')!.prompt)).toMatchObject({ voice: choices[0]!.voice });
      expect(candidate.project.shots.map((shot) => ({ action: shot.action, camera: shot.camera }))).toEqual(before.shots.map((shot) => ({ action: shot.action, camera: shot.camera })));
      expect(candidate.project.dataset).toEqual(before.dataset); expect(await h.services.projects.read(h.source.projectId)).toEqual(before);
    } finally { await h.close(); }
  });
});

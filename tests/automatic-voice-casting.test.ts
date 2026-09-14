import type { SpeechGenerationInput, SpeechGenerationResult } from '../src/codex/speech-engine.js';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { describe, expect, it, vi } from 'vitest';
import { automaticHash } from '../src/automation/application-evidence.js';
import { nextAutomaticWork } from '../src/automation/job-graph.js';
import { planAutomaticVoiceCasting } from '../src/automation/plan-voice-casting.js';
import { AutomationRunExecutor } from '../src/automation/run-executor.js';
import { AutomationSettingsSchema } from '../src/automation/run-schema.js';
import type { AutomationSettings } from '../src/automation/run-schema.js';
import { createAutomationRun } from '../src/automation/run-state.js';
import { missingVoiceCastingSpeakers, requiredAutomationSpeechVoices, resolvedAutomationSpeakerVoices } from '../src/automation/speech-settings.js';
import type { StructuredGenerationResult } from '../src/codex/structured-engine.js';
import type { Project } from '../src/domain/schema.js';
import type { InstalledSpeechVoice } from '../src/domain/speech-voice.js';
import { voiceCastingIssues } from '../src/domain/voice-casting.js';
import { parseProject, parseProjectSnapshotEvidence } from '../src/io/project.js';
import { automaticPlanProject, automaticPlanProvenance, stagedPlanSpeech } from './automatic-plan-helpers.js';
import { createExecutionHarness, initial, settings } from './automatic-executor-helpers.js';
import { manualMissingSpeechProject } from './automatic-missing-speech-helpers.js';

const automatic: AutomationSettings = { ...settings, speakerVoices: [], voicePlanning: 'automatic' };
const catalog: InstalledSpeechVoice[] = [{ name: 'Yuna', locale: 'ko_KR', sample: '안녕하세요' }, { name: 'Test Korean', locale: 'ko_KR', sample: '차분하게 안내합니다' }];
const selectedVoice = { name: 'Test Korean', rateWordsPerMinute: 160 };
const plan = { version: '1.0.0', status: 'ready', summary: '원문 언어와 안내 역할에 맞춘 음성 배정', assignments: [{ speakerId: 'CHAR-01', language: 'ko', voice: selectedVoice, reason: '한국어 안내 원문을 차분하게 전달하도록 160 단어/분으로 제안합니다.' }] };
const provenance = (): Omit<ReturnType<typeof automaticPlanProvenance>, 'model' | 'turnId' | 'prompt'> => ({ generationId: randomUUID(), generatorBuild: automaticPlanProvenance().generatorBuild, createdAt: automaticPlanProvenance().createdAt });
const signal: AbortSignal = new AbortController().signal;
const output = (value: unknown): StructuredGenerationResult => ({ model: 'casting-test', turnId: randomUUID(), result: z.json().parse(value) });
const services = () => ({ model: { run: vi.fn(async (): Promise<StructuredGenerationResult> => output(plan)) }, catalog: vi.fn(async (): Promise<InstalledSpeechVoice[]> => structuredClone(catalog)), onProgress: vi.fn(async (): Promise<void> => {}) });

describe('Codex 화자 자동 배정', (): void => {
  it('automatic_voice_casting_plans_missing_speakers_persists_reason_and_prioritizes_manual_choices', async (): Promise<void> => {
    const project = await automaticPlanProject(); const before = structuredClone(project); const engines = services();
    const candidate = await planAutomaticVoiceCasting(project, ['demonstration'], automatic, provenance(), engines, signal);
    expect(candidate.voiceCasting?.assignments).toEqual([{ speakerId: 'CHAR-01', voice: selectedVoice, reason: plan.assignments[0]!.reason, locale: 'ko_KR', sourceUnitIds: ['안내-1'] }]);
    expect(voiceCastingIssues(candidate)).toEqual([]); expect(parseProject(candidate)).toEqual(candidate);
    const { voiceCasting: _casting, generationRecords: _records, ...rest } = candidate;
    const { generationRecords: _oldRecords, ...original } = before; expect(rest).toEqual(original); expect(project).toEqual(before);
    expect(missingVoiceCastingSpeakers(candidate, ['demonstration'], automatic)).toEqual([]);
    expect(resolvedAutomationSpeakerVoices(candidate, ['demonstration'], automatic)).toEqual([{ speakerId: 'CHAR-01', voice: selectedVoice }]);
    const manual = { ...automatic, speakerVoices: [{ speakerId: 'CHAR-01', voice: settings.voice }] };
    expect(resolvedAutomationSpeakerVoices(candidate, ['demonstration'], manual)).toEqual(manual.speakerVoices);
    expect(requiredAutomationSpeechVoices(project, ['demonstration'], { ...automatic, voice: { name: 'Unused Common', rateWordsPerMinute: 180 } })).toEqual([]);
    expect(engines.model.run).toHaveBeenCalledTimes(1); expect(engines.catalog).toHaveBeenCalledTimes(2);
  });

  it('automatic_voice_casting_reuses_current_source_but_requires_replanning_changed_or_other_project_sources', async (): Promise<void> => {
    const project = await automaticPlanProject(); const candidate = await planAutomaticVoiceCasting(project, ['demonstration'], automatic, provenance(), services(), signal);
    for (const changed of [{ ...candidate, projectId: 'another-story' }, { ...candidate, dataset: { ...candidate.dataset, title: '수정된 원본' } }]) {
      expect(missingVoiceCastingSpeakers(changed, ['demonstration'], automatic)).toHaveLength(1);
      expect(() => resolvedAutomationSpeakerVoices(changed, ['demonstration'], automatic)).toThrowError(expect.objectContaining({ code: 'AUTOMATION_VOICE_CASTING_REQUIRED' }));
      expect(voiceCastingIssues(changed)).toEqual([]);
    }
    const tampered: Project = { ...candidate, voiceCasting: { ...candidate.voiceCasting!, assignments: candidate.voiceCasting!.assignments.map((entry) => ({ ...entry, voice: settings.voice })) } };
    expect(voiceCastingIssues(tampered)[0]?.code).toBe('INVALID_VOICE_CASTING'); expect(() => parseProject(tampered)).toThrow();
    const existing: Project = { ...candidate, audioCues: candidate.audioCues.map((cue) => cue.kind === 'voiceover' ? { ...cue, assetId: 'existing', timingStatus: 'measured' } : cue) };
    expect(requiredAutomationSpeechVoices(existing, ['demonstration'], automatic)).toEqual([]);
  });

  it('automatic_voice_casting_rejects_unknown_duplicate_missing_voices_and_changed_catalog_with_finite_corrections', async (): Promise<void> => {
    const project = await automaticPlanProject(); const before = structuredClone(project);
    for (const assignments of [[], [...plan.assignments, ...plan.assignments], [{ ...plan.assignments[0], speakerId: 'foreign' }], [{ ...plan.assignments[0], language: 'en' }], [{ ...plan.assignments[0], voice: { ...selectedVoice, name: 'Invented' } }]]) {
      const engine = services(); engine.model.run.mockResolvedValue(output({ ...plan, assignments }));
      await expect(planAutomaticVoiceCasting(project, ['demonstration'], automatic, provenance(), engine, signal)).rejects.toThrow();
      expect(engine.model.run).toHaveBeenCalledTimes(2); expect(project).toEqual(before);
    }
    const corrected = services(); corrected.model.run.mockResolvedValueOnce(output({ ...plan, assignments: [] }));
    expect((await planAutomaticVoiceCasting(project, ['demonstration'], automatic, provenance(), corrected, signal)).voiceCasting?.assignments).toHaveLength(1);
    const changed = services(); changed.catalog.mockResolvedValueOnce(structuredClone(catalog)).mockResolvedValue([catalog[0]!]);
    await expect(planAutomaticVoiceCasting(project, ['demonstration'], automatic, provenance(), changed, signal)).rejects.toMatchObject({ code: 'AUTOMATION_VOICE_CATALOG_CHANGED' });
    const unsupported = services(); unsupported.model.run.mockResolvedValue(output({ ...plan, status: 'unsupported-language', assignments: [], summary: '이 원문 언어의 음성이 설치되지 않았습니다.' }));
    await expect(planAutomaticVoiceCasting(project, ['demonstration'], automatic, provenance(), unsupported, signal)).rejects.toMatchObject({ code: 'AUTOMATION_VOICE_LANGUAGE_UNSUPPORTED' });
    expect(unsupported.model.run).toHaveBeenCalledTimes(1);
    const controller = new AbortController(); controller.abort(); const stopped = services();
    await expect(planAutomaticVoiceCasting(project, ['demonstration'], automatic, provenance(), stopped, controller.signal)).rejects.toMatchObject({ code: 'AUTOMATION_CANCELLED' });
    expect(stopped.model.run).not.toHaveBeenCalled(); expect(project).toEqual(before);
  });

  it('automatic_voice_casting_job_respects_legacy_settings_selected_scope_and_protected_speech', async (): Promise<void> => {
    const project = await automaticPlanProject(); const created = initial(project);
    const run = createAutomationRun({ ...created, settings: automatic });
    expect(nextAutomaticWork(run, project)).toMatchObject({ kind: 'register', jobs: [{ task: { kind: 'voice-casting', segmentIds: ['demonstration'] } }] });
    expect(nextAutomaticWork(createAutomationRun(created), project)).not.toMatchObject({ jobs: [{ task: { kind: 'voice-casting' } }] });
    expect(AutomationSettingsSchema.parse(settings)).toEqual(settings);
    expect(missingVoiceCastingSpeakers(project, ['missing-selection'], automatic)).toEqual([]);
    const protectedProject: Project = { ...project, shots: project.shots.map((shot) => ({ ...shot, approvalStatus: 'approved' })) };
    expect(missingVoiceCastingSpeakers(protectedProject, ['demonstration'], automatic)).toEqual([]);
  });

  it('automatic_voice_casting_commits_before_speech_and_reuses_assignment_after_executor_restart', async (): Promise<void> => {
    let failOnce: boolean = true; const interrupted = new AbortController();
    const h = await createExecutionHarness(async (phase): Promise<void> => { if (phase === 'after-project-commit' && failOnce) { failOnce = false; interrupted.abort(); throw new Error('배정 Commit 이후 중단 검증'); } });
    try {
      await new AutomationRunExecutor(h.services).cancel(h.id);
      // 기존 편집 컷에서 배정→재시작→음성만 검사하며 무관한 제작 계획·기준 그림을 생성하지 않는다.
      const manual = await manualMissingSpeechProject();
      const source = await h.services.projects.update(h.source.projectId, 0, (current): Project => ({ ...current, shots: manual.shots }), []);
      const created = { ...initial(source), settings: automatic }; await h.services.runs.create(created, source);
      h.engine.voiceCatalog = async (): Promise<InstalledSpeechVoice[]> => structuredClone(catalog);
      const casting = vi.fn(async (): Promise<StructuredGenerationResult> => output(plan));
      const image = vi.fn(async (): Promise<never> => { throw new Error('음성 배정 재시작 검사에서 그림 생성을 호출할 수 없습니다.'); });
      h.engine.model.run = casting; h.engine.image.run = image;
      const speech = vi.fn(async (input: SpeechGenerationInput): Promise<SpeechGenerationResult> => ({ ...stagedPlanSpeech(await h.services.projects.read(h.source.projectId)).result, voice: { ...input.voice } }));
      h.engine.speech.run = speech;
      const first = await new AutomationRunExecutor(h.services).run(created.id, interrupted.signal);
      expect(first.run.status).toBe('paused'); expect(speech).not.toHaveBeenCalled();
      const cast = await h.services.projects.read(h.source.projectId); expect(cast.voiceCasting?.assignments[0]?.voice).toEqual(selectedVoice);
      const stopped = new AbortController(); stopped.abort();
      await new AutomationRunExecutor(h.services).run(created.id, stopped.signal);
      const current = await h.services.projects.read(h.source.projectId); const snapshot = await h.services.runs.read(created.id);
      await h.services.runs.append(created.id, snapshot.sequence, { type: 'resumed', revision: current.revision, projectHash: automaticHash(current), at: new Date().toISOString() });
      const afterSpeech = new AbortController();
      h.services.onSpeechReady = async (): Promise<void> => { afterSpeech.abort(); };
      const resumed = await new AutomationRunExecutor(h.services).run(created.id, afterSpeech.signal);
      expect(resumed.run.status).toBe('paused'); expect(casting).toHaveBeenCalledTimes(1); expect(image).not.toHaveBeenCalled();
      expect(resumed.run.jobs.map((job): string => job.task.kind)).toEqual(['voice-casting', 'repair']); expect(speech).toHaveBeenCalledTimes(1);
      expect(speech.mock.calls[0]![0].voice).toEqual(selectedVoice);
      const final = await h.services.projects.read(h.source.projectId);
      expect(final.voiceCasting).toEqual(cast.voiceCasting); expect(final.dataset).toEqual(source.dataset); expect(final.shots).toEqual(source.shots);
      expect(final.generationRecords.filter((record): boolean => record.templateVersion === 'automatic-voice-casting-1.0.0')).toHaveLength(1);
      expect(final.frames.every((frame): boolean => frame.visualReview !== 'accepted')).toBe(true);
    } finally { await h.close(); }
  });

  it('automatic_voice_casting_migration_preserves_legacy_snapshot_hashes_without_inventing_assignments', async (): Promise<void> => {
    const project = await automaticPlanProject(); const legacy = { ...project, schemaVersion: '1.16.0' }; const before = JSON.stringify(legacy);
    const evidence = parseProjectSnapshotEvidence(legacy);
    expect(evidence.project).toEqual(project); expect(evidence.project).not.toHaveProperty('voiceCasting');
    expect(evidence.projectionHashes).toContain(automaticHash(legacy)); expect(JSON.stringify(legacy)).toBe(before);
    expect(() => parseProject({ ...legacy, voiceCasting: null })).toThrowError(expect.objectContaining({ code: 'UNSUPPORTED_LEGACY_VOICE_CASTING' }));
  });
});

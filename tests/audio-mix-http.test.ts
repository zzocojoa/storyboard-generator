import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';
import { expect, it } from 'vitest';
import { automaticHash } from '../src/automation/application-evidence.js';
import { AutomationSettingsSchema } from '../src/automation/run-schema.js';
import { createAutomationRun, reduceAutomationRun } from '../src/automation/run-state.js';
import { executeAutomaticTask } from '../src/automation/task-executor.js';
import { sha256Text } from '../src/importers/integrity.js';
import { errorBody, httpErrorPolicy } from '../src/server/app.js';
import { registerAudioMixRoutes } from '../src/server/audio-mix-routes.js';
import { recommendedAutomationSettings } from '../src/server/automation-routes.js';
import { ProjectStore } from '../src/server/store.js';
import { initial, createExecutionHarness } from './automatic-executor-helpers.js';
import { audioMixFixture } from './automatic-audio-mix-helpers.js';
import { automaticPlanProvenance, automaticPlanProject } from './automatic-plan-helpers.js';
import { TEST_TEXT_FONT_PATH } from './helpers.js';

it('audio_mix_http_preserves_legacy_bytes_and_audio_files_and_rejects_stale_invalid_or_protected_edits', async (): Promise<void> => {
  const root = await mkdtemp(join(tmpdir(), 'cutroom-mix-http-')); const store = new ProjectStore(root); const app = Fastify();
  registerAudioMixRoutes(app, store); app.setErrorHandler((error: Error, request, reply): void => { reply.status(httpErrorPolicy(error).status).send(errorBody(error, request)); });
  try {
    const h = await audioMixFixture(); await store.create(await automaticPlanProject());
    const before = await store.update(h.project.projectId, 0, () => h.project, h.project.assets.map((asset) => ({ relativePath: asset.path, content: h.files.get(asset.id)! })));
    const directory: string = join(root, sha256Text(h.project.projectId)); const currentPath: string = join(directory, 'project.json');
    const legacy: string = JSON.stringify({ ...before, schemaVersion: '1.15.0' });
    await writeFile(currentPath, legacy); await writeFile(join(directory, 'versions', '000001.json'), legacy);
    expect((await store.read(h.project.projectId)).audioCues).toEqual(before.audioCues); expect(await readFile(currentPath, 'utf8')).toBe(legacy);
    const path: string = `/api/projects/${encodeURIComponent(h.project.projectId)}/audio/${h.speechId}/mix`;
    const mix = { mode: 'manual', volumeDb: -6, fadeInMs: 0, fadeOutMs: 0 };
    const response = await app.inject({ method: 'PATCH', url: path, payload: { expectedRevision: 1, mix } });
    expect(response.statusCode).toBe(200); const saved = await store.read(h.project.projectId);
    expect(saved.revision).toBe(2); expect(saved.audioCues.find((cue): boolean => cue.id === h.speechId)?.mix).toMatchObject(mix);
    for (const key of ['dataset', 'shots', 'frames', 'textCues', 'assets', 'generationRecords'] as const) expect(saved[key]).toEqual(before[key]);
    expect(await readFile(join(directory, 'versions', '000001.json'), 'utf8')).toBe(legacy);
    for (const asset of h.project.assets) expect((await store.asset(h.project.projectId, asset.id)).content).toEqual(h.files.get(asset.id));
    const snapshot = await readFile(currentPath);
    expect((await app.inject({ method: 'PATCH', url: path, payload: { expectedRevision: 1, mix } })).statusCode).toBe(409);
    expect((await app.inject({ method: 'PATCH', url: path, payload: { expectedRevision: 2, mix: { ...mix, volumeDb: 6 } } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'PATCH', url: path, payload: { expectedRevision: 2, mix: { ...mix, fadeInMs: 2000 } } })).statusCode).toBe(400);
    expect(await readFile(currentPath)).toEqual(snapshot);
    await store.update(saved.projectId, 2, (project) => ({ ...project, shots: project.shots.map((shot) => ({ ...shot, lockedFields: ['timing'] })) }), []);
    expect((await app.inject({ method: 'PATCH', url: path, payload: { expectedRevision: 3, mix } })).json().error.code).toBe('AUDIO_MIX_PROTECTED');
  } finally { await app.close(); await store.close(); await rm(root, { recursive: true, force: true }); }
});

it('audio_mix_job_requires_explicit_run_setting_and_selected_segment_without_rewriting_legacy_settings', async (): Promise<void> => {
  const h = await audioMixFixture(); const event = initial(h.project); const settings = recommendedAutomationSettings('Yuna');
  const job = { id: randomUUID(), task: { kind: 'audio-mix' as const, segmentId: 'demonstration' }, dependsOn: [] };
  const update = { type: 'jobs-added' as const, jobs: [job], at: event.at };
  expect(() => reduceAutomationRun(createAutomationRun(event), update)).toThrowError(expect.objectContaining({ code: 'AUTOMATION_RUN_TRANSITION' }));
  const run = createAutomationRun({ ...event, settings }); expect(reduceAutomationRun(run, update).jobs).toHaveLength(1);
  expect(() => reduceAutomationRun(run, { ...update, jobs: [{ ...job, task: { ...job.task, segmentId: 'other' } }] })).toThrow();
  expect(AutomationSettingsSchema.parse(event.settings)).toEqual(event.settings);
  expect(AutomationSettingsSchema.safeParse({ ...settings, audioMixPlanning: 'unknown' }).success).toBe(false);
});

it('audio_mix_executor_rejects_project_edits_during_model_execution_without_publishing_a_candidate', async (): Promise<void> => {
  const h = await createExecutionHarness(async (): Promise<void> => {});
  try {
    const fixture = await audioMixFixture();
    const project = await h.services.projects.update(fixture.project.projectId, 0, () => fixture.project, fixture.project.assets.map((asset) => ({ relativePath: asset.path, content: fixture.files.get(asset.id)! })));
    const before: string = automaticHash(project); const { model: _model, turnId: _turn, prompt: _prompt, ...provenance } = automaticPlanProvenance();
    await expect(executeAutomaticTask({ project, task: { kind: 'audio-mix', segmentId: 'demonstration' }, settings: { ...recommendedAutomationSettings('Yuna'), maxModelCorrections: 0 }, remainingBytes: 1, provenance },
      { store: h.services.projects, textFontPath: TEST_TEXT_FONT_PATH, onProgress: async (): Promise<void> => {}, onSpeechReady: async (): Promise<void> => {}, engines: { ...h.engine,
        model: { run: async (input, signal) => { await h.services.projects.update(project.projectId, 1, (current) => ({ ...current, title: '동시 사용자 편집' }), []); return h.engine.model.run(input, signal); } } } }, new AbortController().signal)).rejects.toMatchObject({ code: 'AUTOMATION_STALE_PLAN' });
    expect(automaticHash(project)).toBe(before); const saved = await h.services.projects.read(project.projectId);
    expect(saved.title).toBe('동시 사용자 편집'); expect(saved.generationRecords).toEqual(project.generationRecords); expect(saved.audioCues).toEqual(project.audioCues);
  } finally { await h.close(); }
});

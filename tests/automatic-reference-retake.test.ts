import { randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import { automaticHash } from '../src/automation/application-evidence.js';
import { nextAutomaticWork } from '../src/automation/job-graph.js';
import { generateAutomaticReference } from '../src/automation/production-reference.js';
import { assertReferenceRetakeIntent, createReferenceRetakeIntent } from '../src/automation/reference-retake.js';
import { AutomationRunExecutor } from '../src/automation/run-executor.js';
import { createAutomationRun, reduceAutomationRun } from '../src/automation/run-state.js';
import { AutomationService } from '../src/automation/service.js';
import type { Project } from '../src/domain/schema.js';
import { errorBody, httpErrorPolicy } from '../src/server/app.js';
import { registerAutomationRoutes } from '../src/server/automation-routes.js';
import { createExecutionHarness, initial, settings } from './automatic-executor-helpers.js';
import { referenceRetakeCandidate } from './reference-retake-helpers.js';
import { automaticPlanProvenance } from './automatic-plan-helpers.js';

describe('선택 기준 이미지 재생성', (): void => {
  it('reference_retake_correction_binds_prompt_and_previous_image_without_source_changes', async (): Promise<void> => {
    const h = await createExecutionHarness(async (): Promise<void> => {});
    try {
      const prepared = await referenceRetakeCandidate(h.source); const project = prepared.project; const before = structuredClone(project);
      const resource = project.productionPlan!.resources[0]!; const correctionNote = '창문 위치는 유지하고 작업대가 전부 보이도록 카메라를 뒤로 옮겨 주세요.';
      const intent = createReferenceRetakeIntent(project, { resourceId: resource.id, correctionNote });
      expect(() => assertReferenceRetakeIntent(project, { ...intent, correctionNote: '다른 수정 요청' })).toThrowError(expect.objectContaining({ code: 'AUTOMATION_REFERENCE_RETAKE_STALE' }));
      expect(() => createReferenceRetakeIntent(project, { resourceId: resource.id, correctionNote: ' ' })).toThrow();
      expect(() => createReferenceRetakeIntent(project, { resourceId: resource.id, correctionNote: '가'.repeat(4001) })).toThrow();
      const basis = assertReferenceRetakeIntent(project, intent); expect(basis.referenceAssetIds).toEqual([resource.referenceAssetId]);
      const image = vi.fn(h.engine.image.run); const { model: _model, prompt: _prompt, turnId: _turnId, ...provenance } = automaticPlanProvenance();
      const bytes = Buffer.from(prepared.writes[0]!.content);
      const result = await generateAutomaticReference(project, basis, [{ assetId: resource.referenceAssetId!, bytes }],
        { ...provenance, generationId: 'corrected-reference' }, { run: image }, new AbortController().signal);
      expect(image).toHaveBeenCalledOnce(); expect(image.mock.calls[0]?.[0].prompt).toContain(correctionNote);
      expect(image.mock.calls[0]?.[0].references[0]?.bytes).toEqual(bytes);
      expect(image.mock.calls[0]?.[0].references[0]?.label).toContain('수정 대상의 이전 이미지');
      expect(result.project.generationRecords.at(-1)?.prompt).toContain(correctionNote);
      expect(result.project.productionPlan!.resources[0]?.description).toBe(resource.description);
      expect(result.project.dataset).toEqual(project.dataset); expect(result.project.assets.slice(0, project.assets.length)).toEqual(project.assets);
      expect(project).toEqual(before);
    } finally { await h.close(); }
  });

  it('reference_retake_binds_resource_version_and_protects_approved_or_locked_shots', async (): Promise<void> => {
    const h = await createExecutionHarness(async (): Promise<void> => {});
    try {
      await new AutomationRunExecutor(h.services).run(h.id, new AbortController().signal);
      const project = await h.services.projects.read(h.source.projectId); const resource = project.productionPlan!.resources[0]!;
      const intent = createReferenceRetakeIntent(project, { resourceId: resource.id });
      expect(intent.previousAssetId).toBe(resource.referenceAssetId);
      expect(assertReferenceRetakeIntent(project, intent).resourceId).toBe(resource.id);
      const changed: Project = { ...project, productionPlan: { ...project.productionPlan!, resources: [{ ...resource, description: '다른 가구 배치' }] } };
      expect(() => assertReferenceRetakeIntent(changed, intent)).toThrowError(expect.objectContaining({ code: 'AUTOMATION_REFERENCE_RETAKE_STALE' }));
      for (const state of [{ approvalStatus: 'approved' as const }, { lockedFields: ['camera' as const] }]) {
        const protectedProject: Project = { ...project, shots: project.shots.map((shot) => shot.segmentId === 'demonstration' ? { ...shot, ...state } : shot) };
        expect(() => createReferenceRetakeIntent(protectedProject, { resourceId: resource.id })).toThrowError(expect.objectContaining({ code: 'AUTOMATION_PROTECTED_REFERENCE' }));
      }
      const empty: Project = { ...project, productionPlan: { ...project.productionPlan!, resources: [{ ...resource, referenceAssetId: null }] } };
      expect(() => createReferenceRetakeIntent(empty, { resourceId: resource.id })).toThrowError(expect.objectContaining({ code: 'AUTOMATION_REFERENCE_RETAKE_TARGET' }));
      expect(() => createReferenceRetakeIntent(project, { resourceId: 'foreign-resource' })).toThrowError(expect.objectContaining({ code: 'AUTOMATION_PRODUCTION_RESOURCE' }));
    } finally { await h.close(); }
  });

  it('reference_retake_run_limits_one_fixed_target_and_charges_image_attempt_budget', async (): Promise<void> => {
    const h = await createExecutionHarness(async (): Promise<void> => {});
    try {
      await new AutomationRunExecutor(h.services).run(h.id, new AbortController().signal);
      const project = await h.services.projects.read(h.source.projectId); const resource = project.productionPlan!.resources[0]!;
      const purpose = createReferenceRetakeIntent(project, { resourceId: resource.id });
      const created = { ...initial(project), purpose, settings: { ...settings, maxImageAttempts: 1 } };
      const run = createAutomationRun(created); const work = nextAutomaticWork(run, project);
      expect(work.kind).toBe('register'); if (work.kind !== 'register') throw new Error('기준 재생성 작업 등록이 필요합니다.');
      expect(work.jobs.map((job) => job.task)).toEqual([purpose]);
      const event = { type: 'jobs-added' as const, at: created.at, jobs: work.jobs };
      expect(() => reduceAutomationRun(createAutomationRun(initial(project)), event)).toThrow();
      expect(() => reduceAutomationRun(run, { ...event, jobs: [{ ...work.jobs[0]!, task: { ...purpose, previousAssetId: 'different-version' } }] })).toThrow();
      const registered = reduceAutomationRun(run, event); const attemptId = randomUUID(); const jobId = work.jobs[0]!.id;
      const started = reduceAutomationRun(registered, { type: 'attempt-started', jobId, attemptId, revision: project.revision, projectHash: automaticHash(project), at: created.at });
      expect(started.imageAttempts).toBe(1);
      const failed = reduceAutomationRun(started, { type: 'attempt-failed', jobId, attemptId, at: created.at, problem: { code: 'CODEX_ENGINE_EXIT', message: '검증용 종료' } });
      expect(() => reduceAutomationRun(failed, { type: 'attempt-started', jobId, attemptId: randomUUID(), revision: project.revision, projectHash: automaticHash(project), at: created.at })).toThrowError(expect.objectContaining({ code: 'AUTOMATION_IMAGE_BUDGET' }));
    } finally { await h.close(); }
  });

  it('reference_retake_http_only_replaces_selected_reference_and_preserves_existing_media', async (): Promise<void> => {
    const h = await createExecutionHarness(async (): Promise<void> => {});
    const image = vi.fn(h.engine.image.run); const model = vi.fn(h.engine.model.run); const speech = vi.fn(h.engine.speech.run);
    const service = new AutomationService({ services: { ...h.services, engines: () => ({ ...h.engine, image: { run: image }, model: { run: model }, speech: { run: speech } }) }, onError: vi.fn() });
    const app = Fastify(); registerAutomationRoutes(app, service, 'Yuna');
    app.setErrorHandler((error: Error, request, reply): void => { reply.code(httpErrorPolicy(error).status).send(errorBody(error, request)); });
    try {
      await service.initialize(); await service.cancel(h.source.projectId, h.id);
      const prepared = await referenceRetakeCandidate(h.source);
      const project = await h.services.projects.update(h.source.projectId, 0, (): Project => prepared.project, prepared.writes);
      const resource = project.productionPlan!.resources[0]!; const oldFile = (await h.services.projects.asset(project.projectId, resource.referenceAssetId!)).content;
      const url = `/api/projects/${encodeURIComponent(project.projectId)}/automation/reference-retakes`;
      const payload = { expectedRevision: project.revision, input: { resourceId: resource.id }, settings };
      expect((await app.inject({ method: 'POST', url, headers: { origin: 'https://foreign.example' }, payload })).statusCode).toBe(400);
      expect((await app.inject({ method: 'POST', url, payload: { ...payload, expectedRevision: 0 } })).statusCode).toBe(409);
      expect((await app.inject({ method: 'POST', url, payload: { ...payload, input: { resourceId: 'foreign-resource' } } })).statusCode).toBe(400);
      const response = await app.inject({ method: 'POST', url, payload }); expect(response.statusCode).toBe(202);
      const id: string = response.json().run.id;
      await vi.waitFor(async (): Promise<void> => { expect((await service.read(project.projectId, id)).status).toBe('review-ready'); }, { timeout: 4000, interval: 50 });
      const current = await h.services.projects.read(project.projectId); const run = await service.read(project.projectId, id);
      expect(run.jobs.map((job) => job.task.kind)).toEqual(['reference-retake']); expect(run.imageAttempts).toBe(1);
      expect(current.revision).toBe(project.revision + 1); expect(current.assets.slice(0, project.assets.length)).toEqual(project.assets);
      expect(current.generationRecords.slice(0, project.generationRecords.length)).toEqual(project.generationRecords);
      expect(current.productionPlan!.resources[0]!.referenceAssetId).not.toBe(resource.referenceAssetId);
      expect(current.dataset).toEqual(project.dataset); expect(current.audioCues).toEqual(project.audioCues); expect(current.textCues).toEqual(project.textCues);
      expect(current.frames).toEqual(project.frames); expect(current.shots).toEqual(project.shots);
      expect((await h.services.projects.asset(project.projectId, resource.referenceAssetId!)).content).toEqual(oldFile);
      expect(image).toHaveBeenCalledOnce(); expect(model).not.toHaveBeenCalled(); expect(speech).not.toHaveBeenCalled();
    } finally { await app.close(); await service.close(); await h.close(); }
  });
});

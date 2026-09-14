import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import { AutomationService } from '../src/automation/service.js';
import { AutomationRunExecutor } from '../src/automation/run-executor.js';
import type { AutomationSettings } from '../src/automation/run-schema.js';
import { registerAutomationRoutes } from '../src/server/automation-routes.js';
import { errorBody, httpErrorPolicy } from '../src/server/app.js';
import { contractError } from '../src/domain/errors.js';
import { createExecutionHarness, settings } from './automatic-executor-helpers.js';

function interruptedModel(signal: AbortSignal): Promise<never> {
  return new Promise((_resolve, reject): void => {
    const stop = (): void => { reject(contractError('AUTOMATION_CANCELLED', '검증에서 음성·모델 호출을 중단합니다.', [])); };
    if (signal.aborted) stop(); else signal.addEventListener('abort', stop, { once: true });
  });
}

describe('자동 제작 HTTP 실행 수명', (): void => {
  it('automatic_cancel_preserves_uncommitted_candidate_without_publishing_it', async (): Promise<void> => {
    const h = await createExecutionHarness(async (): Promise<void> => {});
    const executor = new AutomationRunExecutor(h.services);
    const apply = vi.spyOn(h.services.applications, 'apply').mockRejectedValue(contractError('PROJECT_BUSY', '검증용 경합', []));
    try {
      const waiting = await executor.run(h.id, new AbortController().signal);
      expect(waiting.run.status).toBe('needs-attention');
      const attempt = waiting.run.jobs[0]!.attempts[0]!; expect(attempt.status).toBe('applying');
      const cancelled = await executor.cancel(h.id);
      expect(cancelled.run.status).toBe('cancelled'); expect(cancelled.run.jobs[0]!.attempts[0]!.status).toBe('failed');
      expect((await h.services.projects.read(h.source.projectId)).revision).toBe(0);
      expect(await h.services.applications.findPrepared(attempt.id)).not.toBeNull();
    } finally { apply.mockRestore(); await h.close(); }
  });

  it('automatic_cancel_settles_an_actual_commit_after_a_receipt_failure', async (): Promise<void> => {
    const h = await createExecutionHarness(async (point): Promise<void> => { if (point === 'after-project-commit') throw new Error('검증용 게시 후 종료'); });
    const executor = new AutomationRunExecutor(h.services);
    const reconciliation = vi.spyOn(h.services.applications, 'reconcile').mockRejectedValueOnce(new Error('검증용 최초 정산 중단'));
    try {
      await expect(executor.run(h.id, new AbortController().signal)).rejects.toThrow('검증용 최초 정산 중단');
      expect((await h.services.projects.read(h.source.projectId)).revision).toBe(1);
      const cancelled = await executor.cancel(h.id);
      expect(cancelled.run.status).toBe('cancelled'); expect(cancelled.run.revision).toBe(1);
      expect(cancelled.run.jobs[0]!.attempts[0]!.status).toBe('completed');
      expect((await h.services.projects.read(h.source.projectId)).generationRecords).toHaveLength(1);
    } finally { reconciliation.mockRestore(); await h.close(); }
  });
  it('automatic_service_restart_pauses_without_generation_and_resumes_frozen_settings', async (): Promise<void> => {
    const h = await createExecutionHarness(async (): Promise<void> => {});
    const called = Promise.withResolvers<void>();
    const model = vi.fn(async (_input, signal: AbortSignal): Promise<never> => { called.resolve(); return interruptedModel(signal); });
    const engines = vi.fn((_settings: AutomationSettings, _remainingMs: number) => ({ ...h.engine, model: { run: model } }));
    const service = new AutomationService({ services: { ...h.services, engines }, onError: vi.fn() });
    try {
      await service.initialize();
      expect((await service.read(h.source.projectId, h.id)).status).toBe('paused'); expect(model).not.toHaveBeenCalled();
      await service.resume(h.source.projectId, h.id); await called.promise;
      const view = await service.pause(h.source.projectId, h.id);
      expect(view.status).toBe('paused'); expect(view.workerActive).toBe(false); expect(view.jobs[0]!.status).toBe('interrupted');
      expect(engines.mock.calls[0]?.[0]).toEqual(settings);
      expect((await h.services.projects.read(h.source.projectId)).revision).toBe(0);
    } finally { await service.close(); await h.close(); }
  });

  it('automatic_service_close_waits_for_provider_and_preserves_durable_pause', async (): Promise<void> => {
    const h = await createExecutionHarness(async (): Promise<void> => {});
    const called = Promise.withResolvers<void>(); const released = vi.fn();
    const service = new AutomationService({ services: { ...h.services, engines: () => ({ ...h.engine, model: { run: async (_input, signal): Promise<never> => {
      called.resolve(); try { return await interruptedModel(signal); } finally { released(); }
    } } }) }, onError: vi.fn() });
    try {
      await service.initialize(); await service.resume(h.source.projectId, h.id); await called.promise; await service.close();
      expect(released).toHaveBeenCalledOnce(); expect((await h.services.runs.read(h.id)).run.status).toBe('paused');
      await expect(service.resume(h.source.projectId, h.id)).rejects.toMatchObject({ code: 'AUTOMATION_SERVICE_CLOSED' });
    } finally { await service.close(); await h.close(); }
  });

  it('automatic_service_http_blocks_foreign_origin_stale_start_cross_project_and_duplicate_run', async (): Promise<void> => {
    const h = await createExecutionHarness(async (): Promise<void> => {});
    const service = new AutomationService({ services: h.services, onError: vi.fn() });
    const app = Fastify(); registerAutomationRoutes(app, service, 'Yuna');
    app.setErrorHandler((error: Error, request, reply): void => { reply.code(httpErrorPolicy(error).status).send(errorBody(error, request)); });
    try {
      await service.initialize();
      const base = `/api/projects/${encodeURIComponent(h.source.projectId)}/automation`;
      const body = { expectedRevision: 0, segmentIds: ['demonstration'], settings };
      expect((await app.inject({ method: 'POST', url: base, headers: { origin: 'https://another.example' }, payload: body })).statusCode).toBe(400);
      expect((await app.inject({ method: 'POST', url: base, payload: { ...body, expectedRevision: 4 } })).statusCode).toBe(409);
      expect((await app.inject({ method: 'POST', url: base, payload: body })).json().error.code).toBe('AUTOMATION_RUN_ACTIVE');
      expect((await app.inject({ url: `/api/projects/another/automation/${h.id}` })).json().error.code).toBe('AUTOMATION_RUN_PROJECT');
      const overview = (await app.inject({ url: base })).json(); expect(overview.configured).toBe(true); expect(overview.runs).toHaveLength(1);
      expect(overview.recommendedSettings.density).toEqual({ version: '1.0.0', detail: 'source-led', longHoldReviewMs: 15000 });
      expect((await app.inject({ method: 'POST', url: base, payload: { ...body, settings: { ...settings, density: { version: '1.0.0', detail: 'unknown', longHoldReviewMs: 15000 } } } })).statusCode).toBe(400);
      expect((await app.inject({ method: 'POST', url: `${base}/${h.id}/cancel`, payload: {} })).json().run.status).toBe('cancelled');
      expect((await h.services.projects.read(h.source.projectId)).revision).toBe(0);
    } finally { await app.close(); await service.close(); await h.close(); }
  });

  it('automatic_service_changed_project_requires_new_run_and_never_rebases_user_edits', async (): Promise<void> => {
    const h = await createExecutionHarness(async (): Promise<void> => {});
    const model = vi.fn(h.engine.model.run);
    const service = new AutomationService({ services: { ...h.services, engines: () => ({ ...h.engine, model: { run: model } }) }, onError: vi.fn() });
    try {
      await service.initialize();
      await h.services.projects.update(h.source.projectId, 0, (project) => ({ ...project, title: '사용자가 바꾼 제목' }), []);
      await expect(service.resume(h.source.projectId, h.id)).rejects.toMatchObject({ code: 'AUTOMATION_RUN_STALE' });
      expect(model).not.toHaveBeenCalled(); expect((await h.services.projects.read(h.source.projectId)).title).toBe('사용자가 바꾼 제목');
      expect((await service.cancel(h.source.projectId, h.id)).status).toBe('cancelled');
    } finally { await service.close(); await h.close(); }
  });

  it('automatic_service_start_returns_before_provider_and_cancel_retains_initial_snapshot', async (): Promise<void> => {
    const h = await createExecutionHarness(async (): Promise<void> => {}); const called = Promise.withResolvers<void>();
    const service = new AutomationService({ services: { ...h.services, engines: () => ({ ...h.engine, model: { run: async (_input, signal): Promise<never> => { called.resolve(); return interruptedModel(signal); } } }) }, onError: vi.fn() });
    try {
      await service.initialize(); await service.cancel(h.source.projectId, h.id);
      const started = await service.start(h.source.projectId, 0, ['demonstration'], settings);
      expect(started.workerActive).toBe(true); await called.promise;
      const cancelled = await service.cancel(h.source.projectId, started.id);
      expect(cancelled.status).toBe('cancelled'); expect(cancelled.workerActive).toBe(false);
      expect(await h.services.runs.initialProject(started.id)).toEqual(h.source);
    } finally { await service.close(); await h.close(); }
  });
});

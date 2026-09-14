import { describe, expect, it, vi } from 'vitest';
import { automaticHash } from '../src/automation/application-evidence.js';
import type { AutomaticApplicationFault } from '../src/automation/application-store.js';
import { nextAutomaticWork } from '../src/automation/job-graph.js';
import { AutomationRunExecutor } from '../src/automation/run-executor.js';
import { createAutomationRun } from '../src/automation/run-state.js';
import { contractError } from '../src/domain/errors.js';
import type { Project } from '../src/domain/schema.js';
import { automaticPlanProject } from './automatic-plan-helpers.js';
import { createExecutionHarness, initial, settings } from './automatic-executor-helpers.js';

async function harness(fault: AutomaticApplicationFault): ReturnType<typeof createExecutionHarness> {
  const h = await createExecutionHarness(fault);
  h.engine.model.run = vi.fn(h.engine.model.run);
  h.engine.image.run = vi.fn(h.engine.image.run);
  h.engine.speech.run = vi.fn(h.engine.speech.run);
  h.services.onProgress = vi.fn(h.services.onProgress);
  h.services.onSpeechReady = vi.fn(h.services.onSpeechReady);
  h.services.onWarning = vi.fn(h.services.onWarning);
  return h;
}

describe('자동 제작 실행 연결', (): void => {
  it('automatic_executor_reconciles_post_commit_failure_without_repeating_generation', async (): Promise<void> => {
    let injected: boolean = false;
    const h = await harness(async (point): Promise<void> => { if (point === 'after-project-commit' && !injected) { injected = true; throw new Error('검증용 Commit 직후 중단'); } });
    try {
      const controller = new AbortController();
      h.services.onProgress = async (_runId, _jobId, progress): Promise<void> => { if (progress.phase === 'image') controller.abort(); };
      const result = await new AutomationRunExecutor(h.services).run(h.id, controller.signal);
      expect(result.run.status).toBe('paused'); expect(h.engine.model.run).toHaveBeenCalledTimes(1);
      expect(result.run.jobs[0]?.attempts[0]?.committedRevision).toBe(1);
      expect((await h.services.projects.read(h.source.projectId)).revision).toBe(1);
    } finally { await h.close(); }
  });

  it('automatic_executor_recovers_prepared_result_on_resume_without_repeating_the_provider', async (): Promise<void> => {
    let injected: boolean = false;
    const h = await harness(async (point): Promise<void> => { if (point === 'after-prepared' && !injected) { injected = true; throw new Error('검증용 준비 결과 게시 직후 중단'); } });
    try {
      const stopped = await new AutomationRunExecutor(h.services).run(h.id, new AbortController().signal);
      expect(stopped.run.status).toBe('needs-attention'); expect(stopped.run.jobs[0]?.attempts[0]?.status).toBe('prepared');
      const project = await h.services.projects.read(h.source.projectId); expect(project.revision).toBe(0);
      await h.services.runs.append(h.id, stopped.sequence, { type: 'resumed', revision: project.revision, projectHash: automaticHash(project), at: new Date().toISOString() });
      const controller = new AbortController();
      h.services.onProgress = async (_runId, _jobId, progress): Promise<void> => { if (progress.phase === 'image') controller.abort(); };
      const result = await new AutomationRunExecutor(h.services).run(h.id, controller.signal);
      expect(result.run.status).toBe('paused'); expect(h.engine.model.run).toHaveBeenCalledTimes(1);
    } finally { await h.close(); }
  });

  it('automatic_executor_preserves_user_edits_made_while_a_model_is_running', async (): Promise<void> => {
    const h = await harness(async (): Promise<void> => {});
    try {
      const original = h.engine.model.run;
      h.engine.model.run = vi.fn(async (input, signal) => {
        const result = await original(input, signal);
        await h.services.projects.update(h.source.projectId, 0, (project): Project => ({ ...project, title: '사용자가 바꾼 콘티 이름' }), []);
        return result;
      });
      const result = await new AutomationRunExecutor(h.services).run(h.id, new AbortController().signal);
      expect(result.run.status).toBe('needs-attention'); expect(result.run.problem?.code).toBe('AUTOMATION_STALE_PLAN');
      expect((await h.services.projects.read(h.source.projectId)).title).toBe('사용자가 바꾼 콘티 이름');
      expect(h.engine.image.run).not.toHaveBeenCalled();
    } finally { await h.close(); }
  });

  it('automatic_executor_retries_transient_provider_errors_with_a_warning_but_preserves_login_failures', async (): Promise<void> => {
    const h = await harness(async (): Promise<void> => {});
    try {
      const original = h.engine.model.run;
      h.engine.model.run = vi.fn().mockRejectedValueOnce(contractError('CODEX_ENGINE_IO', '검증용 일시적 연결 실패', [])).mockImplementation(original);
      const controller = new AbortController();
      h.services.onProgress = async (_runId, _jobId, progress): Promise<void> => { if (progress.phase === 'image') controller.abort(); };
      const result = await new AutomationRunExecutor(h.services).run(h.id, controller.signal);
      expect(result.run.status).toBe('paused'); expect(result.run.jobs[0]?.attempts).toHaveLength(2);
      expect(h.services.onWarning).toHaveBeenCalledWith(h.id, result.run.jobs[0]?.id, expect.objectContaining({ code: 'CODEX_ENGINE_IO' }));
    } finally { await h.close(); }
    const denied = await harness(async (): Promise<void> => {});
    try {
      denied.engine.model.run = vi.fn().mockRejectedValue(contractError('CODEX_LOGIN_REQUIRED', 'Codex App에 로그인하세요.', []));
      const result = await new AutomationRunExecutor(denied.services).run(denied.id, new AbortController().signal);
      expect(result.run.status).toBe('needs-attention'); expect(result.run.problem?.code).toBe('CODEX_LOGIN_REQUIRED');
      expect(denied.engine.model.run).toHaveBeenCalledTimes(1);
    } finally { await denied.close(); }
  });

  it('automatic_executor_pauses_cancels_the_provider_and_reuses_the_frozen_settings_on_resume', async (): Promise<void> => {
    const h = await harness(async (): Promise<void> => {});
    try {
      const controller = new AbortController(); const original = h.engine.model.run;
      h.engine.model.run = vi.fn(async (input, signal) => { const result = await original(input, signal); controller.abort(); return result; });
      const paused = await new AutomationRunExecutor(h.services).run(h.id, controller.signal);
      expect(paused.run.status).toBe('paused'); expect(paused.run.jobs[0]?.attempts[0]?.status).toBe('interrupted');
      expect((await h.services.projects.read(h.source.projectId)).revision).toBe(0);
      h.engine.model.run = original;
      await h.services.runs.append(h.id, paused.sequence, { type: 'resumed', revision: 0, projectHash: automaticHash(h.source), at: new Date().toISOString() });
      const resumedController = new AbortController();
      h.services.onProgress = async (_runId, _jobId, progress): Promise<void> => { if (progress.phase === 'image') resumedController.abort(); };
      const resumed = await new AutomationRunExecutor(h.services).run(h.id, resumedController.signal);
      expect(resumed.run.status).toBe('paused'); expect(resumed.run.settings).toEqual(paused.run.settings);
      expect(resumed.run.jobs[0]?.attempts).toHaveLength(2);
    } finally { await h.close(); }
  });

  it('automatic_executor_checks_build_and_remaining_image_budget_before_provider_calls', async (): Promise<void> => {
    const h = await harness(async (): Promise<void> => {});
    try {
      const result = await new AutomationRunExecutor({ ...h.services, generatorBuild: { ...h.services.generatorBuild, sourceTreeSha256: 'b'.repeat(64) } }).run(h.id, new AbortController().signal);
      expect(result.run.problem?.code).toBe('AUTOMATION_BUILD_CHANGED'); expect(h.engine.model.run).not.toHaveBeenCalled();
      await h.services.runs.append(h.id, result.sequence, { type: 'cancelled', at: new Date().toISOString() });
      const smaller = { ...initial(h.source), settings: { ...settings, maxStagedBytes: 1024 } };
      await h.services.runs.create(smaller, h.source);
      const limited = await new AutomationRunExecutor(h.services).run(smaller.id, new AbortController().signal);
      expect(limited.run.problem?.code).toBe('AUTOMATION_STAGING_BUDGET'); expect(h.engine.image.run).not.toHaveBeenCalled();
    } finally { await h.close(); }
  });

  it('automatic_executor_serializes_competing_workers_without_holding_the_project_lock', async (): Promise<void> => {
    const h = await harness(async (): Promise<void> => {});
    try {
      const entered = Promise.withResolvers<void>(); const release = Promise.withResolvers<void>();
      const original = h.engine.model.run;
      let first: boolean = true;
      h.engine.model.run = vi.fn(async (input, signal) => {
        if (first) { first = false; entered.resolve(); await release.promise; }
        return original(input, signal);
      });
      const controller = new AbortController();
      h.services.onProgress = async (_runId, _jobId, progress): Promise<void> => { if (progress.phase === 'image') controller.abort(); };
      const firstRun = new AutomationRunExecutor(h.services).run(h.id, controller.signal);
      await entered.promise;
      expect((await h.services.projects.read(h.source.projectId)).revision).toBe(0);
      const secondRun = new AutomationRunExecutor(h.services).run(h.id, new AbortController().signal);
      release.resolve();
      const results = await Promise.all([firstRun, secondRun]);
      expect(results[0]).toEqual(results[1]); expect(results[0]?.run.status).toBe('paused');
      expect(h.engine.model.run).toHaveBeenCalledTimes(1); expect(h.engine.image.run).not.toHaveBeenCalled();
    } finally { await h.close(); }
  });

  it('automatic_job_graph_preserves_manual_and_accepted_segments_and_has_stable_job_ids', async (): Promise<void> => {
    const source = await automaticPlanProject(); const run = createAutomationRun(initial(source));
    const before = structuredClone(source);
    expect(nextAutomaticWork(run, source)).toEqual(nextAutomaticWork(run, source)); expect(source).toEqual(before);
    const manual: Project = { ...source, shots: source.shots.map((shot) => shot.segmentId === 'demonstration' ? { ...shot, proposalOrigin: 'manual' } : shot) };
    expect(nextAutomaticWork({ ...run, projectHash: automaticHash(manual) }, manual)).toMatchObject({ kind: 'register', jobs: [{ task: { kind: 'repair', segmentId: 'demonstration' } }] });
    const accepted: Project = { ...source, frames: source.frames.map((frame) => frame.shotId === 'shot-2' ? { ...frame, visualReview: 'accepted' } : frame) };
    expect(() => nextAutomaticWork({ ...run, projectHash: automaticHash(accepted) }, accepted)).toThrow(expect.objectContaining({ code: 'AUTOMATION_NO_WORK' }));
  });

  it('automatic_job_graph_regenerates_only_explicit_rejections_beside_accepted_frames_and_preserves_locks', async (): Promise<void> => {
    const source = await automaticPlanProject();
    const target = source.shots.find((shot): boolean => shot.segmentId === 'demonstration')!;
    const frame = source.frames.find((value): boolean => value.shotId === target.id)!;
    const project: Project = { ...source, shots: source.shots.map((shot) => shot.id === target.id ? { ...shot, proposalOrigin: 'manual' } : shot),
      frames: [...source.frames.map((value) => value.id === frame.id ? { ...value, visualReview: 'accepted' as const } : value),
        { ...frame, id: 'explicit-rejected', role: 'key', offsetMs: 100, visualReview: 'rejected' },
        { ...frame, id: 'untouched-pending', role: 'key', offsetMs: 200, visualReview: 'pending' }] };
    const before = structuredClone(project);
    const run = createAutomationRun(initial(project));
    const work = nextAutomaticWork(run, project);
    expect(work.kind).toBe('register');
    if (work.kind !== 'register') throw new Error('재생성 작업이 등록되지 않았습니다.');
    expect(work.jobs.map((job) => job.task)).toEqual([{ kind: 'image', frameId: 'explicit-rejected' }]);
    expect(project).toEqual(before);
    const locked: Project = { ...project, shots: project.shots.map((shot) => shot.id === target.id ? { ...shot, lockedFields: ['action'] } : shot) };
    expect(() => nextAutomaticWork({ ...run, projectHash: automaticHash(locked) }, locked)).toThrow(expect.objectContaining({ code: 'AUTOMATION_NO_WORK' }));
  });
});

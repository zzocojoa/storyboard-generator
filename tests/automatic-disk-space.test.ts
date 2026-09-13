import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import { AutomationDiskSpace, inspectDiskDemands, readDiskSpace } from '../src/automation/disk-space.js';
import type { DiskReader } from '../src/automation/disk-space.js';
import { AutomationDiskReportSchema } from '../src/automation/disk-space-schema.js';
import { AutomationRunExecutor } from '../src/automation/run-executor.js';
import { AutomationService } from '../src/automation/service.js';
import { automaticHash } from '../src/automation/application-evidence.js';
import { registerAutomationRoutes } from '../src/server/automation-routes.js';
import { createExecutionHarness, settings } from './automatic-executor-helpers.js';

const GIB: bigint = 1024n ** 3n;
function simulatedDisk(root: string, available: () => bigint): AutomationDiskSpace {
  const reader: DiskReader = async (path) => ({ path, device: 'simulation-only', availableBytes: available() });
  return new AutomationDiskSpace({ project: join(root, 'data'), automation: join(root, 'automatic'), temporary: tmpdir() }, Number(GIB), reader);
}
async function resume(h: Awaited<ReturnType<typeof createExecutionHarness>>): Promise<void> {
  const snapshot = await h.services.runs.read(h.id);
  const project = await h.services.projects.read(h.source.projectId);
  await h.services.runs.append(h.id, snapshot.sequence, { type: 'resumed', revision: project.revision, projectHash: automaticHash(project), at: new Date().toISOString() });
}

describe('자동 제작 실제 디스크 공간', (): void => {
  it('automatic_disk_sums_shared_volume_demand_without_double_reserve_and_preserves_bigints', async (): Promise<void> => {
    const huge: bigint = BigInt(Number.MAX_SAFE_INTEGER) + 500n;
    const report = await inspectDiskDemands([{ path: 'cache', bytes: 40n }, { path: 'project', bytes: 50n }, { path: 'temp', bytes: huge }], 10n,
      async (path) => ({ path, device: path === 'temp' ? 'second' : 'shared', availableBytes: path === 'temp' ? huge + 10n : 99n }));
    expect(report.sufficient).toBe(false); expect(report.volumes).toHaveLength(2);
    expect(report.volumes[0]).toMatchObject({ requiredBytes: '100', availableBytes: '99', sufficient: false });
    expect(report.volumes[1]).toMatchObject({ requiredBytes: (huge + 10n).toString(), sufficient: true });
    expect(AutomationDiskReportSchema.parse(report)).toEqual(report);
  });
  it('automatic_disk_checks_actual_filesystem_and_reports_missing_path_without_fallback', async (): Promise<void> => {
    const actual = await readDiskSpace(tmpdir());
    expect(actual.availableBytes).toBeGreaterThan(0n); expect(actual.device).not.toBe('');
    await expect(readDiskSpace(join(tmpdir(), 'missing-cutroom-disk-probe', 'no-directory'))).rejects.toMatchObject({ code: 'AUTOMATION_DISK_CHECK_FAILED' });
    await expect(inspectDiskDemands([{ path: 'bad', bytes: 0n }], 0n, async (path) => ({ path, device: 'bad', availableBytes: -1n }))).rejects.toMatchObject({ code: 'AUTOMATION_DISK_CHECK_FAILED' });
  });
  it('automatic_disk_low_before_generation_preserves_revision_and_attempt_budget_until_resume', async (): Promise<void> => {
    const controller = new AbortController();
    const h = await createExecutionHarness(async (point): Promise<void> => { if (point === 'after-project-commit') controller.abort(); });
    let available: bigint = 1n;
    const engines = vi.fn(h.services.engines);
    const executor = new AutomationRunExecutor({ ...h.services, engines, diskSpace: simulatedDisk(h.root, () => available) });
    try {
      const stopped = await executor.run(h.id, new AbortController().signal);
      expect(stopped.run.problem?.code).toBe('AUTOMATION_DISK_SPACE_LOW'); expect(stopped.run.status).toBe('needs-attention');
      expect(engines).not.toHaveBeenCalled(); expect(stopped.run.jobs.every((job): boolean => job.attempts.length === 0)).toBe(true);
      expect(await h.services.projects.read(h.source.projectId)).toEqual(h.source);
      await resume(h); const stillLow = await executor.run(h.id, new AbortController().signal);
      expect(stillLow.run.problem?.code).toBe('AUTOMATION_DISK_SPACE_LOW'); expect(engines).not.toHaveBeenCalled();
      available = 10n * GIB; await resume(h);
      const resumed = await executor.run(h.id, controller.signal);
      expect(resumed.run.status).toBe('paused'); expect(resumed.run.revision).toBe(1);
      expect(resumed.run.jobs[0]?.attempts).toHaveLength(1); expect(resumed.run.jobs[0]?.attempts[0]?.status).toBe('completed');
      expect(engines).toHaveBeenCalledOnce();
    } finally { await h.close(); }
  });
  it('automatic_disk_retains_received_candidate_below_reserve_and_applies_without_regeneration', async (): Promise<void> => {
    const controller = new AbortController();
    const h = await createExecutionHarness(async (point): Promise<void> => { if (point === 'after-project-commit') controller.abort(); });
    let available: bigint = 10n * GIB;
    const original = h.engine.model.run;
    const model = vi.fn(async (...args: Parameters<typeof original>) => { const result = await original(...args); available = 256n * 1024n * 1024n; return result; });
    const executor = new AutomationRunExecutor({ ...h.services, diskSpace: simulatedDisk(h.root, () => available), engines: () => ({ ...h.engine, model: { run: model } }) });
    try {
      const stopped = await executor.run(h.id, new AbortController().signal);
      expect(stopped.run.problem?.code).toBe('AUTOMATION_DISK_SPACE_LOW'); expect(stopped.run.jobs[0]?.attempts[0]?.status).toBe('prepared');
      const id = stopped.run.jobs[0]!.attempts[0]!.id;
      const candidate = await h.services.applications.findPrepared(id); expect(candidate).not.toBeNull();
      expect((await h.services.projects.read(h.source.projectId)).revision).toBe(0);
      available = 10n * GIB; model.mockImplementation(original); await resume(h);
      const result = await executor.run(h.id, controller.signal);
      expect(result.run.status).toBe('paused'); expect(result.run.revision).toBe(1); expect(result.run.jobs[0]?.attempts).toHaveLength(1);
      expect(result.run.jobs[0]?.attempts[0]?.id).toBe(id); expect(result.run.jobs[0]?.attempts[0]?.status).toBe('completed'); expect(model).toHaveBeenCalledOnce();
      expect(await h.services.applications.findPrepared(id)).toEqual(candidate);
    } finally { await h.close(); }
  });
  it('automatic_disk_pause_after_cached_speech_reuses_wav_and_never_repeats_completed_jobs', async (): Promise<void> => {
    const controller = new AbortController();
    let stopAfterCommit: boolean = false;
    const h = await createExecutionHarness(async (point): Promise<void> => { if (point === 'after-project-commit' && stopAfterCommit) controller.abort(); });
    let available: bigint = 10n * GIB;
    const speech = vi.fn(h.engine.speech.run);
    let inject: boolean = true;
    const executor = new AutomationRunExecutor({ ...h.services, diskSpace: simulatedDisk(h.root, () => available),
      engines: () => ({ ...h.engine, speech: { run: speech } }), onSpeechReady: async (): Promise<void> => { if (inject) available = 256n * 1024n * 1024n; } });
    try {
      const stopped = await executor.run(h.id, new AbortController().signal);
      expect(stopped.run.problem?.code).toBe('AUTOMATION_DISK_SPACE_LOW'); expect(stopped.run.revision).toBe(2);
      expect(await h.services.speechCache.bytes(h.id)).toBeGreaterThan(0); expect(speech).toHaveBeenCalledOnce();
      expect(stopped.run.jobs.find((job): boolean => job.task.kind === 'segment')?.attempts[0]?.status).toBe('interrupted');
      available = 10n * GIB; inject = false; stopAfterCommit = true; await resume(h);
      const result = await executor.run(h.id, controller.signal);
      expect(result.run.status).toBe('paused'); expect(result.run.revision).toBe(3); expect(speech).toHaveBeenCalledOnce();
      expect(result.run.jobs.find((job): boolean => job.task.kind === 'segment')?.attempts.at(-1)?.status).toBe('completed');
      expect(result.run.jobs.slice(0, 2).every((job): boolean => job.attempts.length === 1)).toBe(true);
    } finally { await h.close(); }
  });
  it('automatic_disk_low_does_not_prevent_reconciling_an_actual_project_commit', async (): Promise<void> => {
    let available: bigint = 10n * GIB;
    const h = await createExecutionHarness(async (point): Promise<void> => { if (point === 'after-project-commit') { available = 1n; throw new Error('검증용 게시 후 공간 부족'); } });
    const executor = new AutomationRunExecutor({ ...h.services, diskSpace: simulatedDisk(h.root, () => available) });
    try {
      const stopped = await executor.run(h.id, new AbortController().signal);
      expect(stopped.run.problem?.code).toBe('AUTOMATION_DISK_SPACE_LOW'); expect(stopped.run.revision).toBe(1);
      expect(stopped.run.jobs[0]?.attempts[0]?.status).toBe('completed');
      expect((await h.services.projects.read(h.source.projectId)).revision).toBe(1);
    } finally { await h.close(); }
  });
  it('automatic_disk_http_returns_current_capacity_and_rejects_cross_origin_invalid_limits', async (): Promise<void> => {
    const h = await createExecutionHarness(async (): Promise<void> => {});
    const service = new AutomationService({ services: h.services, onError: vi.fn() });
    const app = Fastify(); registerAutomationRoutes(app, service, 'Yuna');
    try {
      await service.initialize(); const url = `/api/projects/${encodeURIComponent(h.source.projectId)}/automation/storage`;
      const result = await app.inject({ method: 'POST', url, payload: { maxStagedBytes: settings.maxStagedBytes } });
      expect(result.statusCode).toBe(200); expect(AutomationDiskReportSchema.parse(result.json()).sufficient).toBe(true);
      expect((await app.inject({ method: 'POST', url, payload: { maxStagedBytes: -1 } })).statusCode).not.toBe(200);
      expect((await app.inject({ method: 'POST', url, headers: { origin: 'https://foreign.invalid' }, payload: { maxStagedBytes: 1 } })).statusCode).not.toBe(200);
      expect(await h.services.projects.read(h.source.projectId)).toEqual(h.source);
    } finally { await app.close(); await service.close(); await h.close(); }
  });
  it('automatic_disk_refuses_new_run_when_initial_snapshot_cannot_be_preserved', async (): Promise<void> => {
    const h = await createExecutionHarness(async (): Promise<void> => {});
    const engines = vi.fn(h.services.engines);
    const service = new AutomationService({ services: { ...h.services, engines, diskSpace: simulatedDisk(h.root, () => 0n) }, onError: vi.fn() });
    try {
      await service.initialize(); await service.cancel(h.source.projectId, h.id);
      const before = await h.services.runs.list();
      await expect(service.start(h.source.projectId, 0, ['demonstration'], settings)).rejects.toMatchObject({ code: 'AUTOMATION_DISK_SPACE_LOW' });
      expect(await h.services.runs.list()).toEqual(before); expect(engines).not.toHaveBeenCalled();
      expect(await h.services.projects.read(h.source.projectId)).toEqual(h.source);
    } finally { await service.close(); await h.close(); }
  });
});

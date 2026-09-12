import { legacyTextProject } from './legacy-text-helpers.js';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { automaticHash } from '../src/automation/application-evidence.js';
import { AutomationApplicationStore } from '../src/automation/application-store.js';
import { createSegmentPlanBasis } from '../src/automation/plan-basis.js';
import { compileAutomaticSegmentPlan } from '../src/automation/plan-compiler.js';
import type { AutomationRunCreated, AutomationRunEvent, AutomationSettings } from '../src/automation/run-schema.js';
import { createAutomationRun, reduceAutomationRun } from '../src/automation/run-state.js';
import { AutomationRunStore } from '../src/automation/run-store.js';
import type { AutomationRunStoreFault } from '../src/automation/run-store.js';
import type { Project } from '../src/domain/schema.js';
import { recoverSourceProject } from '../src/importers/import-package.js';
import { createIndependentStoryboard } from '../src/proposal/independent-storyboard.js';
import { ProjectStore } from '../src/server/store.js';
import { automaticPlanProject, automaticPlanProvenance, demonstrationPlan, stagedPlanSpeech } from './automatic-plan-helpers.js';

const initialAt: string = '2026-09-11T00:00:00.000Z';
const settings: AutomationSettings = { model: null, voice: { name: 'Yuna', rateWordsPerMinute: 180 }, productionBatchSize: 16,
  maxModelCorrections: 2, maxFramesPerSegment: 32, maxAttemptsPerJob: 2, maxImageAttempts: 4, maxJobs: 32, maxStagedBytes: 8 * 1024 * 1024, maxActiveMs: 60000 };
const noFault: AutomationRunStoreFault = async (_point): Promise<void> => {};
function initial(project: Project): AutomationRunCreated {
  return { type: 'created', id: randomUUID(), projectId: project.projectId, revision: project.revision, projectHash: automaticHash(project),
    segmentIds: ['demonstration'], settings: structuredClone(settings), generatorBuild: automaticPlanProvenance().generatorBuild, at: initialAt };
}

it('automatic_legacy_run_reads_original_snapshot_hash_before_migration_and_rejects_tampering', async (): Promise<void> => {
  const root = await mkdtemp(join(tmpdir(), 'cutroom-legacy-run-'));
  try {
    const runs = new AutomationRunStore(root, noFault); await runs.initialize();
    const project = await automaticPlanProject(); const created = initial(project); await runs.create(created, project);
    const legacy = { ...legacyTextProject(project), schemaVersion: '1.11.0' };
    const event = { ...created, projectHash: automaticHash(legacy), generatorBuild: { ...created.generatorBuild, projectSchemaVersion: '1.11.0' } };
    const envelope = { version: 1, runId: created.id, sequence: 0, previousHash: null, event };
    const snapshotPath = join(root, 'runs', created.id, 'project.json');
    const content: string = JSON.stringify(legacy);
    await writeFile(snapshotPath, content);
    await writeFile(join(root, 'runs', created.id, '000000000.json'), JSON.stringify(envelope));
    await writeFile(join(root, 'runs', created.id, 'head.json'), JSON.stringify({ sequence: 0, hash: automaticHash(envelope) }));
    expect(await runs.initialProject(created.id)).toEqual({ ...project, textLayoutControl: { version: '1.0.0', mode: 'manual', plannedInputHash: null } });
    expect((await runs.read(created.id)).run.initialProjectHash).toBe(automaticHash(legacy));
    expect(await readFile(snapshotPath, 'utf8')).toBe(content);
    await writeFile(snapshotPath, JSON.stringify({ ...legacy, title: '수정된 입력' }));
    await expect(runs.initialProject(created.id)).rejects.toMatchObject({ code: 'AUTOMATION_RUN_INPUT' });
  } finally { await rm(root, { recursive: true, force: true }); }
});

it('실행 이력과 적용 영수증을 연결하여 음성 포함 결과를 재개 없이 검토 단계로 전달한다', async (): Promise<void> => {
  const root = await mkdtemp(join(tmpdir(), 'cutroom-run-'));
  const projects = new ProjectStore(join(root, 'data'));
  try {
    const runs = new AutomationRunStore(join(root, 'automation'), noFault); await runs.initialize();
    const applications = new AutomationApplicationStore(join(root, 'automation'), settings.maxStagedBytes, async (_point): Promise<void> => {}); await applications.initialize();
    const project = await automaticPlanProject(); await projects.create(project);
    const created = initial(project); let snapshot = await runs.create(created, project);
    const jobId = randomUUID(); const attemptId = randomUUID();
    const append = async (event: AutomationRunEvent): Promise<void> => { snapshot = await runs.append(created.id, snapshot.sequence, event); };
    await append({ type: 'jobs-added', jobs: [{ id: jobId, task: { kind: 'segment', segmentId: 'demonstration', replaceShotIds: ['shot-2'] }, dependsOn: [] }], at: initialAt });
    await append({ type: 'attempt-started', jobId, attemptId, revision: project.revision, projectHash: automaticHash(project), at: initialAt });
    const candidate = compileAutomaticSegmentPlan(project, createSegmentPlanBasis(project, 'demonstration', ['shot-2']), demonstrationPlan(project), [stagedPlanSpeech(project)], [], { ...automaticPlanProvenance(), generationId: attemptId }, 32);
    const application = await applications.prepare({ id: attemptId, runId: created.id, jobId, settingsHash: snapshot.run.settingsHash }, project, candidate.project, candidate.writes);
    await append({ type: 'result-prepared', jobId, attemptId, applicationHash: automaticHash(application), stagedBytes: application.assets.reduce((sum, asset): number => sum + asset.size, 0), at: initialAt });
    await append({ type: 'apply-started', jobId, attemptId, at: initialAt });
    const receipt = await applications.apply(attemptId, projects, new AbortController().signal);
    await append({ type: 'attempt-committed', jobId, attemptId, receipt, at: initialAt });
    await append({ type: 'review-ready', at: initialAt });
    const reopened = new AutomationRunStore(join(root, 'automation'), noFault); await reopened.initialize();
    expect(await reopened.read(created.id)).toEqual(snapshot);
    expect(await reopened.initialProject(created.id)).toEqual(project);
    expect(snapshot.run.status).toBe('review-ready'); expect(snapshot.run.revision).toBe(1);
    const result = await projects.read(project.projectId);
    expect(result.shots.every((shot): boolean => shot.approvalStatus === 'proposed')).toBe(true);
    expect(result.frames.every((frame): boolean => frame.visualReview !== 'accepted')).toBe(true);
    await expect(runs.append(created.id, snapshot.sequence, { type: 'resumed', revision: 1, projectHash: snapshot.run.projectHash, at: initialAt })).rejects.toMatchObject({ code: 'AUTOMATION_RUN_TRANSITION' });
  } finally { await projects.close(); await rm(root, { recursive: true, force: true }); }
});

it('중단과 재개는 사용한 이미지 시도와 시간을 초기화하지 않으며 이전 결과도 중복 집계하지 않는다', async (): Promise<void> => {
  const project = await automaticPlanProject(); const created = initial(project);
  created.settings.maxImageAttempts = 1;
  const jobId = randomUUID(); const attemptId = randomUUID();
  let run = createAutomationRun(created);
  run = reduceAutomationRun(run, { type: 'jobs-added', jobs: [{ id: jobId, task: { kind: 'image', frameId: 'frame-2' }, dependsOn: [] }], at: initialAt });
  run = reduceAutomationRun(run, { type: 'attempt-started', jobId, attemptId, revision: 0, projectHash: run.projectHash, at: initialAt });
  run = reduceAutomationRun(run, { type: 'paused', reason: '사용자 일시 중지', at: '2026-09-11T00:00:05.000Z' });
  expect(run.jobs[0]?.attempts[0]?.status).toBe('interrupted'); expect(run.activeMs).toBe(5000);
  run = reduceAutomationRun(run, { type: 'resumed', revision: 0, projectHash: run.projectHash, at: '2026-09-11T01:00:00.000Z' });
  expect(run.activeMs).toBe(5000); expect(run.imageAttempts).toBe(1);
  expect(() => reduceAutomationRun(run, { type: 'attempt-started', jobId, attemptId: randomUUID(), revision: 0, projectHash: run.projectHash, at: run.updatedAt })).toThrow('이미지 시도 한도');
  run = reduceAutomationRun(run, { type: 'result-prepared', jobId, attemptId, applicationHash: 'a'.repeat(64), stagedBytes: 1024, at: run.updatedAt });
  expect(run.stagedBytes).toBe(1024); expect(run.jobs[0]?.attempts[0]?.status).toBe('prepared');
  expect(() => reduceAutomationRun(run, { type: 'result-prepared', jobId, attemptId, applicationHash: 'a'.repeat(64), stagedBytes: 1024, at: run.updatedAt })).toThrow('보존한 생성 결과');
});

it('의존 순서와 재시도 한도 및 오래된 재개를 검사하고 사용자가 정한 설정을 보존한다', async (): Promise<void> => {
  const project = await automaticPlanProject(); const created = initial(project); created.settings.maxAttemptsPerJob = 1;
  let run = createAutomationRun(created); const unchanged = structuredClone(run);
  const first = randomUUID(); const next = randomUUID(); const attemptId = randomUUID();
  expect(() => reduceAutomationRun(run, { type: 'jobs-added', jobs: [{ id: first, task: { kind: 'segment', segmentId: '다른 구간', replaceShotIds: [] }, dependsOn: [] }], at: initialAt })).toThrow('실행 범위');
  run = reduceAutomationRun(run, { type: 'jobs-added', jobs: [
    { id: first, task: { kind: 'production', segmentIds: ['demonstration'] }, dependsOn: [] },
    { id: next, task: { kind: 'segment', segmentId: 'demonstration', replaceShotIds: ['shot-2'] }, dependsOn: [first] },
  ], at: initialAt });
  expect(unchanged.jobs).toEqual([]);
  expect(() => reduceAutomationRun(run, { type: 'attempt-started', jobId: next, attemptId, revision: 0, projectHash: run.projectHash, at: initialAt })).toThrow('미완료 의존 작업');
  run = reduceAutomationRun(run, { type: 'attempt-started', jobId: first, attemptId, revision: 0, projectHash: run.projectHash, at: initialAt });
  run = reduceAutomationRun(run, { type: 'attempt-failed', jobId: first, attemptId, problem: { code: 'CODEX_TIMEOUT', message: '제한 시간' }, at: initialAt });
  expect(() => reduceAutomationRun(run, { type: 'attempt-started', jobId: first, attemptId: randomUUID(), revision: 0, projectHash: run.projectHash, at: initialAt })).toThrow('재시도 한도');
  run = reduceAutomationRun(run, { type: 'paused', reason: '확인', at: initialAt });
  expect(() => reduceAutomationRun(run, { type: 'resumed', revision: 1, projectHash: 'b'.repeat(64), at: initialAt })).toThrow('프로젝트가 변경');
  expect(run.settings).toEqual(created.settings); expect(run.generatorBuild).toEqual(created.generatorBuild);
});

it('HEAD 저장 전에 중단되면 연속된 이벤트를 복구하고 같은 순번의 새 수정을 거부한다', async (): Promise<void> => {
  const root = await mkdtemp(join(tmpdir(), 'cutroom-run-head-'));
  try {
    const runs = new AutomationRunStore(root, async (point): Promise<void> => { if (point === 'after-event') throw new Error('HEAD 이전 중단'); }); await runs.initialize();
    const project = await automaticPlanProject(); const created = initial(project); await runs.create(created, project);
    await expect(runs.append(created.id, 0, { type: 'paused', reason: '중지', at: initialAt })).rejects.toThrow('HEAD 이전 중단');
    const reopened = new AutomationRunStore(root, noFault); await reopened.initialize();
    expect((await reopened.read(created.id)).run.status).toBe('paused');
    expect((await reopened.read(created.id)).sequence).toBe(1);
    await expect(reopened.append(created.id, 0, { type: 'cancelled', at: initialAt })).rejects.toMatchObject({ code: 'AUTOMATION_RUN_REVISION_CONFLICT' });
  } finally { await rm(root, { recursive: true, force: true }); }
});

it('같은 프로젝트의 동시 실행 생성과 같은 이벤트 순번의 경쟁을 직렬화한다', async (): Promise<void> => {
  const root = await mkdtemp(join(tmpdir(), 'cutroom-run-race-'));
  try {
    const runs = new AutomationRunStore(root, noFault); await runs.initialize();
    const project = await automaticPlanProject(); const first = initial(project); const second = initial(project);
    const outcomes = await Promise.allSettled([runs.create(first, project), runs.create(second, project)]);
    expect(outcomes.filter((value): boolean => value.status === 'fulfilled')).toHaveLength(1);
    expect(outcomes.filter((value): boolean => value.status === 'rejected')).toHaveLength(1);
    const snapshot = (await runs.list())[0]!;
    const results = await Promise.allSettled([runs.append(snapshot.run.id, 0, { type: 'paused', reason: '첫 요청', at: initialAt }), runs.append(snapshot.run.id, 0, { type: 'paused', reason: '두 번째 요청', at: initialAt })]);
    expect(results.filter((value): boolean => value.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((value): boolean => value.status === 'rejected')).toHaveLength(1);
    const other = createIndependentStoryboard(recoverSourceProject(project), { handoffPath: '/synthetic/storyboard_handoff.json', storyboardId: randomUUID(), name: '독립 프로젝트', proposedTextHoldMs: 2000 });
    const otherCreated = initial(other);
    expect((await runs.create(otherCreated, other)).run.projectId).toBe(other.projectId);
  } finally { await rm(root, { recursive: true, force: true }); }
});

it('이벤트 누락과 내용 변조 및 시작 Snapshot의 symlink를 검출하고 증거를 보존한다', async (): Promise<void> => {
  const root = await mkdtemp(join(tmpdir(), 'cutroom-run-proof-'));
  try {
    const runs = new AutomationRunStore(root, noFault); await runs.initialize();
    const project = await automaticPlanProject(); const created = initial(project); await runs.create(created, project);
    await runs.append(created.id, 0, { type: 'paused', reason: '중지', at: initialAt });
    const eventPath = join(root, 'runs', created.id, '000000001.json'); const bytes = await readFile(eventPath);
    await rm(eventPath);
    await expect(runs.read(created.id)).rejects.toMatchObject({ code: 'AUTOMATION_RUN_HISTORY_MISSING' });
    await writeFile(eventPath, bytes);
    const event = JSON.parse(bytes.toString()) as { event: { reason: string } }; event.event.reason = '바뀐 이유'; await writeFile(eventPath, JSON.stringify(event));
    await expect(runs.read(created.id)).rejects.toMatchObject({ code: 'AUTOMATION_RUN_HISTORY_HASH' });
    await writeFile(eventPath, bytes);
    const snapshotPath = join(root, 'runs', created.id, 'project.json'); const original = await readFile(snapshotPath);
    const external = join(root, 'external.json'); await writeFile(external, original); await rm(snapshotPath); await symlink(external, snapshotPath);
    await expect(runs.initialProject(created.id)).rejects.toMatchObject({ code: 'STORE_PATH_UNSAFE' });
    expect(await readFile(external)).toEqual(original);
  } finally { await rm(root, { recursive: true, force: true }); }
});

it('적용 중에는 실패나 취소로 정산을 건너뛰거나 다른 영수증으로 완료하지 않는다', async (): Promise<void> => {
  const project = await automaticPlanProject(); const created = initial(project); let run = createAutomationRun(created);
  const jobId = randomUUID(); const attemptId = randomUUID();
  run = reduceAutomationRun(run, { type: 'jobs-added', jobs: [{ id: jobId, task: { kind: 'segment', segmentId: 'demonstration', replaceShotIds: [] }, dependsOn: [] }], at: initialAt });
  run = reduceAutomationRun(run, { type: 'attempt-started', jobId, attemptId, revision: 0, projectHash: run.projectHash, at: initialAt });
  run = reduceAutomationRun(run, { type: 'result-prepared', jobId, attemptId, applicationHash: 'a'.repeat(64), stagedBytes: 0, at: initialAt });
  run = reduceAutomationRun(run, { type: 'apply-started', jobId, attemptId, at: initialAt });
  expect(() => reduceAutomationRun(run, { type: 'cancelled', at: initialAt })).toThrow('정산한 후 취소');
  expect(() => reduceAutomationRun(run, { type: 'attempt-failed', jobId, attemptId, problem: { code: '실패', message: '확인' }, at: initialAt })).toThrow('정산한 후 실패');
  expect(() => reduceAutomationRun(run, { type: 'attempt-committed', jobId, attemptId, receipt: { version: 1, applicationId: attemptId, applicationHash: 'a'.repeat(64), projectId: project.projectId, committedRevision: 2, resultProjectHash: 'b'.repeat(64) }, at: initialAt })).toThrow('완료 영수증');
  run = reduceAutomationRun(run, { type: 'paused', reason: '적용 정산 필요', at: initialAt });
  run = reduceAutomationRun(run, { type: 'attempt-committed', jobId, attemptId, receipt: { version: 1, applicationId: attemptId, applicationHash: 'a'.repeat(64), projectId: project.projectId, committedRevision: 1, resultProjectHash: 'b'.repeat(64) }, at: initialAt });
  expect(run.revision).toBe(1); expect(run.status).toBe('paused');
});

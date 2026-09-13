import { legacyTextProject } from './legacy-text-helpers.js';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { automaticHash } from '../src/automation/application-evidence.js';
import { AutomationApplicationStore } from '../src/automation/application-store.js';
import type { AutomaticApplicationFault } from '../src/automation/application-store.js';
import type { AutomaticApplication, AutomaticApplicationIdentity } from '../src/automation/application-schema.js';
import { createSegmentPlanBasis } from '../src/automation/plan-basis.js';
import { compileAutomaticSegmentPlan } from '../src/automation/plan-compiler.js';
import type { AutomaticCandidate } from '../src/automation/plan-compiler.js';
import type { Project } from '../src/domain/schema.js';
import { sha256Text } from '../src/importers/integrity.js';
import { ProjectStore } from '../src/server/store.js';
import { automaticPlanProject, automaticPlanProvenance, demonstrationPlan, stagedPlanSpeech } from './automatic-plan-helpers.js';

type Setup = { root: string; store: ProjectStore; applications: AutomationApplicationStore; original: Project; identity: AutomaticApplicationIdentity; candidate: AutomaticCandidate };
const noFault: AutomaticApplicationFault = async (_point): Promise<void> => {};

async function setup(fault: AutomaticApplicationFault): Promise<Setup> {
  const root = await mkdtemp(join(tmpdir(), 'cutroom-automatic-apply-'));
  const store = new ProjectStore(join(root, 'data'));
  const applications = new AutomationApplicationStore(join(root, 'runs'), 8 * 1024 * 1024, fault);
  const original = await automaticPlanProject();
  await store.create(original); await applications.initialize();
  const identity = { id: randomUUID(), runId: randomUUID(), jobId: randomUUID(), settingsHash: '1'.repeat(64) };
  const candidate = compileAutomaticSegmentPlan(original, createSegmentPlanBasis(original, 'demonstration', ['shot-2']), demonstrationPlan(original), [stagedPlanSpeech(original)], [], { ...automaticPlanProvenance(), generationId: identity.id }, 64);
  return { root, store, applications, original, identity, candidate };
}

async function cleanup(state: Setup): Promise<void> { await state.store.close(); await rm(state.root, { recursive: true, force: true }); }
async function prepare(state: Setup): Promise<void> { await state.applications.prepare(state.identity, state.original, state.candidate.project, state.candidate.writes); }
function applicationPath(state: Setup, file: string): string { return join(state.root, 'runs', 'applications', state.identity.id, file); }
function mediaPath(state: Setup): string { return applicationPath(state, `${sha256Text(state.candidate.writes[0]!.relativePath)}.media`); }

type LegacyAutomationProject = Omit<Project, 'schemaVersion' | 'textLayout' | 'textReadability' | 'textLayoutControl'> & { schemaVersion: '1.11.0' };
function legacyAutomationProject(project: Project): LegacyAutomationProject {
  return { ...legacyTextProject(project), schemaVersion: '1.11.0', generationRecords: project.generationRecords.map((record) => ({ ...record,
    generatorBuild: record.generatorBuild === null ? null : { ...record.generatorBuild, projectSchemaVersion: '1.11.0' } })) };
}
async function legacyApplication(state: Setup): Promise<AutomaticApplication> {
  const previous = await state.applications.read(state.identity.id);
  const before = legacyAutomationProject(state.original);
  const candidate = legacyAutomationProject(state.candidate.project);
  const application: AutomaticApplication = { ...previous, basisProjectHash: automaticHash(before),
    candidateProjectHash: automaticHash({ ...candidate, revision: 1 }), records: candidate.generationRecords.map((record) => ({ id: record.id, hash: automaticHash(record) })) };
  await writeFile(applicationPath(state, 'before.json'), JSON.stringify(before));
  await writeFile(applicationPath(state, 'candidate.json'), JSON.stringify(candidate));
  await writeFile(applicationPath(state, 'application.json'), JSON.stringify(application));
  return application;
}

it('자동 결과는 준비만으로 원본을 바꾸지 않고 한 revision에 적용하며 중복 적용을 정산한다', async (): Promise<void> => {
  const state = await setup(noFault);
  try {
    await prepare(state);
    expect(await state.store.read(state.original.projectId)).toEqual(state.original);
    const receipt = await state.applications.apply(state.identity.id, state.store, new AbortController().signal);
    expect(receipt.committedRevision).toBe(1);
    const applied = await state.store.read(state.original.projectId);
    expect(applied.assets).toHaveLength(1); expect(applied.generationRecords).toHaveLength(2);
    expect(applied.dataset).toEqual(state.original.dataset);
    expect(await state.applications.apply(state.identity.id, state.store, new AbortController().signal)).toEqual(receipt);
    expect((await state.store.read(state.original.projectId)).revision).toBe(1);
    expect(JSON.parse(await readFile(join(state.root, 'data', sha256Text(state.original.projectId), 'versions', '000000.json'), 'utf8'))).toEqual(state.original);
    await expect(prepare(state)).rejects.toMatchObject({ code: 'AUTOMATION_APPLICATION_EXISTS' });
  } finally { await cleanup(state); }
});

it('프로젝트 반영 뒤 종료되면 임시 미디어가 없어도 최초 revision을 복구하고 후속 편집을 보존한다', async (): Promise<void> => {
  const state = await setup(async (point): Promise<void> => { if (point === 'after-project-commit') throw new Error('중단 지점'); });
  try {
    await prepare(state);
    await expect(state.applications.apply(state.identity.id, state.store, new AbortController().signal)).rejects.toThrow('중단 지점');
    await state.store.update(state.original.projectId, 1, (project) => ({ ...project, title: '사용자가 이후 편집한 제목' }), []);
    await rm(mediaPath(state)); await rm(applicationPath(state, 'candidate.json')); await rm(applicationPath(state, 'before.json'));
    const reopened = new AutomationApplicationStore(join(state.root, 'runs'), 8 * 1024 * 1024, noFault); await reopened.initialize();
    const receipt = await reopened.reconcile(state.identity.id, state.store);
    expect(receipt?.committedRevision).toBe(1);
    expect(await reopened.apply(state.identity.id, state.store, new AbortController().signal)).toEqual(receipt);
    expect((await state.store.read(state.original.projectId)).title).toBe('사용자가 이후 편집한 제목');
    expect((await state.store.read(state.original.projectId)).revision).toBe(2);
  } finally { await cleanup(state); }
});

it('Intent 뒤 중단한 결과는 다시 생성하지 않고 준비한 바이트로 적용한다', async (): Promise<void> => {
  const state = await setup(async (point): Promise<void> => { if (point === 'after-intent') throw new Error('반영 전 중단'); });
  try {
    await prepare(state);
    await expect(state.applications.apply(state.identity.id, state.store, new AbortController().signal)).rejects.toThrow('반영 전 중단');
    expect((await state.store.read(state.original.projectId)).revision).toBe(0);
    const reopened = new AutomationApplicationStore(join(state.root, 'runs'), 8 * 1024 * 1024, noFault); await reopened.initialize();
    expect(await reopened.reconcile(state.identity.id, state.store)).toBeNull();
    expect((await reopened.apply(state.identity.id, state.store, new AbortController().signal)).committedRevision).toBe(1);
  } finally { await cleanup(state); }
});

it('준비 뒤 사용자 편집과 취소는 반영을 막고 후보 파일은 보존한다', async (): Promise<void> => {
  const state = await setup(noFault);
  try {
    await prepare(state);
    const cancelled = new AbortController(); cancelled.abort();
    await expect(state.applications.apply(state.identity.id, state.store, cancelled.signal)).rejects.toMatchObject({ code: 'AUTOMATION_CANCELLED' });
    await state.store.update(state.original.projectId, 0, (project) => ({ ...project, title: '사용자 편집' }), []);
    await expect(state.applications.apply(state.identity.id, state.store, new AbortController().signal)).rejects.toMatchObject({ code: 'AUTOMATION_STALE_RESULT' });
    expect(await readFile(mediaPath(state))).toEqual(state.candidate.writes[0]!.content);
    expect((await state.store.read(state.original.projectId)).title).toBe('사용자 편집');
  } finally { await cleanup(state); }
});

it('준비 파일 변조와 symlink는 프로젝트 수정 전에 거부한다', async (): Promise<void> => {
  const state = await setup(noFault);
  try {
    await prepare(state);
    const originalBytes = await readFile(mediaPath(state));
    await writeFile(mediaPath(state), Buffer.alloc(originalBytes.length, 1));
    await expect(state.applications.apply(state.identity.id, state.store, new AbortController().signal)).rejects.toMatchObject({ code: 'AUTOMATION_STAGED_ASSET_HASH' });
    await rm(mediaPath(state));
    const external = join(state.root, 'original.wav'); await writeFile(external, originalBytes); await symlink(external, mediaPath(state));
    await expect(state.applications.apply(state.identity.id, state.store, new AbortController().signal)).rejects.toMatchObject({ code: 'STORE_PATH_UNSAFE' });
    expect((await state.store.read(state.original.projectId)).revision).toBe(0);
    expect(await readFile(external)).toEqual(originalBytes);
  } finally { await cleanup(state); }
});

it('실제 Commit과 다른 영수증 또는 준비 결과 결속은 자동 정산하지 않는다', async (): Promise<void> => {
  const state = await setup(noFault);
  try {
    await prepare(state);
    const receipt = await state.applications.apply(state.identity.id, state.store, new AbortController().signal);
    await writeFile(applicationPath(state, 'receipt.json'), JSON.stringify({ ...receipt, committedRevision: 2 }));
    await expect(state.applications.reconcile(state.identity.id, state.store)).rejects.toMatchObject({ code: 'AUTOMATION_APPLY_EVIDENCE_CONFLICT' });
    await writeFile(applicationPath(state, 'receipt.json'), JSON.stringify(receipt));
    const application = await state.applications.read(state.identity.id);
    await writeFile(applicationPath(state, 'application.json'), JSON.stringify({ ...application, settingsHash: '2'.repeat(64) }));
    await expect(state.applications.reconcile(state.identity.id, state.store)).rejects.toMatchObject({ code: 'AUTOMATION_APPLY_EVIDENCE_CONFLICT' });
  } finally { await cleanup(state); }
});

it('동시 적용은 같은 결과를 한 번만 Commit하며 기존 Record를 유지한다', async (): Promise<void> => {
  const state = await setup(noFault);
  try {
    await prepare(state);
    const results = await Promise.all([state.applications.apply(state.identity.id, state.store, new AbortController().signal), state.applications.apply(state.identity.id, state.store, new AbortController().signal)]);
    expect(results[0]).toEqual(results[1]);
    expect((await state.store.read(state.original.projectId)).revision).toBe(1);
  } finally { await cleanup(state); }
});

it('임시 바이트 한도와 다른 원본 후보 및 다른 생성 ID는 준비 단계에서 거부한다', async (): Promise<void> => {
  const state = await setup(noFault);
  try {
    const small = new AutomationApplicationStore(join(state.root, 'small'), 1, noFault); await small.initialize();
    await expect(small.prepare(state.identity, state.original, state.candidate.project, state.candidate.writes)).rejects.toMatchObject({ code: 'AUTOMATION_STAGING_BUDGET' });
    await expect(state.applications.prepare({ ...state.identity, id: randomUUID() }, state.original, state.candidate.project, state.candidate.writes)).rejects.toMatchObject({ code: 'AUTOMATION_APPLICATION_RECORD' });
    const changed = structuredClone(state.candidate.project); changed.dataset.title = '변조한 원문';
    await expect(state.applications.prepare(state.identity, state.original, changed, state.candidate.writes)).rejects.toMatchObject({ code: 'INVALID_PROJECT' });
    expect(automaticHash(await state.store.read(state.original.projectId))).toBe(automaticHash(state.original));
  } finally { await cleanup(state); }
});

it('automatic_legacy_commit_reconciles_forward_migration_without_rewriting_history_or_later_edits', async (): Promise<void> => {
  const state = await setup(noFault);
  try {
    await prepare(state); await state.applications.apply(state.identity.id, state.store, new AbortController().signal);
    const application = await legacyApplication(state);
    const directory = join(state.root, 'data', sha256Text(state.original.projectId));
    const { productionPlan: _productionPlan, ...before } = legacyAutomationProject(state.original);
    // 1.10 저장 원본을 1.11 메모리 모델로 읽고 생성했던 과거 Commit을 재현한다.
    const beforeContent: string = JSON.stringify({ ...before, schemaVersion: '1.10.0' });
    const introduction = { ...legacyAutomationProject(state.candidate.project), revision: 1 };
    const introductionContent: string = JSON.stringify(introduction);
    await writeFile(join(directory, 'versions', '000000.json'), beforeContent);
    await writeFile(join(directory, 'versions', '000001.json'), introductionContent);
    await writeFile(join(directory, 'project.json'), introductionContent);
    await writeFile(applicationPath(state, 'applying.json'), JSON.stringify({ version: 1, applicationId: application.id, applicationHash: automaticHash(application), startedAt: application.createdAt }));
    await rm(applicationPath(state, 'receipt.json'));
    await state.store.update(state.original.projectId, 1, (project) => ({ ...project, title: '업그레이드 후 사용자의 편집' }), []);
    const currentContent = await readFile(join(directory, 'project.json'));
    for (const path of [mediaPath(state), applicationPath(state, 'candidate.json'), applicationPath(state, 'before.json')]) await rm(path);
    const receipt = await state.applications.reconcile(state.identity.id, state.store);
    expect(receipt).toMatchObject({ committedRevision: 1, resultProjectHash: application.candidateProjectHash });
    expect(await state.applications.apply(state.identity.id, state.store, new AbortController().signal)).toEqual(receipt);
    expect(await readFile(join(directory, 'project.json'))).toEqual(currentContent);
    expect(await readFile(join(directory, 'versions', '000000.json'), 'utf8')).toBe(beforeContent);
    expect(await readFile(join(directory, 'versions', '000001.json'), 'utf8')).toBe(introductionContent);
    await writeFile(join(directory, 'versions', '000001.json'), JSON.stringify({ ...introduction, title: '변조한 과거 제목' }));
    await expect(state.applications.reconcile(state.identity.id, state.store)).rejects.toMatchObject({ code: 'AUTOMATION_APPLY_EVIDENCE_CONFLICT' });
  } finally { await cleanup(state); }
});

it('automatic_legacy_uncommitted_candidate_requires_new_run_and_rejects_tampered_staging', async (): Promise<void> => {
  const state = await setup(noFault);
  try {
    await prepare(state); await legacyApplication(state);
    const current = await state.store.read(state.original.projectId);
    const bytes = await readFile(applicationPath(state, 'candidate.json'));
    await expect(state.applications.apply(state.identity.id, state.store, new AbortController().signal)).rejects.toMatchObject({ code: 'AUTOMATION_STAGED_SCHEMA_CHANGED' });
    expect(await state.applications.reconcile(state.identity.id, state.store)).toBeNull();
    expect(await state.store.read(state.original.projectId)).toEqual(current);
    expect(await readFile(applicationPath(state, 'candidate.json'))).toEqual(bytes);
    await writeFile(applicationPath(state, 'candidate.json'), JSON.stringify({ ...legacyAutomationProject(state.candidate.project), title: '수정된 후보' }));
    await expect(state.applications.apply(state.identity.id, state.store, new AbortController().signal)).rejects.toMatchObject({ code: 'AUTOMATION_STAGED_PROJECT_HASH' });
  } finally { await cleanup(state); }
});

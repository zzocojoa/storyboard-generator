import { readBuildManifest } from '../src/build.js';
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { CodexRequestStore } from '../src/codex/requests.js';
import type { AppConfig } from '../src/server/config.js';
import { createApp } from '../src/server/app.js';
import { ProjectStore } from '../src/server/store.js';
import { TEST_AUDIO_NORMALIZATION_OPTIONS } from './helpers.js';
import { readDocumentSources, writeDocumentPackage } from '../src/documents/io.js';
import { documentTestSettings, SYNTHETIC_DOCUMENT_BINDINGS } from './document-helpers.js';
import { HandoffSchema, NativeDatasetSchema } from '../src/domain/schema.js';
import type { Project } from '../src/domain/schema.js';
import { sha256Text } from '../src/importers/integrity.js';

const roots: string[] = [];

async function fixtureApp(): Promise<{ app: FastifyInstance; root: string; requests: CodexRequestStore }> {
  const root: string = await mkdtemp(join(tmpdir(), 'storyboard-server-'));
  roots.push(root);
  const webRoot: string = join(root, 'web');
  await mkdir(webRoot);
  await writeFile(join(webRoot, 'index.html'), '<!doctype html><div id="root">workbench</div>', 'utf8');
  await mkdir(join(webRoot, 'assets'));
  await writeFile(join(webRoot, 'assets', 'app.js'), 'document.body.dataset.ready="true";', 'utf8');
  const config: AppConfig = { host: '127.0.0.1', port: 4317, dataRoot: join(root, 'data'), webRoot,
    pdfFontPath: resolve('assets/fonts/NanumGothic-Regular.ttf'), audioNormalization: TEST_AUDIO_NORMALIZATION_OPTIONS,
    codex: { requestRoot: join(root, 'requests'), speechVoice: 'Yuna' } };
  const requests: CodexRequestStore = new CodexRequestStore(config.codex.requestRoot, readBuildManifest());
  return { app: await createApp(config, new ProjectStore(config.dataRoot), requests), root, requests };
}

afterEach(async (): Promise<void> => {
  await Promise.all(roots.splice(0).map(async (root: string): Promise<void> => { await rm(root, { recursive: true, force: true }); }));
});

describe('로컬 작업 API', (): void => {
  it('source_update_review_binds_source_bytes_settings_path_and_revision_without_mutating_rejected_updates', async (): Promise<void> => {
    const { app, root } = await fixtureApp();
    try {
      const directory: string = join(root, 'incoming');
      await cp(resolve('tests/fixtures/native'), directory, { recursive: true });
      const handoffPath: string = join(directory, 'storyboard_handoff.json');
      const dataPath: string = join(directory, 'data.json');
      const input = { handoffPath, proposedTextHoldMs: 2000, expectedRevision: 0 };
      const imported = await app.inject({ method: 'POST', url: '/api/projects/import', payload: { handoffPath, proposedTextHoldMs: 2000 } });
      expect(imported.statusCode).toBe(201);
      const original: Project = imported.json<{ project: Project }>().project;
      const url: string = `/api/projects/${encodeURIComponent(original.projectId)}`;
      const projectDirectory: string = join(root, 'data', sha256Text(original.projectId));
      const currentPath: string = join(projectDirectory, 'project.json');
      const before: string = await readFile(currentPath, 'utf8');
      const versionsBefore: string[] = await readdir(join(projectDirectory, 'versions'));
      const preview = await app.inject({ method: 'POST', url: `${url}/source-update/preview`, payload: input });
      expect(preview.statusCode).toBe(200);
      const reviewed = preview.json<{ impact: { canApply: boolean }; basisSha256: string }>();
      expect(reviewed.impact.canApply).toBe(true);
      expect(reviewed.basisSha256).toMatch(/^[a-f0-9]{64}$/u);
      const missing = await app.inject({ method: 'POST', url: `${url}/source-update/apply`, payload: input });
      expect(missing.statusCode).toBe(400);
      const differentStory = await app.inject({ method: 'POST', url: `${url}/source-update/preview`,
        payload: { ...input, handoffPath: resolve('tests/fixtures/production/storyboard_handoff.json') } });
      expect(differentStory.statusCode).toBe(400);
      expect(differentStory.json().error).toMatchObject({ code: 'PROJECT_MISMATCH', category: 'validation', mutationBlocked: false });
      for (const changed of [
        { ...input, basisSha256: '0'.repeat(64) },
        { ...input, proposedTextHoldMs: 3000, basisSha256: reviewed.basisSha256 },
        { ...input, handoffPath: resolve('tests/fixtures/native/storyboard_handoff.json'), basisSha256: reviewed.basisSha256 },
      ]) {
        const rejected = await app.inject({ method: 'POST', url: `${url}/source-update/apply`, payload: changed });
        expect(rejected.statusCode).toBe(409);
        expect(rejected.json().error).toMatchObject({ code: 'SOURCE_REVIEW_STALE', category: 'conflict', mutationBlocked: false, retryable: false });
      }
      const handoff = HandoffSchema.parse(JSON.parse(await readFile(handoffPath, 'utf8')));
      const data = NativeDatasetSchema.parse(JSON.parse(await readFile(dataPath, 'utf8')));
      const changedData: string = JSON.stringify({ ...data, title: '검토 뒤 변경한 합성 제목' });
      await writeFile(dataPath, changedData);
      await writeFile(handoffPath, JSON.stringify({ ...handoff, files: handoff.files.map((file) => ({ ...file, sha256: sha256Text(changedData) })) }));
      const stale = await app.inject({ method: 'POST', url: `${url}/source-update/apply`, payload: { ...input, basisSha256: reviewed.basisSha256 } });
      expect(stale.statusCode).toBe(409);
      expect(stale.json().error.code).toBe('SOURCE_REVIEW_STALE');
      expect(await readFile(currentPath, 'utf8')).toBe(before);
      expect(await readdir(join(projectDirectory, 'versions'))).toEqual(versionsBefore);
      const fresh = await app.inject({ method: 'POST', url: `${url}/source-update/preview`, payload: input });
      expect(fresh.statusCode).toBe(200);
      const basisSha256: string = fresh.json<{ basisSha256: string }>().basisSha256;
      expect(basisSha256).not.toBe(reviewed.basisSha256);
      const applied = await app.inject({ method: 'POST', url: `${url}/source-update/apply`, payload: { ...input, basisSha256 } });
      expect(applied.statusCode, applied.body).toBe(200);
      const updated: Project = applied.json<{ project: Project }>().project;
      expect(updated).toMatchObject({ revision: 1, title: '검토 뒤 변경한 합성 제목' });
      expect(updated.shots).toEqual(original.shots);
      expect(updated.assets).toEqual(original.assets);
      expect(updated.generationRecords).toEqual(original.generationRecords);
      const committed: string = await readFile(currentPath, 'utf8');
      const repeat = await app.inject({ method: 'POST', url: `${url}/source-update/apply`, payload: { ...input, basisSha256 } });
      expect(repeat.statusCode).toBe(409);
      expect(repeat.json().error.code).toBe('REVISION_CONFLICT');
      expect(await readFile(currentPath, 'utf8')).toBe(committed);
      const direct = await app.inject({ method: 'POST', url: `${url}/source-update`, payload: { ...input, expectedRevision: 1 } });
      expect(direct.statusCode, direct.body).toBe(200);
      expect(direct.json().project.revision).toBe(2);
      const approval = await app.inject({ method: 'POST', url: `${url}/shots/shot-1/approve`, payload: { expectedRevision: 2 } });
      expect(approval.statusCode).toBe(200);
      const approvedBytes: string = await readFile(currentPath, 'utf8');
      const currentHandoff = HandoffSchema.parse(JSON.parse(await readFile(handoffPath, 'utf8')));
      await writeFile(handoffPath, JSON.stringify({ ...currentHandoff, profile: { ...currentHandoff.profile, visualStyle: '변경된 스타일' } }));
      const lockedPreview = await app.inject({ method: 'POST', url: `${url}/source-update/preview`, payload: { ...input, expectedRevision: 3 } });
      expect(lockedPreview.statusCode).toBe(200);
      expect(lockedPreview.json().impact).toMatchObject({ canApply: false, lockedShotIds: ['shot-1'] });
      const lockedApply = await app.inject({ method: 'POST', url: `${url}/source-update/apply`,
        payload: { ...input, expectedRevision: 3, basisSha256: lockedPreview.json<{ basisSha256: string }>().basisSha256 } });
      expect(lockedApply.statusCode).toBe(400);
      expect(lockedApply.json().error).toMatchObject({ code: 'SOURCE_UPDATE_LOCKED_IMPACT', category: 'validation', mutationBlocked: false });
      expect(await readFile(currentPath, 'utf8')).toBe(approvedBytes);
    } finally { await app.close(); }
  });

  it('document_package_verification_http_preserves_output_and_classifies_missing_or_changed_files', async (): Promise<void> => {
    const { app, root } = await fixtureApp();
    try {
      const directory: string = resolve('tests/fixtures/documents');
      const settings = documentTestSettings(await readDocumentSources(directory), SYNTHETIC_DOCUMENT_BINDINGS);
      const output: string = join(root, 'package');
      const payload = { directory, settings, output };
      const missing = await app.inject({ method: 'POST', url: '/api/document-packages/verify', payload });
      expect(missing.statusCode).toBe(400);
      expect(missing.json().error).toMatchObject({ code: 'MISSING_DOCUMENT_OUTPUT', category: 'validation', mutationBlocked: false });
      const result = await writeDocumentPackage(directory, settings, output);
      const verified = await app.inject({ method: 'POST', url: '/api/document-packages/verify', payload });
      expect(verified.statusCode).toBe(200);
      expect(verified.json()).toEqual(result);
      const path: string = join(output, '09_PRODUCTION', 'narration.md');
      const changed: string = await readFile(path, 'utf8') + '\n변경된 파일';
      await writeFile(path, changed);
      const mismatch = await app.inject({ method: 'POST', url: '/api/document-packages/verify', payload });
      expect(mismatch.statusCode).toBe(400);
      expect(mismatch.json().error).toMatchObject({ code: 'DOCUMENT_OUTPUT_MISMATCH', category: 'validation', scope: 'request', mutationBlocked: false });
      expect(await readFile(path, 'utf8')).toBe(changed);
    } finally { await app.close(); }
  });

  it('authority_resolution_requires_expected_revision', async (): Promise<void> => {
    const { app } = await fixtureApp();
    try {
      const imported = await app.inject({ method: 'POST', url: '/api/projects/import', payload: { handoffPath: 'tests/fixtures/native/storyboard_handoff.json', proposedTextHoldMs: 2000 } });
      const cueId: string = imported.json<{ project: { textCues: Array<{ id: string }> } }>().project.textCues[0]?.id ?? '';
      const missing = await app.inject({ method: 'POST', url: `/api/projects/plant-care-demo/text/${encodeURIComponent(cueId)}/authority`,
        payload: { resolution: { authority: 'source-unit', unitId: '제목', startMs: 0, endMs: 500, kind: 'overlay' } } });
      expect(missing.statusCode).toBe(400);
      const stale = await app.inject({ method: 'POST', url: `/api/projects/plant-care-demo/text/${encodeURIComponent(cueId)}/authority`,
        payload: { expectedRevision: 1, resolution: { authority: 'source-unit', unitId: '제목', startMs: 0, endMs: 500, kind: 'overlay' } } });
      expect(stale.statusCode).toBe(409);
      expect(stale.json().error.code).toBe('REVISION_CONFLICT');
    } finally { await app.close(); }
  });

  it('글자 큐 종료 시각을 저장하고 명시적으로 확정한다', async (): Promise<void> => {
    const { app } = await fixtureApp();
    try {
      const imported = await app.inject({ method: 'POST', url: '/api/projects/import', payload: { handoffPath: 'tests/fixtures/production/storyboard_handoff.json', proposedTextHoldMs: 2000 } });
      const importedProject = imported.json<{ project: { projectId: string; revision: number; textCues: Array<{ id: string; startMs: number; endMs: number; kind: 'overlay' | 'prop-text' | 'dialogue-subtitle' }> } }>().project;
      const cue = importedProject.textCues[0];
      if (cue === undefined) throw new Error('검증용 글자 큐가 없습니다.');
      const projectUrl: string = `/api/projects/${encodeURIComponent(importedProject.projectId)}`;
      const changed = await app.inject({ method: 'PATCH', url: `${projectUrl}/text/${encodeURIComponent(cue.id)}`,
        payload: { expectedRevision: 0, timing: { startMs: cue.startMs, endMs: cue.endMs + 500, kind: cue.kind } } });
      expect(changed.statusCode).toBe(200);
      expect(changed.json().project.textCues[0]).toEqual(expect.objectContaining({ endMs: cue.endMs + 500, timingStatus: 'proposed' }));
      const confirmed = await app.inject({ method: 'POST', url: `${projectUrl}/text/${encodeURIComponent(cue.id)}/confirm`, payload: { expectedRevision: 1 } });
      expect(confirmed.statusCode).toBe(200);
      expect(confirmed.json().project).toEqual(expect.objectContaining({ revision: 2 }));
      expect(confirmed.json().project.textCues[0]).toEqual(expect.objectContaining({ timingStatus: 'confirmed' }));
      const stale = await app.inject({ method: 'POST', url: `${projectUrl}/text/${encodeURIComponent(cue.id)}/confirm`, payload: { expectedRevision: 1 } });
      expect(stale.statusCode).toBe(409);
      expect(stale.json().error.code).toBe('REVISION_CONFLICT');
    } finally { await app.close(); }
  });

  it('정적 자산·가져오기·리비전 충돌·PDF 내보내기를 함께 처리한다', async (): Promise<void> => {
    const { app } = await fixtureApp();
    try {
      const script = await app.inject({ method: 'GET', url: '/assets/app.js' });
      expect(script.statusCode).toBe(200);
      expect(script.headers['content-type']).toContain('javascript');
      expect(script.body).toContain('dataset.ready');
      for (const path of ['/assets/missing.js', '/assets/missing.css?v=1', '/assets/missing.woff2']) {
        const missing = await app.inject({ method: 'GET', url: path });
        expect(missing.statusCode).toBe(404);
        expect(missing.headers['content-type']).toContain('application/json');
        expect(missing.json().error.code).toBe('WEB_ASSET_NOT_FOUND');
        expect(missing.json().error.category).toBe('not-found');
      }
      const navigation = await app.inject({ method: 'GET', url: '/' });
      expect(navigation.statusCode).toBe(200);
      expect(navigation.body).toContain('workbench');
      const imported = await app.inject({ method: 'POST', url: '/api/projects/import', payload: { handoffPath: 'tests/fixtures/native/storyboard_handoff.json', proposedTextHoldMs: 2000 } });
      expect(imported.statusCode).toBe(201);
      expect(imported.json().project).toEqual(expect.objectContaining({ projectId: 'plant-care-demo', revision: 0 }));
      const approved = await app.inject({ method: 'POST', url: '/api/projects/plant-care-demo/shots/shot-1/approve', payload: { expectedRevision: 0 } });
      expect(approved.statusCode).toBe(200);
      expect(approved.json().project).toEqual(expect.objectContaining({ revision: 1 }));
      const conflict = await app.inject({ method: 'POST', url: '/api/projects/plant-care-demo/shots/shot-1/approve', payload: { expectedRevision: 0 } });
      expect(conflict.statusCode).toBe(409);
      expect(conflict.json().error.code).toBe('REVISION_CONFLICT');
      const pdf = await app.inject({ method: 'GET', url: '/api/projects/plant-care-demo/export.pdf' });
      expect(pdf.statusCode).toBe(200);
      expect(pdf.rawPayload.subarray(0, 5).toString('ascii')).toBe('%PDF-');
    } finally { await app.close(); }
  });

  it('이미지 생성을 Codex App 요청으로 영속화하고 API 키 없이 편집 상태를 유지한다', async (): Promise<void> => {
    const { app } = await fixtureApp();
    try {
      await app.inject({ method: 'POST', url: '/api/projects/import', payload: { handoffPath: 'tests/fixtures/native/storyboard_handoff.json', proposedTextHoldMs: 2000 } });
      const started = await app.inject({ method: 'POST', url: '/api/projects/plant-care-demo/frames/frame-1/generate', payload: { expectedRevision: 0 } });
      expect(started.statusCode).toBe(202);
      const requestId: string = started.json().request.id;
      expect(started.json().request).toEqual(expect.objectContaining({ kind: 'image', status: 'pending', projectId: 'plant-care-demo', targetId: 'frame-1' }));
      const request = await app.inject({ method: 'GET', url: `/api/codex/requests/${requestId}` });
      expect(request.json().request).toEqual(expect.objectContaining({ id: requestId, status: 'pending' }));
      const status = await app.inject({ method: 'GET', url: '/api/status' });
      expect(status.json()).toEqual(expect.objectContaining({ provider: 'codex-app', pendingRequests: 1 }));
      const project = (await app.inject({ method: 'GET', url: '/api/projects/plant-care-demo' })).json().project;
      expect(project.revision).toBe(0);
      expect(project.frames[0].imageAssetId).toBeNull();
    } finally { await app.close(); }
  });

  it('효과음을 Codex 음성 요청으로 저장하기 전에 거부한다', async (): Promise<void> => {
    const { app } = await fixtureApp();
    try {
      const imported = await app.inject({ method: 'POST', url: '/api/projects/import', payload: { handoffPath: 'tests/fixtures/native/storyboard_handoff.json', proposedTextHoldMs: 2000 } });
      const project = imported.json<{ project: { audioCues: Array<{ id: string; kind: string }> } }>().project;
      const sfx: { id: string; kind: string } | undefined = project.audioCues.find((cue: { id: string; kind: string }): boolean => cue.kind === 'sfx');
      expect(sfx).toBeTruthy();
      if (sfx === undefined) throw new Error('효과음 fixture를 찾을 수 없습니다.');
      const started = await app.inject({ method: 'POST', url: `/api/projects/plant-care-demo/audio/${encodeURIComponent(sfx.id)}/generate`, payload: { expectedRevision: 0 } });
      expect(started.statusCode).toBe(400);
      expect(started.json().error).toEqual(expect.objectContaining({ code: 'SPEECH_CUE_REQUIRED' }));
    } finally { await app.close(); }
  });

  it('프레임 추가와 독립 오디오 편집을 저장하고 원본 글자 종류 변경을 거부한다', async (): Promise<void> => {
    const { app } = await fixtureApp();
    try {
      const imported = await app.inject({ method: 'POST', url: '/api/projects/import', payload: { handoffPath: 'tests/fixtures/native/storyboard_handoff.json', proposedTextHoldMs: 2000 } });
      const initial = imported.json<{ project: { audioCues: Array<{ id: string; startMs: number; endMs: number; timingRelation: 'within-segment' | 'j-cut' | 'l-cut' }>; textCues: Array<{ id: string; startMs: number; endMs: number; kind: string }> } }>().project;
      const audio = initial.audioCues[0];
      const text = initial.textCues[0];
      if (audio === undefined || text === undefined) throw new Error('트랙 API 검증 자료가 없습니다.');
      const audioEdit = await app.inject({ method: 'PATCH', url: `/api/projects/plant-care-demo/audio/${encodeURIComponent(audio.id)}`,
        payload: { expectedRevision: 0, timing: { startMs: audio.startMs + 1, endMs: audio.endMs, timingRelation: audio.timingRelation } } });
      expect(audioEdit.statusCode).toBe(200);
      expect(audioEdit.json().project.revision).toBe(1);
      const frameAdd = await app.inject({ method: 'POST', url: '/api/projects/plant-care-demo/shots/shot-1/frames',
        payload: { expectedRevision: 1, frame: { offsetMs: 1000, role: 'key', description: '동작 중간' } } });
      expect(frameAdd.statusCode).toBe(201);
      expect(frameAdd.json().project.frames.filter((frame: { shotId: string }) => frame.shotId === 'shot-1')).toHaveLength(2);
      const textEdit = await app.inject({ method: 'PATCH', url: `/api/projects/plant-care-demo/text/${encodeURIComponent(text.id)}`,
        payload: { expectedRevision: 2, timing: { startMs: text.startMs, endMs: text.endMs, kind: 'dialogue-subtitle' } } });
      expect(textEdit.statusCode).toBe(400);
      expect(textEdit.json().error).toEqual(expect.objectContaining({ code: 'AUTHORITATIVE_TEXT_CUE_READ_ONLY', category: 'validation' }));
    } finally { await app.close(); }
  });

  it('최근 Codex 실패 원인을 상태 API에 노출한다', async (): Promise<void> => {
    const { app, requests } = await fixtureApp();
    try {
      const queued = await requests.create('image', 'project', 'frame', '0'.repeat(64), '2026-09-06T00:00:00.000Z');
      await requests.fail(queued.id, 'IMAGE_TOOL_FAILED', '이미지 생성 도구가 결과를 반환하지 않았습니다.', '2026-09-06T00:00:01.000Z');
      const status = await app.inject({ method: 'GET', url: '/api/status' });
      expect(status.json()).toEqual(expect.objectContaining({ totalRequests: 1, completedRequests: 0, pendingRequests: 0, failedRequests: 1,
        averageLatencyMs: 1000, maximumLatencyMs: 1000, repeatedRequests: 0, apiCostUsd: null,
        recentFailures: [expect.objectContaining({ id: queued.id, projectId: 'project', error: { code: 'IMAGE_TOOL_FAILED', message: '이미지 생성 도구가 결과를 반환하지 않았습니다.' } })] }));
    } finally { await app.close(); }
  });

  it('Text·Source Mapping을 expectedRevision으로 조회하고 수정한다', async (): Promise<void> => {
    const { app } = await fixtureApp();
    try {
      const imported = await app.inject({ method: 'POST', url: '/api/projects/import', payload: { handoffPath: 'tests/fixtures/production/storyboard_handoff.json', proposedTextHoldMs: 3000 } });
      expect(imported.statusCode).toBe(201);
      const project = imported.json().project;
      const decision = project.textMappingDecisions.find((value: { canonicalUnitId: string | null }) => value.canonicalUnitId === 'UNIT-061');
      const shot = project.shots.find((value: { segmentId: string }) => value.segmentId === 'SEG-024');
      if (decision === undefined || shot === undefined) throw new Error('Mapping API 검증 자료가 없습니다.');
      const review = await app.inject({ method: 'GET', url: '/api/projects/PRJ-007/mapping-review' });
      expect(review.statusCode).toBe(200);
      expect(review.json().issues).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'UNRESOLVED_TEXT_MAPPING' })]));
      const mapping = await app.inject({ method: 'PATCH', url: `/api/projects/PRJ-007/text-mappings/${encodeURIComponent(decision.id)}`, payload: { expectedRevision: 0, decision: {
        canonicalUnitId: 'UNIT-061', relation: 'abbreviation', status: 'confirmed', renderCanonicalSeparately: false,
        canonicalStartMs: null, canonicalEndMs: null, note: 'API 확인',
      } } });
      expect(mapping.statusCode).toBe(200);
      expect(mapping.json().project.revision).toBe(1);
      const stale = await app.inject({ method: 'PATCH', url: `/api/projects/PRJ-007/text-mappings/${encodeURIComponent(decision.id)}`, payload: { expectedRevision: 0, decision: {
        canonicalUnitId: 'UNIT-061', relation: 'abbreviation', status: 'confirmed', renderCanonicalSeparately: false,
        canonicalStartMs: null, canonicalEndMs: null, note: '충돌',
      } } });
      expect(stale.statusCode).toBe(409);
      const source = await app.inject({ method: 'PATCH', url: `/api/projects/PRJ-007/shots/${encodeURIComponent(shot.id)}/source-links`, payload: { expectedRevision: 1, mapping: { links: shot.sourceLinks.map((link: { unitId: string; usage: string; status: string }) => link.unitId === 'UNIT-059' ? { ...link, status: 'mapping-required' } : link) } } });
      expect(source.statusCode).toBe(200);
      expect(source.json().project.revision).toBe(2);
    } finally { await app.close(); }
  });
});

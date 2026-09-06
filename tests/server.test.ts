import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { CodexRequestStore } from '../src/codex/requests.js';
import type { AppConfig } from '../src/server/config.js';
import { createApp } from '../src/server/app.js';
import { ProjectStore } from '../src/server/store.js';

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
    pdfFontPath: resolve('assets/fonts/NanumGothic-Regular.ttf'), codex: { requestRoot: join(root, 'requests'), speechVoice: 'Yuna' } };
  const requests: CodexRequestStore = new CodexRequestStore(config.codex.requestRoot);
  return { app: await createApp(config, new ProjectStore(config.dataRoot), requests), root, requests };
}

afterEach(async (): Promise<void> => {
  await Promise.all(roots.splice(0).map(async (root: string): Promise<void> => { await rm(root, { recursive: true, force: true }); }));
});

describe('로컬 작업 API', (): void => {
  it('정적 자산·가져오기·리비전 충돌·PDF 내보내기를 함께 처리한다', async (): Promise<void> => {
    const { app } = await fixtureApp();
    try {
      const script = await app.inject({ method: 'GET', url: '/assets/app.js' });
      expect(script.statusCode).toBe(200);
      expect(script.headers['content-type']).toContain('javascript');
      expect(script.body).toContain('dataset.ready');
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

  it('프레임 추가와 독립 오디오·글자 트랙 편집을 revision 순서로 저장한다', async (): Promise<void> => {
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
      expect(textEdit.statusCode).toBe(200);
      expect(textEdit.json().project).toEqual(expect.objectContaining({ revision: 3, schemaVersion: '1.4.0' }));
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

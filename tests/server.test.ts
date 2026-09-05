import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { CodexRequestStore } from '../src/codex/requests.js';
import type { AppConfig } from '../src/server/config.js';
import { createApp } from '../src/server/app.js';
import { ProjectStore } from '../src/server/store.js';

const roots: string[] = [];

async function fixtureApp(): Promise<{ app: FastifyInstance; root: string }> {
  const root: string = await mkdtemp(join(tmpdir(), 'storyboard-server-'));
  roots.push(root);
  const webRoot: string = join(root, 'web');
  await mkdir(webRoot);
  await writeFile(join(webRoot, 'index.html'), '<!doctype html><div id="root">workbench</div>', 'utf8');
  await mkdir(join(webRoot, 'assets'));
  await writeFile(join(webRoot, 'assets', 'app.js'), 'document.body.dataset.ready="true";', 'utf8');
  const config: AppConfig = { host: '127.0.0.1', port: 4317, dataRoot: join(root, 'data'), webRoot,
    pdfFontPath: '/System/Library/Fonts/Supplemental/AppleGothic.ttf', codex: { requestRoot: join(root, 'requests'), speechVoice: 'Yuna' } };
  return { app: await createApp(config, new ProjectStore(config.dataRoot), new CodexRequestStore(config.codex.requestRoot)), root };
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
});

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { GeneratedImage, GeneratedSpeech, GenerationConnector, ImageReference, ProposedSegment } from '../src/connectors/generation.js';
import type { ImageContext, SegmentContext } from '../src/proposal/context.js';
import type { AppConfig } from '../src/server/config.js';
import { createApp } from '../src/server/app.js';
import { ProjectStore } from '../src/server/store.js';

const roots: string[] = [];

function fakeConnector(): GenerationConnector {
  return {
    async propose(context: SegmentContext): Promise<ProposedSegment> {
      return { proposal: { shots: [{ sourceUnitIds: context.sourceUnits.map((unit): string => unit.id), durationWeight: 1,
        action: context.sourceUnits.map((unit): string => unit.text).join(' '), visualLocationId: context.storyLocationId,
        camera: { size: 'MS', angle: 'eye-level', move: 'static' }, presence: [], propIds: [], cameraAxis: null,
        screenDirection: null, informationIds: [], frameDescription: '검증 프레임' }] }, prompt: 'proposal', model: 'fake-proposal', requestId: 'proposal-request' };
    },
    async image(_context: ImageContext, references: readonly ImageReference[]): Promise<GeneratedImage> {
      return { bytes: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64'),
        prompt: 'image', model: 'fake-image', requestId: 'image-request', mimeType: 'image/png', referenceHashes: references.map((reference: ImageReference): string => reference.sha256) };
    },
    async speech(text: string): Promise<GeneratedSpeech> {
      throw new Error(`음성 검증에서는 호출하지 않습니다: ${text}`);
    },
  };
}

async function fixtureApp(): Promise<{ app: FastifyInstance; root: string }> {
  const root: string = await mkdtemp(join(tmpdir(), 'storyboard-server-'));
  roots.push(root);
  const webRoot: string = join(root, 'web');
  await mkdir(webRoot);
  await writeFile(join(webRoot, 'index.html'), '<!doctype html><div id="root">workbench</div>', 'utf8');
  await mkdir(join(webRoot, 'assets'));
  await writeFile(join(webRoot, 'assets', 'app.js'), 'document.body.dataset.ready="true";', 'utf8');
  const config: AppConfig = { host: '127.0.0.1', port: 4317, dataRoot: join(root, 'data'), webRoot,
    pdfFontPath: '/System/Library/Fonts/Supplemental/AppleGothic.ttf', generation: { proposalModel: 'fake-proposal', imageModel: 'fake-image', imageQuality: 'low',
      speechModel: 'fake-speech', speechVoice: 'cedar', speechInstructions: '검증', requestTimeoutMs: 1000, retryCount: 0, retryBackoffMs: 0 } };
  return { app: await createApp(config, new ProjectStore(config.dataRoot), fakeConnector), root };
}

async function completedJob(app: FastifyInstance, jobId: string): Promise<Record<string, unknown>> {
  for (let attempt: number = 0; attempt < 50; attempt += 1) {
    const response = await app.inject({ method: 'GET', url: `/api/jobs/${jobId}` });
    const payload = response.json<{ job: Record<string, unknown> }>();
    if (payload.job.status === 'succeeded' || payload.job.status === 'failed') return payload.job;
    await new Promise<void>((resolve): void => { setTimeout(resolve, 2); });
  }
  throw new Error(`생성 작업이 제한 시간 안에 끝나지 않았습니다: ${jobId}`);
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

  it('백그라운드 이미지 생성 결과를 자산과 새 리비전으로 게시한다', async (): Promise<void> => {
    const { app } = await fixtureApp();
    try {
      await app.inject({ method: 'POST', url: '/api/projects/import', payload: { handoffPath: 'tests/fixtures/native/storyboard_handoff.json', proposedTextHoldMs: 2000 } });
      const started = await app.inject({ method: 'POST', url: '/api/projects/plant-care-demo/frames/frame-1/generate', payload: { expectedRevision: 0 } });
      expect(started.statusCode).toBe(202);
      const jobId: string = started.json().job.id;
      const job = await completedJob(app, jobId);
      expect(job.status).toBe('succeeded');
      expect(job.result).toEqual({ projectId: 'plant-care-demo', revision: 1 });
      const project = (await app.inject({ method: 'GET', url: '/api/projects/plant-care-demo' })).json().project;
      expect(project.frames[0].imageAssetId).toBeTruthy();
      expect(project.generationRecords[0]).toEqual(expect.objectContaining({ provider: 'openai', model: 'fake-image', requestId: 'image-request' }));
      const asset = await app.inject({ method: 'GET', url: `/api/projects/plant-care-demo/assets/${encodeURIComponent(project.frames[0].imageAssetId)}` });
      expect(asset.statusCode).toBe(200);
      expect(asset.headers['content-type']).toBe('image/png');
    } finally { await app.close(); }
  });

  it('효과음을 음성으로 읽기 전에 생성 작업을 거부한다', async (): Promise<void> => {
    const { app } = await fixtureApp();
    try {
      const imported = await app.inject({ method: 'POST', url: '/api/projects/import', payload: { handoffPath: 'tests/fixtures/native/storyboard_handoff.json', proposedTextHoldMs: 2000 } });
      const project = imported.json<{ project: { audioCues: Array<{ id: string; kind: string }> } }>().project;
      const sfx: { id: string; kind: string } | undefined = project.audioCues.find((cue: { id: string; kind: string }): boolean => cue.kind === 'sfx');
      expect(sfx).toBeTruthy();
      if (sfx === undefined) throw new Error('효과음 fixture를 찾을 수 없습니다.');
      const started = await app.inject({ method: 'POST', url: `/api/projects/plant-care-demo/audio/${encodeURIComponent(sfx.id)}/generate`, payload: { expectedRevision: 0 } });
      expect(started.statusCode).toBe(202);
      const job = await completedJob(app, started.json().job.id);
      expect(job.status).toBe('failed');
      expect(job.error).toEqual(expect.objectContaining({ code: 'SPEECH_CUE_REQUIRED' }));
    } finally { await app.close(); }
  });
});

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { applyCodexImage, applyCodexProposal, applyCodexSpeech } from '../src/codex/apply.js';
import { CodexRequestStore } from '../src/codex/requests.js';
import type { CodexRequest } from '../src/codex/schema.js';
import { codexRequestBasis } from '../src/codex/work.js';
import { importPackage } from '../src/importers/import-package.js';
import type { Project } from '../src/domain/schema.js';
import { createSourceOutline } from '../src/proposal/outline.js';
import { ProjectStore } from '../src/server/store.js';
import { nativePackage, png, testAudioNormalizer } from './helpers.js';

const roots: string[] = [];

function wav(durationMs: number): Buffer {
  const sampleRate: number = 8000;
  const dataLength: number = Math.round(sampleRate * durationMs / 1000) * 2;
  const bytes: Buffer = Buffer.alloc(44 + dataLength);
  bytes.write('RIFF', 0); bytes.writeUInt32LE(36 + dataLength, 4); bytes.write('WAVE', 8); bytes.write('fmt ', 12);
  bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22); bytes.writeUInt32LE(sampleRate, 24);
  bytes.writeUInt32LE(sampleRate * 2, 28); bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34); bytes.write('data', 36); bytes.writeUInt32LE(dataLength, 40);
  return bytes;
}

async function fixture(): Promise<{ root: string; project: Project; store: ProjectStore; requests: CodexRequestStore }> {
  const root: string = await mkdtemp(join(tmpdir(), 'storyboard-codex-'));
  roots.push(root);
  const project: Project = createSourceOutline(importPackage(await nativePackage()), { proposedTextHoldMs: 2000 });
  const store: ProjectStore = new ProjectStore(join(root, 'data'));
  const requests: CodexRequestStore = new CodexRequestStore(join(root, 'requests'));
  await store.create(project);
  return { root, project, store, requests };
}

afterEach(async (): Promise<void> => {
  await Promise.all(roots.splice(0).map(async (root: string): Promise<void> => { await rm(root, { recursive: true, force: true }); }));
});

describe('Codex App 생성 브리지', (): void => {
  it('같은 입력의 중복 요청을 하나로 유지하고 파일에서 다시 읽는다', async (): Promise<void> => {
    const { project, requests } = await fixture();
    const basis: string = codexRequestBasis(project, 'image', 'frame-1');
    const first: CodexRequest = await requests.create('image', project.projectId, 'frame-1', basis, '2026-09-06T00:00:00.000Z');
    const second: CodexRequest = await requests.create('image', project.projectId, 'frame-1', basis, '2026-09-06T00:00:01.000Z');
    expect(second.id).toBe(first.id);
    expect(await requests.read(first.id)).toEqual(first);
    expect(await requests.list('pending')).toHaveLength(1);
  });

  it('Codex 이미지 결과를 자산과 생성 이력으로 반영한다', async (): Promise<void> => {
    const { root, project, store, requests } = await fixture();
    const request: CodexRequest = await requests.create('image', project.projectId, 'frame-1', codexRequestBasis(project, 'image', 'frame-1'), '2026-09-06T00:00:00.000Z');
    const input: string = join(root, 'result.png');
    await writeFile(input, await png(1, 1));
    const result: Project = await applyCodexImage(request.id, input, store, requests, '2026-09-06T00:00:01.000Z');
    expect(result.frames[0]?.imageAssetId).toBe(`codex:${request.id}:image`);
    expect(result.generationRecords[0]).toEqual(expect.objectContaining({ provider: 'codex-app', model: 'codex-imagegen', requestId: request.id }));
    expect((await requests.read(request.id)).resultRevision).toBe(1);
  });

  it('요청 뒤 대상이 바뀌면 오래된 결과 적용을 거부한다', async (): Promise<void> => {
    const { root, project, store, requests } = await fixture();
    const request: CodexRequest = await requests.create('image', project.projectId, 'frame-1', codexRequestBasis(project, 'image', 'frame-1'), '2026-09-06T00:00:00.000Z');
    await store.update(project.projectId, 0, (current: Project): Project => ({ ...current,
      frames: current.frames.map((frame) => frame.id === 'frame-1' ? { ...frame, description: '바뀐 설명' } : frame) }), []);
    const input: string = join(root, 'stale.png');
    await writeFile(input, Buffer.from('89504e470d0a1a0a', 'hex'));
    await expect(applyCodexImage(request.id, input, store, requests, '2026-09-06T00:00:01.000Z')).rejects.toEqual(expect.objectContaining({ code: 'CODEX_REQUEST_STALE' }));
  });

  it('Codex 컷 제안과 로컬 가이드 음성을 각각 적용한다', async (): Promise<void> => {
    const { root, project, store, requests } = await fixture();
    const segment = project.dataset.segments[0];
    const cue = project.audioCues.find((candidate): boolean => ['dialogue', 'voiceover', 'panel'].includes(candidate.kind));
    if (segment === undefined || cue === undefined) throw new Error('Codex 검증용 구간 또는 음성 큐가 없습니다.');
    const proposalRequest: CodexRequest = await requests.create('proposal', project.projectId, segment.id, codexRequestBasis(project, 'proposal', segment.id), '2026-09-06T00:00:00.000Z');
    const proposalPath: string = join(root, 'proposal.json');
    const sourceIds: string[] = project.dataset.units.filter((unit): boolean => unit.segmentId === segment.id).map((unit): string => unit.id);
    await writeFile(proposalPath, JSON.stringify({ shots: [{ sourceLinks: sourceIds.map((unitId: string) => ({ unitId, usage: 'primary-visual' })), durationWeight: 1, action: '원문에 맞춘 동작', visualLocationId: project.dataset.scenes[0]?.storyLocationId ?? null,
      camera: { size: 'MS', angle: 'eye-level', move: 'static' }, presence: [], propIds: [], cameraAxis: null, screenDirection: null,
      informationIds: [], transitionOut: { kind: 'cut', durationMs: 0, note: '' }, frameDescription: '원문에 맞춘 콘티 프레임' }] }), 'utf8');
    const proposed: Project = await applyCodexProposal(proposalRequest.id, proposalPath, store, requests, '2026-09-06T00:00:01.000Z');
    expect(proposed.shots.filter((shot): boolean => shot.segmentId === segment.id)).toHaveLength(1);
    const speechRequest: CodexRequest = await requests.create('speech', proposed.projectId, cue.id, codexRequestBasis(proposed, 'speech', cue.id), '2026-09-06T00:00:02.000Z');
    const speechPath: string = join(root, 'speech.wav');
    await writeFile(speechPath, wav(200));
    const spoken: Project = await applyCodexSpeech(speechRequest.id, speechPath, 'Yuna', store, requests, '2026-09-06T00:00:03.000Z', testAudioNormalizer());
    expect(spoken.audioCues.find((candidate): boolean => candidate.id === cue.id)?.assetId).toBe(`codex:${speechRequest.id}:audio`);
    expect(spoken.generationRecords.at(-1)).toEqual(expect.objectContaining({ provider: 'codex-app', model: 'macos-say:Yuna' }));
  });
});

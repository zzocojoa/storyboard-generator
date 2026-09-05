import { describe, expect, it } from 'vitest';
import type { Project } from '../src/domain/schema.js';
import { addReferenceAsset, applyGeneratedImage, applyGeneratedSpeech, wavDurationMs } from '../src/domain/media.js';
import { importPackage } from '../src/importers/import-package.js';
import { createSourceOutline } from '../src/proposal/outline.js';
import { nativePackage } from './helpers.js';

function wav(durationMs: number): Buffer {
  const sampleRate: number = 8000;
  const dataLength: number = Math.round(sampleRate * durationMs / 1000) * 2;
  const bytes: Buffer = Buffer.alloc(44 + dataLength);
  bytes.write('RIFF', 0); bytes.writeUInt32LE(36 + dataLength, 4); bytes.write('WAVE', 8); bytes.write('fmt ', 12);
  bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22); bytes.writeUInt32LE(sampleRate, 24);
  bytes.writeUInt32LE(sampleRate * 2, 28); bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34); bytes.write('data', 36); bytes.writeUInt32LE(dataLength, 40);
  return bytes;
}

async function outline(): Promise<Project> {
  return createSourceOutline(importPackage(await nativePackage()), { proposedTextHoldMs: 2000 });
}

describe('생성 미디어 반영', (): void => {
  it('WAV 청크에서 실제 길이를 읽고 음성 큐와 생성 이력을 갱신한다', async (): Promise<void> => {
    const project: Project = await outline();
    const cue = project.audioCues[0];
    if (cue === undefined) throw new Error('오디오 검증 자료가 없습니다.');
    const bytes: Buffer = wav(500);
    expect(wavDurationMs(bytes)).toBe(500);
    const mutation = applyGeneratedSpeech(project, cue.id, 'speech-generation', '2026-09-06T00:00:00.000Z', { bytes, provider: 'codex-app', prompt: '가이드', model: 'speech-model', requestId: 'request-1', mimeType: 'audio/wav' });
    expect(mutation.project.audioCues.find((candidate): boolean => candidate.id === cue.id)).toEqual(expect.objectContaining({ assetId: 'speech-generation:audio', timingStatus: 'measured', endMs: cue.startMs + 500 }));
    expect(mutation.project.generationRecords[0]).toEqual(expect.objectContaining({ provider: 'codex-app', requestId: 'request-1', resultAssetIds: ['speech-generation:audio'] }));
    expect(project.audioCues.find((candidate): boolean => candidate.id === cue.id)?.assetId).toBeNull();
  });

  it('잘못된 이미지 헤더와 잠긴 프레임 덮어쓰기를 거부한다', async (): Promise<void> => {
    const project: Project = await outline();
    const frame = project.frames[0];
    if (frame === undefined) throw new Error('프레임 검증 자료가 없습니다.');
    const result = { bytes: Buffer.from('not-png'), provider: 'codex-app' as const, prompt: 'frame', model: 'image-model', requestId: 'request-1', mimeType: 'image/png' as const, referenceHashes: [] };
    expect(() => applyGeneratedImage(project, frame.id, 'image-generation', '2026-09-06T00:00:00.000Z', result)).toThrowError(expect.objectContaining({ code: 'INVALID_IMAGE_BYTES' }));
    const locked: Project = { ...project, shots: project.shots.map((shot) => shot.id === frame.shotId ? { ...shot, lockedFields: ['frames'] } : shot) };
    expect(() => applyGeneratedImage(locked, frame.id, 'image-generation', '2026-09-06T00:00:00.000Z', { ...result, bytes: Buffer.from('89504e470d0a1a0a', 'hex') })).toThrowError(expect.objectContaining({ code: 'SHOT_FIELD_LOCKED' }));
  });

  it('인물 기준 이미지를 버전으로 누적하고 입력 프로젝트를 바꾸지 않는다', async (): Promise<void> => {
    const project: Project = await outline();
    const person = project.dataset.people[0];
    if (person === undefined) throw new Error('인물 검증 자료가 없습니다.');
    const image: Buffer = Buffer.from('89504e470d0a1a0a', 'hex');
    const first = addReferenceAsset(project, { id: 'reference-1', kind: 'character', subjectId: person.id, description: '정면 기준', mimeType: 'image/png', bytes: image });
    const second = addReferenceAsset(first.project, { id: 'reference-2', kind: 'character', subjectId: person.id, description: '측면 기준', mimeType: 'image/png', bytes: image });
    expect(second.project.assets.map((asset): number => asset.version)).toEqual([1, 2]);
    expect(project.assets).toEqual([]);
  });
});

import { describe, expect, it } from 'vitest';
import { addStoryboardFrame, updateStoryboardFrame } from '../src/domain/frame.js';
import { activeStoryboardFrame } from '../src/domain/playback.js';
import type { Project } from '../src/domain/schema.js';
import { importPackage } from '../src/importers/import-package.js';
import { createSourceOutline } from '../src/proposal/outline.js';
import { nativePackage } from './helpers.js';

async function outline(): Promise<Project> {
  return createSourceOutline(importPackage(await nativePackage()), { proposedTextHoldMs: 2000 });
}

describe('다중 콘티 프레임과 재생', (): void => {
  it('시작·키·끝 프레임을 컷 안에 추가하고 재생 위치에 맞춰 고른다', async (): Promise<void> => {
    const project: Project = await outline();
    const shot = project.shots[0];
    if (shot === undefined) throw new Error('검증용 컷이 없습니다.');
    const duration: number = shot.endMs - shot.startMs;
    const withKey: Project = addStoryboardFrame(project, shot.id, 'key-frame', { offsetMs: 1000, role: 'key', description: '중간 동작' });
    const withEnd: Project = addStoryboardFrame(withKey, shot.id, 'end-frame', { offsetMs: duration, role: 'end', description: '끝 동작' });
    expect(activeStoryboardFrame(withEnd, shot.id, shot.startMs + 999)?.role).toBe('start');
    expect(activeStoryboardFrame(withEnd, shot.id, shot.startMs + 1000)?.id).toBe('key-frame');
    expect(activeStoryboardFrame(withEnd, shot.id, shot.endMs)?.id).toBe('end-frame');
    expect(project.frames).toHaveLength(3);
  });

  it('프레임 역할·오프셋 규칙과 프레임 잠금을 강제한다', async (): Promise<void> => {
    const project: Project = await outline();
    const shot = project.shots[0];
    const frame = project.frames[0];
    if (shot === undefined || frame === undefined) throw new Error('검증용 컷 또는 프레임이 없습니다.');
    expect(() => addStoryboardFrame(project, shot.id, 'bad-key', { offsetMs: 0, role: 'key', description: '잘못된 키' })).toThrowError(expect.objectContaining({ code: 'INVALID_FRAME_EDIT' }));
    expect(() => updateStoryboardFrame(project, frame.id, { offsetMs: 10, role: 'start', description: frame.description })).toThrowError(expect.objectContaining({ code: 'INVALID_FRAME_EDIT' }));
    const locked: Project = { ...project, shots: project.shots.map((candidate) => candidate.id === shot.id ? { ...candidate, lockedFields: ['frames'] } : candidate) };
    expect(() => addStoryboardFrame(locked, shot.id, 'locked-key', { offsetMs: 1000, role: 'key', description: '잠긴 키' })).toThrowError(expect.objectContaining({ code: 'SHOT_FIELD_LOCKED' }));
  });
});

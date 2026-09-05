import { describe, expect, it } from 'vitest';
import { approveShot, mergeShots, reorderShots, requireShot, setShotLocks, shotContent, splitShot, updateShotContent } from '../src/domain/edit.js';
import type { Project } from '../src/domain/schema.js';
import { validateProject } from '../src/domain/validation.js';
import { importPackage } from '../src/importers/import-package.js';
import { createSourceOutline } from '../src/proposal/outline.js';
import { nativePackage, productionPackage } from './helpers.js';

async function nativeOutline(): Promise<Project> {
  return createSourceOutline(importPackage(await nativePackage()), { proposedTextHoldMs: 3000 });
}

describe('원문 뼈대와 편집', (): void => {
  it('전체 원문·발화·자막을 연결하고 시각 정보와 음성을 확정한 것처럼 표시하지 않는다', async (): Promise<void> => {
    for (const payload of [await nativePackage(), await productionPackage()]) {
      const imported = importPackage(payload);
      const before: string = JSON.stringify(imported);
      const project = createSourceOutline(imported, { proposedTextHoldMs: 3000 });
      expect(validateProject(project, imported.dataset)).toEqual([]);
      expect(JSON.stringify(imported)).toBe(before);
      expect(project.shots.every((shot): boolean => shot.visualLocationId === null && shot.presence.length === 0 && shot.approvalStatus === 'proposed')).toBe(true);
      expect(project.audioCues.every((cue): boolean => cue.timingStatus === 'proposed' && cue.assetId === null)).toBe(true);
      expect(() => createSourceOutline(project, { proposedTextHoldMs: 3000 })).toThrowError(expect.objectContaining({ code: 'OUTLINE_ALREADY_EXISTS' }));
    }
  });

  it('컷 분할·순서 변경·병합이 원문 ID와 독립 음성 트랙을 보존한다', async (): Promise<void> => {
    const project = await nativeOutline();
    const original: string = JSON.stringify(project);
    const split = splitShot(project, 'shot-2', 8000, 'new-shot', 'new-frame');
    expect(split.shots).toHaveLength(4);
    expect(split.audioCues).toEqual(project.audioCues);
    expect(requireShot(split, 'shot-2').sourceUnitIds).toEqual(requireShot(split, 'new-shot').sourceUnitIds);
    const reordered = reorderShots(split, 'demonstration', ['new-shot', 'shot-2']);
    expect(requireShot(reordered, 'new-shot').startMs).toBe(5000);
    expect(requireShot(reordered, 'shot-2').endMs).toBe(13500);
    const merged = mergeShots(split, 'shot-2', 'new-shot');
    expect(merged.shots.map((shot): string => shot.id)).toEqual(project.shots.map((shot): string => shot.id));
    expect(merged.audioCues).toEqual(project.audioCues);
    expect(merged.dataset).toEqual(project.dataset);
    expect(validateProject(merged, project.dataset)).toEqual([]);
    expect(JSON.stringify(project)).toBe(original);
  });

  it('확정 컷과 잠긴 필드는 덮어쓰지 않고 명시적 잠금 해제 후 수정한다', async (): Promise<void> => {
    const project = approveShot(await nativeOutline(), 'shot-1');
    const shot = requireShot(project, 'shot-1');
    expect(() => updateShotContent(project, shot.id, { ...shotContent(shot), action: '새로운 연출' })).toThrowError(expect.objectContaining({ code: 'SHOT_FIELD_LOCKED' }));
    expect(() => splitShot(project, shot.id, 2500, 'new', 'frame-new')).toThrowError(expect.objectContaining({ code: 'SHOT_FIELD_LOCKED' }));
    const unlocked = setShotLocks(project, shot.id, shot.lockedFields.filter((field): boolean => field !== 'action'));
    const modified = updateShotContent(unlocked, shot.id, { ...shotContent(requireShot(unlocked, shot.id)), action: '새로운 연출' });
    expect(requireShot(modified, shot.id).action).toBe('새로운 연출');
    expect(requireShot(modified, shot.id).approvalStatus).toBe('proposed');
    expect(modified.dataset).toEqual(project.dataset);
  });

  it('채팅 낭독·발화 복제·자막 삭제·원문 변경·프로젝트 혼입을 검출한다', async (): Promise<void> => {
    const project = await nativeOutline();
    const audio = project.audioCues[0];
    if (audio === undefined) throw new Error('음성 검증 자료가 없습니다.');
    expect(validateProject({ ...project, audioCues: [...project.audioCues, { ...audio, id: 'duplicate-audio' }] }, project.dataset).some((issue): boolean => issue.code === 'SPOKEN_UNIT_COVERAGE')).toBe(true);
    expect(validateProject({ ...project, textCues: [] }, project.dataset).some((issue): boolean => issue.code === 'UNCOVERED_SCREEN_TEXT')).toBe(true);
    expect(validateProject({ ...project, dataset: { ...project.dataset, units: project.dataset.units.map((unit) => ({ ...unit, text: '변경됨' })) } }, project.dataset).some((issue): boolean => issue.code === 'SOURCE_DATASET_MODIFIED')).toBe(true);
    expect(validateProject({ ...project, projectId: '다른 작품' }, project.dataset).some((issue): boolean => issue.code === 'PROJECT_MISMATCH')).toBe(true);
    expect(validateProject({ ...project, audioCues: [...project.audioCues, { ...audio, id: 'text-read', unitId: '제목' }] }, project.dataset).some((issue): boolean => issue.code === 'NON_SPOKEN_UNIT_AUDIO')).toBe(true);
  });

  it('미공개 정보를 초기 컷에 붙이는 변경은 거부한다', async (): Promise<void> => {
    const project = createSourceOutline(importPackage(await productionPackage()), { proposedTextHoldMs: 3000 });
    const later = project.dataset.informationRules.find((rule): boolean => rule.notBeforeMs > 0);
    if (later === undefined) throw new Error('공개 시점 검증 자료가 없습니다.');
    const shot = requireShot(project, 'shot-1');
    expect(() => updateShotContent(project, shot.id, { ...shotContent(shot), informationIds: [...shot.informationIds, later.id] })).toThrowError(expect.objectContaining({ code: 'INVALID_EDIT', issues: expect.arrayContaining([expect.objectContaining({ code: 'FORBIDDEN_REVEAL' })]) }));
  });

  it('편집 입력에 시간이나 잠금 필드를 숨겨 넣어 우회할 수 없다', async (): Promise<void> => {
    const project = await nativeOutline();
    const shot = requireShot(project, 'shot-1');
    const forged = { ...shotContent(shot), startMs: 100, lockedFields: [] };
    expect(() => updateShotContent(project, shot.id, forged)).toThrow();
  });
});

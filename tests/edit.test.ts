import { describe, expect, it } from 'vitest';
import { approveShot, mergeShots, reorderShots, requireShot, setShotLocks, shotContent, splitShot, updateShotContent } from '../src/domain/edit.js';
import type { Asset, Project } from '../src/domain/schema.js';
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
    expect(requireShot(split, 'shot-2').sourceLinks).not.toEqual(requireShot(split, 'new-shot').sourceLinks);
    expect([...requireShot(split, 'shot-2').sourceLinks, ...requireShot(split, 'new-shot').sourceLinks].some((link): boolean => link.status === 'mapping-required')).toBe(true);
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
    expect(validateProject({ ...project, textCues: [], textMappingDecisions: [] }, project.dataset).some((issue): boolean => ['UNCOVERED_SCREEN_TEXT', 'TEXT_MAPPING_DECISION_COVERAGE'].includes(issue.code))).toBe(true);
    expect(validateProject({ ...project, dataset: { ...project.dataset, units: project.dataset.units.map((unit) => ({ ...unit, text: '변경됨' })) } }, project.dataset).some((issue): boolean => issue.code === 'SOURCE_DATASET_MODIFIED')).toBe(true);
    expect(validateProject({ ...project, projectId: '다른 작품' }, project.dataset).some((issue): boolean => issue.code === 'PROJECT_MISMATCH')).toBe(true);
    expect(validateProject({ ...project, audioCues: [...project.audioCues, { ...audio, id: 'text-read', unitId: '제목' }] }, project.dataset).some((issue): boolean => issue.code === 'NON_SPOKEN_UNIT_AUDIO')).toBe(true);
  });

  it('미공개 정보는 초안 편집을 허용하지만 컷 승인을 거부한다', async (): Promise<void> => {
    const project = createSourceOutline(importPackage(await productionPackage()), { proposedTextHoldMs: 3000 });
    const later = project.dataset.informationRules.find((rule): boolean => rule.baseNotBeforeMs > 0);
    if (later === undefined) throw new Error('공개 시점 검증 자료가 없습니다.');
    const shot = requireShot(project, 'shot-1');
    const changed = updateShotContent(project, shot.id, { ...shotContent(shot), informationIds: [...shot.informationIds, later.id] });
    expect(() => approveShot(changed, shot.id)).toThrowError(expect.objectContaining({ code: 'SHOT_APPROVAL_BLOCKED', issues: expect.arrayContaining([expect.objectContaining({ code: 'INFORMATION_WITHOUT_SOURCE_LINK' })]) }));
  });

  it('편집 입력에 시간이나 잠금 필드를 숨겨 넣어 우회할 수 없다', async (): Promise<void> => {
    const project = await nativeOutline();
    const shot = requireShot(project, 'shot-1');
    const forged = { ...shotContent(shot), startMs: 100, lockedFields: [] };
    expect(() => updateShotContent(project, shot.id, forged)).toThrow();
  });

  it('전환을 컷 콘텐츠로 편집하고 분할·병합 경계에서 보존한다', async (): Promise<void> => {
    const project = await nativeOutline();
    const shot = requireShot(project, 'shot-2');
    const transitioned = updateShotContent(project, shot.id, { ...shotContent(shot), transitionOut: { kind: 'dissolve', durationMs: 500, note: '시간 경과' } });
    const split = splitShot(transitioned, shot.id, 8000, 'transition-shot', 'transition-frame');
    expect(requireShot(split, shot.id).transitionOut).toEqual({ kind: 'cut', durationMs: 0, note: '' });
    expect(requireShot(split, 'transition-shot').transitionOut).toEqual({ kind: 'dissolve', durationMs: 500, note: '시간 경과' });
    const merged = mergeShots(split, shot.id, 'transition-shot');
    expect(requireShot(merged, shot.id).transitionOut).toEqual({ kind: 'dissolve', durationMs: 500, note: '시간 경과' });
    expect(() => updateShotContent(project, shot.id, { ...shotContent(shot), transitionOut: { kind: 'cut', durationMs: 100, note: '' } })).toThrowError(expect.objectContaining({ code: 'INVALID_EDIT' }));
  });

  it('키 프레임 위치에서 분할할 때 그 프레임을 새 컷의 시작으로 재사용한다', async (): Promise<void> => {
    const project = await nativeOutline();
    const shot = requireShot(project, 'shot-2');
    const withBoundary: Project = { ...project, frames: [...project.frames, { id: 'boundary-key', shotId: shot.id, offsetMs: 3000, role: 'key', description: '분할 경계', imageAssetId: null, visualReview: 'pending' }] };
    const split = splitShot(withBoundary, shot.id, shot.startMs + 3000, 'boundary-shot', 'unused-frame');
    const starts = split.frames.filter((frame): boolean => frame.shotId === 'boundary-shot' && frame.role === 'start');
    expect(starts).toEqual([expect.objectContaining({ id: 'boundary-key', offsetMs: 0 })]);
    expect(split.frames.some((frame): boolean => frame.id === 'unused-frame')).toBe(false);
  });

  it('인접 컷의 자산 상태가 다르면 연속성 오류로 저장을 거부한다', async (): Promise<void> => {
    const project = await nativeOutline();
    const asset: Asset = { id: 'continuity-prop', kind: 'prop', subjectId: null, path: 'assets/continuity.png', mimeType: 'image/png', sha256: '1'.repeat(64), description: '연속성 소품', durationMs: null, version: 1 };
    const withAsset: Project = { ...project, assets: [asset] };
    const first = requireShot(withAsset, 'shot-1');
    const second = requireShot(withAsset, 'shot-2');
    const outgoing = updateShotContent(withAsset, first.id, { ...shotContent(first), continuityAfter: [{ assetId: asset.id, state: '닫힘' }] });
    expect(() => updateShotContent(outgoing, second.id, { ...shotContent(requireShot(outgoing, second.id)), continuityBefore: [{ assetId: asset.id, state: '열림' }] })).toThrowError(expect.objectContaining({ code: 'INVALID_EDIT', issues: expect.arrayContaining([expect.objectContaining({ code: 'CONTINUITY_STATE_MISMATCH' })]) }));
  });
});

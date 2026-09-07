import { describe, expect, it } from 'vitest';
import type { Asset, AudioCue, Project, TextCue } from '../src/domain/schema.js';
import { confirmTextCueTiming, updateAudioCueTiming, updateTextCueTiming } from '../src/domain/tracks.js';
import { importPackage } from '../src/importers/import-package.js';
import { createSourceOutline } from '../src/proposal/outline.js';
import { nativePackage } from './helpers.js';

async function outline(): Promise<Project> {
  return createSourceOutline(importPackage(await nativePackage()), { proposedTextHoldMs: 2000 });
}

describe('독립 오디오·글자 트랙 편집', (): void => {
  it('같은 길이로 오디오를 옮길 때 자산을 유지하고 길이가 바뀌면 재측정을 요구한다', async (): Promise<void> => {
    const project: Project = await outline();
    const cue: AudioCue | undefined = project.audioCues[0];
    if (cue === undefined) throw new Error('검증용 오디오 큐가 없습니다.');
    const measuredCue: AudioCue = { ...cue, endMs: cue.endMs - 200, assetId: 'audio-asset', timingStatus: 'measured' };
    const asset: Asset = { id: 'audio-asset', kind: 'audio', subjectId: cue.id, path: 'assets/audio.wav', mimeType: 'audio/wav', sha256: '0'.repeat(64), description: '가이드 음성', durationMs: measuredCue.endMs - measuredCue.startMs, version: 1 };
    const measured: Project = { ...project, assets: [asset], audioCues: project.audioCues.map((candidate): AudioCue => candidate.id === cue.id ? measuredCue : candidate) };
    const shifted: Project = updateAudioCueTiming(measured, cue.id, { startMs: measuredCue.startMs + 100, endMs: measuredCue.endMs + 100, timingRelation: measuredCue.timingRelation });
    expect(shifted.audioCues.find((candidate): boolean => candidate.id === cue.id)).toEqual(expect.objectContaining({ assetId: asset.id, timingStatus: 'proposed' }));
    const resized: Project = updateAudioCueTiming(shifted, cue.id, { startMs: measuredCue.startMs + 100, endMs: measuredCue.endMs + 200, timingRelation: measuredCue.timingRelation });
    expect(resized.audioCues.find((candidate): boolean => candidate.id === cue.id)).toEqual(expect.objectContaining({ assetId: null, timingStatus: 'proposed' }));
    expect(project.audioCues[0]).toEqual(cue);
  });

  it('열린 Placement 종료는 편집하고 원본에서 확정된 시작점은 거부한다', async (): Promise<void> => {
    const project: Project = await outline();
    const fixed: TextCue | undefined = project.textCues.find((cue: TextCue): boolean => cue.placementId !== null);
    if (fixed === undefined) throw new Error('검증용 글자 큐가 없습니다.');
    const movable: TextCue = { ...fixed, id: 'movable-text', placementId: null, mappingDecisionId: null, authority: 'source-unit', timingStatus: 'proposed' };
    const editable: Project = { ...project, textCues: [...project.textCues, movable] };
    const moved: Project = updateTextCueTiming(editable, movable.id, { startMs: movable.startMs + 1, endMs: movable.endMs, kind: 'overlay' });
    expect(moved.textCues.find((cue): boolean => cue.id === movable.id)).toEqual(expect.objectContaining({ startMs: movable.startMs + 1, kind: 'overlay', text: movable.text, timingStatus: 'proposed' }));
    const confirmed: Project = { ...editable, textCues: editable.textCues.map((cue): TextCue => cue.id === movable.id ? { ...cue, timingStatus: 'confirmed' } : cue) };
    const retyped: Project = updateTextCueTiming(confirmed, movable.id, { startMs: movable.startMs, endMs: movable.endMs, kind: 'prop-text' });
    expect(retyped.textCues.find((cue): boolean => cue.id === movable.id)).toEqual(expect.objectContaining({ kind: 'prop-text', timingStatus: 'confirmed' }));
    const open: Project = { ...project,
      dataset: { ...project.dataset, textPlacements: project.dataset.textPlacements.map((placement) => placement.id === fixed.placementId ? { ...placement, endMs: null } : placement) },
      textCues: project.textCues.map((cue: TextCue): TextCue => cue.id === fixed.id ? { ...cue, timingStatus: 'proposed' } : cue),
    };
    const extended: Project = updateTextCueTiming(open, fixed.id, { startMs: fixed.startMs, endMs: fixed.endMs + 500, kind: fixed.kind });
    expect(extended.textCues.find((cue): boolean => cue.id === fixed.id)).toEqual(expect.objectContaining({ endMs: fixed.endMs + 500, timingStatus: 'proposed' }));
    expect(() => updateTextCueTiming(project, fixed.id, { startMs: fixed.startMs + 1, endMs: fixed.endMs, kind: fixed.kind })).toThrowError(expect.objectContaining({ code: 'AUTHORITATIVE_TEXT_CUE_READ_ONLY' }));
    expect(() => updateTextCueTiming(project, fixed.id, { startMs: fixed.startMs, endMs: fixed.endMs + 1, kind: fixed.kind })).toThrowError(expect.objectContaining({ code: 'AUTHORITATIVE_TEXT_CUE_READ_ONLY' }));
    expect(() => updateTextCueTiming(open, fixed.id, { startMs: fixed.startMs, endMs: fixed.endMs, kind: fixed.kind === 'overlay' ? 'prop-text' : 'overlay' })).toThrowError(expect.objectContaining({ code: 'AUTHORITATIVE_TEXT_CUE_READ_ONLY' }));
  });

  it('출력 검토를 통과한 글자 큐 시각을 확정하고 후속 시간 변경은 다시 제안 상태로 만든다', async (): Promise<void> => {
    const project: Project = await outline();
    const cue: TextCue | undefined = project.textCues.find((candidate: TextCue): boolean => candidate.placementId !== null);
    if (cue === undefined) throw new Error('검증용 글자 큐가 없습니다.');
    const proposed: Project = { ...project,
      dataset: { ...project.dataset, textPlacements: project.dataset.textPlacements.map((placement) => placement.id === cue.placementId ? { ...placement, endMs: null } : placement) },
      textCues: project.textCues.map((candidate: TextCue): TextCue => candidate.id === cue.id ? { ...candidate, timingStatus: 'proposed' } : candidate),
    };
    const confirmed: Project = confirmTextCueTiming(proposed, cue.id);
    expect(confirmed.textCues.find((candidate: TextCue): boolean => candidate.id === cue.id)?.timingStatus).toBe('confirmed');
    expect(proposed.textCues.find((candidate: TextCue): boolean => candidate.id === cue.id)?.timingStatus).toBe('proposed');
    const changed: Project = updateTextCueTiming(confirmed, cue.id, { startMs: cue.startMs, endMs: cue.endMs + 500, kind: cue.kind });
    expect(changed.textCues.find((candidate: TextCue): boolean => candidate.id === cue.id)?.timingStatus).toBe('proposed');
    const blocked: Project = { ...proposed, textCues: proposed.textCues.map((candidate: TextCue): TextCue => candidate.id === cue.id
      ? { ...candidate, authority: 'review-required', placementId: null } : candidate) };
    expect(() => confirmTextCueTiming(blocked, cue.id)).toThrowError(expect.objectContaining({ code: 'TEXT_TIMING_CONFIRMATION_BLOCKED' }));
  });
});

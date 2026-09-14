import { describe, expect, it } from 'vitest';
import { compileAutomaticSegmentPlan } from '../src/automation/plan-compiler.js';
import { createSegmentPlanBasis } from '../src/automation/plan-basis.js';
import type { AutomaticSegmentPlan } from '../src/automation/plan-schema.js';
import { effectiveInformationGate } from '../src/domain/mapping.js';
import type { Project } from '../src/domain/schema.js';
import { reviewIssuesForTextCue } from '../src/domain/emission.js';
import { importPackage } from '../src/importers/import-package.js';
import { createSourceOutline } from '../src/proposal/outline.js';
import { nativeData, nativePackage, withNativeData } from './helpers.js';
import { automaticPlanProject, automaticPlanProvenance, automaticShot, demonstrationPlan, existingPlanAudio, stagedPlanSpeech } from './automatic-plan-helpers.js';

function basis(project: Project, segmentId: string) {
  return createSegmentPlanBasis(project, segmentId, project.shots.filter((shot): boolean => shot.segmentId === segmentId).map((shot): string => shot.id));
}

describe('자동 원문·시간 후보 적용', (): void => {
  it('미정 연결과 실측 음성을 함께 검증하고 원본·다른 구간·사람 검토 상태를 보존한다', async (): Promise<void> => {
    const project = await automaticPlanProject();
    const snapshot = structuredClone(project);
    expect(effectiveInformationGate(project, 'reveal:안내-1').reviewRequired).toBe(true);
    expect(project.shots.find((shot): boolean => shot.segmentId === 'demonstration')?.sourceLinks.some((link): boolean => link.status === 'mapping-required')).toBe(true);
    const candidate = compileAutomaticSegmentPlan(project, basis(project, 'demonstration'), demonstrationPlan(project), [stagedPlanSpeech(project)], [], automaticPlanProvenance(), 64);
    expect(candidate.project.dataset).toEqual(project.dataset);
    expect(project).toEqual(snapshot);
    expect(candidate.project.shots.filter((shot): boolean => shot.segmentId !== 'demonstration')).toEqual(project.shots.filter((shot): boolean => shot.segmentId !== 'demonstration'));
    expect(candidate.project.frames.every((frame): boolean => frame.visualReview === 'pending')).toBe(true);
    expect(candidate.project.shots.every((shot): boolean => shot.approvalStatus === 'proposed')).toBe(true);
    expect(candidate.project.revision).toBe(project.revision);
    expect(candidate.writes).toHaveLength(1);
    expect(candidate.project.audioCues.find((cue): boolean => cue.unitId === '안내-1')).toMatchObject({ startMs: 5000, endMs: 7300, timingStatus: 'measured' });
    expect(effectiveInformationGate(candidate.project, 'reveal:안내-1').reviewRequired).toBe(false);
    expect(candidate.exceptions).toEqual([]);
    expect(candidate.project.generationRecords.map((record): string => record.provider)).toEqual(['codex-app', 'macos-speech']);
  });

  it('시점 계획과 다른 실제 음성 길이는 보정 오류로 반환하고 입력을 바꾸지 않는다', async (): Promise<void> => {
    const project = await automaticPlanProject();
    const plan = demonstrationPlan(project);
    const invalid = { ...plan, audioTimings: plan.audioTimings.map((timing) => ({ ...timing, endMs: timing.endMs + 1 })) };
    expect(() => compileAutomaticSegmentPlan(project, basis(project, 'demonstration'), invalid, [stagedPlanSpeech(project)], [], automaticPlanProvenance(), 64)).toThrowError(expect.objectContaining({ code: 'AUTOMATION_SPEECH_DURATION' }));
    expect(project.assets).toEqual([]);
  });

  it('모델이 음성 바이트나 원문 해시를 바꾸면 등록하지 않는다', async (): Promise<void> => {
    const project = await automaticPlanProject();
    const staged = stagedPlanSpeech(project);
    const changed = { ...staged, result: { ...staged.result, sourceTextHash: 'a'.repeat(64) } };
    expect(() => compileAutomaticSegmentPlan(project, basis(project, 'demonstration'), demonstrationPlan(project), [changed], [], automaticPlanProvenance(), 64)).toThrowError(expect.objectContaining({ code: 'AUTOMATION_SPEECH_SOURCE_CHANGED' }));
    const bytes = Buffer.from(staged.result.bytes);
    bytes[100] = 1;
    expect(() => compileAutomaticSegmentPlan(project, basis(project, 'demonstration'), demonstrationPlan(project), [{ ...staged, result: { ...staged.result, bytes } }], [], automaticPlanProvenance(), 64)).toThrowError(expect.objectContaining({ code: 'AUTOMATION_SPEECH_INTEGRITY' }));
  });

  it('선택한 프로젝트와 revision 또는 같은 revision의 내용이 바뀌면 오래된 후보를 거부한다', async (): Promise<void> => {
    const project = await automaticPlanProject();
    const originalBasis = basis(project, 'demonstration');
    for (const changed of [{ ...project, revision: 1 }, { ...project, title: '사용자 수정' }, { ...project, projectId: 'another-story' }]) {
      expect(() => compileAutomaticSegmentPlan(changed, originalBasis, demonstrationPlan(project), [stagedPlanSpeech(project)], [], automaticPlanProvenance(), 64)).toThrowError(expect.objectContaining({ code: 'AUTOMATION_STALE_PLAN' }));
    }
  });

  it('확정·잠금 컷과 명시되지 않은 교체 범위를 보호한다', async (): Promise<void> => {
    const project = await automaticPlanProject();
    expect(() => createSegmentPlanBasis(project, 'demonstration', [])).toThrowError(expect.objectContaining({ code: 'AUTOMATION_REPLACEMENT_SCOPE' }));
    const locked: Project = { ...project, shots: project.shots.map((shot) => shot.segmentId === 'demonstration' ? { ...shot, lockedFields: ['action'] } : shot) };
    expect(() => basis(locked, 'demonstration')).toThrowError(expect.objectContaining({ code: 'AUTOMATION_PROTECTED_SHOTS' }));
  });

  it('다른 구간 원문·알 수 없는 인물·중복 발화·대사 재작성 입력을 거부한다', async (): Promise<void> => {
    const project = await automaticPlanProject();
    const plan = demonstrationPlan(project);
    const variants: unknown[] = [
      { ...plan, shots: plan.shots.map((shot) => ({ ...shot, sourceLinks: [...shot.sourceLinks, { unitId: 'UNIT-001', usage: 'context-only', startOffsetMs: 0, endOffsetMs: 100, reason: '잘못된 구간' }] })) },
      { ...plan, shots: plan.shots.map((shot) => ({ ...shot, presence: [{ personId: 'unknown', mode: 'VISIBLE' }] })) },
      { ...plan, audioTimings: [...plan.audioTimings, ...plan.audioTimings] },
      { ...plan, audioTimings: plan.audioTimings.map((timing) => ({ ...timing, text: '새 대사' })) },
    ];
    for (const input of variants) expect(() => compileAutomaticSegmentPlan(project, basis(project, 'demonstration'), input, [stagedPlanSpeech(project)], [], automaticPlanProvenance(), 64)).toThrow();
  });

  it('고정 시간표·시각 커버리지·공개 순서 위반을 자동 승인으로 우회하지 않는다', async (): Promise<void> => {
    const project = await automaticPlanProject();
    const plan = demonstrationPlan(project);
    const variants: AutomaticSegmentPlan[] = [
      { ...plan, shots: plan.shots.map((shot) => ({ ...shot, endMs: shot.endMs + 100 })) },
      { ...plan, shots: plan.shots.map((shot) => ({ ...shot, sourceLinks: shot.sourceLinks.map((link) => link.usage === 'primary-visual' ? { ...link, endOffsetMs: 1000 } : link) })) },
      { ...plan, audioTimings: plan.audioTimings.map((timing) => timing.endMs - timing.startMs === 2300 ? { ...timing, startMs: 6000, endMs: 8300 } : timing) },
    ];
    for (const input of variants) expect(() => compileAutomaticSegmentPlan(project, basis(project, 'demonstration'), input, [stagedPlanSpeech(project)], [], automaticPlanProvenance(), 64)).toThrowError(expect.objectContaining({ code: 'AUTOMATION_CANDIDATE_INVALID' }));
  });

  it('파생 공개 프레임을 포함해 생성 한도를 검사하고 명시 프레임 충돌을 거부한다', async (): Promise<void> => {
    const project = await automaticPlanProject();
    const plan = demonstrationPlan(project);
    const derived = { ...plan, shots: plan.shots.map((shot) => ({ ...shot, sourceLinks: shot.sourceLinks.map((link) => link.usage === 'primary-visual' ? { ...link, startOffsetMs: 1000 } : link) })) };
    expect(() => compileAutomaticSegmentPlan(project, basis(project, 'demonstration'), derived, [stagedPlanSpeech(project)], [], automaticPlanProvenance(), 1)).toThrowError(expect.objectContaining({ code: 'AUTOMATION_FRAME_BUDGET' }));
    const duplicate = { ...plan, shots: plan.shots.map((shot) => ({ ...shot, frames: [...shot.frames, ...shot.frames] })) };
    expect(() => compileAutomaticSegmentPlan(project, basis(project, 'demonstration'), duplicate, [stagedPlanSpeech(project)], [], automaticPlanProvenance(), 64)).toThrowError(expect.objectContaining({ code: 'AUTOMATION_FRAME_COLLISION' }));
  });

  it('확정된 화면 문구와 시각은 보존하고 새 글자를 사람 확정으로 표시하지 않는다', async (): Promise<void> => {
    const project = await automaticPlanProject();
    const plan: AutomaticSegmentPlan = { schemaVersion: '1.0.0', segmentId: 'SEG-001', summary: '제목과 화분 원문의 검토 계획.', shots: [{ ...automaticShot(0, 5000), sourceLinks: [
      { unitId: 'UNIT-001', usage: 'primary-visual', startOffsetMs: 0, endOffsetMs: 5000, reason: '화분을 보여준다.' },
      { unitId: '제목', usage: 'primary-visual', startOffsetMs: 0, endOffsetMs: 4000, reason: '고정 제목 표시를 보존한다.' },
    ] }], mappings: [], placementInformation: [], audioTimings: [], textTimings: [{ authority: 'placement', targetId: 'title-placement', startMs: 0, endMs: 4000, reason: '원본의 확정 시각.' }] };
    const candidate = compileAutomaticSegmentPlan(project, basis(project, 'SEG-001'), plan, [], [], automaticPlanProvenance(), 64);
    const title = candidate.project.textCues.find((cue): boolean => cue.placementId === 'title-placement');
    expect(title).toMatchObject({ text: '흙부터 확인하세요', startMs: 0, endMs: 4000 });
    expect(reviewIssuesForTextCue(candidate.project, title?.id ?? '')).toEqual([]);
    const changed = { ...plan, textTimings: plan.textTimings.map((timing) => ({ ...timing, startMs: 50 })) };
    expect(() => compileAutomaticSegmentPlan(project, basis(project, 'SEG-001'), changed, [], [], automaticPlanProvenance(), 64)).toThrow();
  });

  it('automation_plan_resolves_ambiguous_text_from_originals_without_auto_confirming_new_timing', async (): Promise<void> => {
    const payload = await nativePackage(); const data = nativeData(payload);
    const project = createSourceOutline(importPackage(withNativeData(payload, { ...data, textPlacements: data.textPlacements.map((placement) => placement.id === 'title-placement' ? { ...placement, text: '흙 확인', unitId: null, endMs: null } : placement) })), { proposedTextHoldMs: 2000 });
    const mapping = project.textMappingDecisions.find((value): boolean => value.placementId === 'title-placement')!;
    expect(mapping.status).toBe('unresolved');
    const plan: AutomaticSegmentPlan = { schemaVersion: '1.0.0', segmentId: 'SEG-001', summary: '축약 글자와 별도 원문 렌더링 계획.', shots: [{ ...automaticShot(0, 5000), sourceLinks: [
      { unitId: 'UNIT-001', usage: 'primary-visual', startOffsetMs: 0, endOffsetMs: 5000, reason: '화분 원문 행동.' }, { unitId: '제목', usage: 'primary-visual', startOffsetMs: 0, endOffsetMs: 4000, reason: '제목 원문 보존.' },
    ] }], mappings: [{ decisionId: mapping.id, canonicalUnitId: '제목', relation: 'abbreviation', renderCanonicalSeparately: true, canonicalStartMs: 0, canonicalEndMs: 4000, reason: '축약 문구이며 원문을 별도로 표시한다.' }], placementInformation: [], audioTimings: [], textTimings: [
      { authority: 'placement', targetId: 'title-placement', startMs: 0, endMs: 3000, reason: '짧은 축약 글자 검토 시간.' }, { authority: 'mapping-decision', targetId: mapping.id, startMs: 0, endMs: 4000, reason: '원문 별도 렌더링 시간.' },
    ] };
    const candidate = compileAutomaticSegmentPlan(project, basis(project, 'SEG-001'), plan, [], [], automaticPlanProvenance(), 64);
    expect(candidate.project.textCues.filter((cue): boolean => cue.segmentId === 'SEG-001').map((cue) => [cue.text, cue.timingStatus])).toEqual([['흙 확인', 'proposed'], ['흙부터 확인하세요', 'proposed']]);
    expect(candidate.project.dataset).toEqual(project.dataset);
  });

  it('automation_replan_preserves_measured_audio_assets_and_historical_generation_targets', async (): Promise<void> => {
    const original = await automaticPlanProject(); const plan = demonstrationPlan(original);
    const first = compileAutomaticSegmentPlan(original, basis(original, 'demonstration'), plan, [stagedPlanSpeech(original)], [], automaticPlanProvenance(), 64);
    const second = compileAutomaticSegmentPlan(first.project, basis(first.project, 'demonstration'), plan, [], existingPlanAudio(first.project, first.writes), { ...automaticPlanProvenance(), generationId: 'second-plan' }, 64);
    expect(second.writes).toEqual([]);
    expect(second.project.assets).toEqual(first.project.assets);
    expect(second.project.generationRecords.slice(0, 2)).toEqual(first.project.generationRecords);
    expect(second.project.generationRecords[0]?.shotIds).toEqual(['automatic-plan-test:shot:0']);
    expect(second.project.shots.some((shot): boolean => shot.id === 'automatic-plan-test:shot:0')).toBe(false);
    const pending: Project = { ...first.project, audioCues: first.project.audioCues.map((cue) => cue.unitId === '안내-1' ? { ...cue, timingStatus: 'proposed' } : cue) };
    expect(() => compileAutomaticSegmentPlan(pending, basis(pending, 'demonstration'), plan, [stagedPlanSpeech(original)], [], { ...automaticPlanProvenance(), generationId: 'third-plan' }, 64)).toThrowError(expect.objectContaining({ code: 'AUTOMATION_EXISTING_AUDIO_REVIEW' }));
  });
});

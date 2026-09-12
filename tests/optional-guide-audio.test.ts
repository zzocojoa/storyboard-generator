import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { createSegmentPlanBasis } from '../src/automation/plan-basis.js';
import { compileAutomaticSegmentPlan } from '../src/automation/plan-compiler.js';
import { planAutomaticSegment } from '../src/automation/plan-segment.js';
import type { AutomaticSegmentPlan } from '../src/automation/plan-schema.js';
import { automationAudioProduction, AutomationSettingsSchema } from '../src/automation/run-schema.js';
import { requiredAutomationSpeechVoices, missingVoiceCastingSpeakers } from '../src/automation/speech-settings.js';
import { approveShot } from '../src/domain/edit.js';
import { setFrameReview } from '../src/domain/frame.js';
import { reviewFinalReadiness } from '../src/domain/final-readiness.js';
import { storyboardAudioIssues } from '../src/domain/audio-storyboard.js';
import { effectiveInformationGate } from '../src/domain/mapping.js';
import { inspectImageBytes } from '../src/domain/media-inspection.js';
import { reviewAudioPlaybackAt } from '../src/domain/playback.js';
import type { Asset, Project } from '../src/domain/schema.js';
import { createCsvProjection } from '../src/exporters/csv.js';
import { createPdfProjection, exportProjectPdfForPolicy } from '../src/exporters/pdf.js';
import { importPackage } from '../src/importers/import-package.js';
import { createSourceOutline } from '../src/proposal/outline.js';
import { recommendedAutomationSettings } from '../src/server/automation-routes.js';
import { automaticPlanProvenance, demonstrationPlan } from './automatic-plan-helpers.js';
import { nativeData, nativePackage, png, TEST_TEXT_FONT_PATH, withNativeData } from './helpers.js';

async function storyboardFixture(): Promise<{ project: Project; plan: AutomaticSegmentPlan }> {
  const payload = await nativePackage(); const data = nativeData(payload);
  const units = data.units.filter((unit): boolean => unit.segmentId === 'demonstration').map((unit) => ({ ...unit, informationIds: [`reveal:${unit.id}`] }));
  const project = createSourceOutline(importPackage(withNativeData(payload, { ...data,
    scenes: data.scenes.filter((scene): boolean => scene.id === 'SCN-01'),
    segments: data.segments.filter((segment): boolean => segment.id === 'demonstration').map((segment) => ({ ...segment, startMs: 0, endMs: 8500 })),
    units, textPlacements: [], informationRules: units.map((unit) => ({ id: `reveal:${unit.id}`, segmentId: unit.segmentId, notBeforeMs: 0, notBeforeUnitId: unit.id, notBeforeUnitOrder: unit.order, precision: 'unit-order' as const })),
  })), { proposedTextHoldMs: 2000 });
  const proposed = demonstrationPlan(project);
  return { project, plan: { ...proposed, shots: proposed.shots.map((shot) => ({ ...shot, startMs: shot.startMs - 5000, endMs: shot.endMs - 5000 })),
    audioTimings: proposed.audioTimings.map((cue) => ({ ...cue, startMs: cue.startMs - 5000, endMs: cue.endMs - 5000 })) } };
}

describe('음원 선택 기능과 기본 콘티 완료', (): void => {
  it('음성 엔진 없이 콘티를 자동 계획하고 실제 그림 검토 뒤 Final PDF와 CSV에 대사를 출력한다', async (): Promise<void> => {
    const { project, plan } = await storyboardFixture(); const before = structuredClone(project);
    const provenance = automaticPlanProvenance();
    const speech = vi.fn(async (): Promise<never> => { throw new Error('기본 콘티 제작에서 음성을 호출했습니다.'); });
    const candidate = await planAutomaticSegment(project, createSegmentPlanBasis(project, 'demonstration', project.shots.map((shot): string => shot.id)), {
      audioProduction: 'instructions-only', voice: { name: 'not-installed', rateWordsPerMinute: 180 }, density: null,
      maxCorrections: 0, maxFrames: 64, maxStagedAudioBytes: 5000000, provenance: { generationId: provenance.generationId, createdAt: provenance.createdAt, generatorBuild: provenance.generatorBuild },
    }, { textFontPath: TEST_TEXT_FONT_PATH, speech: { run: speech },
      model: { run: async () => ({ model: 'fixture', turnId: 'turn', result: z.json().parse(plan) }) },
      loadExistingAudio: async (): Promise<never> => { throw new Error('음원이 없는 콘티에서 파일을 읽었습니다.'); },
      onProgress: async (): Promise<void> => {}, onSpeechReady: async (): Promise<never> => { throw new Error('음성 파일을 준비했습니다.'); },
    }, new AbortController().signal);
    expect(speech).not.toHaveBeenCalled(); expect(candidate.writes).toEqual([]); expect(project).toEqual(before);
    expect(candidate.project.assets).toEqual([]);
    expect(candidate.project.audioCues.every((cue): boolean => cue.assetId === null && cue.timingStatus === 'proposed')).toBe(true);
    expect(effectiveInformationGate(candidate.project, 'reveal:안내-1')).toMatchObject({ evidenceType: 'planned-audio', reviewRequired: false, effectiveNotBeforeMs: 0 });
    expect(reviewFinalReadiness(candidate.project, {}).finalReady).toBe(false);
    const bytes = await png(90, 160); const inspection = await inspectImageBytes(bytes, 'image/png');
    const images: Asset[] = candidate.project.frames.map((frame): Asset => ({ id: `image:${frame.id}`, kind: 'image', subjectId: frame.id, path: `assets/${frame.id}.png`,
      version: 1, mimeType: 'image/png', sha256: inspection.sha256, durationMs: null, description: '검증 이미지' }));
    let reviewed: Project = { ...candidate.project, assets: images, frames: candidate.project.frames.map((frame) => ({ ...frame, imageAssetId: `image:${frame.id}` })) };
    for (const frame of reviewed.frames) reviewed = setFrameReview(reviewed, frame.id, 'accepted');
    for (const shot of reviewed.shots) reviewed = approveShot(reviewed, shot.id);
    const integrity = Object.fromEntries(images.map((asset): [string, string] => [asset.id, 'verified']));
    const report = reviewFinalReadiness(reviewed, integrity);
    expect(report.issues).toEqual([]); expect(report.finalReady).toBe(true); expect(report.counts.audioPlayable).toBe(0);
    expect(report.optionalAudioIssues.some((issue): boolean => issue.code === 'AUDIO_NOT_MEASURED')).toBe(true);
    expect(reviewAudioPlaybackAt(reviewed, 0).playable).toEqual([]);
    const projection = await createPdfProjection(reviewed, async (): Promise<Buffer> => bytes, { maturity: 'final', channel: 'pdf-export' }, integrity);
    expect(projection.items[0]?.audioEntries.map((entry): string => entry.body)).toContain('물을 주기 전에 흙이 말랐는지 확인하세요.');
    expect(JSON.stringify(createCsvProjection(reviewed, integrity, { maturity: 'final', channel: 'csv-export' }))).toContain('물이 흙에 닿는 소리');
    const pdf = await exportProjectPdfForPolicy(reviewed, TEST_TEXT_FONT_PATH, async (): Promise<Buffer> => bytes, { maturity: 'final', channel: 'pdf-export' }, integrity);
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
  });

  it('음원 없는 콘티라도 원문 순서·공개 하한·발화 Anchor 불일치를 차단한다', async (): Promise<void> => {
    const { project, plan } = await storyboardFixture();
    const basis = createSegmentPlanBasis(project, 'demonstration', project.shots.map((shot): string => shot.id));
    const reversed = { ...plan, audioTimings: plan.audioTimings.map((cue) => ({ ...cue, startMs: 1000, endMs: 2000 })) };
    expect(() => compileAutomaticSegmentPlan(project, basis, reversed, [], [], automaticPlanProvenance(), 64)).toThrowError(expect.objectContaining({ code: 'AUTOMATION_CANDIDATE_INVALID' }));
    const candidate = compileAutomaticSegmentPlan(project, basis, plan, [], [], automaticPlanProvenance(), 64).project;
    const manuallyReversed: Project = { ...candidate, audioCues: candidate.audioCues.map((cue) => cue.unitId === '안내-1' ? { ...cue, startMs: 1000, endMs: 2000 } : cue),
      shots: candidate.shots.map((shot) => ({ ...shot, sourceLinks: shot.sourceLinks.map((link) => link.unitId === '안내-1' ? { ...link, temporalAnchor: { kind: 'shot-offset', startOffsetMs: 1000, endOffsetMs: 2000, status: 'confirmed', basis: 'manual' } } : link) })) };
    expect(reviewFinalReadiness(manuallyReversed, {}).issues).toContainEqual(expect.objectContaining({ code: 'AUTOMATION_UNIT_ORDER_REVERSED', entityId: '동작' }));
    const later: Project = { ...project, dataset: { ...project.dataset, informationRules: project.dataset.informationRules.map((rule) => ({ ...rule, baseNotBeforeMs: 1000 })) } };
    expect(() => compileAutomaticSegmentPlan(later, createSegmentPlanBasis(later, 'demonstration', later.shots.map((shot): string => shot.id)), plan, [], [], automaticPlanProvenance(), 64)).toThrow();
  });

  it('기본 실행은 설치 음성과 배정을 요구하지 않고 이전 실행 선택은 그대로 보존한다', async (): Promise<void> => {
    const { project } = await storyboardFixture();
    const recommended = AutomationSettingsSchema.parse(recommendedAutomationSettings('not-installed'));
    expect(automationAudioProduction(recommended)).toBe('instructions-only');
    expect(requiredAutomationSpeechVoices(project, ['demonstration'], recommended)).toEqual([]);
    expect(missingVoiceCastingSpeakers(project, ['demonstration'], recommended)).toEqual([]);
    const { audioProduction: _choice, ...legacy } = recommended as typeof recommended & { audioProduction: string };
    expect(automationAudioProduction(AutomationSettingsSchema.parse(legacy))).toBe('guide-voice');
    expect(AutomationSettingsSchema.parse(legacy)).toEqual(legacy);
    const unfinishedVoice = { ...recommended, voice: { name: '', rateWordsPerMinute: 0 } };
    expect(AutomationSettingsSchema.parse(unfinishedVoice)).toEqual(unfinishedVoice);
    expect(AutomationSettingsSchema.safeParse({ ...unfinishedVoice, audioProduction: 'guide-voice' }).success).toBe(false);
  });

  it('음원 없는 J-cut도 인접 구간 배치를 허용하되 정보 공개 하한을 앞당기지 않는다', async (): Promise<void> => {
    const project = createSourceOutline(importPackage(await nativePackage()), { proposedTextHoldMs: 2000 });
    const cue = project.audioCues.find((value): boolean => value.unitId === '안내-1')!;
    const planned = { ...cue, startMs: 4000, endMs: 6000, timingRelation: 'j-cut' as const };
    const withoutInformation: Project = { ...project, dataset: { ...project.dataset, units: project.dataset.units.map((unit) => unit.id === cue.unitId ? { ...unit, informationIds: [] } : unit) } };
    expect(storyboardAudioIssues(withoutInformation, planned)).toEqual([]);
    const bounded: Project = { ...project, dataset: { ...project.dataset, units: project.dataset.units.map((unit) => unit.id === cue.unitId ? { ...unit, informationIds: ['speech-bound'] } : unit),
      informationRules: [...project.dataset.informationRules, { id: 'speech-bound', segmentId: 'demonstration', baseNotBeforeMs: 5000, notBeforeUnitId: null, notBeforeUnitOrder: null, precision: 'exact-time', sourceRefs: [] }] } };
    expect(storyboardAudioIssues(bounded, planned)).toContainEqual(expect.objectContaining({ code: 'EARLY_INFORMATION_EMISSION' }));
  });
});

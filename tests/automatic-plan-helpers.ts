import { inspectAudioFileBytes } from '../src/domain/media-inspection.js';
import type { Project, SourceUnit } from '../src/domain/schema.js';
import { importPackage } from '../src/importers/import-package.js';
import { sha256Text } from '../src/importers/integrity.js';
import { createSourceOutline } from '../src/proposal/outline.js';
import type { AutomaticPlanProvenance } from '../src/automation/plan-compiler.js';
import type { AutomaticSegmentPlan, AutomaticShot } from '../src/automation/plan-schema.js';
import type { ExistingAudioFile, PlannedAssetWrite, StagedSpeech } from '../src/automation/plan-audio.js';
import { nativeData, nativePackage, pcmWav, testGeneratorBuild, withNativeData } from './helpers.js';

export async function automaticPlanProject(): Promise<Project> {
  const payload = await nativePackage();
  const data = nativeData(payload);
  const units = data.units.map((unit) => ({ ...unit, informationIds: unit.segmentId === 'demonstration' ? [`reveal:${unit.id}`] : unit.informationIds }));
  return createSourceOutline(importPackage(withNativeData(payload, { ...data, units, informationRules: units.filter((unit): boolean => unit.segmentId === 'demonstration').map((unit) => ({ id: `reveal:${unit.id}`, segmentId: unit.segmentId, notBeforeMs: 5000, notBeforeUnitId: unit.id, notBeforeUnitOrder: unit.order, precision: 'unit-order' as const })) })), { proposedTextHoldMs: 2000 });
}

export function automaticShot(startMs: number, endMs: number): AutomaticShot {
  return { startMs, endMs, visualMode: 'sourced', visualLocationId: 'workbench', action: '화분 가장자리에 물을 준다.',
    camera: { size: 'CU', angle: 'eye-level', move: 'static' }, presence: [], propIds: [], continuityBefore: [], continuityAfter: [], cameraAxis: null, screenDirection: null,
    transitionOut: { kind: 'cut', durationMs: 0, note: '', incomingExposure: 'none' },
    frames: [{ role: 'start', offsetMs: 0, description: '작은 물뿌리개와 흙 표면의 가까운 화면.' }], sourceLinks: [], reason: '화분 관리 행동을 가까이 보여주는 제안.' };
}

export function demonstrationPlan(project: Project): AutomaticSegmentPlan {
  const shot: AutomaticShot = { ...automaticShot(5000, 13500), sourceLinks: [
    { unitId: '안내-1', usage: 'audio-only', startOffsetMs: 0, endOffsetMs: 2300, reason: '원문 내레이션을 한 번 재생한다.' },
    { unitId: '동작', usage: 'primary-visual', startOffsetMs: 0, endOffsetMs: 8500, reason: '물을 주는 원문 행동을 전체 구간에 배치한다.' },
    { unitId: '효과음', usage: 'audio-only', startOffsetMs: 3000, endOffsetMs: 3200, reason: '물소리 녹음이 필요하다.' },
  ] };
  return { schemaVersion: '1.0.0', segmentId: 'demonstration', summary: '물주기 동작과 실측 내레이션의 검토 초안.', shots: [shot], mappings: [], placementInformation: [], textTimings: [],
    audioTimings: project.audioCues.filter((cue): boolean => cue.unitId !== null && ['안내-1', '효과음'].includes(cue.unitId)).map((cue) => ({ cueId: cue.id, startMs: cue.unitId === '안내-1' ? 5000 : 8000, endMs: cue.unitId === '안내-1' ? 7300 : 8200, timingRelation: 'within-segment' as const, reason: '실측 발화와 물소리를 차례로 배치한다.' })) };
}

export function stagedPlanSpeech(project: Project): StagedSpeech {
  const unit: SourceUnit | undefined = project.dataset.units.find((value): boolean => value.id === '안내-1');
  const cue = project.audioCues.find((value): boolean => value.unitId === unit?.id);
  if (unit === undefined || cue === undefined) throw new Error('가이드 음성 검증 원문이 없습니다.');
  const bytes: Buffer = pcmWav(2300, project.handoff.timebase.sampleRate, 1, 16);
  return { cueId: cue.id, result: { unitId: unit.id, sourceTextHash: sha256Text(unit.text), voice: { name: 'Yuna', rateWordsPerMinute: 180 }, bytes, inspection: inspectAudioFileBytes(bytes, 'audio/wav') } };
}

export function automaticPlanProvenance(): AutomaticPlanProvenance {
  return { generationId: 'automatic-plan-test', model: 'test-model', turnId: 'turn-test', prompt: '검증용 원문 스냅샷', createdAt: '2026-09-11T03:00:00.000Z', generatorBuild: testGeneratorBuild() };
}

export function existingPlanAudio(project: Project, writes: readonly PlannedAssetWrite[]): ExistingAudioFile[] {
  return project.audioCues.filter((cue): boolean => cue.assetId !== null).map((cue): ExistingAudioFile => {
    const asset = project.assets.find((value): boolean => value.id === cue.assetId);
    const write = writes.find((value): boolean => value.relativePath === asset?.path);
    if (asset === undefined || write === undefined) throw new Error(`검증용 기존 음원이 없습니다: ${cue.id}`);
    return { cueId: cue.id, assetId: asset.id, bytes: Buffer.from(write.content) };
  });
}

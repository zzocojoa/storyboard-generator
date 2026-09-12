import { audioInstructionFixture } from './audio-instruction-helpers.js';
import { describe, expect, it } from 'vitest';
import { applySourceUpdate } from '../src/domain/source-update.js';
import { importPackage } from '../src/importers/import-package.js';
import { createSourceOutline } from '../src/proposal/outline.js';
import { updateAudioInstruction, confirmAudioInstruction, audioInstructionStructureIssues, audioInstructionOutputIssues } from '../src/domain/audio-instructions.js';
import { audioCueSource, audioCuesInSegment } from '../src/domain/audio-source.js';
import { prepareAudioAsset } from '../src/domain/audio-asset.js';
import { reviewAudioPlaybackAt } from '../src/domain/playback.js';
import { reviewFinalReadiness } from '../src/domain/final-readiness.js';
import { audioTimingIssues } from '../src/domain/audio.js';
import { reviewInformationEmission } from '../src/domain/emission.js';
import { validateProject } from '../src/domain/validation.js';
import { AudioCueSchema } from '../src/domain/schema.js';
import type { Project } from '../src/domain/schema.js';
import { compileAutomaticSegmentPlan } from '../src/automation/plan-compiler.js';
import { createSegmentPlanBasis } from '../src/automation/plan-basis.js';
import { existingAudioEvidence } from '../src/automation/plan-audio.js';
import { automaticAudioMixTargets } from '../src/automation/audio-mix-basis.js';
import { parseProject } from '../src/io/project.js';
import { audioTrackEntry } from '../src/exporters/pdf.js';
import { automaticPlanProvenance, demonstrationPlan, stagedPlanSpeech } from './automatic-plan-helpers.js';
import { nativeData, withNativeData, pcmWav, testAudioNormalizer } from './helpers.js';


function required(project: Project): Project {
  return updateAudioInstruction(project, { instructionId: 'ambient-instruction', resolution: 'required', cueIds: [], informationIds: [], reason: '원문에 물소리가 명시돼 있어 별도 음원을 준비한다.' }, 'ambient-track');
}

describe('대본과 구별한 음향 지시 연결', (): void => {
  it('원문 지시를 누락하면 Final을 차단하고 명시적 음악 부재도 검토를 남긴다', async (): Promise<void> => {
    const project = await audioInstructionFixture(); const original = structuredClone(project);
    expect(audioInstructionOutputIssues(project).map((value): string => value.entityId)).toEqual(['ambient-instruction', 'music-instruction']);
    const none = updateAudioInstruction(project, { instructionId: 'music-instruction', resolution: 'none', cueIds: [], informationIds: [], reason: '원문이 배경 음악 없음이라고 명시한다.' }, 'unused');
    expect(none.audioCues).toEqual(project.audioCues);
    expect(reviewFinalReadiness(none, {}).issues).toContainEqual(expect.objectContaining({ code: 'AUDIO_INSTRUCTION_REVIEW_REQUIRED', entityId: 'music-instruction' }));
    const confirmed = confirmAudioInstruction(none, 'music-instruction');
    expect(audioInstructionOutputIssues(confirmed).map((value): string => value.entityId)).toEqual(['ambient-instruction']);
    expect(project).toEqual(original); expect(confirmed.dataset).toEqual(original.dataset);
  });

  it('새 음향은 Instruction을 직접 참조하며 대본·가이드 발화를 추가하지 않는다', async (): Promise<void> => {
    const project = await audioInstructionFixture(); const next = required(project);
    expect(next.dataset).toEqual(project.dataset);
    expect(next.audioCues.filter((cue): boolean => ['dialogue', 'panel', 'voiceover'].includes(cue.kind))).toEqual(project.audioCues.filter((cue): boolean => ['dialogue', 'panel', 'voiceover'].includes(cue.kind)));
    const cue = next.audioCues.find((value): boolean => value.id === 'ambient-track')!;
    expect(cue).toMatchObject({ unitId: null, instructionId: 'ambient-instruction', kind: 'sfx', assetId: null, timingStatus: 'proposed' });
    expect(audioCueSource(next, cue)).toMatchObject({ text: '물 흐르는 소리', instructionId: 'ambient-instruction', speakerId: null });
    expect(audioTimingIssues(next, cue)).toEqual([]);
    expect(audioCuesInSegment(next, 'demonstration')).toContainEqual(cue);
    expect(audioCuesInSegment(next, 'SEG-001')).not.toContainEqual(cue);
    expect(audioInstructionStructureIssues(next)).toEqual([]);
    expect(validateProject(next, project.dataset).filter((value): boolean => value.severity === 'error')).toEqual([]);
    expect(parseProject(next)).toEqual(next);
    expect(AudioCueSchema.safeParse({ ...cue, kind: 'voiceover' }).success).toBe(false);
    expect(AudioCueSchema.safeParse({ ...cue, unitId: '안내-1' }).success).toBe(false);
  });

  it('기존 같은 구간의 효과음과 연결해 중복 음원을 만들지 않고 발화 오용을 거부한다', async (): Promise<void> => {
    const project = await audioInstructionFixture(); const sound = project.audioCues.find((cue): boolean => cue.unitId === '효과음')!;
    const next = updateAudioInstruction(project, { instructionId: 'ambient-instruction', resolution: 'required', cueIds: [sound.id], informationIds: [], reason: '원문 효과음과 같은 물소리이므로 기존 트랙을 사용한다.' }, 'unused');
    expect(next.audioCues).toEqual(project.audioCues);
    const speech = project.audioCues.find((cue): boolean => cue.unitId === '안내-1')!;
    expect(() => updateAudioInstruction(project, { instructionId: 'ambient-instruction', resolution: 'required', cueIds: [speech.id], informationIds: [], reason: '잘못된 발화 연결' }, 'unused')).toThrowError(expect.objectContaining({ code: 'INVALID_AUDIO_INSTRUCTION' }));
  });

  it('실제 WAV 준비·자동 배치·재생·음량·PDF까지 같은 지시와 자산을 유지한다', async (): Promise<void> => {
    const project = updateAudioInstruction(required(await audioInstructionFixture()), { instructionId: 'ambient-instruction', resolution: 'required', cueIds: ['ambient-track'], informationIds: ['reveal:동작'], reason: '물소리가 드러내는 물주기 행동의 공개 조건에 연결한다.' }, 'unused');
    const normalizer = testAudioNormalizer();
    try {
      const prepared = await prepareAudioAsset(project, 'ambient-track', 'ambient-wave', { originalFileName: '물소리.wav', declaredMimeType: 'audio/wav', bytes: pcmWav(1000, 44100, 2, 24) }, normalizer);
      const cue = prepared.project.audioCues.find((value): boolean => value.id === 'ambient-track')!;
      expect(existingAudioEvidence(prepared.project, { cueId: cue.id, assetId: 'ambient-wave', bytes: prepared.content })).toMatchObject({ instructionId: 'ambient-instruction', unitId: null, inspection: { durationMs: 1000 } });
      const base = demonstrationPlan(prepared.project);
      const plan = { ...base, audioTimings: [...base.audioTimings, { cueId: cue.id, startMs: 8000, endMs: 9000, timingRelation: 'within-segment' as const, reason: '원문 물소리를 허용 범위 안에 실제 파일 길이로 배치한다.' }] };
      const result = compileAutomaticSegmentPlan(prepared.project, createSegmentPlanBasis(prepared.project, 'demonstration', ['shot-2']), plan, [stagedPlanSpeech(prepared.project)],
        [{ cueId: cue.id, assetId: 'ambient-wave', bytes: prepared.content }], automaticPlanProvenance(), 64);
      const placed = result.project.audioCues.find((value): boolean => value.id === cue.id)!;
      expect(placed).toMatchObject({ unitId: null, instructionId: 'ambient-instruction', startMs: 8000, endMs: 9000, timingStatus: 'measured', assetId: 'ambient-wave' });
      expect(reviewAudioPlaybackAt(result.project, 8500).playable).toContainEqual(placed);
      for (const channel of ['audio-playback', 'export'] as const) {
        expect(reviewInformationEmission(result.project, { entityId: placed.id, channel, informationIds: ['reveal:동작'], atMs: 8000 })).toEqual([]);
        expect(reviewInformationEmission(result.project, { entityId: placed.id, channel, informationIds: ['reveal:동작'], atMs: 4999 }).map((value): string => value.code)).toContain('EARLY_INFORMATION_EMISSION');
        expect(reviewInformationEmission(result.project, { entityId: placed.id, channel, informationIds: ['reveal:효과음'], atMs: 8000 }).map((value): string => value.code)).toContain('INFORMATION_WITHOUT_OUTPUT_SOURCE');
      }
      expect(automaticAudioMixTargets(result.project, 'demonstration')).toContainEqual(placed);
      expect(audioTrackEntry(result.project, placed)).toMatchObject({ body: '물 흐르는 소리' });
      expect(result.project.dataset).toEqual(project.dataset); expect(result.project.assets).toContainEqual(prepared.project.assets[0]);
      expect(() => updateAudioInstruction(result.project, { instructionId: 'ambient-instruction', resolution: 'none', cueIds: [], informationIds: [], reason: '파일을 조용히 제거할 수 없음' }, 'unused')).toThrowError(expect.objectContaining({ code: 'AUDIO_INSTRUCTION_AUDIO_IN_USE' }));
    } finally { await normalizer.close(); }
  });

  it('바뀐 지시와 조작된 출처 및 끊어진 트랙은 검증 실패로 남긴다', async (): Promise<void> => {
    const project = required(await audioInstructionFixture());
    const changed: Project = { ...project, dataset: { ...project.dataset, instructions: project.dataset.instructions.map((value) => value.id === 'ambient-instruction' ? { ...value, text: '문 닫는 소리' } : value) } };
    expect(audioInstructionStructureIssues(changed)).toContainEqual(expect.objectContaining({ field: 'sourceSnapshot' }));
    expect(audioCueSource(changed, changed.audioCues.find((cue): boolean => cue.id === 'ambient-track')!)).toBeNull();
    expect(() => confirmAudioInstruction(changed, 'ambient-instruction')).toThrow();
    expect(audioInstructionStructureIssues({ ...project, audioCues: project.audioCues.filter((cue): boolean => cue.id !== 'ambient-track') })).toContainEqual(expect.objectContaining({ field: 'cueIds' }));
  });

  it('1.19 저장본은 원문·트랙을 보존하고 새로운 지시 필드를 소급 허용하지 않는다', async (): Promise<void> => {
    const current = await audioInstructionFixture(); const legacy = { ...current, schemaVersion: '1.19.0' }; const bytes = JSON.stringify(legacy);
    const migrated = parseProject(legacy);
    expect(migrated).toEqual({ ...legacy, schemaVersion: '1.23.0' }); expect(JSON.stringify(legacy)).toBe(bytes);
    expect(() => parseProject({ ...legacy, audioInstructionDecisions: [] })).toThrowError(expect.objectContaining({ code: 'UNSUPPORTED_LEGACY_AUDIO_INSTRUCTIONS' }));
  });

  it('원본 업데이트는 바뀌지 않은 음향을 보존하고 바뀐 지시만 재계획하며 이전 자산을 남긴다', async (): Promise<void> => {
    const source = await audioInstructionFixture(); const current = required(source); const normalizer = testAudioNormalizer();
    try {
      const prepared = await prepareAudioAsset(current, 'ambient-track', 'source-update-wave', { originalFileName: '물소리.wav', declaredMimeType: 'audio/wav', bytes: pcmWav(1000, 44100, 1, 16) }, normalizer);
      const same = applySourceUpdate(prepared.project, source, 'same-source');
      expect(same.audioCues).toEqual(prepared.project.audioCues); expect(same.audioInstructionDecisions).toEqual(prepared.project.audioInstructionDecisions);
      const payload = { handoff: source.handoff, files: source.sources.map((value) => ({ path: value.path, content: value.content })) };
      const data = nativeData(payload);
      const incoming = createSourceOutline(importPackage(withNativeData(payload, { ...data, instructions: data.instructions.map((value) => value.id === 'ambient-instruction' ? { ...value, text: '물방울 떨어지는 소리' } : value) })), { proposedTextHoldMs: 2000 });
      const changed = applySourceUpdate(prepared.project, incoming, 'changed-source');
      expect(parseProject(changed)).toEqual(changed); expect(changed.audioInstructionDecisions).toEqual([]);
      expect(changed.audioCues.some((cue): boolean => cue.instructionId === 'ambient-instruction')).toBe(false);
      expect(changed.assets).toEqual(prepared.project.assets); expect(prepared.project.dataset).toEqual(source.dataset);
      expect(audioInstructionOutputIssues(changed).map((value): string => value.entityId)).toContain('ambient-instruction');
    } finally { await normalizer.close(); }
  });
});

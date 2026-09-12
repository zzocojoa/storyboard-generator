import { contractError } from '../domain/errors.js';
import type { Asset, AudioCue, Project } from '../domain/schema.js';
import { attachStagedSpeech, placePreparedAudio } from './plan-audio.js';
import type { ExistingAudioEvidence, PlannedAssetWrite, StagedSpeech } from './plan-audio.js';
import type { SourceRepairBasis, SourceRepairPlan } from './repair-basis.js';

export type RepairedAudio = { audioCues: AudioCue[]; assets: Asset[]; writes: PlannedAssetWrite[] };

/** 새 발화·준비 음향만 허용 범위에 배치하고 기존 컷·음원·다른 트랙을 보존한다. */
export function compileRepairAudio(project: Project, basis: SourceRepairBasis, plan: SourceRepairPlan, speech: readonly StagedSpeech[], evidence: readonly ExistingAudioEvidence[], generationId: string): RepairedAudio {
  const preparedIds: string[] = project.audioCues.filter((cue): boolean => basis.audioCueIds.includes(cue.id) && cue.timingStatus === 'prepared').map((cue): string => cue.id);
  if (preparedIds.length > 0 && plan.schemaVersion !== '1.2.0') throw contractError('AUTOMATION_REPAIR_AUDIO_VERSION', '준비 음향의 자동 배치에는 결과 계약 1.2.0이 필요합니다.', []);
  const timings = plan.schemaVersion === '1.0.0' ? [] : plan.audioTimings;
  const expectedIds: string[] = [...basis.speechCueIds, ...preparedIds];
  const timingIds: string[] = timings.map((timing): string => timing.cueId);
  const speechIds: string[] = speech.map((value): string => value.cueId);
  if (new Set(timingIds).size !== timingIds.length || new Set(speechIds).size !== speechIds.length
    || timingIds.length !== expectedIds.length
    || expectedIds.some((id): boolean => !timingIds.includes(id)) || speechIds.some((id): boolean => !basis.speechCueIds.includes(id))) {
    throw contractError('AUTOMATION_REPAIR_AUDIO_SCOPE', '명시한 미등록 발화·준비 음향마다 배치가 하나씩 필요합니다. 선택적으로 생성한 음성은 대상 발화와 일치해야 하며 기존 등록 음원의 시각은 변경할 수 없습니다.', []);
  }
  const entries = timings.map((timing) => {
    const previous: AudioCue | undefined = project.audioCues.find((cue): boolean => cue.id === timing.cueId);
    if (previous !== undefined && preparedIds.includes(previous.id)) {
      const file = evidence.find((value): boolean => value.cueId === previous.id);
      if (file === undefined) throw contractError('AUTOMATION_EXISTING_AUDIO_REVIEW', `${previous.id}: 준비 음향의 실제 파일 검증이 필요합니다.`, []);
      const cue = placePreparedAudio(project, previous, { ...previous, startMs: timing.startMs, endMs: timing.endMs, timingRelation: timing.timingRelation }, file);
      return { cue, asset: null, write: null };
    }
    if (previous === undefined || previous.assetId !== null || previous.timingStatus !== 'proposed'
      || timing.startMs < previous.startMs || timing.endMs > previous.endMs || timing.startMs >= timing.endMs || timing.timingRelation !== previous.timingRelation) {
      throw contractError('AUTOMATION_REPAIR_AUDIO_WINDOW', `${timing.cueId}: 기존 발화 범위 ${previous?.startMs}..${previous?.endMs}ms와 구간 관계 안에서 배치하세요. 제안=${timing.startMs}..${timing.endMs}ms. 음성을 늘이거나 자르지 않습니다.`, []);
    }
    const staged = speech.find((value): boolean => value.cueId === timing.cueId);
    const cue: AudioCue = { ...previous, startMs: timing.startMs, endMs: timing.endMs };
    return staged === undefined ? { cue, asset: null, write: null } : attachStagedSpeech(project, cue, staged, generationId);
  });
  return {
    audioCues: project.audioCues.map((cue): AudioCue => entries.find((entry): boolean => entry.cue.id === cue.id)?.cue
      ?? (basis.audioCueIds.includes(cue.id) ? { ...cue, timingStatus: 'measured' } : cue)),
    assets: [...project.assets, ...entries.flatMap((entry): Asset[] => entry.asset === null ? [] : [entry.asset])],
    writes: entries.flatMap((entry): PlannedAssetWrite[] => entry.write === null ? [] : [entry.write]),
  };
}

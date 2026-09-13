import { audioCueSource, audioCuesInSegment } from '../domain/audio-source.js';
import { contractError } from '../domain/errors.js';
import { automaticAudioProtected } from '../domain/edit-protection.js';
import { inspectAudioFileBytes, inspectStoredAudioAsset } from '../domain/media-inspection.js';
import type { InspectedAudioFile } from '../domain/media-inspection.js';
import type { Asset, AudioCue, Issue, Project } from '../domain/schema.js';
import { unitAudioKind } from '../domain/unit-media.js';
import { sha256Text } from '../importers/integrity.js';
import { stableJsonStringify } from '../io/stable-json.js';
import type { SpeechGenerationResult } from '../codex/speech-engine.js';
import type { AutomaticSegmentPlan } from './plan-schema.js';
import { assertUniquePlanKeys } from './plan-text.js';

export type StagedSpeech = { cueId: string; result: SpeechGenerationResult };
export type ExistingAudioFile = { cueId: string; assetId: string; bytes: Buffer };
export type ExistingAudioEvidence = { cueId: string; unitId: string | null; instructionId?: string; assetId: string; previousTimingStatus: AudioCue['timingStatus']; startMs: number; endMs: number; timingRelation: AudioCue['timingRelation']; inspection: InspectedAudioFile };
export type PlannedAssetWrite = { relativePath: string; content: Buffer };
export type PlannedAudio = { audioCues: AudioCue[]; assets: Asset[]; writes: PlannedAssetWrite[]; exceptions: Issue[]; existingAudio: ExistingAudioEvidence[] };
type AudioEntry = { cue: AudioCue; asset: Asset | null; write: PlannedAssetWrite | null; exception: Issue | null };

/** 기존 배치는 유지하며 명시적인 준비 음향만 허용 범위와 실측 길이를 분리해 검사한다. */
export function existingAudioEvidence(project: Project, file: ExistingAudioFile): ExistingAudioEvidence {
  const cue = project.audioCues.find((value): boolean => value.id === file.cueId);
  const asset = project.assets.find((value): boolean => value.id === file.assetId);
  if (cue === undefined || asset === undefined || cue.assetId !== file.assetId || asset.subjectId !== cue.id
    || audioCueSource(project, cue) === null) {
    throw contractError('AUTOMATION_EXISTING_AUDIO_BINDING', `기존 WAV와 큐·원문 연결이 다릅니다: cueId=${file.cueId}, assetId=${file.assetId}`, []);
  }
  const inspection = inspectStoredAudioAsset(project, asset, file.bytes);
  if (cue.timingStatus === 'prepared' && (!['sfx', 'music'].includes(cue.kind) || inspection.durationMs > cue.endMs - cue.startMs)) throw contractError('AUTOMATION_PREPARED_AUDIO_WINDOW', `${cue.id}: 준비 음향의 종류·실제 길이와 허용 범위를 확인하세요.`, []);
  if (cue.timingStatus !== 'prepared' && cue.endMs - cue.startMs !== inspection.durationMs) throw contractError('AUTOMATION_EXISTING_AUDIO_TIMING', `기존 음원의 배치와 실제 길이가 다릅니다. 저장한 시각은 보존했습니다: cueId=${cue.id}, timeline=${cue.startMs}..${cue.endMs}, actualDurationMs=${inspection.durationMs}. 음성 탭에서 현재 파일을 듣고 시각을 수정하세요.`, []);
  return { cueId: cue.id, unitId: cue.unitId, ...(cue.instructionId === undefined ? {} : { instructionId: cue.instructionId }), assetId: asset.id, previousTimingStatus: cue.timingStatus, startMs: cue.startMs, endMs: cue.endMs, timingRelation: cue.timingRelation, inspection };
}

export function validateExistingAudioScope(project: Project, segmentId: string, files: readonly ExistingAudioFile[]): ExistingAudioEvidence[] {
  const cues = audioCuesInSegment(project, segmentId).filter((cue): boolean => cue.assetId !== null);
  assertUniquePlanKeys(files.map((file): string => file.cueId), 'existingAudio');
  if (files.length !== cues.length || files.some((file): boolean => !cues.some((cue): boolean => cue.id === file.cueId))) throw contractError('AUTOMATION_EXISTING_AUDIO_REVIEW', `${segmentId}: 기존 WAV의 실제 파일 근거를 모두 제공해야 합니다. 메타데이터만으로 실측 상태를 복원하지 않습니다.`, []);
  return files.map((file): ExistingAudioEvidence => existingAudioEvidence(project, file));
}

/** 준비 음향은 같은 파일을 허용 범위 안에 실측 길이로 배치한다. 최종 공개 검사는 전체 후보가 담당한다. */
export function placePreparedAudio(project: Project, previous: AudioCue, candidate: AudioCue, evidence: ExistingAudioEvidence): AudioCue {
  if (previous.timingStatus !== 'prepared' || !['sfx', 'music'].includes(previous.kind) || previous.assetId === null
    || evidence.cueId !== previous.id || evidence.assetId !== previous.assetId || evidence.previousTimingStatus !== 'prepared'
    || candidate.id !== previous.id || candidate.assetId !== previous.assetId || candidate.unitId !== previous.unitId || candidate.instructionId !== previous.instructionId || candidate.kind !== previous.kind) {
    throw contractError('AUTOMATION_PREPARED_AUDIO_BINDING', `${previous.id}: 준비 파일의 큐·원문·자산을 보존해야 합니다.`, []);
  }
  if (automaticAudioProtected(project, previous) || automaticAudioProtected(project, candidate)) throw contractError('AUDIO_PREPARATION_PROTECTED', `${previous.id}: 보호된 컷의 음향을 자동 배치할 수 없습니다.`, []);
  if (candidate.startMs < previous.startMs || candidate.endMs > previous.endMs || candidate.startMs >= candidate.endMs || candidate.timingRelation !== previous.timingRelation) {
    throw contractError('AUTOMATION_PREPARED_AUDIO_WINDOW', `${previous.id}: 허용 범위 ${previous.startMs}..${previous.endMs}ms와 ${previous.timingRelation} 관계 안에서 배치하세요. 제안=${candidate.startMs}..${candidate.endMs}ms`, []);
  }
  if (candidate.endMs - candidate.startMs !== evidence.inspection.durationMs) throw contractError('AUTOMATION_PREPARED_AUDIO_DURATION', `${previous.id}: 실제 ${evidence.inspection.durationMs}ms와 제안 길이 ${candidate.endMs - candidate.startMs}ms가 다릅니다. 자르기·반복·속도 변경으로 맞추지 마세요.`, []);
  return { ...candidate, timingStatus: 'measured' };
}

export function inspectStagedSpeech(project: Project, cue: AudioCue, staged: StagedSpeech): { content: Buffer; inspected: InspectedAudioFile } {
  const unit = project.dataset.units.find((value): boolean => value.id === cue.unitId);
  if (unit === undefined || staged.result.unitId !== unit.id || sha256Text(unit.text) !== staged.result.sourceTextHash) throw contractError('AUTOMATION_SPEECH_SOURCE_CHANGED', `가이드 음성의 원문 결속이 다릅니다: ${cue.id}`, []);
  if (!['dialogue', 'voiceover', 'panel'].includes(cue.kind) || unitAudioKind(unit) !== cue.kind) throw contractError('AUTOMATION_SPEECH_KIND', `원문과 발화 종류가 일치해야 합니다. 효과음·음악·화면 글자는 낭독하지 않습니다: cueId=${cue.id}, cueKind=${cue.kind}, unitId=${unit.id}, unitKind=${unit.kind}`, []);
  const content: Buffer = Buffer.from(staged.result.bytes);
  const inspected: InspectedAudioFile = inspectAudioFileBytes(content, 'audio/wav');
  if (stableJsonStringify(inspected) !== stableJsonStringify(staged.result.inspection) || inspected.sampleRate !== project.handoff.timebase.sampleRate || inspected.codec !== 'pcm_s16le') throw contractError('AUTOMATION_SPEECH_INTEGRITY', `측정 음성의 바이트·길이·프로젝트 형식이 달라졌습니다: ${cue.id}`, []);
  return { content, inspected };
}

export function attachStagedSpeech(project: Project, cue: AudioCue, staged: StagedSpeech, generationId: string): AudioEntry {
  const { content, inspected } = inspectStagedSpeech(project, cue, staged);
  if (cue.endMs - cue.startMs !== inspected.durationMs) throw contractError('AUTOMATION_SPEECH_DURATION', `${cue.id}: 실제 ${inspected.durationMs}ms를 사용해 배치를 보정하세요. 계획=${cue.startMs}..${cue.endMs}`, []);
  const assetId: string = `${generationId}:audio:${sha256Text(cue.id).slice(0, 16)}`;
  const relativePath: string = `assets/${sha256Text(assetId)}.wav`;
  const version: number = Math.max(0, ...project.assets.filter((asset): boolean => asset.kind === 'audio' && asset.subjectId === cue.id).map((asset): number => asset.version)) + 1;
  const asset: Asset = { id: assetId, kind: 'audio', subjectId: cue.id, path: relativePath, version, mimeType: inspected.mimeType,
    sha256: inspected.sha256, durationMs: inspected.durationMs, description: `macOS ${staged.result.voice.name} · ${staged.result.voice.rateWordsPerMinute} WPM · 가이드 음성`,
    audioMetadata: { sampleRate: inspected.sampleRate, channels: inspected.channels, codec: inspected.codec } };
  return { cue: { ...cue, assetId, timingStatus: 'measured' }, asset, write: { relativePath, content }, exception: null };
}

function plannedAudioEntry(project: Project, previous: AudioCue, plan: AutomaticSegmentPlan, speech: readonly StagedSpeech[], existing: readonly ExistingAudioEvidence[], generationId: string): AudioEntry {
  const timing = plan.audioTimings.find((value): boolean => value.cueId === previous.id);
  if (timing === undefined) throw contractError('AUTOMATION_AUDIO_TIMING_MISSING', `음향 시각 계획이 없습니다: ${previous.id}`, []);
  const cue: AudioCue = { ...previous, startMs: timing.startMs, endMs: timing.endMs, timingRelation: timing.timingRelation };
  const staged: StagedSpeech | undefined = speech.find((value): boolean => value.cueId === cue.id);
  if (previous.assetId !== null) {
    if (!existing.some((value): boolean => value.cueId === previous.id && value.assetId === previous.assetId)) throw contractError('AUTOMATION_EXISTING_AUDIO_REVIEW', `기존 WAV의 실제 파일 근거가 없습니다: ${cue.id}`, []);
    if (previous.timingStatus === 'prepared') {
      if (staged !== undefined) throw contractError('AUTOMATION_PREPARED_AUDIO_SPEECH', `${cue.id}: 외부 음향을 가이드 음성으로 교체할 수 없습니다.`, []);
      return { cue: placePreparedAudio(project, previous, cue, existing.find((value): boolean => value.cueId === previous.id)!), asset: null, write: null, exception: null };
    }
    if (staged !== undefined || cue.startMs !== previous.startMs || cue.endMs !== previous.endMs || cue.timingRelation !== previous.timingRelation) throw contractError('AUTOMATION_EXISTING_AUDIO', `기존 음원과 사용자가 정한 시각을 보존해야 합니다: ${cue.id}`, []);
    return { cue: { ...previous, timingStatus: 'measured' }, asset: null, write: null, exception: null };
  }
  if (previous.timingStatus === 'measured') {
    throw contractError('AUTOMATION_EXISTING_AUDIO_REVIEW', `측정 상태에 실제 음원이 없습니다: ${cue.id}. 음성 탭에서 파일 연결을 확인하세요.`, []);
  }
  if (staged !== undefined) return attachStagedSpeech(project, cue, staged, generationId);
  return { cue: { ...cue, timingStatus: 'proposed' }, asset: null, write: null, exception: null };
}

/** 음성의 실측 결과를 전체 후보에 먼저 연결한다. 출력 Gate 검사는 조립된 후보에서 수행한다. */
export function compilePlannedAudio(project: Project, plan: AutomaticSegmentPlan, speech: readonly StagedSpeech[], files: readonly ExistingAudioFile[], generationId: string): PlannedAudio {
  const existing: ExistingAudioEvidence[] = validateExistingAudioScope(project, plan.segmentId, files);
  const selected: AudioCue[] = audioCuesInSegment(project, plan.segmentId);
  assertUniquePlanKeys(plan.audioTimings.map((value): string => value.cueId), 'audioTimings');
  assertUniquePlanKeys(speech.map((value): string => value.cueId), 'stagedSpeech');
  if (selected.length !== plan.audioTimings.length || plan.audioTimings.some((timing): boolean => !selected.some((cue): boolean => cue.id === timing.cueId)) || speech.some((value): boolean => !selected.some((cue): boolean => cue.id === value.cueId))) throw contractError('AUTOMATION_AUDIO_SCOPE', `${plan.segmentId}: 선택 구간의 모든 오디오 큐를 중복 없이 계획해야 합니다.`, []);
  const entries: AudioEntry[] = selected.map((cue): AudioEntry => plannedAudioEntry(project, cue, plan, speech, existing, generationId));
  return { audioCues: [...project.audioCues.filter((cue): boolean => !selected.some((value): boolean => value.id === cue.id)), ...entries.map((entry): AudioCue => entry.cue)],
    assets: [...project.assets, ...entries.flatMap((entry): Asset[] => entry.asset === null ? [] : [entry.asset])],
    writes: entries.flatMap((entry): PlannedAssetWrite[] => entry.write === null ? [] : [entry.write]),
    exceptions: entries.flatMap((entry): Issue[] => entry.exception === null ? [] : [entry.exception]), existingAudio: existing };
}

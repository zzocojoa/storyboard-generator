import { audioCueSource } from './audio-source.js';
import { assertAudioTimingRelation, audioTimingContext } from './audio.js';
import type { AudioNormalizer } from './audio-normalizer.js';
import { automaticAudioProtected } from './edit-protection.js';
import { reviewInformationEmission } from './emission.js';
import { assertNoErrors, contractError } from './errors.js';
import { inspectAudioBytes } from './media-inspection.js';
import type { InspectedAudio } from './media-inspection.js';
import type { GeneratedMutation } from './media.js';
import type { Asset, AudioCue, Issue, Project, Shot, ShotSourceLink, StoryboardFrame } from './schema.js';
import { ProjectSchema } from './schema.js';
import { validateProject } from './validation.js';
import { sha256Text } from '../importers/integrity.js';

export type AudioAssetImportInput = {
  originalFileName: string;
  declaredMimeType: string;
  bytes: Buffer;
};

export type AttachedAudioAsset = GeneratedMutation & {
  relativePath: string;
  content: Buffer;
  inspection: {
    durationMs: number;
    sampleRate: number;
    channels: number;
    codec: string;
    sha256: string;
  };
};

function finalize(before: Project, input: Project): Project {
  const project: Project = ProjectSchema.parse(input);
  assertNoErrors(validateProject(project, before.dataset), 'INVALID_AUDIO_ASSET_IMPORT');
  return project;
}

function importedAudioAsset(project: Project, cue: AudioCue, assetId: string, fileName: string, inspected: InspectedAudio): Asset {
  const version: number = Math.max(0, ...project.assets.filter((asset: Asset): boolean => asset.kind === 'audio' && asset.subjectId === cue.id)
    .map((asset: Asset): number => asset.version)) + 1;
  return {
    id: assetId, kind: 'audio', subjectId: cue.id, path: `assets/${sha256Text(assetId)}.wav`, mimeType: inspected.mimeType,
    sha256: inspected.sha256, description: `${fileName} · ${inspected.sampleRate}Hz · ${inspected.channels}ch · ${inspected.codec}`,
    durationMs: inspected.durationMs, version,
    audioMetadata: { sampleRate: inspected.sampleRate, channels: inspected.channels, codec: inspected.codec },
  };
}

/** 효과음·음악을 측정·보관하고 구간 안의 자동 배치 후보로 남긴다. 공개·승인은 확정하지 않는다. */
export async function prepareAudioAsset(project: Project, cueId: string, assetId: string, input: AudioAssetImportInput, normalizer: AudioNormalizer): Promise<AttachedAudioAsset> {
  const cue: AudioCue | undefined = project.audioCues.find((value): boolean => value.id === cueId);
  if (cue === undefined) throw contractError('AUDIO_CUE_NOT_FOUND', `오디오 큐를 찾을 수 없습니다: ${cueId}`, []);
  if (!['sfx', 'music'].includes(cue.kind)) throw contractError('AUDIO_PREPARATION_KIND', `${cueId}: 효과음·음악 WAV만 자동 배치를 위해 준비할 수 있습니다.`, []);
  if (cue.assetId !== null && cue.timingStatus !== 'prepared') throw contractError('AUDIO_ALREADY_PLACED', `${cueId}: 기존에 등록한 음원과 배치는 보존합니다. 새 음향 준비는 미등록 큐 또는 배치 대기 큐에서 실행하세요.`, []);
  if (project.assets.some((asset): boolean => asset.id === assetId)) throw contractError('DUPLICATE_ASSET_ID', `자산 ID가 이미 존재합니다: ${assetId}`, []);
  const context = audioTimingContext(project, cue);
  if (context === null) throw contractError('AUDIO_SOURCE_CONTEXT_MISSING', `${cueId}: 원문과 기준 구간을 찾을 수 없습니다.`, []);
  const window: AudioCue = cue.timingStatus !== 'prepared' && cue.timingRelation === 'within-segment'
    ? { ...cue, startMs: context.sourceSegment.startMs, endMs: context.sourceSegment.endMs } : cue;
  assertAudioTimingRelation(project, window);
  if (automaticAudioProtected(project, window)) throw contractError('AUDIO_PREPARATION_PROTECTED', `${cueId}: 같은 원문 또는 배치 범위에 잠금·확정 컷이나 승인 그림이 있습니다. 기존 검토 상태를 보존했습니다.`, []);
  const inspected: InspectedAudio = await inspectAudioBytes(project, input.bytes, input.declaredMimeType, normalizer);
  if (inspected.durationMs > window.endMs - window.startMs) throw contractError('AUDIO_PREPARATION_TOO_LONG', `${cueId}: 실제 파일 ${inspected.durationMs}ms가 허용 범위 ${window.startMs}..${window.endMs}ms보다 깁니다. 해당 구간에 맞는 음원 파일을 선택하세요. 자동 자르기·반복은 하지 않습니다.`, []);
  const asset: Asset = importedAudioAsset(project, cue, assetId, input.originalFileName, inspected);
  const next: Project = finalize(project, { ...project, assets: [...project.assets, asset], audioCues: project.audioCues.map((value): AudioCue =>
    value.id === cue.id ? { ...window, timingStatus: 'prepared', assetId } : value) });
  return { project: next, relativePath: asset.path!, content: inspected.normalizedBytes,
    inspection: { durationMs: inspected.durationMs, sampleRate: inspected.sampleRate, channels: inspected.channels, codec: inspected.codec, sha256: inspected.sha256 } };
}

/** 실제 WAV 파일을 Audio Cue에 연결하고 파생된 검토 상태를 갱신한다. */
export async function attachAudioAsset(
  project: Project, cueId: string, assetId: string, input: AudioAssetImportInput, normalizer: AudioNormalizer,
): Promise<AttachedAudioAsset> {
  const cue: AudioCue | undefined = project.audioCues.find((candidate: AudioCue): boolean => candidate.id === cueId);
  if (cue === undefined) throw contractError('AUDIO_CUE_NOT_FOUND', `오디오 큐를 찾을 수 없습니다. cueId=${cueId}`, []);
  if (project.assets.some((asset: Asset): boolean => asset.id === assetId)) {
    throw contractError('DUPLICATE_ASSET_ID', `자산 ID가 이미 존재합니다. assetId=${assetId}`, []);
  }
  const unit = audioCueSource(project, cue);
  if (unit === null) throw contractError('AUDIO_SOURCE_CONTEXT_MISSING', `오디오 큐의 원문을 찾을 수 없습니다. cueId=${cueId}, unitId=${cue.unitId}, instructionId=${cue.instructionId}`, []);
  const inspected = await inspectAudioBytes(project, input.bytes, input.declaredMimeType, normalizer);
  const measuredCue: AudioCue = { ...cue, endMs: cue.startMs + inspected.durationMs, timingStatus: 'measured', assetId };
  assertAudioTimingRelation(project, measuredCue);
  const gateIssues: Issue[] = reviewInformationEmission(project, { entityId: cue.id, channel: 'audio-playback', informationIds: [...unit.informationIds], atMs: cue.startMs });
  if (gateIssues.length > 0) {
    throw contractError('AUDIO_OUTPUT_GATE_BLOCKED', gateIssues.map((value: Issue): string => `${value.code}: ${value.message}`).join('\n'), gateIssues);
  }
  const asset: Asset = importedAudioAsset(project, cue, assetId, input.originalFileName, inspected);
  const affectedShotIds: Set<string> = new Set<string>();
  const shots: Shot[] = project.shots.map((shot: Shot): Shot => {
    if (!shot.sourceLinks.some((link: ShotSourceLink): boolean => link.unitId === cue.unitId)) return shot;
    affectedShotIds.add(shot.id);
    return { ...shot, approvalStatus: 'proposed', sourceLinks: shot.sourceLinks.map((link: ShotSourceLink): ShotSourceLink => {
      if (link.unitId !== cue.unitId || link.temporalAnchor.kind !== 'shot-offset' || link.temporalAnchor.basis !== 'audio-cue') return link;
      return { ...link, status: 'mapping-required', temporalAnchor: { kind: 'unresolved', basis: 'audio-change', status: 'review-required' } };
    }) };
  });
  const frames: StoryboardFrame[] = project.frames.map((frame: StoryboardFrame): StoryboardFrame => affectedShotIds.has(frame.shotId)
    ? { ...frame, visualReview: 'pending' } : frame);
  const next: Project = finalize(project, { ...project, assets: [...project.assets, asset],
    audioCues: project.audioCues.map((candidate: AudioCue): AudioCue => candidate.id === cue.id ? measuredCue : candidate), shots, frames });
  return { project: next, relativePath: asset.path!, content: inspected.normalizedBytes,
    inspection: { durationMs: inspected.durationMs, sampleRate: inspected.sampleRate, channels: inspected.channels,
      codec: inspected.codec, sha256: inspected.sha256 } };
}

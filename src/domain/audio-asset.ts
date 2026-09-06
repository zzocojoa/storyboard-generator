import { assertAudioTimingRelation } from './audio.js';
import { reviewInformationEmission } from './emission.js';
import { assertNoErrors, contractError } from './errors.js';
import { inspectAudioBytes } from './media-inspection.js';
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

/** 실제 WAV 파일을 Audio Cue에 연결하고 파생된 검토 상태를 갱신한다. */
export function attachAudioAsset(project: Project, cueId: string, assetId: string, input: AudioAssetImportInput): AttachedAudioAsset {
  const cue: AudioCue | undefined = project.audioCues.find((candidate: AudioCue): boolean => candidate.id === cueId);
  if (cue === undefined) throw contractError('AUDIO_CUE_NOT_FOUND', `오디오 큐를 찾을 수 없습니다. cueId=${cueId}`, []);
  if (project.assets.some((asset: Asset): boolean => asset.id === assetId)) {
    throw contractError('DUPLICATE_ASSET_ID', `자산 ID가 이미 존재합니다. assetId=${assetId}`, []);
  }
  const unit = project.dataset.units.find((candidate): boolean => candidate.id === cue.unitId);
  if (unit === undefined) throw contractError('SOURCE_UNIT_NOT_FOUND', `오디오 큐의 원문을 찾을 수 없습니다. cueId=${cueId}, unitId=${cue.unitId}`, []);
  const inspected = inspectAudioBytes(project, input.bytes, input.declaredMimeType);
  const measuredCue: AudioCue = { ...cue, endMs: cue.startMs + inspected.durationMs, timingStatus: 'measured', assetId };
  assertAudioTimingRelation(project, measuredCue);
  const gateIssues: Issue[] = reviewInformationEmission(project, { entityId: cue.id, channel: 'audio-playback', informationIds: [...unit.informationIds], atMs: cue.startMs });
  if (gateIssues.length > 0) {
    throw contractError('AUDIO_OUTPUT_GATE_BLOCKED', gateIssues.map((value: Issue): string => `${value.code}: ${value.message}`).join('\n'), gateIssues);
  }
  const version: number = Math.max(0, ...project.assets.filter((asset: Asset): boolean => asset.kind === 'audio' && asset.subjectId === cue.id)
    .map((asset: Asset): number => asset.version)) + 1;
  const relativePath: string = `assets/${sha256Text(assetId)}.wav`;
  const asset: Asset = {
    id: assetId, kind: 'audio', subjectId: cue.id, path: relativePath, mimeType: inspected.mimeType,
    sha256: inspected.sha256, description: `${input.originalFileName} · ${inspected.sampleRate}Hz · ${inspected.channels}ch · ${inspected.codec}`,
    durationMs: inspected.durationMs, version,
    audioMetadata: { sampleRate: inspected.sampleRate, channels: inspected.channels, codec: inspected.codec },
  };
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
  return { project: next, relativePath, content: inspected.normalizedBytes,
    inspection: { durationMs: inspected.durationMs, sampleRate: inspected.sampleRate, channels: inspected.channels,
      codec: inspected.codec, sha256: inspected.sha256 } };
}

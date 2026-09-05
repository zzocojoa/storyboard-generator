import { assertNoErrors, contractError } from './errors.js';
import type { Asset, AudioCue, GenerationRecord, Project, StoryboardFrame } from './schema.js';
import { ProjectSchema } from './schema.js';
import { validateProject } from './validation.js';
import { sha256Bytes, sha256Text } from '../importers/integrity.js';
import type { GeneratedImage, GeneratedSpeech, ProposedSegment } from '../connectors/generation.js';
import { applySegmentProposal } from '../proposal/model.js';

export type GeneratedMutation = { project: Project; relativePath: string | null; content: Buffer | null };
export type ReferenceAssetInput = {
  id: string; kind: 'character' | 'location' | 'prop'; subjectId: string | null;
  description: string; mimeType: 'image/png' | 'image/jpeg' | 'image/webp'; bytes: Buffer;
};

function finalize(before: Project, input: Project): Project {
  const project: Project = ProjectSchema.parse(input);
  assertNoErrors(validateProject(project, before.dataset), 'INVALID_GENERATION_RESULT');
  return project;
}

function requireUniqueGenerationId(project: Project, generationId: string): void {
  if (project.generationRecords.some((record: GenerationRecord): boolean => record.id === generationId)) {
    throw contractError('DUPLICATE_GENERATION_ID', `생성 작업 ID가 이미 존재합니다: ${generationId}`, []);
  }
}

function requireImageBytes(bytes: Buffer, mimeType: string): void {
  const valid: boolean = mimeType === 'image/png' ? bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))
    : mimeType === 'image/jpeg' ? bytes.length >= 3 && bytes.subarray(0, 3).equals(Buffer.from('ffd8ff', 'hex'))
    : mimeType === 'image/webp' ? bytes.length >= 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP' : false;
  if (!valid) throw contractError('INVALID_IMAGE_BYTES', `선언한 이미지 형식과 파일 헤더가 다릅니다. mimeType=${mimeType}, bytes=${bytes.length}`, []);
}

function generationRecord(
  id: string, result: { prompt: string; model: string; requestId: string | null },
  resultAssetIds: readonly string[], shotIds: readonly string[], referenceHashes: readonly string[], createdAt: string,
): GenerationRecord {
  return {
    id, provider: 'openai', model: result.model, modelVersion: null, requestId: result.requestId,
    prompt: result.prompt, templateVersion: '1.0.0', seed: null, referenceHashes: [...referenceHashes],
    resultAssetIds: [...resultAssetIds], shotIds: [...shotIds], createdAt,
  };
}

function requireWavChunk(bytes: Buffer, offset: number, length: number, name: string): Buffer {
  if (offset + length > bytes.length) throw contractError('INVALID_WAV', `${name} 청크가 파일 범위를 벗어났습니다. offset=${offset}, length=${length}, bytes=${bytes.length}`, []);
  return bytes.subarray(offset, offset + length);
}

/** PCM WAV 헤더를 읽어 실제 재생 시간을 밀리초로 계산한다. */
export function wavDurationMs(bytes: Buffer): number {
  if (bytes.length < 12 || bytes.toString('ascii', 0, 4) !== 'RIFF' || bytes.toString('ascii', 8, 12) !== 'WAVE') {
    throw contractError('INVALID_WAV', `RIFF/WAVE 헤더가 없는 음성 파일입니다. bytes=${bytes.length}`, []);
  }
  let offset: number = 12;
  let byteRate: number | null = null;
  let dataLength: number | null = null;
  while (offset + 8 <= bytes.length) {
    const chunkId: string = bytes.toString('ascii', offset, offset + 4);
    const chunkLength: number = bytes.readUInt32LE(offset + 4);
    const chunk: Buffer = requireWavChunk(bytes, offset + 8, chunkLength, chunkId);
    if (chunkId === 'fmt ') {
      if (chunk.length < 16) throw contractError('INVALID_WAV', `fmt 청크가 너무 짧습니다. bytes=${chunk.length}`, []);
      const format: number = chunk.readUInt16LE(0);
      if (![1, 3].includes(format)) throw contractError('UNSUPPORTED_WAV_FORMAT', `지원하지 않는 WAV 형식입니다. format=${format}`, []);
      byteRate = chunk.readUInt32LE(8);
      if (byteRate <= 0) throw contractError('INVALID_WAV', `WAV byteRate가 올바르지 않습니다. byteRate=${byteRate}`, []);
    }
    if (chunkId === 'data') dataLength = chunkLength;
    offset += 8 + chunkLength + (chunkLength % 2);
  }
  if (byteRate === null || dataLength === null) throw contractError('INVALID_WAV', 'WAV에 fmt 또는 data 청크가 없습니다.', []);
  return Math.max(1, Math.round(dataLength * 1000 / byteRate));
}

export function applyGeneratedProposal(
  project: Project, segmentId: string, generationId: string, createdAt: string, result: ProposedSegment,
): GeneratedMutation {
  requireUniqueGenerationId(project, generationId);
  const proposed: Project = applySegmentProposal(project, segmentId, result.proposal, generationId);
  const shotIds: string[] = proposed.shots.filter((shot): boolean => shot.segmentId === segmentId).map((shot): string => shot.id);
  const record: GenerationRecord = generationRecord(generationId, result, [], shotIds, [], createdAt);
  return { project: finalize(project, { ...proposed, generationRecords: [...proposed.generationRecords, record] }), relativePath: null, content: null };
}

export function applyGeneratedImage(
  project: Project, frameId: string, generationId: string, createdAt: string, result: GeneratedImage,
): GeneratedMutation {
  requireUniqueGenerationId(project, generationId);
  const frame: StoryboardFrame | undefined = project.frames.find((candidate: StoryboardFrame): boolean => candidate.id === frameId);
  if (frame === undefined) throw contractError('FRAME_NOT_FOUND', `프레임을 찾을 수 없습니다: ${frameId}`, []);
  const shot = project.shots.find((candidate): boolean => candidate.id === frame.shotId);
  if (shot === undefined) throw contractError('SHOT_NOT_FOUND', `프레임의 컷을 찾을 수 없습니다: ${frame.shotId}`, []);
  if (shot.lockedFields.includes('frames')) throw contractError('SHOT_FIELD_LOCKED', `${shot.id}: frames 필드를 먼저 잠금 해제하세요.`, []);
  requireImageBytes(result.bytes, result.mimeType);
  const assetId: string = `${generationId}:image`;
  if (project.assets.some((asset: Asset): boolean => asset.id === assetId)) throw contractError('DUPLICATE_ASSET_ID', `자산 ID가 이미 존재합니다: ${assetId}`, []);
  const prior: Asset | undefined = frame.imageAssetId === null ? undefined : project.assets.find((asset: Asset): boolean => asset.id === frame.imageAssetId);
  const relativePath: string = `assets/${sha256Text(assetId)}.png`;
  const asset: Asset = { id: assetId, kind: 'image', subjectId: frame.id, path: relativePath, mimeType: result.mimeType, sha256: sha256Bytes(result.bytes), description: frame.description, durationMs: null, version: (prior?.version ?? 0) + 1 };
  const record: GenerationRecord = generationRecord(generationId, result, [assetId], [shot.id], result.referenceHashes, createdAt);
  const next: Project = { ...project, assets: [...project.assets, asset],
    frames: project.frames.map((candidate: StoryboardFrame): StoryboardFrame => candidate.id === frameId ? { ...candidate, imageAssetId: assetId, visualReview: 'pending' } : candidate),
    generationRecords: [...project.generationRecords, record] };
  return { project: finalize(project, next), relativePath, content: result.bytes };
}

export function applyGeneratedSpeech(
  project: Project, cueId: string, generationId: string, createdAt: string, result: GeneratedSpeech,
): GeneratedMutation {
  requireUniqueGenerationId(project, generationId);
  const cue: AudioCue | undefined = project.audioCues.find((candidate: AudioCue): boolean => candidate.id === cueId);
  if (cue === undefined) throw contractError('AUDIO_CUE_NOT_FOUND', `오디오 큐를 찾을 수 없습니다: ${cueId}`, []);
  if (!['dialogue', 'voiceover', 'panel'].includes(cue.kind)) throw contractError('SPEECH_CUE_REQUIRED', `${cueId}: 대사·내레이션·패널 발화만 가이드 음성으로 만들 수 있습니다.`, []);
  const unit = project.dataset.units.find((candidate): boolean => candidate.id === cue.unitId);
  if (unit === undefined) throw contractError('SOURCE_UNIT_NOT_FOUND', `오디오 큐의 원문을 찾을 수 없습니다: ${cue.unitId}`, []);
  const segment = project.dataset.segments.find((candidate): boolean => candidate.id === unit.segmentId);
  if (segment === undefined) throw contractError('SEGMENT_NOT_FOUND', `원문의 구간을 찾을 수 없습니다: ${unit.segmentId}`, []);
  const durationMs: number = wavDurationMs(result.bytes);
  const endMs: number = cue.startMs + durationMs;
  if (endMs > segment.endMs) throw contractError('GENERATED_SPEECH_TOO_LONG', `${cueId}: 생성 음성이 구간 종료를 ${endMs - segment.endMs}ms 초과합니다. 큐 시작점이나 원문 구간을 조정하세요.`, []);
  const assetId: string = `${generationId}:audio`;
  if (project.assets.some((asset: Asset): boolean => asset.id === assetId)) throw contractError('DUPLICATE_ASSET_ID', `자산 ID가 이미 존재합니다: ${assetId}`, []);
  const prior: Asset | undefined = cue.assetId === null ? undefined : project.assets.find((asset: Asset): boolean => asset.id === cue.assetId);
  const relativePath: string = `assets/${sha256Text(assetId)}.wav`;
  const asset: Asset = { id: assetId, kind: 'audio', subjectId: cue.id, path: relativePath, mimeType: result.mimeType, sha256: sha256Bytes(result.bytes), description: `가이드 음성: ${unit.text}`, durationMs, version: (prior?.version ?? 0) + 1 };
  const shotIds: string[] = project.shots.filter((shot): boolean => shot.sourceUnitIds.includes(unit.id)).map((shot): string => shot.id);
  const record: GenerationRecord = generationRecord(generationId, result, [assetId], shotIds, [], createdAt);
  const next: Project = { ...project, assets: [...project.assets, asset],
    audioCues: project.audioCues.map((candidate: AudioCue): AudioCue => candidate.id === cueId ? { ...candidate, endMs, timingStatus: 'measured', assetId } : candidate),
    generationRecords: [...project.generationRecords, record] };
  return { project: finalize(project, next), relativePath, content: result.bytes };
}

export function addReferenceAsset(project: Project, input: ReferenceAssetInput): GeneratedMutation {
  if (project.assets.some((asset: Asset): boolean => asset.id === input.id)) throw contractError('DUPLICATE_ASSET_ID', `자산 ID가 이미 존재합니다: ${input.id}`, []);
  if (input.bytes.length === 0 || input.bytes.length > 20 * 1024 * 1024) throw contractError('INVALID_REFERENCE_SIZE', `기준 이미지는 1바이트 이상 20MB 이하여야 합니다. actual=${input.bytes.length}`, []);
  requireImageBytes(input.bytes, input.mimeType);
  const validSubject: boolean = input.kind === 'character' ? input.subjectId !== null && project.dataset.people.some((person): boolean => person.id === input.subjectId)
    : input.kind === 'location' ? input.subjectId !== null && project.dataset.locations.some((location): boolean => location.id === input.subjectId) : true;
  if (!validSubject) throw contractError('INVALID_REFERENCE_SUBJECT', `${input.kind}: 연결 대상을 프로젝트에서 찾을 수 없습니다. subjectId=${input.subjectId ?? 'null'}`, []);
  const extension: string = input.mimeType === 'image/png' ? 'png' : input.mimeType === 'image/jpeg' ? 'jpg' : 'webp';
  const relativePath: string = `assets/${sha256Text(input.id)}.${extension}`;
  const version: number = Math.max(0, ...project.assets.filter((asset: Asset): boolean => asset.kind === input.kind && asset.subjectId === input.subjectId).map((asset: Asset): number => asset.version)) + 1;
  const asset: Asset = { id: input.id, kind: input.kind, subjectId: input.subjectId, path: relativePath, mimeType: input.mimeType,
    sha256: sha256Bytes(input.bytes), description: input.description, durationMs: null, version };
  const affectedShotIds: Set<string> = new Set<string>(project.shots.filter((shot): boolean =>
    (input.kind === 'character' && input.subjectId !== null && shot.presence.some((presence): boolean => presence.personId === input.subjectId))
    || (input.kind === 'location' && input.subjectId !== null && shot.visualLocationId === input.subjectId),
  ).map((shot): string => shot.id));
  return { project: finalize(project, { ...project, assets: [...project.assets, asset],
    frames: project.frames.map((frame: StoryboardFrame): StoryboardFrame => affectedShotIds.has(frame.shotId) ? { ...frame, visualReview: 'pending' } : frame) }), relativePath, content: input.bytes };
}

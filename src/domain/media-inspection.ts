import sharp from 'sharp';
import type { AudioNormalizationPlan, AudioNormalizer } from './audio-normalizer.js';
import { contractError } from './errors.js';
import type { ContractError } from './errors.js';
import type { Asset, Project } from './schema.js';
import { sha256Bytes } from '../importers/integrity.js';

export const MAX_IMAGE_BYTES: number = 20 * 1024 * 1024;
export const MAX_IMAGE_PIXELS: number = 40_000_000;
export const MAX_AUDIO_BYTES: number = 50 * 1024 * 1024;
export const MAX_AUDIO_DURATION_MS: number = 60 * 60 * 1000;
export const MAX_AUDIO_NORMALIZED_BYTES: number = MAX_AUDIO_BYTES;
export const MAX_AUDIO_NORMALIZATION_SAMPLE_OPERATIONS: number = Math.floor((MAX_AUDIO_NORMALIZED_BYTES - 44) / 2);
export const MIN_AUDIO_SAMPLE_RATE: number = 8_000;
export const MAX_AUDIO_SAMPLE_RATE: number = 384_000;
export const MAX_WAV_CHUNKS: number = 4_096;

export type InspectedImage = {
  mimeType: 'image/png' | 'image/jpeg' | 'image/webp';
  width: number;
  height: number;
  sha256: string;
};

export type InspectedAudio = {
  normalizedBytes: Buffer;
  mimeType: 'audio/wav';
  durationMs: number;
  sampleRate: number;
  channels: number;
  codec: 'pcm_s16le';
  sha256: string;
};

export type InspectedAudioFile = {
  mimeType: 'audio/wav';
  durationMs: number;
  sampleRate: number;
  channels: number;
  codec: 'pcm_s16le' | 'pcm_s24le';
  sha256: string;
};

type ParsedWav = {
  sampleRate: number;
  channels: 1 | 2;
  bitsPerSample: 16 | 24;
  sampleFrames: number;
  data: Buffer;
};

function isContractError(error: unknown): error is ContractError {
  return error instanceof Error && 'code' in error && typeof error.code === 'string'
    && 'issues' in error && Array.isArray(error.issues);
}

function imageMime(format: string | undefined): InspectedImage['mimeType'] {
  if (format === 'png') return 'image/png';
  if (format === 'jpeg') return 'image/jpeg';
  if (format === 'webp') return 'image/webp';
  throw contractError('ASSET_MIME_MISMATCH', `지원하지 않는 이미지 형식입니다. detected=${format ?? 'unknown'}`, []);
}

/** 전체 픽셀 디코딩을 완료한 이미지만 자산으로 허용한다. */
export async function inspectImageBytes(bytes: Buffer, declaredMimeType: string): Promise<InspectedImage> {
  if (bytes.length === 0 || bytes.length > MAX_IMAGE_BYTES) {
    throw contractError('INVALID_IMAGE_SIZE', `이미지는 1바이트 이상 ${MAX_IMAGE_BYTES}바이트 이하여야 합니다. actual=${bytes.length}`, []);
  }
  try {
    const decoder = sharp(bytes, { failOn: 'error', limitInputPixels: MAX_IMAGE_PIXELS });
    const metadata = await decoder.metadata();
    const mimeType: InspectedImage['mimeType'] = imageMime(metadata.format);
    if (mimeType !== declaredMimeType) {
      throw contractError('ASSET_MIME_MISMATCH', `선언 MIME과 실제 이미지 형식이 다릅니다. declared=${declaredMimeType}, actual=${mimeType}`, []);
    }
    const width: number = metadata.width ?? 0;
    const height: number = metadata.height ?? 0;
    if (width <= 0 || height <= 0 || width * height > MAX_IMAGE_PIXELS) {
      throw contractError('IMAGE_DIMENSIONS_INVALID', `이미지 크기가 허용 범위를 벗어났습니다. width=${width}, height=${height}, maxPixels=${MAX_IMAGE_PIXELS}`, []);
    }
    await decoder.toBuffer();
    return { mimeType, width, height, sha256: sha256Bytes(bytes) };
  } catch (error: unknown) {
    if (isContractError(error)) throw error;
    const message: string = error instanceof Error ? error.message : String(error);
    throw contractError('ASSET_CONTENT_CORRUPT', `이미지를 끝까지 디코딩할 수 없습니다. bytes=${bytes.length}, cause=${message}`, []);
  }
}

function unsupportedContainer(bytes: Buffer): never {
  const signature: string = bytes.subarray(0, 12).toString('ascii');
  throw contractError('UNSUPPORTED_AUDIO_CONTAINER', `지원하는 오디오 컨테이너는 PCM WAV뿐입니다. signature=${JSON.stringify(signature)}`, []);
}

function requireRange(bytes: Buffer, offset: number, length: number, label: string): void {
  if (offset < 0 || length < 0 || offset + length > bytes.length) {
    throw contractError('ASSET_CONTENT_CORRUPT', `WAV ${label} 범위가 파일을 벗어났습니다. offset=${offset}, length=${length}, bytes=${bytes.length}`, []);
  }
}

function parsePcmWav(bytes: Buffer, declaredMimeType: string): ParsedWav {
  if (bytes.length < 12 || bytes.toString('ascii', 0, 4) !== 'RIFF' || bytes.toString('ascii', 8, 12) !== 'WAVE') unsupportedContainer(bytes);
  if (!['audio/wav', 'audio/x-wav', 'audio/wave'].includes(declaredMimeType.toLowerCase())) {
    throw contractError('ASSET_MIME_MISMATCH', `선언 MIME과 실제 오디오 형식이 다릅니다. declared=${declaredMimeType}, actual=audio/wav`, []);
  }
  const riffLength: number = bytes.readUInt32LE(4) + 8;
  if (riffLength !== bytes.length) {
    throw contractError('ASSET_CONTENT_CORRUPT', `WAV RIFF 길이와 실제 파일 길이가 다릅니다. declared=${riffLength}, actual=${bytes.length}`, []);
  }
  let offset: number = 12;
  let format: number | null = null;
  let channels: number | null = null;
  let sampleRate: number | null = null;
  let byteRate: number | null = null;
  let blockAlign: number | null = null;
  let bitsPerSample: number | null = null;
  let data: Buffer | null = null;
  let chunkCount: number = 0;
  while (offset < bytes.length) {
    chunkCount += 1;
    if (chunkCount > MAX_WAV_CHUNKS) {
      throw contractError('AUDIO_WAV_CHUNK_LIMIT', `WAV 청크 수가 허용 범위를 초과합니다. actual>${MAX_WAV_CHUNKS}`, []);
    }
    requireRange(bytes, offset, 8, 'chunk-header');
    const chunkId: string = bytes.toString('ascii', offset, offset + 4);
    const chunkLength: number = bytes.readUInt32LE(offset + 4);
    const contentOffset: number = offset + 8;
    requireRange(bytes, contentOffset, chunkLength, chunkId);
    if (chunkId === 'fmt ') {
      if (chunkLength < 16) throw contractError('ASSET_CONTENT_CORRUPT', `WAV fmt 청크가 너무 짧습니다. length=${chunkLength}`, []);
      format = bytes.readUInt16LE(contentOffset);
      channels = bytes.readUInt16LE(contentOffset + 2);
      sampleRate = bytes.readUInt32LE(contentOffset + 4);
      byteRate = bytes.readUInt32LE(contentOffset + 8);
      blockAlign = bytes.readUInt16LE(contentOffset + 12);
      bitsPerSample = bytes.readUInt16LE(contentOffset + 14);
    }
    if (chunkId === 'data') {
      if (data !== null) throw contractError('ASSET_CONTENT_CORRUPT', 'WAV data 청크가 두 개 이상입니다.', []);
      data = bytes.subarray(contentOffset, contentOffset + chunkLength);
    }
    offset = contentOffset + chunkLength + (chunkLength % 2);
  }
  if (offset !== bytes.length || format === null || channels === null || sampleRate === null || byteRate === null
    || blockAlign === null || bitsPerSample === null || data === null) {
    throw contractError('ASSET_CONTENT_CORRUPT', 'WAV 구조가 완전하지 않거나 fmt/data 청크가 없습니다.', []);
  }
  if (format !== 1) throw contractError('UNSUPPORTED_AUDIO_CODEC', `PCM 정수 WAV만 지원합니다. format=${format}`, []);
  if (channels !== 1 && channels !== 2) throw contractError('UNSUPPORTED_AUDIO_CODEC', `mono 또는 stereo WAV만 지원합니다. channels=${channels}`, []);
  if (bitsPerSample !== 16 && bitsPerSample !== 24) throw contractError('UNSUPPORTED_AUDIO_CODEC', `16비트 또는 24비트 PCM WAV만 지원합니다. bits=${bitsPerSample}`, []);
  if (sampleRate <= 0) throw contractError('ASSET_CONTENT_CORRUPT', `WAV sampleRate가 올바르지 않습니다. sampleRate=${sampleRate}`, []);
  const expectedBlockAlign: number = channels * bitsPerSample / 8;
  if (blockAlign !== expectedBlockAlign || byteRate !== sampleRate * blockAlign || data.length % blockAlign !== 0) {
    throw contractError('ASSET_CONTENT_CORRUPT', `WAV PCM 정렬 정보가 일치하지 않습니다. byteRate=${byteRate}, blockAlign=${blockAlign}, data=${data.length}`, []);
  }
  if (data.length === 0) throw contractError('ASSET_CONTENT_CORRUPT', 'WAV data 청크가 비어 있습니다.', []);
  return { sampleRate, channels, bitsPerSample, sampleFrames: data.length / blockAlign, data };
}

function requireSupportedSampleRate(sampleRate: number, label: string): void {
  if (sampleRate < MIN_AUDIO_SAMPLE_RATE || sampleRate > MAX_AUDIO_SAMPLE_RATE) {
    throw contractError('AUDIO_SAMPLE_RATE_UNSUPPORTED', `${label} sample rate가 허용 범위를 벗어났습니다. sampleRate=${sampleRate}, allowed=${MIN_AUDIO_SAMPLE_RATE}..${MAX_AUDIO_SAMPLE_RATE}`, []);
  }
}

function normalizationPlan(wav: ParsedWav, targetSampleRate: number): AudioNormalizationPlan {
  const sourceRate: bigint = BigInt(wav.sampleRate);
  const numerator: bigint = BigInt(wav.sampleFrames) * BigInt(targetSampleRate);
  const frames: bigint = (numerator + sourceRate / 2n) / sourceRate;
  const normalizedFrames: bigint = frames > 0n ? frames : 1n;
  const normalizedBytes: bigint = 44n + normalizedFrames * BigInt(wav.channels) * 2n;
  const sampleOperations: bigint = normalizedFrames * BigInt(wav.channels);
  if (normalizedBytes > BigInt(MAX_AUDIO_NORMALIZED_BYTES)) {
    throw contractError('AUDIO_NORMALIZED_SIZE_LIMIT', `정규화 결과가 허용 크기를 초과합니다. estimatedBytes=${normalizedBytes.toString()}, maxBytes=${MAX_AUDIO_NORMALIZED_BYTES}`, []);
  }
  if (sampleOperations > BigInt(MAX_AUDIO_NORMALIZATION_SAMPLE_OPERATIONS)) {
    throw contractError('AUDIO_NORMALIZATION_RESOURCE_LIMIT', `정규화 Sample 연산량이 허용 범위를 초과합니다. operations=${sampleOperations.toString()}, maxOperations=${MAX_AUDIO_NORMALIZATION_SAMPLE_OPERATIONS}`, []);
  }
  return {
    sourceData: wav.data,
    sourceSampleRate: wav.sampleRate,
    sourceChannels: wav.channels,
    sourceBitsPerSample: wav.bitsPerSample,
    sourceFrames: wav.sampleFrames,
    targetSampleRate,
    targetFrames: Number(normalizedFrames),
    outputBytes: Number(normalizedBytes),
    sampleOperations: Number(sampleOperations),
  };
}

function durationMs(wav: ParsedWav): number {
  return Math.max(1, Math.round(wav.sampleFrames * 1000 / wav.sampleRate));
}

export function wavDurationMs(bytes: Buffer): number {
  return inspectAudioFileBytes(bytes, 'audio/wav').durationMs;
}

function inspectParsedAudio(bytes: Buffer, declaredMimeType: string): { wav: ParsedWav; inspection: InspectedAudioFile } {
  if (bytes.length === 0 || bytes.length > MAX_AUDIO_BYTES) {
    throw contractError('AUDIO_FILE_SIZE_LIMIT', `오디오는 1바이트 이상 ${MAX_AUDIO_BYTES}바이트 이하여야 합니다. actual=${bytes.length}`, []);
  }
  const wav: ParsedWav = parsePcmWav(bytes, declaredMimeType);
  requireSupportedSampleRate(wav.sampleRate, '입력 WAV');
  const actualDurationMs: number = durationMs(wav);
  const durationLimitExceeded: boolean = BigInt(wav.sampleFrames) * 1_000n > BigInt(wav.sampleRate) * BigInt(MAX_AUDIO_DURATION_MS);
  if (durationLimitExceeded) {
    throw contractError('AUDIO_DURATION_LIMIT', `오디오 길이는 ${MAX_AUDIO_DURATION_MS}ms 이하여야 합니다. actual=${actualDurationMs}`, []);
  }
  return { wav, inspection: { mimeType: 'audio/wav', durationMs: actualDurationMs, sampleRate: wav.sampleRate,
    channels: wav.channels, codec: wav.bitsPerSample === 16 ? 'pcm_s16le' : 'pcm_s24le', sha256: sha256Bytes(bytes) } };
}

/** 저장된 WAV를 변환하지 않고 실제 구조와 metadata를 읽는다. */
export function inspectAudioFileBytes(bytes: Buffer, declaredMimeType: string): InspectedAudioFile {
  return inspectParsedAudio(bytes, declaredMimeType).inspection;
}

/** PCM WAV를 프로젝트 샘플레이트의 16비트 PCM WAV로 정규화하고 결과를 다시 검사한다. */
export async function inspectAudioBytes(
  project: Pick<Project, 'handoff'>, bytes: Buffer, declaredMimeType: string, normalizer: AudioNormalizer,
): Promise<InspectedAudio> {
  const { wav: source } = inspectParsedAudio(bytes, declaredMimeType);
  const targetRate: number = project.handoff.timebase.sampleRate;
  requireSupportedSampleRate(targetRate, 'Project');
  const plan: AudioNormalizationPlan = normalizationPlan(source, targetRate);
  const normalizedBytes: Buffer = source.sampleRate === targetRate && source.bitsPerSample === 16
    ? Buffer.from(bytes) : await normalizer.normalize(plan);
  const normalized: InspectedAudioFile = inspectAudioFileBytes(normalizedBytes, 'audio/wav');
  if (normalized.sampleRate !== targetRate || normalized.codec !== 'pcm_s16le') {
    throw contractError('AUDIO_NORMALIZATION_FAILED', `정규화 결과가 프로젝트 형식과 다릅니다. expected=${targetRate}/pcm_s16le, actual=${normalized.sampleRate}/${normalized.codec}`, []);
  }
  return { normalizedBytes, mimeType: 'audio/wav', durationMs: normalized.durationMs, sampleRate: normalized.sampleRate,
    channels: normalized.channels, codec: 'pcm_s16le', sha256: sha256Bytes(normalizedBytes) };
}

function assertStoredAudioMetadata(asset: Asset, inspected: InspectedAudioFile): void {
  if (asset.durationMs !== inspected.durationMs) {
    throw contractError('AUDIO_ASSET_METADATA_MISMATCH', `저장 WAV 길이와 Asset metadata가 다릅니다. assetId=${asset.id}, expected=${String(asset.durationMs)}, actual=${inspected.durationMs}`, []);
  }
  if (asset.audioMetadata === undefined || asset.audioMetadata === null) {
    throw contractError('AUDIO_ASSET_METADATA_MISSING', `저장 Audio Asset에 실제 형식 metadata가 없습니다. assetId=${asset.id}`, []);
  }
  const mismatch: boolean = asset.audioMetadata.sampleRate !== inspected.sampleRate
    || asset.audioMetadata.channels !== inspected.channels || asset.audioMetadata.codec !== inspected.codec;
  if (mismatch) {
    throw contractError('AUDIO_ASSET_METADATA_MISMATCH', `저장 WAV 형식과 Asset metadata가 다릅니다. assetId=${asset.id}, expected=${asset.audioMetadata.sampleRate}/${asset.audioMetadata.channels}/${asset.audioMetadata.codec}, actual=${inspected.sampleRate}/${inspected.channels}/${inspected.codec}`, []);
  }
}

export async function verifyStoredAsset(project: Pick<Project, 'handoff'>, asset: Asset, bytes: Buffer): Promise<InspectedImage | InspectedAudioFile> {
  const actualHash: string = sha256Bytes(bytes);
  if (actualHash !== asset.sha256) {
    throw contractError('ASSET_HASH_MISMATCH', `저장 파일 해시가 Asset metadata와 다릅니다. assetId=${asset.id}, expected=${asset.sha256}, actual=${actualHash}`, []);
  }
  try {
    if (asset.kind === 'audio') {
      const inspected: InspectedAudioFile = inspectAudioFileBytes(bytes, asset.mimeType);
      assertStoredAudioMetadata(asset, inspected);
      if (inspected.sampleRate !== project.handoff.timebase.sampleRate || inspected.codec !== 'pcm_s16le') {
        throw contractError('AUDIO_ASSET_NORMALIZATION_REQUIRED', `저장 Audio Asset을 프로젝트 PCM 형식으로 정규화해야 합니다. assetId=${asset.id}, actual=${inspected.sampleRate}/${inspected.codec}, target=${project.handoff.timebase.sampleRate}/pcm_s16le`, []);
      }
      return inspected;
    }
    return await inspectImageBytes(bytes, asset.mimeType);
  } catch (error: unknown) {
    if (isContractError(error)) {
      const code: string = error.code;
      if (code === 'ASSET_MIME_MISMATCH' || code === 'ASSET_HASH_MISMATCH' || code.startsWith('AUDIO_ASSET_')) throw error;
      throw contractError('ASSET_CONTENT_CORRUPT', `저장 자산의 내용을 검증할 수 없습니다. assetId=${asset.id}, cause=${error.message}`, []);
    }
    throw error;
  }
}

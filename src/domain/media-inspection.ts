import sharp from 'sharp';
import { contractError } from './errors.js';
import type { ContractError } from './errors.js';
import type { Asset, Project } from './schema.js';
import { sha256Bytes } from '../importers/integrity.js';

export const MAX_IMAGE_BYTES: number = 20 * 1024 * 1024;
export const MAX_IMAGE_PIXELS: number = 40_000_000;
export const MAX_AUDIO_BYTES: number = 50 * 1024 * 1024;
export const MAX_AUDIO_DURATION_MS: number = 60 * 60 * 1000;

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

type ParsedWav = {
  sampleRate: number;
  channels: number;
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
  while (offset < bytes.length) {
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
  return { sampleRate, channels, bitsPerSample, sampleFrames: data.length / blockAlign, data };
}

function readSample(data: Buffer, byteOffset: number, bitsPerSample: 16 | 24): number {
  if (bitsPerSample === 16) return data.readInt16LE(byteOffset) / 32768;
  return data.readIntLE(byteOffset, 3) / 8388608;
}

function sampleAt(wav: ParsedWav, frame: number, channel: number): number {
  const bytesPerSample: number = wav.bitsPerSample / 8;
  return readSample(wav.data, (frame * wav.channels + channel) * bytesPerSample, wav.bitsPerSample);
}

function encodePcm16Wav(wav: ParsedWav, targetSampleRate: number): Buffer {
  const targetFrames: number = Math.max(1, Math.round(wav.sampleFrames * targetSampleRate / wav.sampleRate));
  const dataLength: number = targetFrames * wav.channels * 2;
  const result: Buffer = Buffer.alloc(44 + dataLength);
  result.write('RIFF', 0); result.writeUInt32LE(36 + dataLength, 4); result.write('WAVE', 8); result.write('fmt ', 12);
  result.writeUInt32LE(16, 16); result.writeUInt16LE(1, 20); result.writeUInt16LE(wav.channels, 22); result.writeUInt32LE(targetSampleRate, 24);
  result.writeUInt32LE(targetSampleRate * wav.channels * 2, 28); result.writeUInt16LE(wav.channels * 2, 32); result.writeUInt16LE(16, 34);
  result.write('data', 36); result.writeUInt32LE(dataLength, 40);
  for (let targetFrame: number = 0; targetFrame < targetFrames; targetFrame += 1) {
    const sourcePosition: number = targetFrame * wav.sampleRate / targetSampleRate;
    const leftFrame: number = Math.min(wav.sampleFrames - 1, Math.floor(sourcePosition));
    const rightFrame: number = Math.min(wav.sampleFrames - 1, leftFrame + 1);
    const blend: number = sourcePosition - leftFrame;
    for (let channel: number = 0; channel < wav.channels; channel += 1) {
      const value: number = sampleAt(wav, leftFrame, channel) * (1 - blend) + sampleAt(wav, rightFrame, channel) * blend;
      const integer: number = Math.max(-32768, Math.min(32767, Math.round(value * 32767)));
      result.writeInt16LE(integer, 44 + (targetFrame * wav.channels + channel) * 2);
    }
  }
  return result;
}

function durationMs(wav: ParsedWav): number {
  return Math.max(1, Math.round(wav.sampleFrames * 1000 / wav.sampleRate));
}

export function wavDurationMs(bytes: Buffer): number {
  return durationMs(parsePcmWav(bytes, 'audio/wav'));
}

/** PCM WAV를 프로젝트 샘플레이트의 16비트 PCM WAV로 정규화하고 결과를 다시 검사한다. */
export function inspectAudioBytes(project: Pick<Project, 'handoff'>, bytes: Buffer, declaredMimeType: string): InspectedAudio {
  if (bytes.length === 0 || bytes.length > MAX_AUDIO_BYTES) {
    throw contractError('AUDIO_FILE_SIZE_LIMIT', `오디오는 1바이트 이상 ${MAX_AUDIO_BYTES}바이트 이하여야 합니다. actual=${bytes.length}`, []);
  }
  const source: ParsedWav = parsePcmWav(bytes, declaredMimeType);
  if (durationMs(source) > MAX_AUDIO_DURATION_MS) {
    throw contractError('AUDIO_DURATION_LIMIT', `오디오 길이는 ${MAX_AUDIO_DURATION_MS}ms 이하여야 합니다. actual=${durationMs(source)}`, []);
  }
  const targetRate: number = project.handoff.timebase.sampleRate;
  const normalizedBytes: Buffer = source.sampleRate === targetRate && source.bitsPerSample === 16
    ? Buffer.from(bytes) : encodePcm16Wav(source, targetRate);
  const normalized: ParsedWav = parsePcmWav(normalizedBytes, 'audio/wav');
  if (normalized.sampleRate !== targetRate || normalized.bitsPerSample !== 16) {
    throw contractError('AUDIO_NORMALIZATION_FAILED', `정규화 결과가 프로젝트 형식과 다릅니다. expected=${targetRate}/16, actual=${normalized.sampleRate}/${normalized.bitsPerSample}`, []);
  }
  return { normalizedBytes, mimeType: 'audio/wav', durationMs: durationMs(normalized), sampleRate: normalized.sampleRate,
    channels: normalized.channels, codec: 'pcm_s16le', sha256: sha256Bytes(normalizedBytes) };
}

export async function verifyStoredAsset(project: Pick<Project, 'handoff'>, asset: Asset, bytes: Buffer): Promise<InspectedImage | InspectedAudio> {
  const actualHash: string = sha256Bytes(bytes);
  if (actualHash !== asset.sha256) {
    throw contractError('ASSET_HASH_MISMATCH', `저장 파일 해시가 Asset metadata와 다릅니다. assetId=${asset.id}, expected=${asset.sha256}, actual=${actualHash}`, []);
  }
  try {
    if (asset.kind === 'audio') {
      const inspected: InspectedAudio = inspectAudioBytes(project, bytes, asset.mimeType);
      if (inspected.sha256 !== asset.sha256) {
        throw contractError('ASSET_CONTENT_CORRUPT', `저장 오디오가 프로젝트 샘플레이트로 정규화되지 않았습니다. assetId=${asset.id}, sampleRate=${inspected.sampleRate}`, []);
      }
      return inspected;
    }
    return await inspectImageBytes(bytes, asset.mimeType);
  } catch (error: unknown) {
    if (isContractError(error)) {
      const code: string = error.code;
      if (code === 'ASSET_MIME_MISMATCH' || code === 'ASSET_HASH_MISMATCH') throw error;
      throw contractError('ASSET_CONTENT_CORRUPT', `저장 자산의 내용을 검증할 수 없습니다. assetId=${asset.id}, cause=${error.message}`, []);
    }
    throw error;
  }
}

import { NativeDatasetSchema } from '../src/domain/schema.js';
import type { NativeDataset, PackagePayload } from '../src/domain/schema.js';
import { parseJson, sha256Text } from '../src/importers/integrity.js';
import { readPackage } from '../src/io/package.js';
import sharp from 'sharp';

export async function nativePackage(): Promise<PackagePayload> {
  return readPackage('tests/fixtures/native/storyboard_handoff.json');
}

export async function productionPackage(): Promise<PackagePayload> {
  return readPackage('tests/fixtures/production/storyboard_handoff.json');
}

export function nativeData(payload: PackagePayload): NativeDataset {
  const file = payload.files.find((candidate): boolean => candidate.path === 'data.json');
  if (file === undefined) throw new Error('검증 자료 data.json이 없습니다.');
  return NativeDatasetSchema.parse(parseJson(file.content, file.path));
}

export function withNativeData(payload: PackagePayload, data: NativeDataset): PackagePayload {
  const content: string = JSON.stringify(data);
  return {
    handoff: { ...payload.handoff, projectId: data.projectId, files: payload.handoff.files.map((descriptor) => descriptor.role === 'native-data' ? { ...descriptor, sha256: sha256Text(content) } : descriptor) },
    files: payload.files.map((file) => file.path === 'data.json' ? { ...file, content } : file),
  };
}

export async function png(width: number, height: number): Promise<Buffer> {
  return sharp({ create: { width, height, channels: 4, background: '#204060' } }).png().toBuffer();
}

export function pcmWav(durationMs: number, sampleRate: number, channels: 1 | 2, bitsPerSample: 16 | 24): Buffer {
  const sampleFrames: number = Math.round(sampleRate * durationMs / 1000);
  const bytesPerSample: number = bitsPerSample / 8;
  const blockAlign: number = channels * bytesPerSample;
  const dataLength: number = sampleFrames * blockAlign;
  const bytes: Buffer = Buffer.alloc(44 + dataLength);
  bytes.write('RIFF', 0); bytes.writeUInt32LE(36 + dataLength, 4); bytes.write('WAVE', 8); bytes.write('fmt ', 12);
  bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(channels, 22); bytes.writeUInt32LE(sampleRate, 24);
  bytes.writeUInt32LE(sampleRate * blockAlign, 28); bytes.writeUInt16LE(blockAlign, 32); bytes.writeUInt16LE(bitsPerSample, 34);
  bytes.write('data', 36); bytes.writeUInt32LE(dataLength, 40);
  return bytes;
}

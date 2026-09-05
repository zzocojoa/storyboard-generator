import { NativeDatasetSchema } from '../src/domain/schema.js';
import type { NativeDataset, PackagePayload } from '../src/domain/schema.js';
import { parseJson, sha256Text } from '../src/importers/integrity.js';
import { readPackage } from '../src/io/package.js';

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

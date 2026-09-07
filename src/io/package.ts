import { readFile, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { contractError } from '../domain/errors.js';
import { HandoffSchema } from '../domain/schema.js';
import type { Handoff, PackageFile, PackagePayload } from '../domain/schema.js';
import { isSafePackagePath, parseJson } from '../importers/integrity.js';

export function isMissingFile(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

export async function readUtf8(path: string): Promise<string> {
  const bytes: Buffer = await readFile(path);
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch (error: unknown) {
    if (!(error instanceof TypeError)) throw error;
    throw contractError('INVALID_UTF8', `${path}: UTF-8 텍스트 파일이 필요합니다. ${error.message}`, []);
  }
}

export async function resolvePackageFile(root: string, path: string): Promise<string> {
  if (!isSafePackagePath(path)) throw contractError('UNSAFE_PACKAGE_PATH', `패키지 내부 상대경로가 필요합니다: ${path}`, []);
  const candidate: string = await realpath(resolve(root, path));
  const actualRelative: string = relative(root, candidate);
  if (actualRelative === '..' || actualRelative.startsWith('../') || isAbsolute(actualRelative)) {
    throw contractError('PACKAGE_SYMLINK_ESCAPE', `패키지 밖을 가리키는 링크입니다: ${path}`, []);
  }
  return candidate;
}

/** 명시된 handoff 파일만 읽고 선언한 패키지 경계와 원문 바이트를 보존한다. */
export async function readPackage(handoffPath: string): Promise<PackagePayload> {
  const absolutePath: string = await realpath(handoffPath);
  const root: string = dirname(absolutePath);
  const handoff: Handoff = HandoffSchema.parse(parseJson(await readUtf8(absolutePath), absolutePath));
  const groups: PackageFile[][] = await Promise.all(handoff.files.map(async (descriptor): Promise<PackageFile[]> => {
    let path: string;
    try {
      path = await resolvePackageFile(root, descriptor.path);
    } catch (error: unknown) {
      if (!isMissingFile(error)) throw error;
      if (descriptor.required) throw contractError('MISSING_PACKAGE_FILE', `필수 파일이 없습니다: ${descriptor.path}`, []);
      return [];
    }
    return [{ path: descriptor.path, content: await readUtf8(path) }];
  }));
  return { handoff, files: groups.flat() };
}

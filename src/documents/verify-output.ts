import { lstat, realpath } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import type { Stats } from 'node:fs';
import { contractError } from '../domain/errors.js';
import { importPackage } from '../importers/import-package.js';
import { isMissingFile } from '../io/package.js';
import { readDocumentSources } from './io.js';
import { buildDocumentPackage } from './package.js';
import { readDocumentText } from './read-file.js';

async function directoryIdentity(path: string): Promise<Stats> {
  const info: Stats = await lstat(path).catch((error: unknown): never => {
    if (!isMissingFile(error)) throw error;
    throw contractError('MISSING_DOCUMENT_OUTPUT', `${path}: 생성 결과 폴더가 없습니다. 저장 위치와 생성 결과를 확인하세요.`, []);
  });
  if (!info.isDirectory() || info.isSymbolicLink()) throw contractError('INVALID_DOCUMENT_OUTPUT', `${path}: symlink가 아닌 실제 패키지 폴더가 필요합니다.`, []);
  return info;
}

/** 응답을 놓친 생성 결과를 원본·설정·전체 출력 바이트와 대조한다. 파일을 만들거나 덮어쓰지 않는다. */
export async function verifyDocumentOutput(directory: string, settings: unknown, output: string): Promise<{ handoffPath: string; projectId: string }> {
  const payload = buildDocumentPackage(await readDocumentSources(directory), settings);
  const project = importPackage(payload);
  const requested: string = resolve(output);
  const parent: string = await realpath(dirname(requested)).catch((error: unknown): never => {
    if (!isMissingFile(error)) throw error;
    throw contractError('MISSING_DOCUMENT_OUTPUT', `${dirname(requested)}: 생성 결과의 상위 폴더가 없습니다. 저장 위치를 확인하세요.`, []);
  });
  const target: string = resolve(parent, basename(requested));
  const directories: string[] = [target, resolve(target, '09_PRODUCTION')];
  const identities: Stats[] = await Promise.all(directories.map(directoryIdentity));
  const files: { path: string; content: string }[] = [...payload.files, { path: 'storyboard_handoff.json', content: `${JSON.stringify(payload.handoff, null, 2)}\n` }];
  // 검토 중 파일 변경도 성공 결과로 취급하지 않도록 전체 내용을 재검사한다.
  for (let pass: number = 0; pass < 2; pass += 1) {
    for (const file of files) {
      const path: string = resolve(target, file.path);
      if (await readDocumentText(path, 4 * 1024 * 1024) !== file.content) {
        throw contractError('DOCUMENT_OUTPUT_MISMATCH', `${path}: 생성 요청의 원본·설정과 파일이 다릅니다. 기존 파일을 보존하고 내용을 확인하세요.`, []);
      }
    }
    for (const [index, path] of directories.entries()) {
      const next: Stats = await directoryIdentity(path); const before: Stats = identities[index]!;
      if (next.dev !== before.dev || next.ino !== before.ino || next.mtimeMs !== before.mtimeMs || next.ctimeMs !== before.ctimeMs) {
        throw contractError('DOCUMENT_OUTPUT_CHANGED', `${path}: 결과 확인 중 폴더가 변경되었습니다. 다시 확인하세요.`, []);
      }
    }
  }
  return { handoffPath: resolve(target, 'storyboard_handoff.json'), projectId: project.projectId };
}

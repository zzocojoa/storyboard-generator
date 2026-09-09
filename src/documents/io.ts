import { constants } from 'node:fs';
import { lstat, mkdir, open, realpath } from 'node:fs/promises';
import { basename, dirname, isAbsolute, relative, resolve } from 'node:path';
import { contractError } from '../domain/errors.js';
import type { PackagePayload, Snapshot } from '../domain/schema.js';
import { importPackage } from '../importers/import-package.js';
import { sha256Text } from '../importers/integrity.js';
import { writeNewText } from '../io/project.js';
import { isMissingFile } from '../io/package.js';
import { buildDocumentPackage, documentSources } from './package.js';
import { DOCUMENT_FILES } from './schema.js';
import type { DocumentSources } from './schema.js';

/** 사용자가 지정한 디렉터리의 고정된 8개 파일만 제한된 크기로 읽는다. */
export async function readDocumentSources(directory: string): Promise<DocumentSources> {
  let root: string;
  try { root = await realpath(directory); }
  catch (error: unknown) { if (!isMissingFile(error)) throw error; throw contractError('MISSING_DOCUMENT_DIRECTORY', `${directory}: 제작 문서 폴더를 찾을 수 없습니다.`, []); }
  const snapshots: Snapshot[] = await Promise.all(DOCUMENT_FILES.map(async (file): Promise<Snapshot> => {
    const path: string = resolve(root, file.name);
    const info = await lstat(path).catch((error: unknown) => { if (!isMissingFile(error)) throw error; throw contractError('MISSING_DOCUMENT_FILE', `${path}: 필수 제작 파일이 없습니다.`, []); });
    if (!info.isFile() || info.isSymbolicLink() || info.size > 4 * 1024 * 1024) throw contractError('INVALID_DOCUMENT_FILE', `${path}: 4MB 이하의 일반 UTF-8 파일이 필요합니다. symlink는 허용하지 않습니다.`, []);
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const before = await handle.stat();
      if (before.ino !== info.ino || before.dev !== info.dev || before.size !== info.size) throw contractError('INVALID_DOCUMENT_CHANGED', `${path}: 읽는 동안 파일이 변경되었습니다.`, []);
      const bytes: Buffer = Buffer.alloc(before.size + 1);
      let bytesRead: number = 0;
      while (bytesRead < bytes.length) {
        const chunk = await handle.read(bytes, bytesRead, bytes.length - bytesRead, bytesRead);
        if (chunk.bytesRead === 0) break;
        bytesRead += chunk.bytesRead;
      }
      const after = await handle.stat();
      if (bytesRead !== before.size || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) throw contractError('INVALID_DOCUMENT_CHANGED', `${path}: 읽는 동안 파일이 변경되었습니다.`, []);
      let content: string;
      try { content = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes.subarray(0, bytesRead)); }
      catch (error: unknown) { if (!(error instanceof TypeError)) throw error; throw contractError('INVALID_UTF8', `${path}: ${error.message}`, []); }
      return { id: `document-${file.key}`, role: file.role, path: `09_PRODUCTION/${file.name}`, required: true, hashMode: 'bytes-sha256', sha256: sha256Text(content), content };
    } finally { await handle.close(); }
  }));
  return documentSources(snapshots);
}

function isInside(root: string, target: string): boolean {
  const path: string = relative(root, target);
  return path === '' || (!isAbsolute(path) && path !== '..' && !path.startsWith('../'));
}

/** 모든 변환을 검증한 뒤 새 출력 폴더를 예약하고 handoff를 마지막에 게시한다. */
export async function writeDocumentPackage(directory: string, settings: unknown, output: string): Promise<{ handoffPath: string; projectId: string }> {
  const sourceRoot: string = await realpath(directory);
  const sources: DocumentSources = await readDocumentSources(sourceRoot);
  const payload: PackagePayload = buildDocumentPackage(sources, settings);
  const project = importPackage(payload);
  const requested: string = resolve(output);
  let parent: string;
  try { parent = await realpath(dirname(requested)); }
  catch (error: unknown) { if (!isMissingFile(error)) throw error; throw contractError('MISSING_DOCUMENT_OUTPUT_PARENT', `${dirname(requested)}: 출력 상위 폴더를 먼저 만드세요.`, []); }
  const target: string = resolve(parent, basename(requested));
  if (isInside(sourceRoot, target)) throw contractError('UNSAFE_DOCUMENT_OUTPUT', '출력은 원본 디렉터리 밖의 새 폴더로 지정하세요.', []);
  try { await mkdir(target); }
  catch (error: unknown) {
    if (!(error instanceof Error) || !('code' in error) || error.code !== 'EEXIST') throw error;
    throw contractError('DOCUMENT_OUTPUT_EXISTS', `${target}: 기존 출력은 덮어쓰지 않습니다. 새 폴더를 지정하세요.`, []);
  }
  await mkdir(resolve(target, '09_PRODUCTION'));
  for (const file of payload.files) await writeNewText(resolve(target, file.path), file.content);
  const handoffPath: string = resolve(target, 'storyboard_handoff.json');
  await writeNewText(handoffPath, `${JSON.stringify(payload.handoff, null, 2)}\n`);
  return { handoffPath, projectId: project.projectId };
}

import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { contractError } from '../domain/errors.js';
import { isMissingFile } from '../io/package.js';

/** 지정한 일반 파일만 크기·동일성·UTF-8을 검사해 읽는다. */
export async function readDocumentText(path: string, maxBytes: number): Promise<string> {
  const info = await lstat(path).catch((error: unknown) => { if (!isMissingFile(error)) throw error; throw contractError('MISSING_DOCUMENT_FILE', `${path}: 필수 제작 파일이 없습니다.`, []); });
  if (!info.isFile() || info.isSymbolicLink() || info.size > maxBytes) throw contractError('INVALID_DOCUMENT_FILE', `${path}: ${maxBytes} bytes 이하의 일반 UTF-8 파일이 필요합니다. symlink는 허용하지 않습니다.`, []);
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
    return content;
  } finally { await handle.close(); }
}

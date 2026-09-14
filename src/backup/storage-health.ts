import type { Dirent } from 'node:fs';
import { relative, sep } from 'node:path';
import { contractError } from '../domain/errors.js';
import type { Project } from '../domain/schema.js';
import { inspectReviewStorageHealth } from '../exporters/review-storage-health.js';
import type { ReviewStorageSnapshot } from '../exporters/review-storage-health.js';
import { SafeStoreFilesystem } from '../server/safe-filesystem.js';
import { BACKUP_JSON_MAX_BYTES, BACKUP_MAX_BYTES, BACKUP_MAX_FILES } from './schema.js';

/** 기존 저장 상태 판정을 재사용하되 감사 근거 읽기의 크기·개수도 제한한다. */
class BackupHealthFilesystem extends SafeStoreFilesystem {
  #readBytes: number = 0;
  #entries: number = 0;
  override async read(path: string): Promise<Buffer> {
    const limit: number = Math.min(BACKUP_JSON_MAX_BYTES, BACKUP_MAX_BYTES - this.#readBytes);
    if (limit <= 0) throw contractError('BACKUP_EVIDENCE_LIMIT', '백업 저장 근거의 전체 읽기 한도를 넘었습니다.', []);
    const bytes = await this.readBounded(path, limit); this.#readBytes += bytes.length; return bytes;
  }
  override async entries(path: string): Promise<Dirent[]> {
    if (relative(this.root(), path).split(sep).length > 16) throw contractError('BACKUP_EVIDENCE_LIMIT', '저장 근거 폴더 깊이가 백업 검사 한도를 넘었습니다.', []);
    const entries = await super.entries(path); this.#entries += entries.length;
    if (this.#entries > BACKUP_MAX_FILES * 2) throw contractError('BACKUP_EVIDENCE_LIMIT', '저장 근거 항목 수가 백업 검사 한도를 넘었습니다.', []);
    return entries;
  }
}

export async function inspectBackupStorageHealth(dataRoot: string, project: Project): Promise<ReviewStorageSnapshot> {
  const fs = new BackupHealthFilesystem(dataRoot); await fs.openExisting(); return inspectReviewStorageHealth(fs, project);
}

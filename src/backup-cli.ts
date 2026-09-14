import { dirname, basename, resolve } from 'node:path';
import { createProjectBackup, previewProjectBackup, restoreProjectBackup } from './backup/service.js';
import { readBackupSnapshot, readProjectBackup } from './backup/snapshot.js';
import { contractError } from './domain/errors.js';

/** 백업 복원은 새 dataRoot만 만들며 기존 앱 설정과 저장소를 교체하지 않는다. */
async function main(args: readonly string[]): Promise<void> {
  const [action, first, second, third] = args;
  if (action === 'create' && args.length === 4 && first !== undefined && second !== undefined && third !== undefined) {
    const output: string = resolve(third); const selection = { parentPath: dirname(output), folderName: basename(output) };
    const revision: number = (await readBackupSnapshot(first, second)).project.revision;
    const preview = await previewProjectBackup(first, second, revision, selection);
    const result = await createProjectBackup(first, second, revision, selection, preview.basisSha256);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`); return;
  }
  if (action === 'verify' && args.length === 2 && first !== undefined) {
    const backup = await readProjectBackup(first);
    process.stdout.write(`${JSON.stringify({ manifest: backup.manifest, manifestSha256: backup.manifestSha256, verified: 'file-bytes-and-history' }, null, 2)}\n`); return;
  }
  if (action === 'restore' && args.length === 4 && first !== undefined && second !== undefined && third !== undefined) {
    const output: string = resolve(second);
    const result = await restoreProjectBackup(first, { parentPath: dirname(output), folderName: basename(output) }, third);
    process.stdout.write(`${JSON.stringify({ ...result, dataRoot: result.outputPath, executionResumed: false }, null, 2)}\n`); return;
  }
  throw contractError('INVALID_BACKUP_COMMAND', '사용법: npm run project-backup -- create <dataRoot> <projectId> <새 백업 폴더> | verify <백업 폴더> | restore <백업 폴더> <새 dataRoot> <검증한 manifestSha256>', []);
}

await main(process.argv.slice(2));

import { execFile } from 'node:child_process';
import { symlink, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execute: typeof execFile.__promisify__ = promisify(execFile);
const launcher: string = fileURLToPath(new URL('./fixtures/node-process.sh', import.meta.url));

export function nodeFixtureSource(executable: string): string {
  return `${executable}.source.mjs`;
}

/** 새 shebang 파일의 OS 기동 지연을 Fixture 준비에서 분리하고 실제 RPC·합성의 제한 시간은 유지한다. */
export async function writeNodeFixture(executable: string, source: string): Promise<void> {
  await writeFile(nodeFixtureSource(executable), source, { flag: 'wx', mode: 0o600 });
  await symlink(process.execPath, `${executable}.runtime`);
  await symlink(launcher, executable);
  const result = await execute(executable, ['--cutroom-fixture-ready'], { timeout: 5000, maxBuffer: 1024, encoding: 'utf8' });
  if (result.stdout !== 'cutroom-fixture-ready\n' || result.stderr !== '') {
    throw new Error(`Node Fixture 기동 확인 실패: executable=${executable}, stdout=${result.stdout}, stderr=${result.stderr}`);
  }
}

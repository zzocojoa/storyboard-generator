import { link, mkdir, unlink, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { assertNoErrors, contractError } from '../domain/errors.js';
import { ProjectSchema } from '../domain/schema.js';
import type { Project } from '../domain/schema.js';
import { validateProject } from '../domain/validation.js';
import { recoverSourceProject } from '../importers/import-package.js';
import { isSafePackagePath, parseJson } from '../importers/integrity.js';
import { readUtf8 } from './package.js';

/** 저장된 원본 스냅샷에서 데이터를 다시 계산해 편집 가능한 값과 원문을 구분한다. */
export function parseProject(input: unknown): Project {
  const project: Project = ProjectSchema.parse(input);
  const source: Project = recoverSourceProject(project);
  if (JSON.stringify(project.sources) !== JSON.stringify(source.sources)) throw contractError('SOURCE_SNAPSHOT_MODIFIED', '입력 계약과 저장된 원본 스냅샷의 메타데이터가 다릅니다.', []);
  if (JSON.stringify(project.importIssues) !== JSON.stringify(source.importIssues)) throw contractError('IMPORT_ISSUES_MODIFIED', '원본 검토 항목을 덮어쓸 수 없습니다. 별도의 검토 결정으로 처리하세요.', []);
  for (const asset of project.assets) if (!isSafePackagePath(asset.path)) throw contractError('UNSAFE_ASSET_PATH', `${asset.id}: 프로젝트 내부 상대경로가 필요합니다: ${asset.path}`, []);
  assertNoErrors(validateProject(project, source.dataset), 'INVALID_PROJECT');
  return project;
}

export async function readProject(path: string): Promise<Project> {
  return parseProject(parseJson(await readUtf8(path), path));
}

/** 결과를 원자적으로 새 파일에 게시한다. 기존 파일은 덮어쓰지 않는다. */
export async function writeNewText(path: string, content: string): Promise<void> {
  const target: string = resolve(path);
  await mkdir(dirname(target), { recursive: true });
  const temporary: string = `${target}.${randomUUID()}.tmp`;
  await writeFile(temporary, content, { encoding: 'utf8', flag: 'wx' });
  try {
    await link(temporary, target);
  } finally {
    await unlink(temporary);
  }
}

import { legacyTextProject } from './legacy-text-helpers.js';
import { describe, expect, it } from 'vitest';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Project } from '../src/domain/schema.js';
import { importPackage } from '../src/importers/import-package.js';
import { sha256Text } from '../src/importers/integrity.js';
import { parseProject } from '../src/io/project.js';
import { createSourceOutline } from '../src/proposal/outline.js';
import { ProjectStore } from '../src/server/store.js';
import { nativePackage } from './helpers.js';

describe('프로젝트 형식 마이그레이션', (): void => {
  it('1.0 저장본의 컷을 명시적 CUT 전환이 있는 1.1 형식으로 읽는다', async (): Promise<void> => {
    const project: Project = createSourceOutline(importPackage(await nativePackage()), { proposedTextHoldMs: 2000 });
    const legacy = JSON.parse(JSON.stringify(legacyTextProject(project))) as { schemaVersion: string; shots: { [key: string]: unknown }[]; textMappingDecisions?: unknown };
    legacy.schemaVersion = '1.0.0';
    delete legacy.textMappingDecisions;
    for (const shot of legacy.shots) {
      const links = shot.sourceLinks as { unitId: string }[];
      shot.sourceUnitIds = links.map((link): string => link.unitId);
      delete shot.sourceLinks;
      delete shot.transitionOut;
    }
    const migrated: Project = parseProject(legacy);
    expect(migrated.schemaVersion).toBe('1.23.0');
    expect(migrated.shots.every((shot): boolean => shot.transitionOut.kind === 'cut' && shot.transitionOut.durationMs === 0)).toBe(true);
    expect(migrated.shots.every((shot): boolean => shot.sourceLinks.every((link): boolean => link.status === 'mapping-required'))).toBe(true);
  });
});

it('storage_migrated_update_uses_original_bytes_for_rollback_and_keeps_historical_version', async (): Promise<void> => {
  const root = await mkdtemp(join(tmpdir(), 'cutroom-migration-update-'));
  const initial = new ProjectStore(root);
  const interrupted = new ProjectStore(root, { ownerPid: process.pid, trigger(point): void {
    if (point === 'after-update-version-linked') throw new Error('이관 저장의 게시 직전 실패');
  } });
  const reopened = new ProjectStore(root);
  try {
    const project = createSourceOutline(importPackage(await nativePackage()), { proposedTextHoldMs: 2000 });
    await initial.create(project); await initial.close();
    const directory = join(root, sha256Text(project.projectId));
    const original: string = `${JSON.stringify({ ...legacyTextProject(project), schemaVersion: '1.11.0' }, null, '\t')}\r\n`;
    await writeFile(join(directory, 'project.json'), original);
    await writeFile(join(directory, 'versions', '000000.json'), original);
    expect((await interrupted.read(project.projectId)).schemaVersion).toBe('1.23.0');
    await expect(interrupted.update(project.projectId, 0, (current) => ({ ...current, title: '게시하지 못한 편집' }), [])).rejects.toThrow('게시 직전 실패');
    expect(await readFile(join(directory, 'project.json'), 'utf8')).toBe(original);
    expect(await readdir(join(directory, 'versions'))).toEqual(['000000.json']);
    await interrupted.close();
    const saved = await reopened.update(project.projectId, 0, (current) => ({ ...current, title: '성공한 편집' }), []);
    expect(saved).toMatchObject({ schemaVersion: '1.23.0', revision: 1, title: '성공한 편집' });
    expect(await readFile(join(directory, 'versions', '000000.json'), 'utf8')).toBe(original);
    expect((await reopened.generationHistorySnapshot(project.projectId)).versions).toHaveLength(2);
  } finally { await initial.close(); await interrupted.close(); await reopened.close(); await rm(root, { recursive: true, force: true }); }
});

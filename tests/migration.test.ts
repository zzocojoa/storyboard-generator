import { describe, expect, it } from 'vitest';
import type { Project } from '../src/domain/schema.js';
import { importPackage } from '../src/importers/import-package.js';
import { parseProject } from '../src/io/project.js';
import { createSourceOutline } from '../src/proposal/outline.js';
import { nativePackage } from './helpers.js';

describe('프로젝트 형식 마이그레이션', (): void => {
  it('1.0 저장본의 컷을 명시적 CUT 전환이 있는 1.1 형식으로 읽는다', async (): Promise<void> => {
    const project: Project = createSourceOutline(importPackage(await nativePackage()), { proposedTextHoldMs: 2000 });
    const legacy = JSON.parse(JSON.stringify(project)) as { schemaVersion: string; shots: { [key: string]: unknown }[]; textMappingDecisions?: unknown };
    legacy.schemaVersion = '1.0.0';
    delete legacy.textMappingDecisions;
    for (const shot of legacy.shots) {
      const links = shot.sourceLinks as { unitId: string }[];
      shot.sourceUnitIds = links.map((link): string => link.unitId);
      delete shot.sourceLinks;
      delete shot.transitionOut;
    }
    const migrated: Project = parseProject(legacy);
    expect(migrated.schemaVersion).toBe('1.2.0');
    expect(migrated.shots.every((shot): boolean => shot.transitionOut.kind === 'cut' && shot.transitionOut.durationMs === 0)).toBe(true);
    expect(migrated.shots.every((shot): boolean => shot.sourceLinks.every((link): boolean => link.status === 'mapping-required'))).toBe(true);
  });
});

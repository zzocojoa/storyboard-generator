import { mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { csvCell, exportShotCsv } from '../src/exporters/csv.js';
import { exportProjectJson } from '../src/exporters/json.js';
import { importPackage } from '../src/importers/import-package.js';
import { sha256Text } from '../src/importers/integrity.js';
import { readPackage } from '../src/io/package.js';
import { readProject, writeNewText } from '../src/io/project.js';
import { createSourceOutline } from '../src/proposal/outline.js';
import type { NativeDataset } from '../src/domain/schema.js';
import { nativeData, nativePackage, withNativeData } from './helpers.js';

describe('저장과 출력 경계', (): void => {
  it('JSON 재열기가 원문·컷·시간·검토 상태를 보존하고 기존 파일을 덮어쓰지 않는다', async (): Promise<void> => {
    const payload = await nativePackage();
    const data: NativeDataset = nativeData(payload);
    const gateData: NativeDataset = {
      ...data,
      units: data.units.map((unit) => unit.id === '동작' ? { ...unit, informationIds: ['info:watering'] } : unit),
      informationRules: [{
        id: 'info:watering', segmentId: 'demonstration', notBeforeMs: 5000,
        notBeforeUnitId: '동작', notBeforeUnitOrder: 2, precision: 'exact-time',
      }],
    };
    const project = createSourceOutline(importPackage(withNativeData(payload, gateData)), { proposedTextHoldMs: 3000 });
    const directory: string = await mkdtemp(join(tmpdir(), 'storyboard-json-'));
    const path: string = join(directory, 'project.json');
    await writeNewText(path, exportProjectJson(project));
    expect(await readProject(path)).toEqual(project);
    await expect(writeNewText(path, '덮어쓰기')).rejects.toMatchObject({ code: 'EEXIST' });
    expect(await readProject(path)).toEqual(project);
    const csv: string = exportShotCsv(project);
    expect(csv.startsWith('\uFEFF"project_id"')).toBe(true);
    expect(csv).toContain('흙부터 확인하세요');
    expect(csv).toContain('"17500"');
    expect(csv).toContain('proposed');
    expect(csv).toContain('"source_links"');
    expect(csv).toContain('"source_temporal_anchors"');
    expect(csv).toContain('"information_gates"');
    expect(csv).toContain('baseNotBeforeMs');
    expect(csv).toContain('effectiveNotBeforeMs');
    expect(csv).toContain('temporalAnchor');
    expect(csv).toContain('primary-visual');
    expect(csv).toContain('confirmed');
    expect(csvCell('=2+2')).toBe('"\'=2+2"');
    expect(csvCell('쉼표, "따옴표"\n두 줄')).toBe('"쉼표, ""따옴표""\n두 줄"');
  });

  it('경로 탈출·선언 외 파일·외부 심볼릭 링크와 잘못된 UTF-8을 거부한다', async (): Promise<void> => {
    const payload = await nativePackage();
    expect(() => importPackage({ ...payload, handoff: { ...payload.handoff, files: payload.handoff.files.map((file) => ({ ...file, path: '../data.json' })) } })).toThrowError(expect.objectContaining({ code: 'UNSAFE_PACKAGE_PATH' }));
    expect(() => importPackage({ ...payload, files: [...payload.files, { path: 'extra.md', content: '추가' }] })).toThrowError(expect.objectContaining({ code: 'UNDECLARED_PACKAGE_FILE' }));
    const directory: string = await mkdtemp(join(tmpdir(), 'storyboard-boundary-'));
    const outside: string = join(directory, 'outside.json');
    await writeFile(outside, '{}');
    const nested: string = join(directory, 'inside');
    await writeNewText(join(nested, 'storyboard_handoff.json'), JSON.stringify(payload.handoff));
    await symlink(outside, join(nested, 'data.json'));
    await expect(readPackage(join(nested, 'storyboard_handoff.json'))).rejects.toMatchObject({ code: 'PACKAGE_SYMLINK_ESCAPE' });
    const malformed: string = join(directory, 'invalid');
    await writeNewText(join(malformed, 'storyboard_handoff.json'), JSON.stringify(payload.handoff));
    await writeFile(join(malformed, 'data.json'), Buffer.from([0xff, 0xfe]));
    await expect(readPackage(join(malformed, 'storyboard_handoff.json'))).rejects.toMatchObject({ code: 'INVALID_UTF8' });
    expect(sha256Text(await readFile(outside, 'utf8'))).toBe(sha256Text('{}'));
  });
});

import { describe, expect, it } from 'vitest';
import { importPackage } from '../src/importers/import-package.js';
import { parseJson, requireSnapshot, sha256SortedJson } from '../src/importers/integrity.js';
import { ReactionsSchema, ScreenplaySchema } from '../src/importers/production-schema.js';
import { nativeData, nativePackage, productionPackage, withNativeData } from './helpers.js';

describe('production 입력의 원문과 시간 보존', (): void => {
  it('구조화 원문과 중복된 읽기용 문서를 함께 읽어도 발화를 복제하지 않는다', async (): Promise<void> => {
    const project = importPackage(await productionPackage());
    const screenplay = requireSnapshot(project.sources, 'screenplay');
    const reactions = requireSnapshot(project.sources, 'reactions');
    const sourceUnits = ScreenplaySchema.parse(parseJson(screenplay.content, screenplay.path)).scenes.flatMap((scene) => scene.units);
    const turns = ReactionsSchema.parse(parseJson(reactions.content, reactions.path)).reaction_segments.flatMap((reaction) => reaction.turns);
    expect(project.dataset.scenes).toHaveLength(12);
    expect(project.dataset.segments).toHaveLength(32);
    expect(sourceUnits).toHaveLength(79);
    expect(turns).toHaveLength(16);
    expect(project.dataset.units).toHaveLength(95);
    for (const unit of sourceUnits) expect(project.dataset.units.find((candidate): boolean => candidate.id === unit.unit_id)?.text).toBe(unit.text);
    for (const turn of turns) expect(project.dataset.units.find((candidate): boolean => candidate.id === turn.turn_id)?.text).toBe(turn.spoken_line);
    expect(project.dataset.segments.at(-1)?.endMs).toBe(1500000);
    expect(project.dataset.textPlacements).toHaveLength(25);
    expect(project.importIssues.filter((issue): boolean => issue.severity === 'error')).toEqual([]);
  });

  it('자막 축약과 장면 밖 음성 출연을 원문 변경 없이 검토 항목으로 남긴다', async (): Promise<void> => {
    const project = importPackage(await productionPackage());
    const original = project.dataset.units.find((unit): boolean => unit.id === 'UNIT-061');
    expect(original?.text).toContain('작성 계정 두 개');
    expect(project.importIssues.some((issue): boolean => issue.code === 'SCREEN_TEXT_MAPPING_REVIEW' && issue.actual === '복구 문서 — 동일 원문 / 사진 설명 사후 추가 / 삭제 시도 기록')).toBe(true);
    expect(project.importIssues.some((issue): boolean => issue.code === 'CAST_SCOPE_REVIEW' && issue.entityId === 'UNIT-051')).toBe(true);
    expect(project.dataset.scenes.find((scene): boolean => scene.id === 'SCN-08')?.declaredCastIds).toEqual(['CHAR-02', 'CHAR-03', 'CHAR-04', 'CHAR-05']);
    const footprint = requireSnapshot(project.sources, 'footprint');
    expect(sha256SortedJson(footprint.content, footprint.path)).toBe('15930878fa6b81bf9f040a783237007d583ce3a7a0908dbda25896bd0eca225f');
  });
});

describe('범용 입력과 계약 오류', (): void => {
  it('다른 분량·모드와 선택 요소의 부재를 처리하고 같은 ID의 작품을 분리한다', async (): Promise<void> => {
    const short = importPackage(await nativePackage());
    const production = importPackage(await productionPackage());
    expect(short.dataset.segments.map((segment): string => segment.mode)).toEqual(['TITLE_CARD', 'DEMONSTRATION', 'TITLE_CARD']);
    expect(short.dataset.segments.at(-1)?.endMs).toBe(17500);
    expect(short.dataset.informationRules).toEqual([]);
    expect(short.importIssues).toEqual([]);
    expect(short.dataset.people[0]?.id).toBe(production.dataset.people[0]?.id);
    expect(short.dataset.people[0]?.name).not.toBe(production.dataset.people[0]?.name);
    expect(short.dataset.units[0]?.text).not.toBe(production.dataset.units[0]?.text);
  });

  it('존재하지 않는 참조·시간 공백·프로젝트 내부 중복 ID를 거부한다', async (): Promise<void> => {
    const payload = await nativePackage();
    const data = nativeData(payload);
    expect(() => importPackage(withNativeData(payload, { ...data, units: data.units.map((unit) => ({ ...unit, segmentId: '없음' })) }))).toThrowError(expect.objectContaining({ code: 'INVALID_SOURCE_DATASET' }));
    expect(() => importPackage(withNativeData(payload, { ...data, segments: data.segments.map((segment, index) => index === 1 ? { ...segment, startMs: 5100 } : segment) }))).toThrowError(expect.objectContaining({ code: 'INVALID_SOURCE_DATASET' }));
    expect(() => importPackage(withNativeData(payload, { ...data, units: [...data.units, ...data.units] }))).toThrowError(expect.objectContaining({ code: 'INVALID_SOURCE_DATASET' }));
  });

  it('원문 파일 손상·필수 파일 누락·필드 권한 불일치를 거부한다', async (): Promise<void> => {
    const payload = await nativePackage();
    expect(() => importPackage({ ...payload, files: payload.files.map((file) => ({ ...file, content: file.content + ' ' })) })).toThrowError(expect.objectContaining({ code: 'FILE_HASH_MISMATCH' }));
    expect(() => importPackage({ ...payload, files: [] })).toThrowError(expect.objectContaining({ code: 'MISSING_PACKAGE_FILE' }));
    expect(() => importPackage({ ...payload, handoff: { ...payload.handoff, authority: payload.handoff.authority.filter((entry): boolean => entry.field !== 'units') } })).toThrowError(expect.objectContaining({ code: 'MISSING_AUTHORITY' }));
    expect(() => importPackage({ ...payload, handoff: { ...payload.handoff, contractVersion: '99.0.0' } })).toThrow();
  });

  it('정상적인 선택 참조 파일 부재와 작성자가 없는 메모를 허용한다', async (): Promise<void> => {
    const payload = await nativePackage();
    const data = nativeData(payload);
    const note = { id: 'anonymous-note', segmentId: 'SEG-001', order: 3, kind: 'NOTE' as const, text: '흙을 확인', speakerId: null, informationIds: [] };
    const updated = withNativeData(payload, { ...data, units: [...data.units, note] });
    const project = importPackage({ ...updated, handoff: { ...updated.handoff, files: [...updated.handoff.files, { id: 'optional-ref', role: 'reference', path: 'optional.md', required: false, hashMode: 'bytes-sha256', sha256: '0'.repeat(64) }] } });
    expect(project.dataset.units.at(-1)?.speakerId).toBeNull();
    expect(project.importIssues).toEqual([]);
  });
});

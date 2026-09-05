import { describe, expect, it } from 'vitest';
import { importPackage } from '../src/importers/import-package.js';
import { sha256SortedJson, sha256Text } from '../src/importers/integrity.js';
import { productionPackage } from './helpers.js';

describe('해시 규약과 상위 산출물 연결', (): void => {
  it('유니코드 키를 코드 포인트 순서로 정렬하고 지원하지 않는 수치를 조용히 변환하지 않는다', (): void => {
    expect(sha256SortedJson('{"😀":2,"\uE000":1}', 'unicode.json')).toBe(sha256Text('{"\uE000":1,"😀":2}'));
    expect(sha256SortedJson('{ "b": 2, "a": 1 }', 'integer.json')).toBe(sha256Text('{"a":1,"b":2}'));
    for (const content of ['{"value":1.0}', '{"value":1e3}', '{"value":9007199254740993}', '{"value":"\\uD800"}']) {
      expect(() => sha256SortedJson(content, 'unsupported.json')).toThrowError(expect.objectContaining({ code: 'UNSUPPORTED_CANONICAL_JSON' }));
    }
  });

  it('handoff의 파일 해시만 다시 맞춰도 manifest 내부 연결 오류는 숨길 수 없다', async (): Promise<void> => {
    const payload = await productionPackage();
    const path: string = '09_PRODUCTION/production_manifest.json';
    const source = payload.files.find((file): boolean => file.path === path);
    if (source === undefined) throw new Error('manifest 검증 자료가 없습니다.');
    const content: string = source.content.replace('15930878fa6b81bf9f040a783237007d583ce3a7a0908dbda25896bd0eca225f', '0'.repeat(64));
    const modified = { ...payload, handoff: { ...payload.handoff, files: payload.handoff.files.map((file) => file.path === path ? { ...file, sha256: sha256Text(content) } : file) }, files: payload.files.map((file) => file.path === path ? { ...file, content } : file) };
    expect(() => importPackage(modified)).toThrowError(expect.objectContaining({ code: 'UPSTREAM_HASH_MISMATCH' }));
  });
});

import { createHash } from 'node:crypto';
import { z } from 'zod';
import { contractError } from '../domain/errors.js';
import { PackagePayloadSchema } from '../domain/schema.js';
import type { FileDescriptor, FileRole, Handoff, PackagePayload, Snapshot } from '../domain/schema.js';

type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

export function parseJson(content: string, context: string): unknown {
  try {
    const parsed: unknown = JSON.parse(content);
    return parsed;
  } catch (error: unknown) {
    if (!(error instanceof SyntaxError)) throw error;
    throw contractError('INVALID_JSON', `${context}: JSON 문법 오류: ${error.message}`, []);
  }
}

function compareUnicode(left: string, right: string): number {
  const leftPoints: number[] = [...left].map((value: string): number => value.codePointAt(0) as number);
  const rightPoints: number[] = [...right].map((value: string): number => value.codePointAt(0) as number);
  const index: number = leftPoints.findIndex((value: number, offset: number): boolean => value !== rightPoints[offset]);
  return index < 0 ? leftPoints.length - rightPoints.length : (leftPoints[index] as number) - (rightPoints[index] ?? -1);
}

function serializeSorted(value: JsonValue): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(serializeSorted).join(',')}]`;
  return `{${Object.keys(value).sort(compareUnicode).map((key: string): string => `${JSON.stringify(key)}:${serializeSorted(value[key] as JsonValue)}`).join(',')}}`;
}

export function sha256Text(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

export function sha256Bytes(content: Uint8Array): string {
  return createHash('sha256').update(content).digest('hex');
}

export function sha256SortedJson(content: string, context: string): string {
  const parsed: unknown = parseJson(content, context);
  for (const match of content.matchAll(/"(?:[^"\\]|\\.)*"|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/gu)) {
    const token: string = match[0];
    if (token.startsWith('"')) {
      const decoded: unknown = JSON.parse(token);
      if (typeof decoded === 'string' && /\p{Surrogate}/u.test(decoded)) throw contractError('UNSUPPORTED_CANONICAL_JSON', `${context}: 정규 JSON 해시는 짝이 맞는 유니코드 문자열만 지원합니다.`, []);
    } else if (!/^-?\d+$/u.test(token) || !Number.isSafeInteger(Number(token))) {
      throw contractError('UNSUPPORTED_CANONICAL_JSON', `${context}: 정규 JSON 해시는 안전한 정수 표기만 지원합니다. 소수·지수 값이 필요한 입력은 bytes-sha256을 지정하세요.`, []);
    }
  }
  const value: JsonValue = z.json().parse(parsed);
  return sha256Text(serializeSorted(value));
}

export function isSafePackagePath(path: string): boolean {
  return path.length > 0 && !path.startsWith('/') && !path.includes('\\') && !/^[a-z]:/iu.test(path)
    && path.split('/').every((part: string): boolean => part !== '' && part !== '.' && part !== '..') && !/[\u0000-\u001f]/u.test(path);
}

export function hashFile(content: string, descriptor: FileDescriptor): string {
  return descriptor.hashMode === 'bytes-sha256' ? sha256Text(content) : sha256SortedJson(content, descriptor.path);
}

export function requireSnapshot(snapshots: readonly Snapshot[], role: FileRole): Snapshot {
  const matches: Snapshot[] = snapshots.filter((snapshot: Snapshot): boolean => snapshot.role === role);
  if (matches.length !== 1) throw contractError('SOURCE_ROLE_REQUIRED', `${role}: 정확히 하나의 권한 파일이 필요합니다. 현재 ${matches.length}개입니다.`, []);
  const result: Snapshot | undefined = matches[0];
  if (result === undefined) throw contractError('SOURCE_ROLE_REQUIRED', `${role}: 원본이 없습니다.`, []);
  return result;
}

export function optionalSnapshot(snapshots: readonly Snapshot[], role: FileRole): Snapshot | null {
  const matches: Snapshot[] = snapshots.filter((snapshot: Snapshot): boolean => snapshot.role === role);
  if (matches.length > 1) throw contractError('DUPLICATE_SOURCE_ROLE', `${role}: 중복 원본을 선택할 수 없습니다.`, []);
  return matches[0] ?? null;
}

function validateAuthority(handoff: Handoff, snapshots: readonly Snapshot[]): void {
  const fields: string[] = handoff.authority.map((entry): string => entry.field);
  if (new Set(fields).size !== fields.length) throw contractError('DUPLICATE_AUTHORITY', '필드별 권한은 한 번만 정의해야 합니다.', []);
  const required: string[] = ['timeline', 'units', 'people', 'scenes', 'screen-text'];
  for (const field of required) if (!fields.includes(field)) throw contractError('MISSING_AUTHORITY', `${field}: 권한 원본 정의가 필요합니다.`, []);
  for (const entry of handoff.authority) {
    if (new Set(entry.fileIds).size !== entry.fileIds.length) throw contractError('DUPLICATE_AUTHORITY_SOURCE', `${entry.field}: 중복 파일 ID입니다.`, []);
    for (const fileId of entry.fileIds) {
      const file: Snapshot | undefined = snapshots.find((snapshot: Snapshot): boolean => snapshot.id === fileId);
      if (file === undefined) throw contractError('UNKNOWN_AUTHORITY_SOURCE', `${entry.field}: ${fileId} 원본을 찾을 수 없습니다.`, []);
    }
  }
}

export function validatePackage(input: unknown): { payload: PackagePayload; snapshots: Snapshot[] } {
  const payload: PackagePayload = PackagePayloadSchema.parse(input);
  const descriptors: FileDescriptor[] = payload.handoff.files;
  for (const values of [descriptors.map((file): string => file.id), descriptors.map((file): string => file.path), payload.files.map((file): string => file.path)]) {
    if (new Set(values).size !== values.length) throw contractError('DUPLICATE_PACKAGE_FILE', '파일 ID와 경로는 패키지 안에서 고유해야 합니다.', []);
  }
  for (const file of [...descriptors, ...payload.files]) {
    if (!isSafePackagePath(file.path)) throw contractError('UNSAFE_PACKAGE_PATH', `패키지 내부 상대경로가 필요합니다: ${file.path}`, []);
  }
  for (const file of payload.files) {
    if (!descriptors.some((descriptor): boolean => descriptor.path === file.path)) throw contractError('UNDECLARED_PACKAGE_FILE', `handoff에 선언되지 않은 파일입니다: ${file.path}`, []);
  }
  const snapshots: Snapshot[] = descriptors.flatMap((descriptor: FileDescriptor): Snapshot[] => {
    const file = payload.files.find((candidate): boolean => candidate.path === descriptor.path);
    if (file === undefined) {
      if (descriptor.required) throw contractError('MISSING_PACKAGE_FILE', `필수 파일이 없습니다: ${descriptor.path}`, []);
      return [];
    }
    const actual: string = hashFile(file.content, descriptor);
    if (actual !== descriptor.sha256) throw contractError('FILE_HASH_MISMATCH', `${descriptor.path}: expected=${descriptor.sha256}, actual=${actual}`, []);
    return [{ ...descriptor, content: file.content }];
  });
  validateAuthority(payload.handoff, snapshots);
  return { payload, snapshots };
}

export function assertAuthorityRole(handoff: Handoff, snapshots: readonly Snapshot[], field: Handoff['authority'][number]['field'], roles: readonly FileRole[]): void {
  const authority = handoff.authority.find((entry): boolean => entry.field === field);
  const expected: string[] = roles.map((role: FileRole): string => requireSnapshot(snapshots, role).id).sort();
  const actual: string[] = authority === undefined ? [] : [...authority.fileIds].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw contractError('SOURCE_AUTHORITY_CONFLICT', `${field}: 이 어댑터의 권한 파일 ${expected.join(', ')}와 선언 ${actual.join(', ')}이 다릅니다.`, []);
}

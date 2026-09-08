import { contractError } from '../domain/errors.js';

type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

/** 배열의 의미 순서를 보존하고 객체 키만 플랫폼 독립 순서로 정렬한다. */
function canonicalJson(value: unknown): JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map((entry: unknown): JsonValue => canonicalJson(entry));
  if (typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    const entries: [string, unknown][] = Object.entries(value).sort(([left], [right]): number => left < right ? -1 : left > right ? 1 : 0);
    return Object.fromEntries(entries.map(([key, entry]): [string, JsonValue] => [key, canonicalJson(entry)]));
  }
  throw contractError('INVALID_STABLE_JSON_VALUE', '유한한 JSON 값만 정규 직렬화할 수 있습니다.', []);
}

export function stableJsonStringify(value: unknown): string {
  return `${JSON.stringify(canonicalJson(value), null, 2)}\n`;
}

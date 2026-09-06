import type { Issue, SourceRef } from './schema.js';

export type ContractError = Error & { code: string; issues: readonly Issue[] };

export function contractError(code: string, message: string, issues: readonly Issue[]): ContractError {
  return Object.assign(new Error(message), { name: code, code, issues });
}

export function issue(
  code: string, severity: Issue['severity'], entityId: string, field: string, message: string,
  expected: string | null, actual: string | null, sourceRefs: readonly SourceRef[],
): Issue {
  return { code, severity, entityId, field, message, expected, actual, sourceRefs: [...sourceRefs] };
}

export function assertNoErrors(issues: readonly Issue[], code: string): void {
  const errors: Issue[] = issues.filter((item: Issue): boolean => item.severity === 'error');
  if (errors.length > 0) throw contractError(code, errors.map((item: Issue): string => `${item.entityId}.${item.field}: ${item.message}`).join('\n'), errors);
}

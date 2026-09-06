import { contractError, issue } from './errors.js';
import type { GenerationRecord, Issue, Project } from './schema.js';

export type GenerationRecordTransition = {
  preserved: readonly GenerationRecord[];
  added: readonly GenerationRecord[];
};

export type GenerationRecordAuditEntry = {
  recordId: string;
  introducedRevision: number | null;
  validAtIntroduction: boolean;
  currentTargetState: 'current' | 'historical' | 'unresolved';
  shotIds: string[];
  resultAssetIds: string[];
  issues: Issue[];
};

function recordsEqual(left: GenerationRecord, right: GenerationRecord): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function duplicateValues(values: readonly string[]): string[] {
  const seen: Set<string> = new Set<string>();
  const duplicates: Set<string> = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) duplicates.add(value);
    seen.add(value);
  }
  return [...duplicates];
}

function duplicateArrayIssues(record: GenerationRecord, severity: Issue['severity']): Issue[] {
  const definitions: readonly { values: readonly string[]; code: string; field: string; label: string }[] = [
    { values: record.shotIds, code: 'DUPLICATE_GENERATION_RECORD_SHOT_ID', field: 'shotIds', label: 'Shot ID' },
    { values: record.resultAssetIds, code: 'DUPLICATE_GENERATION_RECORD_ASSET_ID', field: 'resultAssetIds', label: 'Result Asset ID' },
    { values: record.referenceHashes, code: 'DUPLICATE_GENERATION_REFERENCE_HASH', field: 'referenceHashes', label: 'Reference Hash' },
  ];
  return definitions.flatMap((definition): Issue[] => duplicateValues(definition.values).map((value: string): Issue => issue(
    definition.code, severity, record.id, definition.field,
    `Generation Record 내부의 ${definition.label}는 중복될 수 없습니다. recordId=${record.id}, value=${value}`,
    'unique values', value, [],
  )));
}

function duplicateRequestIssues(records: readonly GenerationRecord[], severity: Issue['severity']): Issue[] {
  const seen: Map<string, string> = new Map<string, string>();
  const issues: Issue[] = [];
  for (const record of records) {
    if (record.requestId === null) continue;
    const existingRecordId: string | undefined = seen.get(record.requestId);
    if (existingRecordId !== undefined) {
      issues.push(issue('DUPLICATE_GENERATION_REQUEST_ID', severity, record.id, 'requestId',
        `동일한 non-null Generation Request ID를 여러 Record에 사용할 수 없습니다. requestId=${record.requestId}, firstRecordId=${existingRecordId}`,
        'unique non-null requestId', record.requestId, []));
    } else {
      seen.set(record.requestId, record.id);
    }
  }
  return issues;
}

/** 단일 Project에서 생성 기록의 내부 정규성만 검사하며 과거 Shot의 현재 존재 여부는 검사하지 않는다. */
export function generationRecordStructuralIssues(project: Project): Issue[] {
  const seenIds: Set<string> = new Set<string>();
  const issues: Issue[] = [];
  for (const record of project.generationRecords) {
    if (seenIds.has(record.id)) {
      issues.push(issue('DUPLICATE_GENERATION_RECORD_ID', 'error', record.id, 'generationRecords',
        'Generation Record ID는 프로젝트 안에서 유일해야 합니다.', 'unique record ID', record.id, []));
    }
    seenIds.add(record.id);
    issues.push(...duplicateArrayIssues(record, 'warning'));
  }
  issues.push(...duplicateRequestIssues(project.generationRecords, 'warning'));
  return issues;
}

/** 기존 호출자와 저장본 검증을 위한 이름이다. 현재 Shot 외래 키 검사는 포함하지 않는다. */
export function generationRecordIssues(project: Project): Issue[] {
  return generationRecordStructuralIssues(project);
}

function addedGenerationRecordIssues(current: Project, next: Project, added: readonly GenerationRecord[]): Issue[] {
  const shotIds: ReadonlySet<string> = new Set<string>(next.shots.map((shot): string => shot.id));
  const assetIds: ReadonlySet<string> = new Set<string>(next.assets.map((asset): string => asset.id));
  const issues: Issue[] = [];
  for (const record of added) {
    issues.push(...duplicateArrayIssues(record, 'error'));
    for (const [index, shotId] of record.shotIds.entries()) {
      if (!shotIds.has(shotId)) issues.push(issue('GENERATION_RECORD_SHOT_NOT_FOUND', 'error', record.id, `shotIds.${index}`,
        `새 Generation Record가 현재 Revision에 없는 Shot을 참조합니다. recordId=${record.id}, shotId=${shotId}`,
        'shot in next revision', shotId, []));
    }
    for (const [index, assetId] of record.resultAssetIds.entries()) {
      if (!assetIds.has(assetId)) issues.push(issue('ASSET_REFERENCE_NOT_FOUND', 'error', record.id, `resultAssetIds.${index}`,
        `새 Generation Record가 Next Asset Catalog에 없는 Asset을 참조합니다. recordId=${record.id}, assetId=${assetId}`,
        'asset in next revision', assetId, []));
    }
  }
  const seenRequestIds: Set<string> = new Set<string>(current.generationRecords.flatMap((record: GenerationRecord): string[] =>
    record.requestId === null ? [] : [record.requestId]));
  for (const record of added) {
    if (record.requestId === null) continue;
    if (seenRequestIds.has(record.requestId)) {
      issues.push(issue('DUPLICATE_GENERATION_REQUEST_ID', 'error', record.id, 'requestId',
        `신규 Generation Record의 non-null Request ID는 고유해야 합니다. requestId=${record.requestId}`,
        'unique non-null requestId', record.requestId, []));
    }
    seenRequestIds.add(record.requestId);
  }
  return issues;
}

function throwFirstError(issues: readonly Issue[]): void {
  const first: Issue | undefined = issues.find((value: Issue): boolean => value.severity === 'error');
  if (first !== undefined) throw contractError(first.code, first.message, issues);
}

/** Revision 변경에서 기존 생성 기록을 그대로 보존하고 새 기록만 현재 Shot·Asset과 정규성을 검사한다. */
export function assertGenerationRecordTransition(current: Project, next: Project): GenerationRecordTransition {
  if (next.generationRecords.length < current.generationRecords.length) {
    throw contractError('GENERATION_RECORD_REMOVAL_FORBIDDEN',
      `기존 Generation Record를 삭제할 수 없습니다. current=${current.generationRecords.length}, next=${next.generationRecords.length}`, []);
  }
  const nextIndexes: ReadonlyMap<string, number> = new Map<string, number>(
    next.generationRecords.map((record: GenerationRecord, index: number): [string, number] => [record.id, index]),
  );
  for (const [index, currentRecord] of current.generationRecords.entries()) {
    const nextRecord: GenerationRecord | undefined = next.generationRecords[index];
    if (nextRecord?.id !== currentRecord.id) {
      if (nextIndexes.has(currentRecord.id)) {
        throw contractError('GENERATION_RECORD_ORDER_IMMUTABLE',
          `기존 Generation Record의 순서를 변경하거나 앞에 새 기록을 삽입할 수 없습니다. recordId=${currentRecord.id}, expectedIndex=${index}, actualIndex=${String(nextIndexes.get(currentRecord.id))}`, []);
      }
      throw contractError('GENERATION_RECORD_REMOVAL_FORBIDDEN',
        `기존 Generation Record를 삭제하거나 ID를 바꿀 수 없습니다. recordId=${currentRecord.id}, index=${index}`, []);
    }
    if (!recordsEqual(currentRecord, nextRecord)) {
      throw contractError('GENERATION_RECORD_IMMUTABLE',
        `기존 Generation Record metadata를 변경할 수 없습니다. recordId=${currentRecord.id}, index=${index}`, []);
    }
  }
  const added: readonly GenerationRecord[] = next.generationRecords.slice(current.generationRecords.length);
  throwFirstError(generationRecordStructuralIssues(next));
  throwFirstError(addedGenerationRecordIssues(current, next, added));
  return { preserved: next.generationRecords.slice(0, current.generationRecords.length), added };
}

function auditIssuesAtIntroduction(record: GenerationRecord, project: Project): Issue[] {
  const shotIds: ReadonlySet<string> = new Set<string>(project.shots.map((shot): string => shot.id));
  const assetIds: ReadonlySet<string> = new Set<string>(project.assets.map((asset): string => asset.id));
  const issues: Issue[] = [...duplicateArrayIssues(record, 'warning')];
  for (const [index, shotId] of record.shotIds.entries()) if (!shotIds.has(shotId)) {
    issues.push(issue('HISTORICAL_GENERATION_SHOT_UNRESOLVED', 'warning', record.id, `shotIds.${index}`,
      `Generation Record 도입 Revision에서 Shot을 증명할 수 없습니다. recordId=${record.id}, shotId=${shotId}`,
      'shot in introduction revision', shotId, []));
  }
  for (const [index, assetId] of record.resultAssetIds.entries()) if (!assetIds.has(assetId)) {
    issues.push(issue('HISTORICAL_GENERATION_ASSET_UNRESOLVED', 'warning', record.id, `resultAssetIds.${index}`,
      `Generation Record 도입 Revision에서 Asset을 증명할 수 없습니다. recordId=${record.id}, assetId=${assetId}`,
      'asset in introduction revision', assetId, []));
  }
  return issues;
}

/** Revision snapshot으로 각 생성 기록의 도입 시점과 현재 또는 과거 Target 상태를 파생한다. */
export function auditGenerationRecords(current: Project, versions: readonly Project[]): GenerationRecordAuditEntry[] {
  const orderedVersions: Project[] = [...versions].sort((left: Project, right: Project): number => left.revision - right.revision);
  const currentShotIds: ReadonlySet<string> = new Set<string>(current.shots.map((shot): string => shot.id));
  return current.generationRecords.map((record: GenerationRecord): GenerationRecordAuditEntry => {
    const introduction: Project | undefined = orderedVersions.find((project: Project): boolean =>
      project.generationRecords.some((candidate: GenerationRecord): boolean => candidate.id === record.id));
    if (introduction === undefined) {
      const unresolved: Issue = issue('GENERATION_RECORD_INTRODUCTION_UNRESOLVED', 'warning', record.id, 'generationRecords',
        `Generation Record가 처음 등장한 Revision을 증명할 수 없습니다. recordId=${record.id}`,
        'record in version snapshot', 'missing', []);
      return { recordId: record.id, introducedRevision: null, validAtIntroduction: false,
        currentTargetState: 'unresolved', shotIds: [...record.shotIds], resultAssetIds: [...record.resultAssetIds], issues: [unresolved] };
    }
    const introducedRecord: GenerationRecord | undefined = introduction.generationRecords.find((candidate: GenerationRecord): boolean => candidate.id === record.id);
    if (introducedRecord === undefined) throw contractError('GENERATION_RECORD_AUDIT_INCONSISTENT', `도입 Generation Record를 찾을 수 없습니다. recordId=${record.id}`, []);
    const issues: Issue[] = auditIssuesAtIntroduction(introducedRecord, introduction);
    if (!recordsEqual(introducedRecord, record)) {
      issues.push(issue('HISTORICAL_GENERATION_RECORD_CHANGED', 'warning', record.id, 'generationRecords',
        `도입 Revision 이후 Generation Record metadata가 달라졌습니다. recordId=${record.id}`,
        'immutable record metadata', 'changed', []));
    }
    const validAtIntroduction: boolean = issues.every((value: Issue): boolean =>
      !['HISTORICAL_GENERATION_SHOT_UNRESOLVED', 'HISTORICAL_GENERATION_ASSET_UNRESOLVED'].includes(value.code));
    const allCurrent: boolean = record.shotIds.every((shotId: string): boolean => currentShotIds.has(shotId));
    return {
      recordId: record.id,
      introducedRevision: introduction.revision,
      validAtIntroduction,
      currentTargetState: validAtIntroduction ? (allCurrent ? 'current' : 'historical') : 'unresolved',
      shotIds: [...record.shotIds], resultAssetIds: [...record.resultAssetIds], issues,
    };
  });
}

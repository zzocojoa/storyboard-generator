import { contractError, issue } from './errors.js';
import type { GenerationRecord, Issue, Project } from './schema.js';

export type GenerationRecordTransition = {
  preserved: readonly GenerationRecord[];
  added: readonly GenerationRecord[];
};

function recordsEqual(left: GenerationRecord, right: GenerationRecord): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

/** 현재 프로젝트 안의 생성 기록 ID와 컷 참조를 검사한다. */
export function generationRecordIssues(project: Project): Issue[] {
  const ids: Set<string> = new Set<string>();
  const shotIds: ReadonlySet<string> = new Set<string>(project.shots.map((shot): string => shot.id));
  const issues: Issue[] = [];
  for (const record of project.generationRecords) {
    if (ids.has(record.id)) {
      issues.push(issue('DUPLICATE_GENERATION_RECORD_ID', 'error', record.id, 'generationRecords',
        'Generation Record ID는 프로젝트 안에서 유일해야 합니다.', null, record.id, []));
    }
    ids.add(record.id);
    for (const [index, shotId] of record.shotIds.entries()) if (!shotIds.has(shotId)) {
      issues.push(issue('GENERATION_RECORD_SHOT_NOT_FOUND', 'error', record.id, `shotIds.${index}`,
        `Generation Record가 존재하지 않는 Shot을 참조합니다. recordId=${record.id}, shotId=${shotId}`,
        'existing shot ID', shotId, []));
    }
  }
  return issues;
}

/** Revision 변경에서 기존 생성 기록의 순서와 전체 metadata를 보존하고 뒤쪽 추가만 허용한다. */
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
  const issues: Issue[] = generationRecordIssues(next);
  const first: Issue | undefined = issues.find((value: Issue): boolean => value.severity === 'error');
  if (first !== undefined) throw contractError(first.code, first.message, issues);
  return { preserved: next.generationRecords.slice(0, current.generationRecords.length), added };
}

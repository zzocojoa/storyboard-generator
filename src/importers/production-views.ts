import { contractError, issue } from '../domain/errors.js';
import type { Instruction, Issue, Segment, Snapshot, SourceUnit, TextPlacement } from '../domain/schema.js';
import { parseMinuteTime } from '../domain/time.js';
import { sourceRef } from './native.js';

export function importShooting(file: Snapshot, segments: readonly Segment[]): { instructions: Instruction[]; issues: Issue[] } {
  const rows = file.content.split(/\r?\n/u).map((text: string, index: number) => ({ text, line: index + 1 }))
    .filter((row): boolean => row.text.startsWith('- `'));
  const records = rows.map((row) => {
    const match = /^- `([^`]+)` (\d{2,}:\d{2})–(\d{2,}:\d{2}) \/ `([^`]+)` \/ (.+)$/u.exec(row.text);
    if (match === null || match[1] === undefined || match[2] === undefined || match[3] === undefined || match[4] === undefined || match[5] === undefined) {
      throw contractError('UNSUPPORTED_SHOOTING_ROW', `${file.path}:${row.line}: 지원하지 않는 촬영 큐 형식입니다.`, []);
    }
    const [segmentId, start, end, sceneId, text] = [match[1], match[2], match[3], match[4], match[5]];
    const refs = [sourceRef(file.id, `line:${row.line}`, segmentId)];
    const segment = segments.find((value): boolean => value.id === segmentId);
    const mismatch: boolean = segment === undefined || segment.sceneId !== sceneId || segment.startMs !== parseMinuteTime(start) || segment.endMs !== parseMinuteTime(end);
    const instruction: Instruction = { id: `${file.id}:${row.line}`, segmentId, kind: 'shooting', text, sourceRefs: refs };
    return { instruction, issues: mismatch ? [issue('SHOOTING_TIMELINE_CONFLICT', 'conflict', segmentId, 'timing', '촬영 큐와 기준 시간표가 다릅니다.', JSON.stringify(segment), row.text, refs)] : [] };
  });
  if (records.length === 0) throw contractError('EMPTY_SHOOTING_CUES', `${file.path}: 읽을 수 있는 촬영 큐가 없습니다.`, []);
  const cueIds: string[] = records.map((row): string => row.instruction.segmentId);
  if (new Set(cueIds).size !== cueIds.length) throw contractError('DUPLICATE_SHOOTING_CUE', `${file.path}: 구간 촬영 큐가 중복되었습니다.`, []);
  if (segments.some((segment): boolean => !cueIds.includes(segment.id))) throw contractError('INCOMPLETE_SHOOTING_CUES', `${file.path}: 전체 구간의 촬영 큐가 필요합니다. 누락: ${segments.filter((segment): boolean => !cueIds.includes(segment.id)).map((segment): string => segment.id).join(', ')}`, []);
  return { instructions: records.map((row): Instruction => row.instruction), issues: records.flatMap((row): Issue[] => row.issues) };
}

export function importEdit(file: Snapshot, segments: readonly Segment[]): { instructions: Instruction[]; issues: Issue[] } {
  const rows = file.content.split(/\r?\n/u).map((text: string, index: number) => ({ text, line: index + 1 }))
    .filter((row): boolean => row.text.startsWith('| `'));
  const records = rows.map((row) => {
    const match = /^\| `([^`]+)` \| (\d{2,}:\d{2})–(\d{2,}:\d{2}) \| ([^|]+) \| `([^`]+)` \| (.+) \|$/u.exec(row.text);
    if (match === null || match[1] === undefined || match[2] === undefined || match[3] === undefined || match[4] === undefined || match[5] === undefined || match[6] === undefined) {
      throw contractError('UNSUPPORTED_EDIT_ROW', `${file.path}:${row.line}: 지원하지 않는 편집 큐 형식입니다.`, []);
    }
    const segmentId: string = match[1];
    const refs = [sourceRef(file.id, `line:${row.line}`, segmentId)];
    const segment = segments.find((value): boolean => value.id === segmentId);
    const mismatch: boolean = segment === undefined || segment.sceneId !== match[5] || segment.mode !== match[4].trim()
      || segment.startMs !== parseMinuteTime(match[2]) || segment.endMs !== parseMinuteTime(match[3]);
    const instruction: Instruction = { id: `${file.id}:${row.line}`, segmentId, kind: 'edit', text: match[6], sourceRefs: refs };
    return { instruction, issues: mismatch ? [issue('EDIT_TIMELINE_CONFLICT', 'conflict', segmentId, 'timing', '편집 큐와 기준 시간표가 다릅니다.', JSON.stringify(segment), row.text, refs)] : [] };
  });
  if (records.length === 0) throw contractError('EMPTY_EDIT_CUES', `${file.path}: 읽을 수 있는 편집 큐가 없습니다.`, []);
  const cueIds: string[] = records.map((row): string => row.instruction.segmentId);
  if (new Set(cueIds).size !== cueIds.length) throw contractError('DUPLICATE_EDIT_CUE', `${file.path}: 구간 편집 큐가 중복되었습니다.`, []);
  if (segments.some((segment): boolean => !cueIds.includes(segment.id))) throw contractError('INCOMPLETE_EDIT_CUES', `${file.path}: 전체 구간의 편집 큐가 필요합니다. 누락: ${segments.filter((segment): boolean => !cueIds.includes(segment.id)).map((segment): string => segment.id).join(', ')}`, []);
  return { instructions: records.map((row): Instruction => row.instruction), issues: records.flatMap((row): Issue[] => row.issues) };
}

export function importSubtitles(file: Snapshot, units: readonly SourceUnit[]): { placements: TextPlacement[]; issues: Issue[] } {
  const rows = file.content.split(/\r?\n/u).map((text: string, index: number) => ({ text, line: index + 1 }))
    .filter((row): boolean => /^- \d/u.test(row.text));
  const records = rows.map((row) => {
    const match = /^- (\d{2,}:\d{2}) `([^`]+)` (.+)$/u.exec(row.text);
    if (match === null || match[1] === undefined || match[2] === undefined || match[3] === undefined) throw contractError('UNSUPPORTED_SUBTITLE_ROW', `${file.path}:${row.line}: 지원하지 않는 자막 큐입니다.`, []);
    const [time, segmentId, text] = [match[1], match[2], match[3]];
    const candidates: SourceUnit[] = units.filter((unit: SourceUnit): boolean => unit.segmentId === segmentId && ['SCREEN_TEXT', 'NOTE', 'CHAT'].includes(unit.kind));
    const matches: SourceUnit[] = candidates.filter((unit: SourceUnit): boolean => unit.text === text);
    const canonical: SourceUnit | undefined = matches.length === 1 ? matches[0] : undefined;
    const refs = [sourceRef(file.id, `line:${row.line}`, segmentId)];
    const placement: TextPlacement = { id: `${file.id}:${row.line}`, segmentId, text, startMs: parseMinuteTime(time), endMs: null, unitId: canonical?.id ?? null, sourceRefs: refs };
    const issues: Issue[] = canonical !== undefined || candidates.length === 0 ? [] : [issue(
      'SCREEN_TEXT_MAPPING_REVIEW', 'conflict', placement.id, 'unitId', '원문 화면 문구와 다른 자막입니다. 별도 그래픽인지 축약본인지 확인하세요.',
      candidates.map((unit: SourceUnit): string => unit.text).join('\n'), text, [...refs, ...candidates.flatMap((unit: SourceUnit) => unit.sourceRefs)],
    )];
    return { placement, issues };
  });
  if (records.length === 0) throw contractError('EMPTY_SUBTITLE_CUES', `${file.path}: 읽을 수 있는 자막 큐가 없습니다.`, []);
  return { placements: records.map((record): TextPlacement => record.placement), issues: records.flatMap((record): Issue[] => record.issues) };
}

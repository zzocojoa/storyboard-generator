import type { Instruction, Segment, Snapshot, SourceRef } from '../domain/schema.js';
import { contractError } from '../domain/errors.js';
import { parseMinuteTime } from '../domain/time.js';
import { documentError, documentRefs, documentRows } from './readable.js';

export type DocumentRow = { text: string; line: number };
export type MarkedBlock = { segment: Segment; rows: DocumentRow[]; sourceRefs: SourceRef[] };

/** 편집 문서의 명시적 구간 제목으로 지원 레이아웃을 선택한다. 실패 후 다른 파서로 전환하지 않는다. */
export function hasSectionLayout(file: Snapshot): boolean {
  return documentRows(file).some((row: DocumentRow): boolean => /^## \S+ \d{2,}:\d{2}–/u.test(row.text));
}

export function readSectionTimeline(file: Snapshot): { segments: Segment[]; instructions: Instruction[] } {
  const segments: Segment[] = [];
  const instructions: Instruction[] = [];
  let current: Segment | null = null;
  for (const row of documentRows(file)) {
    if (row.text.startsWith('## ')) {
      const match = /^## (\S+) (\d{2,}:\d{2})–(\d{2,}:\d{2}) · (\S+) · (\S+)$/u.exec(row.text);
      if (match === null) documentError(file, row.line, '구간 제목은 ID 시작–종료 · 모드 · 장면 ID 형식이어야 합니다.');
      const [id, start, end, mode, sceneId] = match.slice(1) as [string, string, string, string, string];
      if (segments.some((segment: Segment): boolean => segment.id === id)) documentError(file, row.line, `구간 ID 중복: ${id}`);
      current = { id, sceneId, mode, startMs: parseMinuteTime(start), endMs: parseMinuteTime(end), timingStatus: 'proposed', reactionId: null, sourceRefs: documentRefs(file, row.line) };
      if (current.endMs <= current.startMs || current.startMs !== (segments.at(-1)?.endMs ?? 0)) documentError(file, row.line, `${id}: 편집 계획의 시간 공백·겹침 또는 역전입니다.`);
      segments.push(current);
    } else if (row.text.startsWith('|')) documentError(file, row.line, '구간 제목형 편집 문서에 표형 시간표를 혼합할 수 없습니다.');
    else if (current !== null && row.text.trim() !== '') instructions.push({ id: `${file.id}:${row.line}`, segmentId: current.id, kind: 'edit', text: row.text, sourceRefs: documentRefs(file, row.line) });
  }
  if (segments.length === 0) documentError(file, 1, '구간 제목형 편집 시간표가 없습니다.');
  const firstHeading: number = documentRows(file).find((row: DocumentRow): boolean => row.text.startsWith('## '))?.line ?? 1;
  const global: Instruction[] = documentRows(file).filter((row: DocumentRow): boolean => row.line < firstHeading && row.text.trim() !== '' && !/^(?:#|\S+ · )/u.test(row.text))
    .flatMap((row: DocumentRow): Instruction[] => segments.map((segment: Segment): Instruction => ({ id: `${file.id}:${row.line}:${segment.id}`, segmentId: segment.id, kind: 'edit', text: row.text, sourceRefs: documentRefs(file, row.line) })));
  return { segments, instructions: [...global, ...instructions] };
}

/** 시작·종료 마커와 편집표를 대조한다. 마커 안의 미지원 본문은 각 역할 파서에서 거부한다. */
export function readMarkedBlocks(file: Snapshot, expected: readonly Segment[]): MarkedBlock[] {
  const blocks: MarkedBlock[] = [];
  let current: MarkedBlock | null = null;
  for (const row of documentRows(file)) {
    if (row.text.startsWith('<!-- SEGMENT:')) {
      const match = /^<!-- SEGMENT:(\S+) TYPE:(\S+) SCENE:(\S+) DURATION:(\d+(?:\.\d+)?) -->$/u.exec(row.text);
      if (current !== null || match === null) documentError(file, row.line, '구간 마커 중첩 또는 지원하지 않는 시작 마커입니다.');
      const segment = expected.find((item: Segment): boolean => item.id === match[1]);
      if (segment === undefined || segment.mode !== match[2] || segment.sceneId !== match[3] || segment.endMs - segment.startMs !== Number(match[4]) * 1000) documentError(file, row.line, `편집표와 구간 ID·장면·유형·길이가 다릅니다: ${match[1]}`);
      if (blocks.some((block: MarkedBlock): boolean => block.segment.id === segment.id)) documentError(file, row.line, `구간 마커 중복: ${segment.id}`);
      current = { segment, rows: [], sourceRefs: documentRefs(file, row.line) };
    } else if (row.text.startsWith('<!-- END_SEGMENT:')) {
      const id = /^<!-- END_SEGMENT:(\S+) -->$/u.exec(row.text)?.[1];
      if (current === null || current.segment.id !== id) documentError(file, row.line, `시작 마커와 종료 마커가 다릅니다: ${id}`);
      blocks.push(current);
      current = null;
    } else if (current !== null) current.rows.push(row);
    else if (/^(?:<!-- (?:UNIT:|SUBTITLE_SOURCE:|CRIME_TRACE)|\[|> )/u.test(row.text)) documentError(file, row.line, '원문 또는 출처 마커가 구간 시작·종료 밖에 있습니다.');
  }
  if (current !== null) documentError(file, 1, `${current.segment.id}: 종료 마커가 없습니다.`);
  if (JSON.stringify(blocks.map((block: MarkedBlock): string => block.segment.id)) !== JSON.stringify(expected.map((segment: Segment): string => segment.id))) documentError(file, 1, '구간 마커의 누락·추가 또는 편집표 순서 불일치입니다.');
  return blocks;
}

export function sectionClock(text: string): number {
  const parts: string[] = text.split(':');
  if (parts.length === 2) return parseMinuteTime(text);
  if (parts.length !== 3 || !/^\d{2}:\d{2}:\d{2}$/u.test(text) || Number(parts[1]) >= 60 || Number(parts[2]) >= 60) throw contractError('INVALID_DOCUMENT_TIME', `지원하지 않는 문서 계획 시각: ${text}`, []);
  return Number(parts[0]) * 3600000 + Number(parts[1]) * 60000 + Number(parts[2]) * 1000;
}

/** 사람용 구간 제목의 시각도 마커와 대조해 오래된 제작표가 섞이지 않게 한다. */
export function verifySectionHeadings(file: Snapshot, blocks: readonly MarkedBlock[]): void {
  const headings = documentRows(file).filter((row: DocumentRow): boolean => row.text.startsWith('## '));
  if (headings.length !== blocks.length) documentError(file, 1, '구간 제목과 마커 개수가 다릅니다.');
  for (const [index, heading] of headings.entries()) {
    const match = / · (\d{2}:\d{2}:\d{2})–(\d{2}:\d{2}:\d{2})$/u.exec(heading.text);
    const block = blocks[index] as MarkedBlock;
    if (match === null || sectionClock(match[1] as string) !== block.segment.startMs || sectionClock(match[2] as string) !== block.segment.endMs) documentError(file, heading.line, `${block.segment.id}: 제목의 계획 시각이 편집표와 다릅니다.`);
    const markerLine: number = Number(block.sourceRefs[0]?.locator.slice(5));
    if (heading.line >= markerLine || (headings[index + 1]?.line ?? Infinity) <= markerLine) documentError(file, heading.line, '제목과 구간 마커의 위치가 다릅니다.');
  }
}

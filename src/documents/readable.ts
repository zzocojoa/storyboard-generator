import { contractError } from '../domain/errors.js';
import type { Snapshot, SourceRef, SourceUnit } from '../domain/schema.js';
import { sourceRef } from '../importers/native.js';
import type { DocumentPerson, DocumentScene, DocumentUnit, ReadableDocument } from './schema.js';

type Row = { text: string; line: number };
export function documentRows(file: Snapshot): Row[] {
  return file.content.split(/\r?\n/u).map((text: string, index: number): Row => ({ text, line: index + 1 }));
}
export function documentError(file: Snapshot, line: number, message: string): never {
  throw contractError('INVALID_DOCUMENT', `${file.path}:${line}: ${message}`, []);
}
export function documentRefs(file: Snapshot, line: number): SourceRef[] {
  return [sourceRef(file.id, `line:${line}`, null)];
}

function roster(file: Snapshot): DocumentPerson[] {
  let kind: DocumentPerson['kind'] | null = null;
  const people: DocumentPerson[] = [];
  for (const row of documentRows(file)) {
    if (row.text.startsWith('## ')) kind = row.text === '## 등장인물' ? 'character' : row.text === '## 패널' ? 'panel' : null;
    if (kind === null || !row.text.startsWith('|')) continue;
    const cells: string[] = row.text.split('|').slice(1, -1).map((cell: string): string => cell.trim());
    if (cells[0] === '인물' || cells[0] === '패널' || cells.every((cell: string): boolean => /^:?-+:?$/u.test(cell))) continue;
    const name: string | undefined = cells[0];
    const role: string | undefined = cells[1];
    if (!name || !role || cells.length !== (kind === 'character' ? 3 : 2)) documentError(file, row.line, '지원하는 인물 표의 이름·역할 열이 필요합니다.');
    if (people.some((person: DocumentPerson): boolean => person.name === name)) documentError(file, row.line, `인물 이름이 중복되었습니다: ${name}`);
    people.push({ name, role, kind, sourceRefs: documentRefs(file, row.line) });
  }
  return people;
}

function markerKind(label: string): SourceUnit['kind'] | null {
  const kinds: ReadonlyMap<string, SourceUnit['kind']> = new Map([
    ['지문', 'ACTION'], ['음향', 'SOUND'], ['화면 문구', 'SCREEN_TEXT'], ['채팅', 'CHAT'], ['메시지', 'CHAT'], ['쪽지', 'NOTE'], ['메모', 'NOTE'], ['내레이션', 'NARRATION'], ['속마음', 'DIALOGUE'], ['내면 독백', 'DIALOGUE'],
  ]);
  return kinds.get(label) ?? null;
}

function spokenUnit(file: Snapshot, row: Row, sceneTitle: string, label: string, text: string, people: readonly DocumentPerson[]): DocumentUnit {
  const match: RegExpExecArray | null = /^(.+?)(?:\((내레이션|채팅|메시지|쪽지|메모|내면 독백)\))?$/u.exec(label);
  const name: string = match?.[1] ?? label;
  const person: DocumentPerson | undefined = people.find((item: DocumentPerson): boolean => item.name === name);
  const kind: SourceUnit['kind'] | null = label === '화면 문구' ? 'SCREEN_TEXT' : match?.[2] ? markerKind(match[2]) : person?.kind === 'panel' ? 'PANEL' : 'DIALOGUE';
  if (kind === null || (label !== '화면 문구' && person === undefined)) documentError(file, row.line, `인물 표에 없는 화자 또는 지원하지 않는 유형입니다: ${label}`);
  return { id: `document-unit-${row.line}`, sceneTitle, kind, speakerName: label === '화면 문구' ? null : name, text, sourceRefs: documentRefs(file, row.line), ...(match?.[2] === '내면 독백' ? { delivery: 'inner-monologue' as const } : {}) };
}

/** 방송 원문의 유형·순서·문자열과 문서 행을 보존하며 해설은 발화로 만들지 않는다. */
export function parseBroadcast(file: Snapshot): ReadableDocument {
  const rows: Row[] = documentRows(file);
  const title: string | undefined = /^# 「(.+)」 방송용 가독형 스크립트$/u.exec(rows[0]?.text ?? '')?.[1];
  if (!title) documentError(file, 1, '지원하는 방송용 가독형 스크립트 제목이 필요합니다.');
  const people: DocumentPerson[] = roster(file);
  const scenes: DocumentScene[] = [];
  const units: DocumentUnit[] = [];
  let sceneTitle: string | null = null;
  for (let index: number = 0; index < rows.length; index += 1) {
    const row: Row = rows[index] as Row;
    const heading: RegExpExecArray | null = /^## 장면 \d+\. (.+)$/u.exec(row.text);
    if (heading?.[1]) {
      sceneTitle = heading[1];
      if (scenes.some((scene: DocumentScene): boolean => scene.title === sceneTitle)) documentError(file, row.line, `장면 제목이 중복되었습니다: ${sceneTitle}`);
      scenes.push({ title: sceneTitle, sourceRefs: documentRefs(file, row.line), metadata: [] });
      continue;
    }
    if (sceneTitle === null || row.text === '' || /^### 패널 반응 \d+$/u.test(row.text)) continue;
    const aside: RegExpExecArray | null = /^\*\[([^:]+): (.+)\]\*$/u.exec(row.text);
    if (aside?.[1] && aside[2]) {
      const kind: SourceUnit['kind'] | null = markerKind(aside[1]);
      if (kind === 'ACTION' || kind === 'SOUND') units.push({ id: `document-unit-${row.line}`, sceneTitle, kind, speakerName: null, text: aside[2], sourceRefs: documentRefs(file, row.line) });
      else if (!['상황 설명', '음향·행동 설명', '반전 후 의미'].includes(aside[1])) documentError(file, row.line, `지원하지 않는 설명 유형입니다: ${aside[1]}`);
      continue;
    }
    const label: string | undefined = /^\*\*(.+)\*\*$/u.exec(row.text)?.[1];
    if (!label) documentError(file, row.line, '해석할 수 없는 방송 본문입니다. 지원하는 발화·지문 표기를 사용하세요.');
    const body: string[] = [];
    while (index + 1 < rows.length && rows[index + 1]?.text !== '') {
      index += 1;
      const next: Row = rows[index] as Row;
      if (/^(?:#|\*\*|\*\[)/u.test(next.text)) documentError(file, next.line, '발화 본문과 다음 블록 사이에 빈 줄이 필요합니다.');
      body.push(next.text);
    }
    if (body.length === 0) documentError(file, row.line, '발화 본문이 비었습니다.');
    units.push(spokenUnit(file, row, sceneTitle, label, body.join('\n'), people));
  }
  if (scenes.length === 0) documentError(file, 1, '장면이 없습니다.');
  return { title, people, scenes, units };
}

/** 별도 인물 대본을 독립 파싱해 방송 대본과 원문 occurrence 단위로 대조한다. */
export function parseReenactment(file: Snapshot): ReadableDocument {
  const rows: Row[] = documentRows(file);
  const title: string | undefined = /^# (.+) — 인물별 대사 스크립트$/u.exec(rows[0]?.text ?? '')?.[1];
  if (!title || !rows.some((row: Row): boolean => row.text === '- 출력 프로필: REENACTMENT_CHARACTER_SCRIPT 1.0.0')) documentError(file, 1, '인물 대본 프로필 1.0.0이 필요합니다.');
  const people: DocumentPerson[] = roster(file);
  const scenes: DocumentScene[] = [];
  const units: DocumentUnit[] = [];
  let current: DocumentScene | null = null;
  for (const row of rows) {
    const heading: string | undefined = /^## 장면 \d+\. (.+)$/u.exec(row.text)?.[1];
    if (heading) {
      if (scenes.some((scene: DocumentScene): boolean => scene.title === heading)) documentError(file, row.line, '장면 제목이 중복되었습니다.');
      current = { title: heading, sourceRefs: documentRefs(file, row.line), metadata: [] };
      scenes.push(current);
      continue;
    }
    if (current === null || row.text === '') continue;
    const metadata: RegExpExecArray | null = /^- ([^:]+): (.+)$/u.exec(row.text);
    if (metadata?.[1] && metadata[2]) {
      current.metadata.push({ key: metadata[1], text: metadata[2], sourceRefs: documentRefs(file, row.line) });
      continue;
    }
    const marked: RegExpExecArray | null = /^\[([^\]]+)\] (.+)$/u.exec(row.text);
    const kind: SourceUnit['kind'] | null = marked?.[1] ? markerKind(marked[1]) : 'DIALOGUE';
    const body: string = marked?.[2] ?? row.text;
    if (kind === null) documentError(file, row.line, '지원하지 않는 인물 대본 유형입니다.');
    const needsSpeaker: boolean = ['DIALOGUE', 'NARRATION', 'CHAT', 'NOTE'].includes(kind);
    const spoken: RegExpExecArray | null = needsSpeaker ? /^([^:]+): (.+)$/u.exec(body) : null;
    if (needsSpeaker && (!spoken?.[1] || !spoken[2])) documentError(file, row.line, '화자와 발화 본문을 확인하세요.');
    const speakerName: string | null = spoken?.[1] ?? null;
    if (speakerName !== null && !people.some((person: DocumentPerson): boolean => person.name === speakerName)) documentError(file, row.line, `인물 표에 없는 화자입니다: ${speakerName}`);
    units.push({ id: `reenactment-unit-${row.line}`, sceneTitle: current.title, kind, speakerName, text: spoken?.[2] ?? body, sourceRefs: documentRefs(file, row.line), ...(marked?.[1] === '속마음' ? { delivery: 'inner-monologue' as const } : {}) });
  }
  return { title, people, scenes, units };
}

export function compareReadable(broadcast: ReadableDocument, reenactment: ReadableDocument): void {
  if (broadcast.title !== reenactment.title) throw contractError('INVALID_DOCUMENT_TITLE', `방송/인물 대본 제목 불일치: ${broadcast.title} / ${reenactment.title}`, []);
  const original: DocumentUnit[] = broadcast.units.filter((unit: DocumentUnit): boolean => unit.kind !== 'PANEL');
  if (original.length !== reenactment.units.length) throw contractError('INVALID_DOCUMENT_UNIT_COVERAGE', `방송/인물 대본 원문 개수 불일치: ${original.length} / ${reenactment.units.length}`, []);
  for (const [index, unit] of original.entries()) {
    const other: DocumentUnit = reenactment.units[index] as DocumentUnit;
    if (unit.sceneTitle !== other.sceneTitle || unit.kind !== other.kind || unit.delivery !== other.delivery || unit.speakerName !== other.speakerName || unit.text !== other.text) {
      throw contractError('INVALID_DOCUMENT_UNIT_CONFLICT', `${unit.sourceRefs[0]?.locator} ↔ ${other.sourceRefs[0]?.locator}: 방송/인물 대본 원문·유형·화자·순서 불일치. expected=${unit.text}, actual=${other.text}`, []);
    }
  }
  const orderedPeople = (people: readonly DocumentPerson[]): { name: string; role: string }[] => people.map((person: DocumentPerson) => ({ name: person.name, role: person.role }))
    .sort((left, right): number => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
  const expected: string = JSON.stringify(orderedPeople(broadcast.people.filter((person: DocumentPerson): boolean => person.kind === 'character')));
  const actual: string = JSON.stringify(orderedPeople(reenactment.people));
  if (expected !== actual) throw contractError('INVALID_DOCUMENT_ROSTER', `방송/인물 대본 인물 표 불일치: expected=${expected}, actual=${actual}`, []);
}

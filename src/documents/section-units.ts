import type { Snapshot, SourceRef, SourceUnit } from '../domain/schema.js';
import { documentError, documentRefs } from './readable.js';
import type { DocumentRow, MarkedBlock } from './section-format.js';
import type { PanelBlock } from './supporting.js';

export type MarkedUnit = { originalId: string | null; segmentId: string; kind: SourceUnit['kind']; personId: string | null; text: string; sourceRefs: SourceRef[]; delivery?: 'inner-monologue' };

function withoutCrimeMetadata(file: Snapshot, rows: readonly DocumentRow[]): DocumentRow[] {
  const result: DocumentRow[] = [];
  let metadata: DocumentRow[] | null = null;
  for (const row of rows) {
    if (row.text === '<!-- CRIME_TRACE') {
      if (metadata !== null) documentError(file, row.line, '범죄 추적 메타데이터 중첩입니다.');
      metadata = [];
    } else if (metadata !== null) {
      if (row.text === '-->') {
        if (metadata.length === 0) documentError(file, row.line, '범죄 추적 메타데이터가 비었습니다.');
        metadata = null;
      } else if (/^(?:EVENT|ACTION|HARM|DEV)=\S+$/u.test(row.text)) metadata.push(row);
      else documentError(file, row.line, '지원하지 않는 범죄 추적 메타데이터입니다.');
    } else if (row.text.trim() !== '') result.push(row);
  }
  if (metadata !== null) documentError(file, 1, '범죄 추적 메타데이터 종료 표기가 없습니다.');
  return result;
}

export function readMarkedPanel(file: Snapshot, block: MarkedBlock): PanelBlock {
  const rows = withoutCrimeMetadata(file, block.rows);
  const header = /^\[(\S+)\] \[(\S+)\] \[(\S+)\]$/u.exec(rows[0]?.text ?? '');
  if (header === null) documentError(file, rows[0]?.line ?? 1, '패널 반응 ID·화자·기능 마커가 필요합니다.');
  const turns = rows.slice(1).map((row): PanelBlock['turns'][number] => {
    const turn = /^\[(\S+)\] “(.+)”$/u.exec(row.text);
    if (turn === null) documentError(file, row.line, '패널 ID와 인용 발화가 필요합니다.');
    return { personId: turn[1] as string, text: turn[2] as string, sourceRefs: documentRefs(file, row.line) };
  });
  if (turns.length === 0 || turns[0]?.personId !== header[2]) documentError(file, rows[0]?.line ?? 1, '패널 첫 화자 또는 발화 수가 마커와 다릅니다.');
  return { segmentId: block.segment.id, reactionId: header[1] as string, durationMs: block.segment.endMs - block.segment.startMs, turns, sourceRefs: block.sourceRefs };
}

function markedBody(file: Snapshot, text: string, line: number): Pick<MarkedUnit, 'kind' | 'text' | 'personId' | 'delivery'> {
  const marked = /^\[([^\]]+)\] (.+)$/u.exec(text);
  const label: string = marked?.[1] ?? 'DIALOGUE';
  const body: string = marked?.[2] ?? text;
  const kinds: ReadonlyMap<string, SourceUnit['kind']> = new Map([
    ['DIALOGUE', 'DIALOGUE'], ['INNER_MONOLOGUE', 'DIALOGUE'], ['NARRATION', 'NARRATION'], ['MESSAGE', 'CHAT'], ['NOTE', 'NOTE'],
    ['화면 문구', 'SCREEN_TEXT'], ['지문', 'ACTION'], ['음향', 'SOUND'],
  ]);
  const kind = kinds.get(label);
  if (kind === undefined) documentError(file, line, `지원하지 않는 원문 마커 유형: ${label}`);
  const spoken = ['DIALOGUE', 'NARRATION', 'CHAT', 'NOTE'].includes(kind) ? /^(\S+): (.+)$/u.exec(body) : null;
  if (['DIALOGUE', 'NARRATION', 'CHAT', 'NOTE'].includes(kind) && spoken === null) documentError(file, line, '원문에 명시적 인물 ID가 필요합니다.');
  return { kind, personId: spoken?.[1] ?? null, text: spoken?.[2] ?? body, ...(label === 'INNER_MONOLOGUE' ? { delivery: 'inner-monologue' as const } : {}) };
}

export function readMarkedUnits(file: Snapshot, block: MarkedBlock): MarkedUnit[] {
  if (block.segment.mode === 'PANEL_REACTION') return readMarkedPanel(file, block).turns.map((turn): MarkedUnit => ({ originalId: null, segmentId: block.segment.id, kind: 'PANEL', personId: turn.personId, text: turn.text, sourceRefs: turn.sourceRefs }));
  const rows = withoutCrimeMetadata(file, block.rows);
  const result: MarkedUnit[] = [];
  for (let index: number = 0; index < rows.length; index += 2) {
    const marker = rows[index];
    const body = rows[index + 1];
    const match = /^<!-- UNIT:(\S+)(?: (?:FACT|CLUE|EVENT|HARM|DEV|REVEAL):\S+)* -->$/u.exec(marker?.text ?? '');
    if (match === null || body === undefined || body.text.startsWith('<!--')) documentError(file, marker?.line ?? 1, 'UNIT 마커와 바로 다음 원문이 필요합니다.');
    const originalId: string = match[1] as string;
    result.push({ ...markedBody(file, body.text, body.line), originalId, segmentId: block.segment.id,
      sourceRefs: [...documentRefs(file, marker?.line ?? 1), ...documentRefs(file, body.line)].map((ref: SourceRef): SourceRef => ({ ...ref, originalId })) });
  }
  if (result.length === 0) documentError(file, 1, `${block.segment.id}: 원문이 없습니다.`);
  return result;
}

/** 인용 본문만 원문과 대조하고, 구간 경계는 개별 자막의 표시 시각으로 사용하지 않는다. */
export function readPlannedSubtitles(file: Snapshot, block: MarkedBlock, expected: readonly MarkedUnit[]): SourceRef[][] {
  const rows = block.rows.filter((row): boolean => row.text.trim() !== '');
  const refs: SourceRef[][] = [];
  const ids: string[] = [];
  for (let index: number = 0; index < rows.length; index += 3) {
    const label = rows[index];
    const marker = rows[index + 1];
    const body = rows[index + 2];
    const labelMatch = /^\*\*자막 \d+ · (.+) · (화면 원문|문자 원문|메모 원문|독백|대사|내레이션|발화)\*\*$/u.exec(label?.text ?? '');
    const id = /^<!-- SUBTITLE_SOURCE:(\S+) -->$/u.exec(marker?.text ?? '')?.[1];
    const unit = expected[refs.length];
    if (labelMatch === null || id === undefined || body === undefined || !body.text.startsWith('> ') || unit === undefined) documentError(file, label?.line ?? 1, '자막 항목·출처 마커·인용 원문 구성이 맞지 않습니다.');
    if (ids.includes(id) || (unit.originalId !== null && unit.originalId !== id) || body.text.slice(2) !== unit.text) documentError(file, body.line, `${id}: 자막 출처 ID·원문·순서가 촬영 대본과 다릅니다.`);
    const type: string = unit.kind === 'SCREEN_TEXT' ? '화면 원문' : unit.kind === 'CHAT' ? '문자 원문' : unit.kind === 'NOTE' ? '메모 원문' : unit.kind === 'NARRATION' ? '내레이션' : unit.kind === 'PANEL' ? '발화' : unit.delivery === 'inner-monologue' ? '독백' : '대사';
    if (labelMatch[2] !== type) documentError(file, label?.line ?? 1, `${id}: 자막 유형이 원문과 다릅니다. 기대=${type}`);
    ids.push(id);
    refs.push([...(documentRefs(file, marker?.line ?? 1)), ...documentRefs(file, body.line)].map((ref: SourceRef): SourceRef => ({ ...ref, originalId: id })));
  }
  if (refs.length !== expected.length) documentError(file, 1, `${block.segment.id}: 자막 원문의 누락·추가입니다.`);
  return refs;
}

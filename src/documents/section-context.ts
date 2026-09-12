import type { Instruction, Segment } from '../domain/schema.js';
import { documentError, documentRefs, documentRows } from './readable.js';
import type { DocumentSources, MappingChoice } from './schema.js';
import type { MarkedBlock } from './section-format.js';
import type { PanelBlock } from './supporting.js';

/** 녹음·자막의 사람용 제작 정보도 대조하고 지시는 해당 구간에만 전달한다. */
export function recordingInstructions(sources: DocumentSources, groups: { narration: MarkedBlock[]; panel: MarkedBlock[]; subtitles: MarkedBlock[] }, people: readonly MappingChoice[], panels: readonly PanelBlock[], segments: readonly Segment[]): Instruction[] {
  const result: Instruction[] = [];
  const hashes: string[] = [];
  for (const key of ['narration', 'panel', 'subtitles'] as const) {
    const file = sources[key];
    const rows = documentRows(file);
    const fingerprints = rows.filter((row): boolean => row.text.startsWith('<!-- SOURCE_FINAL_SHA256:'));
    if (fingerprints.length !== 1 || !/^<!-- SOURCE_FINAL_SHA256:[a-f0-9]{64} -->$/u.test(fingerprints[0]?.text ?? '')) documentError(file, 1, '기준 원문 해시 마커 하나가 필요합니다.');
    hashes.push(fingerprints[0]?.text as string);
    const headings = rows.filter((row): boolean => row.text.startsWith('## '));
    const blocks = groups[key];
    const global = rows.filter((row): boolean => row.line < (headings[0]?.line ?? Infinity) && row.text.trim() !== '' && !/^(?:#|<!--|제작 메타데이터:)/u.test(row.text));
    for (const row of global) for (const segment of segments) result.push({ id: `section-context:${key}:${row.line}:${segment.id}`, segmentId: segment.id, kind: 'edit', text: row.text, sourceRefs: documentRefs(file, row.line) });
    for (const [index, block] of blocks.entries()) {
      const heading = headings[index];
      const markerLine = Number(block.sourceRefs[0]?.locator.slice(5));
      const context = rows.filter((row): boolean => row.line > (heading?.line ?? 0) && row.line < markerLine && row.text.trim() !== '');
      if (context.length !== 1 || !context[0]?.text.startsWith('제작 정보: ')) documentError(file, heading?.line ?? 1, '구간 제목 아래 제작 정보 한 줄이 필요합니다.');
      const row = context[0];
      const duration = (block.segment.endMs - block.segment.startMs) / 1000;
      const prefix: string = key === 'subtitles' ? `제작 정보: ${block.segment.sceneId} · ${duration}초 계획.`
        : key === 'panel' ? `제작 정보: ${block.segment.id} · ${panels.find((panel: PanelBlock): boolean => panel.segmentId === block.segment.id)?.reactionId} · ${block.segment.sceneId} 뒤 · ${duration}초 계획.`
        : `제작 정보: ${block.segment.id} · ${block.segment.sceneId} · ${duration}초 계획 · `;
      if (!row.text.startsWith(prefix)) documentError(file, row.line, `${block.segment.id}: 제작 정보의 ID·길이가 마커와 다릅니다.`);
      if (key === 'narration') {
        const match = / · 화자 (.+)\(([^()]+)\)\.$/u.exec(row.text);
        if (match === null || !people.some((person: MappingChoice): boolean => person.key === match[1] && person.selected === match[2]) || !block.rows.some((body): boolean => body.text.startsWith(`[NARRATION] ${match[2]}: `))) documentError(file, row.line, '녹음 제작 정보의 화자 이름·ID가 원문과 다릅니다.');
        if (!heading?.text.includes(` · ${match[1]} · `)) documentError(file, heading?.line ?? 1, '녹음 제목의 화자가 제작 정보와 다릅니다.');
      }
      if (key === 'subtitles' && !heading?.text.startsWith(`## ${block.segment.id} · `)) documentError(file, heading?.line ?? 1, '자막 제목의 구간 ID가 마커와 다릅니다.');
      result.push({ id: `section-context:${key}:${row.line}`, segmentId: block.segment.id, kind: 'edit', text: row.text, sourceRefs: documentRefs(file, row.line) });
    }
  }
  if (new Set(hashes).size !== 1) documentError(sources.subtitles, 1, '내레이션·패널·자막에 선언된 기준 원문 해시가 다릅니다. 상위 원본 파일 자체의 해시 검증은 수행하지 않습니다.');
  return result;
}

import { contractError } from '../domain/errors.js';
import type { Instruction, Segment, SourceRef } from '../domain/schema.js';
import type { Inspection } from './compile.js';
import { documentFingerprint } from './compile.js';
import { compareReadable, documentError, documentRefs, documentRows, parseBroadcast, parseReenactment } from './readable.js';
import { DocumentPreviewSchema } from './schema.js';
import type { DocumentBindings, DocumentSources, MappingChoice } from './schema.js';
import { recordingInstructions } from './section-context.js';
import { readMarkedBlocks, readSectionTimeline, sectionClock, verifySectionHeadings } from './section-format.js';
import type { MarkedBlock } from './section-format.js';
import { readMarkedPanel, readMarkedUnits, readPlannedSubtitles } from './section-units.js';
import type { MarkedUnit } from './section-units.js';
import { parseDocumentManifest, verifyShootingManifest } from './supporting.js';
import type { NarrationRow, PanelBlock } from './supporting.js';

export type SectionInspection = { markedUnits: MarkedUnit[]; subtitleRefs: Record<string, SourceRef[]>; instructions: Instruction[] };

function linkedChoice(key: string, label: string, targetId: string, sourceRefs: SourceRef[]): MappingChoice {
  return { key, label, candidates: [targetId], selected: targetId, sourceRefs };
}

function applyBindings(choices: readonly MappingChoice[], bindings: readonly DocumentBindings['people'][number][]): MappingChoice[] {
  const seen: Set<string> = new Set();
  for (const binding of bindings) {
    const choice = choices.find((item: MappingChoice): boolean => item.key === binding.key);
    if (seen.has(binding.key) || choice === undefined || !choice.candidates.includes(binding.targetId)) throw contractError('INVALID_DOCUMENT_BINDING', `${binding.key}: 문서 마커로 확인된 연결과 다르거나 중복된 결정입니다. 후보=${choice?.candidates.join(',')}, 입력=${binding.targetId}`, []);
    seen.add(binding.key);
  }
  return choices.map((choice: MappingChoice): MappingChoice => ({ ...choice, selected: bindings.find((binding): boolean => binding.key === choice.key)?.targetId ?? choice.selected }));
}

function verifyUnits(file: DocumentSources['shooting'], actual: readonly MarkedUnit[], expected: readonly MarkedUnit[]): void {
  const comparable = (unit: MarkedUnit): string => JSON.stringify([unit.originalId, unit.segmentId, unit.kind, unit.delivery ?? null, unit.personId, unit.text]);
  if (actual.length !== expected.length || actual.some((unit: MarkedUnit, index: number): boolean => comparable(unit) !== comparable(expected[index] as MarkedUnit))) documentError(file, 1, '촬영 대본과 녹음 문서의 원문 ID·화자·유형·순서가 다릅니다.');
}

function shootingInstructions(sources: DocumentSources, segments: readonly Segment[]): Instruction[] {
  const instructions: Instruction[] = [];
  let sceneId: string | null = null;
  let inside: boolean = false;
  const seen: string[] = [];
  for (const row of documentRows(sources.shooting)) {
    if (row.text.startsWith('<!-- SEGMENT:')) {
      const declared = / SCENE:(\S+) /u.exec(row.text)?.[1];
      if (sceneId === null || declared !== sceneId) documentError(sources.shooting, row.line, '장면 제목과 구간 마커의 장면 ID가 다릅니다.');
      inside = true; continue;
    }
    if (row.text.startsWith('<!-- END_SEGMENT:')) { inside = false; continue; }
    if (inside || row.text.trim() === '' || row.text.startsWith('<!--') || row.text.startsWith('# ')) continue;
    if (row.text.startsWith('## ')) {
      const match = /^## (\S+) · (.+) · (\d{2,}:\d{2})–(\d{2,}:\d{2})$/u.exec(row.text);
      if (match === null) documentError(sources.shooting, row.line, '촬영 장면 제목의 ID·장소·계획 시간이 필요합니다.');
      sceneId = match[1] as string;
      const related = segments.filter((segment: Segment): boolean => segment.sceneId === sceneId);
      if (seen.includes(sceneId) || related.length === 0 || related[0]?.startMs !== sectionClock(match[3] as string) || related.at(-1)?.endMs !== sectionClock(match[4] as string)) documentError(sources.shooting, row.line, `${sceneId}: 촬영 장면 시간·ID가 편집표와 다릅니다.`);
      seen.push(sceneId);
      continue;
    }
    for (const segment of segments.filter((item: Segment): boolean => sceneId === null || item.sceneId === sceneId)) instructions.push({ id: `section-shooting:${row.line}:${segment.id}`, segmentId: segment.id, kind: 'shooting', text: row.text, sourceRefs: documentRefs(sources.shooting, row.line) });
  }
  if (JSON.stringify(seen) !== JSON.stringify([...new Set(segments.map((segment: Segment): string => segment.sceneId))])) documentError(sources.shooting, 1, '촬영 장면 제목의 coverage·순서가 편집표와 다릅니다.');
  return instructions;
}

/** 구간 제목·명시 마커를 가진 여덟 문서를 대조한다. 작품명·ID 접두사·숫자 순서로 대응을 추측하지 않는다. */
export function inspectSectionDocuments(sources: DocumentSources, bindings: DocumentBindings): Inspection {
  const manifest = parseDocumentManifest(sources);
  verifyShootingManifest(sources.shooting, manifest);
  const broadcast = parseBroadcast(sources.broadcast);
  const reenactment = parseReenactment(sources.reenactment);
  compareReadable(broadcast, reenactment);
  const timeline = readSectionTimeline(sources.edit);
  const blocks = readMarkedBlocks(sources.shooting, timeline.segments);
  const markedUnits = blocks.flatMap((block: MarkedBlock): MarkedUnit[] => readMarkedUnits(sources.shooting, block));
  const sourceIds = markedUnits.flatMap((unit: MarkedUnit): string[] => unit.originalId === null ? [] : [unit.originalId]);
  if (new Set(sourceIds).size !== sourceIds.length) documentError(sources.shooting, 1, '촬영 원문 ID 중복입니다.');
  if (markedUnits.length !== broadcast.units.length) documentError(sources.shooting, 1, `방송 원문 개수와 촬영 원문 개수가 다릅니다: ${broadcast.units.length}/${markedUnits.length}`);
  for (const [index, unit] of broadcast.units.entries()) {
    const marked = markedUnits[index] as MarkedUnit;
    if (unit.text !== marked.text || unit.kind !== marked.kind || unit.delivery !== marked.delivery || (unit.speakerName === null) !== (marked.personId === null)) documentError(sources.shooting, Number(marked.sourceRefs[0]?.locator.slice(5)), `방송 ${unit.id}와 촬영 원문·유형·순서가 다릅니다.`);
  }
  const people = applyBindings(broadcast.people.map((person): MappingChoice => {
    const matching = markedUnits.filter((_unit: MarkedUnit, index: number): boolean => broadcast.units[index]?.speakerName === person.name);
    const ids = [...new Set(matching.map((unit: MarkedUnit): string | null => unit.personId))];
    if (ids.length > 1 || ids.includes(null)) documentError(sources.shooting, 1, `${person.name}: 원문 마커의 인물 ID 대응이 없거나 서로 충돌합니다.`);
    if (matching.length === 0) {
      const candidates = person.kind === 'character' ? [...new Set(manifest.scenes.flatMap((scene): string[] => scene.cast_ids))]
        : [...new Set(markedUnits.filter((unit: MarkedUnit): boolean => unit.kind === 'PANEL').map((unit: MarkedUnit): string => unit.personId as string))];
      return { key: person.name, label: `${person.name} · ${person.role}`, candidates, selected: null, sourceRefs: person.sourceRefs };
    }
    if (person.kind === 'character' && !manifest.scenes.some((scene): boolean => scene.cast_ids.includes(ids[0] as string))) documentError(sources.shooting, 1, `${person.name}: 촬영 인물 ID가 manifest 출연 후보에 없습니다.`);
    return linkedChoice(person.name, `${person.name} · ${person.role}`, ids[0] as string, [...person.sourceRefs, ...matching.flatMap((unit: MarkedUnit): SourceRef[] => unit.sourceRefs)]);
  }), bindings.people);
  const selectedPeople = people.flatMap((person: MappingChoice): string[] => person.selected === null ? [] : [person.selected]);
  if (new Set(selectedPeople).size !== selectedPeople.length) documentError(sources.shooting, 1, '서로 다른 이름이 같은 인물 ID에 연결됩니다.');
  const scenes = broadcast.scenes.map((scene): MappingChoice => {
    const matching = markedUnits.filter((_unit: MarkedUnit, index: number): boolean => broadcast.units[index]?.sceneTitle === scene.title);
    const ids = [...new Set(matching.map((unit: MarkedUnit): string | undefined => timeline.segments.find((segment: Segment): boolean => segment.id === unit.segmentId)?.sceneId))];
    if (ids.length !== 1 || ids[0] === undefined || !manifest.scenes.some((entry): boolean => entry.scene_id === ids[0])) documentError(sources.shooting, 1, `${scene.title}: 장면 마커 대응을 확인하세요.`);
    return linkedChoice(scene.title, scene.title, ids[0], [...scene.sourceRefs, ...matching.flatMap((unit: MarkedUnit): SourceRef[] => unit.sourceRefs)]);
  });
  if (scenes.length !== manifest.scenes.length || new Set(scenes.map((scene: MappingChoice): string | null => scene.selected)).size !== scenes.length) documentError(sources.shooting, 1, '방송·촬영·manifest 장면 coverage가 다릅니다.');
  const units = broadcast.units.map((unit, index: number): MappingChoice => linkedChoice(unit.id, `${unit.sceneTitle} · ${unit.kind} · ${unit.text}`, (markedUnits[index] as MarkedUnit).segmentId, [...unit.sourceRefs, ...(markedUnits[index] as MarkedUnit).sourceRefs]));
  applyBindings(scenes, bindings.scenes); applyBindings(units, bindings.units);
  const narrationBlocks = readMarkedBlocks(sources.narration, timeline.segments.filter((segment: Segment): boolean => segment.mode === 'NARRATION'));
  const panelBlocks = readMarkedBlocks(sources.panel, timeline.segments.filter((segment: Segment): boolean => segment.mode === 'PANEL_REACTION'));
  verifySectionHeadings(sources.narration, narrationBlocks); verifySectionHeadings(sources.panel, panelBlocks);
  const recordedNarration = narrationBlocks.flatMap((block: MarkedBlock): MarkedUnit[] => readMarkedUnits(sources.narration, block));
  verifyUnits(sources.narration, recordedNarration, markedUnits.filter((unit: MarkedUnit): boolean => unit.kind === 'NARRATION'));
  verifyUnits(sources.panel, panelBlocks.flatMap((block: MarkedBlock): MarkedUnit[] => readMarkedUnits(sources.panel, block)), markedUnits.filter((unit: MarkedUnit): boolean => unit.kind === 'PANEL'));
  const narration: NarrationRow[] = recordedNarration.map((unit: MarkedUnit): NarrationRow => ({ segmentId: unit.segmentId, name: people.find((person: MappingChoice): boolean => person.selected === unit.personId)?.key as string, text: unit.text, sourceRefs: unit.sourceRefs }));
  const panels: PanelBlock[] = panelBlocks.map((block: MarkedBlock): PanelBlock => readMarkedPanel(sources.panel, block));
  const shootingPanels = blocks.filter((block: MarkedBlock): boolean => block.segment.mode === 'PANEL_REACTION').map((block: MarkedBlock): PanelBlock => readMarkedPanel(sources.shooting, block));
  if (new Set(panels.map((block: PanelBlock): string => block.reactionId)).size !== panels.length || panels.some((panel: PanelBlock, index: number): boolean => panel.reactionId !== shootingPanels[index]?.reactionId)) documentError(sources.panel, 1, '패널 반응 ID가 촬영 대본과 다르거나 중복되었습니다.');
  const segments: Segment[] = timeline.segments.map((segment: Segment): Segment => ({ ...segment, reactionId: panels.find((panel: PanelBlock): boolean => panel.segmentId === segment.id)?.reactionId ?? null }));
  const subtitleBlocks = readMarkedBlocks(sources.subtitles, segments);
  verifySectionHeadings(sources.subtitles, subtitleBlocks);
  const subtitleRefs: Record<string, SourceRef[]> = {};
  const subtitleIds: Set<string> = new Set();
  for (const block of subtitleBlocks) {
    const expected = markedUnits.filter((unit: MarkedUnit): boolean => unit.segmentId === block.segment.id && !['ACTION', 'SOUND', 'MUSIC'].includes(unit.kind));
    const refs = readPlannedSubtitles(sources.subtitles, block, expected);
    for (const [index, unit] of expected.entries()) {
      const sourceRefs = refs[index] as SourceRef[];
      const id = sourceRefs[0]?.originalId as string;
      if (subtitleIds.has(id)) documentError(sources.subtitles, 1, `${id}: 자막 원문 ID 중복입니다.`);
      subtitleIds.add(id);
      subtitleRefs[(broadcast.units[markedUnits.indexOf(unit)] as typeof broadcast.units[number]).id] = sourceRefs;
    }
  }
  const preview = DocumentPreviewSchema.parse({ format: 'production-documents-v1', projectId: manifest.project_id, title: broadcast.title, sourceFingerprint: documentFingerprint(sources), people, scenes, units,
    candidateEvidence: [...people.filter((choice: MappingChoice): boolean => choice.selected !== null).map((choice: MappingChoice) => ({ field: 'people', targetId: choice.selected, description: '방송·인물 대본의 이름과 촬영 대본의 ID를 같은 원문·유형·순서로 대조했습니다.', sourceRefs: choice.sourceRefs })), ...scenes.map((choice: MappingChoice) => ({ field: 'scenes', targetId: choice.selected, description: '촬영 구간 마커와 편집표·방송 대본을 대조했습니다.', sourceRefs: choice.sourceRefs }))],
    counts: { scenes: scenes.length, segments: segments.length, units: units.length, narration: narration.length, panel: panels.reduce((sum: number, block: PanelBlock): number => sum + block.turns.length, 0) },
    notices: ['구간 제목형 제작 문서를 확인했습니다. 인물·장면·원문 연결은 촬영 마커와 동일 원문의 대조 결과입니다.',
      `편집 시간은 제작 계획이며 녹음 실측값이 아닙니다. 자막 ${Object.keys(subtitleRefs).length}개의 개별 시작·종료는 미정으로 보존하고, 편집기에서 제안 시각을 조정·확정합니다.`,
      '문자·메모 작성자를 낭독 화자로 만들지 않습니다. 극중 내면 독백은 별도 내레이션 구간과 구별합니다.',
      'FPS·화면비·음성 샘플레이트는 제작자가 지정해야 합니다. 상위 원본·footprint는 읽지 않으며 fact·clue의 의미별 공개 조건은 별도 검토가 필요합니다.'] });
  return { preview, broadcast, reenactment, manifest, segments, narration, panels,
    section: { markedUnits, subtitleRefs, instructions: [...timeline.instructions, ...shootingInstructions(sources, segments), ...recordingInstructions(sources, { narration: narrationBlocks, panel: panelBlocks, subtitles: subtitleBlocks }, people, panels, segments)] } };
}

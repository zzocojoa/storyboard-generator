import { assertNoErrors, contractError, issue } from '../domain/errors.js';
import type { Dataset, InformationRule, Instruction, Issue, Location, Person, Scene, Segment, SourceUnit } from '../domain/schema.js';
import { validateDataset } from '../domain/validation.js';
import { sha256Text } from '../importers/integrity.js';
import { importEdit, importShooting, importSubtitles, readEditTimeline } from '../importers/production-views.js';
import { compareReadable, documentRefs, documentRows, parseBroadcast, parseReenactment } from './readable.js';
import type { DocumentBindings, DocumentPreview, DocumentSources, DocumentUnit, MappingChoice, ReadableDocument } from './schema.js';
import { DOCUMENT_FILES, DocumentPreviewSchema } from './schema.js';
import { parseDocumentManifest, parseNarration, parsePanels, verifyShootingManifest } from './supporting.js';
import type { DocumentManifest, NarrationRow, PanelBlock } from './supporting.js';

type Inspection = { preview: DocumentPreview; broadcast: ReadableDocument; reenactment: ReadableDocument;
  manifest: DocumentManifest; segments: Segment[]; narration: NarrationRow[]; panels: PanelBlock[] };

export function documentFingerprint(sources: DocumentSources): string {
  return sha256Text(JSON.stringify(DOCUMENT_FILES.map((file) => ({ key: file.key, sha256: sha256Text(sources[file.key].content) }))));
}

function resolvedChoice(choice: MappingChoice, bindings: readonly DocumentBindings['people'][number][]): MappingChoice {
  const matched = bindings.filter((binding): boolean => binding.key === choice.key);
  if (matched.length > 1) throw contractError('DUPLICATE_DOCUMENT_BINDING', `${choice.key}: 결정이 중복되었습니다.`, []);
  const requested: string | undefined = matched[0]?.targetId;
  if (requested !== undefined && !choice.candidates.includes(requested)) throw contractError('INVALID_DOCUMENT_BINDING', `${choice.key}: 후보 안의 ID를 선택하세요. candidates=${choice.candidates.join(',')}, actual=${requested}`, []);
  return { ...choice, selected: requested ?? choice.selected };
}

function requireKnownBindings(choices: readonly MappingChoice[], bindings: readonly DocumentBindings['people'][number][]): void {
  for (const binding of bindings) if (!choices.some((choice: MappingChoice): boolean => choice.key === binding.key)) throw contractError('INVALID_DOCUMENT_BINDING', `${binding.key}: 현재 문서에 없는 결정입니다.`, []);
}

function matchingSegments(unit: DocumentUnit, narration: readonly NarrationRow[], panels: readonly PanelBlock[]): string[] {
  if (unit.kind === 'NARRATION') return [...new Set(narration.filter((row: NarrationRow): boolean => row.name === unit.speakerName && row.text === unit.text).map((row: NarrationRow): string => row.segmentId))];
  if (unit.kind === 'PANEL') return [...new Set(panels.filter((block: PanelBlock): boolean => block.turns.some((turn): boolean => turn.text === unit.text)).map((block: PanelBlock): string => block.segmentId))];
  return [];
}

/** 유일한 원문 연결과 명시적 결정으로만 후보를 좁힌다. 표의 행 순서는 ID 대응 근거로 쓰지 않는다. */
export function inspectDocuments(sources: DocumentSources, bindings: DocumentBindings): Inspection {
  const manifest: DocumentManifest = parseDocumentManifest(sources);
  verifyShootingManifest(sources.shooting, manifest);
  const broadcast: ReadableDocument = parseBroadcast(sources.broadcast);
  const reenactment: ReadableDocument = parseReenactment(sources.reenactment);
  compareReadable(broadcast, reenactment);
  const initialSegments: Segment[] = readEditTimeline(sources.edit).map((row): Segment => row.segment);
  const narration: NarrationRow[] = parseNarration(sources.narration, initialSegments);
  const panels: PanelBlock[] = parsePanels(sources.panel, initialSegments);
  const segments: Segment[] = initialSegments.map((segment: Segment): Segment => ({ ...segment, reactionId: panels.find((block: PanelBlock): boolean => block.segmentId === segment.id)?.reactionId ?? null }));
  const shooting = importShooting(sources.shooting, segments);
  if (shooting.issues.length > 0) throw contractError('INVALID_DOCUMENT_TIMELINE', '촬영표와 편집표의 시간을 일치시킨 뒤 다시 검토하세요.', shooting.issues);
  const sceneIds: string[] = [...new Set(segments.map((segment: Segment): string => segment.sceneId))];
  if (sceneIds.length !== manifest.scenes.length || sceneIds.some((id: string): boolean => !manifest.scenes.some((scene): boolean => scene.scene_id === id)) || broadcast.scenes.length !== sceneIds.length) {
    throw contractError('INVALID_DOCUMENT_SCENE_COVERAGE', '방송·편집표·manifest의 전체 장면 연결을 확인하세요.', []);
  }
  const scenes: MappingChoice[] = broadcast.scenes.map((scene): MappingChoice => {
    const linked: string[] = [...new Set(broadcast.units.filter((unit: DocumentUnit): boolean => unit.sceneTitle === scene.title).flatMap((unit: DocumentUnit): string[] => {
      const matched: string[] = matchingSegments(unit, narration, panels);
      return matched.length === 1 ? segments.filter((segment: Segment): boolean => matched.includes(segment.id)).map((segment: Segment): string => segment.sceneId) : [];
    }))];
    if (linked.length > 1) throw contractError('INVALID_DOCUMENT_SCENE_LINK', `${scene.title}: 원문이 서로 다른 장면 ID에 연결됩니다: ${linked.join(',')}`, []);
    return resolvedChoice({ key: scene.title, label: scene.title, candidates: linked.length === 0 ? sceneIds : linked, selected: linked[0] ?? null, sourceRefs: scene.sourceRefs }, bindings.scenes);
  });
  requireKnownBindings(scenes, bindings.scenes);
  const characterIds: string[] = [...new Set(manifest.scenes.flatMap((scene): string[] => scene.cast_ids))];
  const panelIds: string[] = [...new Set(panels.flatMap((block: PanelBlock): string[] => block.turns.map((turn): string => turn.personId)))];
  const people: MappingChoice[] = broadcast.people.map((person): MappingChoice => {
    const linked: string[] = person.kind === 'panel' ? [...new Set(broadcast.units.filter((unit: DocumentUnit): boolean => unit.kind === 'PANEL' && unit.speakerName === person.name)
      .flatMap((unit: DocumentUnit): string[] => panels.flatMap((block: PanelBlock): string[] => block.turns.filter((turn): boolean => turn.text === unit.text).map((turn): string => turn.personId))))] : [];
    const candidates: string[] = person.kind === 'panel' ? linked.length === 1 ? linked : panelIds : characterIds;
    return resolvedChoice({ key: person.name, label: `${person.name} · ${person.role}`, candidates, selected: person.kind === 'panel' && linked.length === 1 ? linked[0] as string : null, sourceRefs: person.sourceRefs }, bindings.people);
  });
  requireKnownBindings(people, bindings.people);
  const units: MappingChoice[] = broadcast.units.map((unit: DocumentUnit): MappingChoice => {
    const scene: MappingChoice | undefined = scenes.find((choice: MappingChoice): boolean => choice.key === unit.sceneTitle);
    const direct: string[] = matchingSegments(unit, narration, panels);
    const sceneSegments: Segment[] = segments.filter((segment: Segment): boolean => scene?.selected === null || scene?.selected === segment.sceneId);
    const visualSegments: Segment[] = sceneSegments.filter((segment: Segment): boolean => !['NARRATION', 'PANEL_REACTION'].includes(segment.mode));
    const spoken: boolean = unit.kind === 'NARRATION' || unit.kind === 'PANEL';
    const candidates: string[] = spoken ? direct : sceneSegments.map((segment: Segment): string => segment.id);
    const automatic: string | null = spoken ? direct.length === 1 ? direct[0] as string : null
      : sceneSegments.length === 1 ? sceneSegments[0]?.id ?? null : visualSegments.length === 1 ? visualSegments[0]?.id ?? null : null;
    return resolvedChoice({ key: unit.id, label: `${unit.sceneTitle} · ${unit.kind} · ${unit.text}`, candidates, selected: automatic, sourceRefs: unit.sourceRefs }, bindings.units);
  });
  requireKnownBindings(units, bindings.units);
  const preview: DocumentPreview = DocumentPreviewSchema.parse({ format: 'production-documents-v1', projectId: manifest.project_id, title: broadcast.title,
    sourceFingerprint: documentFingerprint(sources), scenes, people, units,
    counts: { scenes: scenes.length, segments: segments.length, units: units.length, narration: narration.length, panel: panels.reduce((sum: number, block: PanelBlock): number => sum + block.turns.length, 0) },
    notices: ['FPS·화면비·음성 샘플레이트는 제작자가 지정해야 합니다. 자막 종료는 미정으로 보존합니다.',
      '사람용 문서에 없는 Canonical Unit·fact·clue ID는 복원하지 않습니다. 새 문서 Unit ID와 원문 공개 순서를 사용하며 의미별 정보 공개는 별도 검토가 필요합니다.',
      '상위 footprint 원본은 읽지 않으므로 연결 해시 검증 범위에 포함하지 않습니다.'],
  });
  return { preview, broadcast, reenactment, manifest, segments, narration, panels };
}

function requireSelected(choices: readonly MappingChoice[], field: string): void {
  const missing: Issue[] = choices.filter((choice: MappingChoice): boolean => choice.selected === null).map((choice: MappingChoice): Issue => issue(
    'DOCUMENT_MAPPING_REQUIRED', 'error', choice.key, field, `${choice.label}: 연결을 선택하세요.`, choice.candidates.join(', '), null, choice.sourceRefs));
  if (missing.length > 0) throw contractError('DOCUMENT_MAPPING_REQUIRED', '문서에 없는 연결을 검토하고 명시적으로 선택하세요.', missing);
}

function uniqueSelected(choices: readonly MappingChoice[], field: string): void {
  const ids: (string | null)[] = choices.map((choice: MappingChoice): string | null => choice.selected);
  if (new Set(ids).size !== ids.length) throw contractError('INVALID_DOCUMENT_BINDING', `${field}: 서로 다른 항목에 동일한 ID를 지정할 수 없습니다.`, []);
}

function verifyAuxiliaryUnits(inspection: Inspection, units: readonly SourceUnit[]): void {
  const narration = units.filter((unit: SourceUnit): boolean => unit.kind === 'NARRATION');
  if (narration.length !== inspection.narration.length) throw contractError('INVALID_DOCUMENT_NARRATION_COVERAGE', '방송 대본과 내레이션 문서의 발화 수가 다릅니다.', []);
  for (const segment of inspection.segments) {
    const expectedNarration: string[] = inspection.narration.filter((row: NarrationRow): boolean => row.segmentId === segment.id).map((row: NarrationRow): string => row.text);
    const actualNarration: string[] = narration.filter((unit: SourceUnit): boolean => unit.segmentId === segment.id).map((unit: SourceUnit): string => unit.text);
    if (JSON.stringify(expectedNarration) !== JSON.stringify(actualNarration)) throw contractError('INVALID_DOCUMENT_NARRATION_ORDER', `${segment.id}: 내레이션 원문 또는 순서가 다릅니다.`, []);
    const block: PanelBlock | undefined = inspection.panels.find((item: PanelBlock): boolean => item.segmentId === segment.id);
    const expectedPanel = block?.turns.map((turn) => ({ text: turn.text, speakerId: turn.personId })) ?? [];
    const actualPanel = units.filter((unit: SourceUnit): boolean => unit.segmentId === segment.id && unit.kind === 'PANEL').map((unit: SourceUnit) => ({ text: unit.text, speakerId: unit.speakerId }));
    if (JSON.stringify(expectedPanel) !== JSON.stringify(actualPanel)) throw contractError('INVALID_DOCUMENT_PANEL_ORDER', `${segment.id}: 패널 원문·화자 또는 순서가 다릅니다.`, []);
  }
}

function contextInstructions(sources: DocumentSources, inspection: Inspection): Instruction[] {
  const local: Instruction[] = inspection.reenactment.scenes.flatMap((scene): Instruction[] => {
    const id: string | null | undefined = inspection.preview.scenes.find((choice: MappingChoice): boolean => choice.key === scene.title)?.selected;
    const segments: Segment[] = inspection.segments.filter((segment: Segment): boolean => segment.sceneId === id);
    return scene.metadata.filter((entry): boolean => ['배경 음악', '환경 음향'].includes(entry.key)).flatMap((entry): Instruction[] => segments.map((segment: Segment): Instruction => ({
      id: `document-context:${segment.id}:${entry.key}`, segmentId: segment.id, kind: entry.key === '배경 음악' ? 'music' : 'ambience', text: entry.text, sourceRefs: entry.sourceRefs,
    })));
  });
  const global: Instruction[] = (['shooting', 'edit', 'narration', 'panel', 'subtitles'] as const).flatMap((key): Instruction[] => documentRows(sources[key])
    .filter((row): boolean => row.text !== '' && !/^(?:#|\||<!--|- `|- \d)/u.test(row.text))
    .flatMap((row): Instruction[] => inspection.segments.map((segment: Segment): Instruction => ({ id: `document-global:${key}:${row.line}:${segment.id}`,
      segmentId: segment.id, kind: key === 'shooting' ? 'shooting' : 'edit', text: row.text, sourceRefs: documentRefs(sources[key], row.line) }))));
  return [...local, ...global];
}

export function compileDocuments(sources: DocumentSources, bindings: DocumentBindings): { dataset: Dataset; issues: Issue[] } {
  const inspection: Inspection = inspectDocuments(sources, bindings);
  const { preview, broadcast, reenactment, manifest, segments } = inspection;
  requireSelected(preview.scenes, 'scenes'); requireSelected(preview.people, 'people'); requireSelected(preview.units, 'units');
  uniqueSelected(preview.scenes, 'scenes'); uniqueSelected(preview.people, 'people');
  const people: Person[] = broadcast.people.map((person, index: number): Person => ({ id: preview.people[index]?.selected as string, ...person, visualDescription: null }));
  const scenes: Scene[] = broadcast.scenes.map((scene, index: number): Scene => {
    const id: string = preview.scenes[index]?.selected as string;
    const entry = manifest.scenes.find((value): boolean => value.scene_id === id);
    if (entry === undefined) throw contractError('INVALID_DOCUMENT_SCENE', `${id}: manifest 장면이 없습니다.`, []);
    return { id, title: scene.title, storyLocationId: entry.location_id, declaredCastIds: [...entry.cast_ids], sourceRefs: [...scene.sourceRefs, { fileId: sources.manifest.id, locator: `/scenes/${manifest.scenes.indexOf(entry)}`, originalId: id }] };
  });
  const locations: Location[] = [...new Set(scenes.map((scene: Scene): string => scene.storyLocationId as string))].map((id: string): Location => {
    const linked = reenactment.scenes.filter((scene): boolean => scenes.some((item: Scene): boolean => item.title === scene.title && item.storyLocationId === id));
    const descriptions = linked.flatMap((scene) => scene.metadata.filter((entry): boolean => entry.key === '장소'));
    if (descriptions.length !== linked.length) throw contractError('MISSING_DOCUMENT_LOCATION', `${id}: 인물 대본의 장소 설명이 필요합니다.`, []);
    return { id, name: id, description: [...new Set(descriptions.map((entry): string => entry.text))].join('\n'), sourceRefs: descriptions.flatMap((entry) => entry.sourceRefs) };
  });
  const units: SourceUnit[] = broadcast.units.map((unit: DocumentUnit, index: number): SourceUnit => {
    const segmentId: string = preview.units[index]?.selected as string;
    const segment: Segment | undefined = segments.find((item: Segment): boolean => item.id === segmentId);
    const scene: Scene | undefined = scenes.find((item: Scene): boolean => item.title === unit.sceneTitle);
    if (segment?.sceneId !== scene?.id) throw contractError('INVALID_DOCUMENT_UNIT_SCENE', `${unit.id}: 원문과 구간의 장면 소속이 다릅니다.`, []);
    const counterpartIndex: number = broadcast.units.slice(0, index).filter((other: DocumentUnit): boolean => other.kind !== 'PANEL').length;
    const counterpart: DocumentUnit | undefined = unit.kind === 'PANEL' ? undefined : reenactment.units[counterpartIndex];
    const refs = [...unit.sourceRefs, ...(counterpart?.sourceRefs ?? [])];
    const spokenRefs = unit.kind === 'NARRATION' ? inspection.narration.filter((row: NarrationRow): boolean => row.segmentId === segmentId && row.name === unit.speakerName && row.text === unit.text).flatMap((row: NarrationRow) => row.sourceRefs)
      : unit.kind === 'PANEL' ? inspection.panels.filter((block: PanelBlock): boolean => block.segmentId === segmentId).flatMap((block: PanelBlock) => block.turns.filter((turn): boolean => turn.text === unit.text).flatMap((turn) => turn.sourceRefs)) : [];
    return { id: unit.id, segmentId, order: index + 1, kind: unit.kind, text: unit.text,
      speakerId: unit.speakerName === null ? null : people.find((person: Person): boolean => person.name === unit.speakerName)?.id ?? null,
      informationIds: [`document-information:${unit.id}`], sourceRefs: [...refs, ...spokenRefs] };
  });
  for (const [index, unit] of units.entries()) {
    const previous: SourceUnit | undefined = units[index - 1];
    if (previous !== undefined && segments.findIndex((segment: Segment): boolean => segment.id === previous.segmentId) > segments.findIndex((segment: Segment): boolean => segment.id === unit.segmentId)) throw contractError('INVALID_DOCUMENT_BROADCAST_ORDER', `${unit.id}: 방송 원문 순서와 편집 구간 순서가 다릅니다.`, []);
  }
  verifyAuxiliaryUnits(inspection, units);
  const informationRules: InformationRule[] = units.map((unit: SourceUnit): InformationRule => ({ id: unit.informationIds[0] as string, segmentId: unit.segmentId,
    baseNotBeforeMs: (segments.find((segment: Segment): boolean => segment.id === unit.segmentId) as Segment).startMs,
    notBeforeUnitId: unit.id, notBeforeUnitOrder: unit.order, precision: 'unit-order', sourceRefs: unit.sourceRefs }));
  const shooting = importShooting(sources.shooting, segments);
  const edit = importEdit(sources.edit, segments);
  const subtitles = documentRows(sources.subtitles).some((row): boolean => /^- \d/u.test(row.text)) ? importSubtitles(sources.subtitles, units) : { placements: [], issues: [] };
  const dataset: Dataset = { projectId: manifest.project_id, title: broadcast.title, people, locations, scenes, segments, units, informationRules,
    instructions: [...shooting.instructions, ...edit.instructions, ...contextInstructions(sources, inspection)], textPlacements: subtitles.placements };
  assertNoErrors(validateDataset(dataset, Object.values(sources)), 'INVALID_DOCUMENT_DATASET');
  const notices: Issue[] = preview.notices.map((text: string): Issue => issue('DOCUMENT_IMPORT_REVIEW', 'warning', manifest.project_id, 'documents', text, null, null, []));
  return { dataset, issues: [...subtitles.issues, ...notices] };
}

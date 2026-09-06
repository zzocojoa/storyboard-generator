import { contractError, issue } from '../domain/errors.js';
import type { Dataset, Handoff, InformationRule, Instruction, Issue, Location, Person, Scene, Segment, Snapshot, SourceUnit } from '../domain/schema.js';
import { secondsToMilliseconds } from '../domain/time.js';
import { assertAuthorityRole, optionalSnapshot, parseJson, requireSnapshot } from './integrity.js';
import { sourceRef } from './native.js';
import { CharactersSchema, PanelCastSchema, PresentationSchema, ReactionsSchema, SceneCardsSchema, ScreenplaySchema } from './production-schema.js';
import type { ProductionPresentation, ProductionReactions, ProductionScreenplay } from './production-schema.js';
import { importEdit, importShooting, importSubtitles } from './production-views.js';
import { verifyProductionManifest } from './production-manifest.js';

function assertProjectId(expected: string, actual: string, path: string): void {
  if (expected !== actual) throw contractError('PROJECT_MISMATCH', `${path}: 프로젝트가 다릅니다. expected=${expected}, actual=${actual}`, []);
}

function importUnits(screenplay: ProductionScreenplay, file: Snapshot): SourceUnit[] {
  return screenplay.scenes.flatMap((scene, sceneIndex): SourceUnit[] => scene.units.map((unit, unitIndex): SourceUnit => {
    if (!scene.segment_ids.includes(unit.segment_id)) throw contractError('UNIT_SCENE_MEMBERSHIP', `${unit.unit_id}: 원본 장면 ${scene.scene_id}의 구간이 아닙니다.`, []);
    return {
      id: unit.unit_id, segmentId: unit.segment_id, order: unit.order, kind: unit.type,
      text: unit.text, speakerId: unit.speaker_id ?? null,
      informationIds: [...unit.references.fact_ids.map((id: string): string => `fact:${id}`), ...unit.references.clue_ids.map((id: string): string => `clue:${id}`)],
      sourceRefs: [sourceRef(file.id, `/scenes/${sceneIndex}/units/${unitIndex}`, unit.unit_id)],
    };
  }));
}

function importTurns(reactions: ProductionReactions, file: Snapshot, segments: readonly Segment[]): SourceUnit[] {
  return reactions.reaction_segments.flatMap((reaction, reactionIndex): SourceUnit[] => {
    const matches: Segment[] = segments.filter((segment: Segment): boolean => segment.reactionId === reaction.reaction_segment_id);
    const segment: Segment | undefined = matches[0];
    if (matches.length !== 1 || segment === undefined) throw contractError('REACTION_SEGMENT_LINK', `${reaction.reaction_segment_id}: 반응은 방송 구간 하나에 연결돼야 합니다.`, []);
    if (segment.sceneId !== reaction.after_scene_id || segment.startMs !== secondsToMilliseconds(reaction.start_sec)
      || segment.endMs - segment.startMs !== secondsToMilliseconds(reaction.duration_sec)) {
      throw contractError('REACTION_TIMELINE_MISMATCH', `${reaction.reaction_segment_id}: 기준 시간표와 반응 구간이 다릅니다.`, []);
    }
    return reaction.turns.map((turn, index): SourceUnit => ({
      id: turn.turn_id, segmentId: segment.id, order: index + 1, kind: 'PANEL', text: turn.spoken_line, speakerId: turn.panelist_id,
      informationIds: [...turn.known_fact_ids.map((id: string): string => `fact:${id}`), ...turn.evidence_ids.map((id: string): string => `clue:${id}`)],
      sourceRefs: [sourceRef(file.id, `/reaction_segments/${reactionIndex}/turns/${index}`, turn.turn_id)],
    }));
  });
}

function importInformation(presentation: ProductionPresentation, file: Snapshot, segments: readonly Segment[], units: readonly SourceUnit[]): InformationRule[] {
  const disclosures: InformationRule[] = presentation.segments.flatMap((segment, index): InformationRule[] => {
    const ids: string[] = [...segment.revealed_fact_ids.map((id: string): string => `fact:${id}`), ...segment.revealed_clue_ids.map((id: string): string => `clue:${id}`)];
    const normalizedSegment: Segment | undefined = segments.find((value: Segment): boolean => value.id === segment.segment_id);
    if (normalizedSegment === undefined) throw contractError('SEGMENT_NOT_FOUND', `${segment.segment_id}: 정보 공개 구간을 찾을 수 없습니다.`, []);
    return ids.map((id: string): InformationRule => {
      const unit: SourceUnit | undefined = units.filter((value: SourceUnit): boolean => value.segmentId === segment.segment_id && value.informationIds.includes(id)).sort((left: SourceUnit, right: SourceUnit): number => left.order - right.order)[0];
      return {
        id, segmentId: segment.segment_id, notBeforeMs: normalizedSegment.startMs,
        notBeforeUnitId: unit?.id ?? null, notBeforeUnitOrder: unit?.order ?? null,
        precision: unit === undefined ? 'segment-start' : 'unit-order',
        sourceRefs: [sourceRef(file.id, `/segments/${index}`, segment.segment_id)],
      };
    });
  });
  return disclosures.filter((rule: InformationRule, index: number): boolean => disclosures.findIndex((candidate: InformationRule): boolean => candidate.id === rule.id) === index);
}

function importAmbience(screenplay: ProductionScreenplay, file: Snapshot): Instruction[] {
  return screenplay.scenes.flatMap((scene, index): Instruction[] => {
    const segmentId: string | undefined = scene.segment_ids[0];
    if (segmentId === undefined) throw contractError('EMPTY_SCENE_SEGMENTS', `${scene.scene_id}: 장면의 구간 목록이 비어 있습니다.`, []);
    return [
      { id: `${scene.scene_id}:music`, segmentId, kind: 'music', text: scene.context.background_music_description, sourceRefs: [sourceRef(file.id, `/scenes/${index}/context/background_music_description`, scene.scene_id)] },
      ...scene.context.sound_cues.map((cue, cueIndex): Instruction => ({ id: `${scene.scene_id}:${cue.sound_cue_id}`, segmentId, kind: 'ambience', text: cue.description, sourceRefs: [sourceRef(file.id, `/scenes/${index}/context/sound_cues/${cueIndex}`, cue.sound_cue_id)] })),
    ];
  });
}

export function importProduction(handoff: Handoff, snapshots: readonly Snapshot[]): { dataset: Dataset; issues: Issue[] } {
  verifyProductionManifest(handoff.projectId, snapshots);
  const screenplayFile: Snapshot = requireSnapshot(snapshots, 'screenplay');
  const presentationFile: Snapshot = requireSnapshot(snapshots, 'presentation');
  const charactersFile: Snapshot = requireSnapshot(snapshots, 'characters');
  const scenesFile: Snapshot = requireSnapshot(snapshots, 'scene-cards');
  const reactionsFile: Snapshot | null = optionalSnapshot(snapshots, 'reactions');
  const panelFile: Snapshot | null = optionalSnapshot(snapshots, 'panel-cast');
  assertAuthorityRole(handoff, snapshots, 'timeline', ['presentation']);
  assertAuthorityRole(handoff, snapshots, 'units', ['screenplay']);
  assertAuthorityRole(handoff, snapshots, 'screen-text', ['screenplay']);
  assertAuthorityRole(handoff, snapshots, 'scenes', ['screenplay', 'scene-cards']);
  assertAuthorityRole(handoff, snapshots, 'people', panelFile === null ? ['characters'] : ['characters', 'panel-cast']);
  if (reactionsFile !== null) assertAuthorityRole(handoff, snapshots, 'panel-turns', ['reactions']);
  const screenplay = ScreenplaySchema.parse(parseJson(screenplayFile.content, screenplayFile.path));
  const presentation = PresentationSchema.parse(parseJson(presentationFile.content, presentationFile.path));
  const characters = CharactersSchema.parse(parseJson(charactersFile.content, charactersFile.path));
  const sceneCards = SceneCardsSchema.parse(parseJson(scenesFile.content, scenesFile.path));
  const reactions = reactionsFile === null ? null : ReactionsSchema.parse(parseJson(reactionsFile.content, reactionsFile.path));
  const panels = panelFile === null ? null : PanelCastSchema.parse(parseJson(panelFile.content, panelFile.path));
  for (const record of [{ data: screenplay, file: screenplayFile }, { data: presentation, file: presentationFile }, { data: characters, file: charactersFile }, { data: sceneCards, file: scenesFile }]) assertProjectId(handoff.projectId, record.data.project_id, record.file.path);
  if (reactions !== null && reactionsFile !== null) assertProjectId(handoff.projectId, reactions.project_id, reactionsFile.path);
  if (panels !== null && panelFile !== null) assertProjectId(handoff.projectId, panels.project_id, panelFile.path);
  const segments: Segment[] = presentation.segments.map((segment, index): Segment => ({
    id: segment.segment_id, sceneId: segment.scene_id, mode: segment.segment_type,
    startMs: secondsToMilliseconds(segment.start_sec), endMs: secondsToMilliseconds(segment.start_sec) + secondsToMilliseconds(segment.duration_sec),
    timingStatus: 'fixed', reactionId: segment.reaction_segment_id ?? null,
    sourceRefs: [sourceRef(presentationFile.id, `/segments/${index}`, segment.segment_id)],
  }));
  for (const segment of segments) {
    if (!presentation.modes.includes(segment.mode)) throw contractError('UNDECLARED_SEGMENT_MODE', `${segment.id}: ${segment.mode} 모드가 선언되지 않았습니다.`, []);
    if (segment.mode === 'PANEL_REACTION' && segment.reactionId === null) throw contractError('MISSING_REACTION_LINK', `${segment.id}: 패널 발화 연결이 필요합니다.`, []);
    if (segment.reactionId !== null && !reactions?.reaction_segments.some((reaction): boolean => reaction.reaction_segment_id === segment.reactionId)) throw contractError('MISSING_REACTION', `${segment.id}: 반응 원본을 찾을 수 없습니다.`, []);
  }
  const people: Person[] = [
    ...characters.characters.map((character, index): Person => ({ id: character.character_id, name: character.name, role: character.role, kind: 'character', visualDescription: null, sourceRefs: [sourceRef(charactersFile.id, `/characters/${index}`, character.character_id)] })),
    ...(panels === null || panelFile === null ? [] : panels.panelists.map((panel, index): Person => ({ id: panel.panelist_id, name: panel.display_name, role: panel.persona, kind: 'panel', visualDescription: null, sourceRefs: [sourceRef(panelFile.id, `/panelists/${index}`, panel.panelist_id)] }))),
  ];
  const scenes: Scene[] = screenplay.scenes.map((scene, index): Scene => {
    const matches = sceneCards.scenes.filter((card): boolean => card.scene_id === scene.scene_id);
    const card = matches[0];
    if (matches.length !== 1 || card === undefined) throw contractError('SCENE_CARD_LINK', `${scene.scene_id}: 장면 카드가 정확히 하나 필요합니다.`, []);
    if (card.location_id !== scene.location_id) throw contractError('SCENE_LOCATION_CONFLICT', `${scene.scene_id}: 원본 장면 위치가 서로 다릅니다.`, []);
    for (const segmentId of scene.segment_ids) if (!segments.some((segment: Segment): boolean => segment.id === segmentId && segment.sceneId === scene.scene_id)) throw contractError('SCENE_SEGMENT_LINK', `${scene.scene_id}: ${segmentId} 구간 소속이 다릅니다.`, []);
    return { id: scene.scene_id, title: scene.title, storyLocationId: scene.location_id, declaredCastIds: [...card.cast_ids], sourceRefs: [sourceRef(screenplayFile.id, `/scenes/${index}`, scene.scene_id), sourceRef(scenesFile.id, `/scenes/${sceneCards.scenes.indexOf(card)}`, scene.scene_id)] };
  });
  if (scenes.length !== sceneCards.scenes.length) throw contractError('SCENE_CARD_COVERAGE', '대본과 장면 카드의 장면 수가 다릅니다.', []);
  const locations: Location[] = [...new Set(scenes.map((scene: Scene): string => scene.storyLocationId as string))].map((id: string): Location => {
    const matching = screenplay.scenes.filter((scene): boolean => scene.location_id === id);
    return { id, name: id, description: [...new Set(matching.map((scene): string => scene.context.location_description))].join('\n'), sourceRefs: matching.map((scene) => sourceRef(screenplayFile.id, `/scenes/${screenplay.scenes.indexOf(scene)}/context/location_description`, scene.scene_id)) };
  });
  const units: SourceUnit[] = [...importUnits(screenplay, screenplayFile), ...(reactions !== null && reactionsFile !== null ? importTurns(reactions, reactionsFile, segments) : [])]
    .sort((left: SourceUnit, right: SourceUnit): number => segments.findIndex((segment: Segment): boolean => segment.id === left.segmentId) - segments.findIndex((segment: Segment): boolean => segment.id === right.segmentId) || left.order - right.order);
  const shootingFile = optionalSnapshot(snapshots, 'shooting');
  const editFile = optionalSnapshot(snapshots, 'edit');
  const subtitleFile = optionalSnapshot(snapshots, 'subtitles');
  const shooting = shootingFile === null ? { instructions: [], issues: [] } : importShooting(shootingFile, segments);
  const edit = editFile === null ? { instructions: [], issues: [] } : importEdit(editFile, segments);
  const subtitles = subtitleFile === null ? { placements: [], issues: [] } : importSubtitles(subtitleFile, units);
  const castIssues: Issue[] = units.filter((unit: SourceUnit): boolean => unit.kind === 'NARRATION' || unit.kind === 'DIALOGUE').flatMap((unit: SourceUnit): Issue[] => {
    const segment = segments.find((candidate: Segment): boolean => candidate.id === unit.segmentId);
    const scene = scenes.find((candidate: Scene): boolean => candidate.id === segment?.sceneId);
    return unit.speakerId === null || scene === undefined || scene.declaredCastIds.includes(unit.speakerId) ? [] : [issue('CAST_SCOPE_REVIEW', 'warning', unit.id, 'speakerId', '화자가 장면 출연 목록에 없습니다. 음성 출연과 화면 출연을 별도로 확인하세요.', JSON.stringify(scene.declaredCastIds), unit.speakerId, [...unit.sourceRefs, ...scene.sourceRefs])];
  });
  return {
    dataset: { projectId: handoff.projectId, title: screenplay.title, scenes, segments, units, people, locations,
      informationRules: importInformation(presentation, presentationFile, segments, units), instructions: [...importAmbience(screenplay, screenplayFile), ...shooting.instructions, ...edit.instructions], textPlacements: subtitles.placements },
    issues: [...shooting.issues, ...edit.issues, ...subtitles.issues, ...castIssues],
  };
}

import { contractError } from '../domain/errors.js';
import { requireShot } from '../domain/edit.js';
import { absoluteFrameTime, directVisualLinks, effectiveInformationGate } from '../domain/mapping.js';
import type { EffectiveInformationGate } from '../domain/mapping.js';
import type {
  Asset, Person, Profile, Project, Segment, Shot, ShotSourceLink, SourceUnit,
  StoryboardFrame, TextMappingDecision, TextPlacement,
} from '../domain/schema.js';

export type ProposalPerson = Pick<Person, 'id' | 'name' | 'visualDescription'>;
export type ProposalUnit = Pick<SourceUnit, 'id' | 'kind' | 'order' | 'text' | 'speakerId' | 'informationIds'> & {
  mappingStatus: 'confirmed' | 'mapping-required';
};
export type ContextTextMapping = Pick<TextMappingDecision, 'id' | 'canonicalUnitId' | 'relation' | 'status' | 'renderCanonicalSeparately'> & {
  placementId: string; placementText: string; placementStartMs: number;
};
export type ContextInformationGate = Pick<EffectiveInformationGate, 'id' | 'segmentId' | 'notBeforeMs' | 'notBeforeUnitId' | 'notBeforeUnitOrder' | 'precision' | 'reviewRequired'>;
export type SegmentContext = {
  projectId: string; profile: Profile; segment: Pick<Segment, 'id' | 'mode' | 'startMs' | 'endMs'>;
  storyLocationId: string | null; sourceUnits: ProposalUnit[]; people: ProposalPerson[];
  instructions: { kind: string; text: string }[]; informationAvailableBeforeSegment: string[];
  informationGates: ContextInformationGate[]; textMappings: ContextTextMapping[];
};
export type ImageContext = {
  projectId: string; profile: Profile;
  shot: Pick<Shot, 'id' | 'startMs' | 'endMs' | 'action' | 'camera' | 'cameraAxis' | 'screenDirection' | 'visualLocationId' | 'presence' | 'continuityBefore' | 'continuityAfter'>;
  frame: Pick<StoryboardFrame, 'id' | 'offsetMs' | 'role' | 'description'> & { absoluteMs: number };
  sourceLinks: ShotSourceLink[]; sourceUnits: ProposalUnit[]; people: ProposalPerson[];
  visualReferences: Pick<Asset, 'id' | 'kind' | 'description' | 'sha256' | 'version'>[];
  allowedInformationIds: string[]; informationGates: ContextInformationGate[];
  textOverlayUnitIds: string[]; textMappings: ContextTextMapping[];
};

function contextGate(gate: EffectiveInformationGate): ContextInformationGate {
  return {
    id: gate.id, segmentId: gate.segmentId, notBeforeMs: gate.notBeforeMs,
    notBeforeUnitId: gate.notBeforeUnitId, notBeforeUnitOrder: gate.notBeforeUnitOrder,
    precision: gate.precision, reviewRequired: gate.reviewRequired,
  };
}

function requireAllowedInformation(project: Project, ids: readonly string[], absoluteMs: number, context: string): ContextInformationGate[] {
  return [...new Set(ids)].map((id: string): ContextInformationGate => {
    const gate: EffectiveInformationGate = effectiveInformationGate(project, id);
    if (gate.reviewRequired) throw contractError('UNRESOLVED_TEXT_MAPPING', `${context}: ${id}의 자막 Mapping 검토가 끝나지 않았습니다.`, []);
    if (gate.notBeforeMs > absoluteMs) throw contractError('FORBIDDEN_PROMPT_INFORMATION', `${context}: ${id}는 ${gate.notBeforeMs}ms 이후에만 전달할 수 있습니다.`, []);
    return contextGate(gate);
  });
}

function mappingStatus(project: Project, unitId: string, segmentId: string): ProposalUnit['mappingStatus'] {
  const links: ShotSourceLink[] = project.shots.filter((shot: Shot): boolean => shot.segmentId === segmentId).flatMap((shot: Shot): ShotSourceLink[] => shot.sourceLinks.filter((link: ShotSourceLink): boolean => link.unitId === unitId));
  return links.some((link: ShotSourceLink): boolean => link.status === 'mapping-required') ? 'mapping-required' : 'confirmed';
}

function proposalUnit(project: Project, unit: SourceUnit): ProposalUnit {
  return {
    id: unit.id, kind: unit.kind, order: unit.order, text: unit.text, speakerId: unit.speakerId,
    informationIds: [...unit.informationIds], mappingStatus: mappingStatus(project, unit.id, unit.segmentId),
  };
}

function promptUnits(project: Project, links: readonly ShotSourceLink[], segmentId: string, absoluteMs: number): ProposalUnit[] {
  return links.map((link: ShotSourceLink): ProposalUnit => {
    if (link.status === 'mapping-required') throw contractError('SOURCE_MAPPING_REQUIRED', `${link.unitId}: 이미지 생성 전에 Source Mapping을 확정하세요.`, []);
    const unit: SourceUnit | undefined = project.dataset.units.find((value: SourceUnit): boolean => value.id === link.unitId && value.segmentId === segmentId);
    if (unit === undefined) throw contractError('INVALID_PROMPT_SOURCE', `${link.unitId}: 선택 구간의 원문만 전달할 수 있습니다.`, []);
    requireAllowedInformation(project, unit.informationIds, absoluteMs, unit.id);
    return proposalUnit(project, unit);
  });
}

function promptPeople(project: Project, ids: readonly string[]): ProposalPerson[] {
  return [...new Set(ids)].map((id: string): ProposalPerson => {
    const person: Person | undefined = project.dataset.people.find((value: Person): boolean => value.id === id);
    if (person === undefined) throw contractError('UNKNOWN_PROMPT_PERSON', `${id}: 인물 기준을 찾을 수 없습니다.`, []);
    return { id: person.id, name: person.name, visualDescription: person.visualDescription };
  });
}

function latestAssets(assets: readonly Asset[]): Asset[] {
  return assets.filter((asset: Asset): boolean => !assets.some((candidate: Asset): boolean => candidate.kind === asset.kind && candidate.subjectId === asset.subjectId && candidate.version > asset.version));
}

function contextMappings(project: Project, segmentId: string): ContextTextMapping[] {
  return project.textMappingDecisions.flatMap((decision: TextMappingDecision): ContextTextMapping[] => {
    const placement: TextPlacement | undefined = project.dataset.textPlacements.find((value: TextPlacement): boolean => value.id === decision.placementId && value.segmentId === segmentId);
    return placement === undefined ? [] : [{
      id: decision.id, placementId: decision.placementId, placementText: placement.text, placementStartMs: placement.startMs,
      canonicalUnitId: decision.canonicalUnitId, relation: decision.relation, status: decision.status,
      renderCanonicalSeparately: decision.renderCanonicalSeparately,
    }];
  });
}

/** 컷 제안에는 현재 구간의 원문 순서와 공개 Gate를 함께 전달한다. */
export function buildSegmentContext(project: Project, segmentId: string): SegmentContext {
  const segment: Segment | undefined = project.dataset.segments.find((value: Segment): boolean => value.id === segmentId);
  if (segment === undefined) throw contractError('SEGMENT_NOT_FOUND', `${segmentId}: 구간을 찾을 수 없습니다.`, []);
  const scene = project.dataset.scenes.find((value): boolean => value.id === segment.sceneId);
  if (scene === undefined) throw contractError('SCENE_NOT_FOUND', `${segment.sceneId}: 장면을 찾을 수 없습니다.`, []);
  const units: SourceUnit[] = project.dataset.units.filter((unit: SourceUnit): boolean => unit.segmentId === segmentId).sort((left: SourceUnit, right: SourceUnit): number => left.order - right.order);
  const rules: EffectiveInformationGate[] = project.dataset.informationRules.map((rule): EffectiveInformationGate => effectiveInformationGate(project, rule.id));
  return {
    projectId: project.projectId, profile: project.profile,
    segment: { id: segment.id, mode: segment.mode, startMs: segment.startMs, endMs: segment.endMs }, storyLocationId: scene.storyLocationId,
    sourceUnits: units.map((unit: SourceUnit): ProposalUnit => proposalUnit(project, unit)),
    people: promptPeople(project, [...scene.declaredCastIds, ...units.flatMap((unit: SourceUnit): string[] => unit.speakerId === null ? [] : [unit.speakerId])]),
    instructions: project.dataset.instructions.filter((instruction): boolean => instruction.segmentId === segmentId).map((instruction) => ({ kind: instruction.kind, text: instruction.text })),
    informationAvailableBeforeSegment: rules.filter((rule: EffectiveInformationGate): boolean => rule.notBeforeMs < segment.startMs).map((rule: EffectiveInformationGate): string => rule.id),
    informationGates: rules.filter((rule: EffectiveInformationGate): boolean => rule.segmentId === segmentId).map(contextGate),
    textMappings: contextMappings(project, segmentId),
  };
}

/** 그림 요청에는 선택한 프레임의 절대 시각에 허용된 직접 시각 원문만 넣는다. */
function imageContext(project: Project, shot: Shot, frame: StoryboardFrame): ImageContext {
  const absoluteMs: number = absoluteFrameTime(shot, frame);
  const unresolved = contextMappings(project, shot.segmentId).filter((decision: ContextTextMapping): boolean => decision.status === 'unresolved');
  if (unresolved.length > 0) throw contractError('UNRESOLVED_TEXT_MAPPING', `${shot.id}: 이미지 생성 전에 자막 Mapping을 확정하세요: ${unresolved.map((decision: ContextTextMapping): string => decision.id).join(', ')}`, []);
  const links: ShotSourceLink[] = directVisualLinks(shot);
  const units: ProposalUnit[] = promptUnits(project, links, shot.segmentId, absoluteMs);
  const unitInformationIds: string[] = units.flatMap((unit: ProposalUnit): string[] => unit.informationIds);
  const allowedInformationIds: string[] = [...new Set([...shot.informationIds, ...unitInformationIds])];
  const informationGates: ContextInformationGate[] = requireAllowedInformation(project, allowedInformationIds, absoluteMs, shot.id);
  const visiblePersonIds: string[] = shot.presence.filter((presence): boolean => ['VISIBLE', 'HAND_ONLY', 'SILHOUETTE', 'ARCHIVE_IMAGE'].includes(presence.mode)).map((presence): string => presence.personId);
  const automaticReferenceIds: string[] = latestAssets(project.assets.filter((asset: Asset): boolean =>
    (asset.kind === 'character' && asset.subjectId !== null && visiblePersonIds.includes(asset.subjectId))
    || (asset.kind === 'location' && asset.subjectId !== null && asset.subjectId === shot.visualLocationId),
  )).map((asset: Asset): string => asset.id);
  const referenceIds: string[] = [...automaticReferenceIds, ...shot.propIds, ...shot.continuityBefore.map((state): string => state.assetId), ...shot.continuityAfter.map((state): string => state.assetId)];
  const visualReferences = [...new Set(referenceIds)].map((id: string) => {
    const asset: Asset | undefined = project.assets.find((value: Asset): boolean => value.id === id && ['character', 'location', 'prop'].includes(value.kind));
    if (asset === undefined) throw contractError('MISSING_VISUAL_REFERENCE', `${shot.id}: 시각 기준 자산 ${id}이 없습니다.`, []);
    return { id: asset.id, kind: asset.kind, description: asset.description, sha256: asset.sha256, version: asset.version };
  });
  return {
    projectId: project.projectId, profile: project.profile,
    shot: { id: shot.id, startMs: shot.startMs, endMs: shot.endMs, action: shot.action, camera: shot.camera, cameraAxis: shot.cameraAxis,
      screenDirection: shot.screenDirection, visualLocationId: shot.visualLocationId, presence: shot.presence, continuityBefore: shot.continuityBefore, continuityAfter: shot.continuityAfter },
    frame: { id: frame.id, offsetMs: frame.offsetMs, role: frame.role, description: frame.description, absoluteMs },
    sourceLinks: links, sourceUnits: units.filter((unit: ProposalUnit): boolean => !['SCREEN_TEXT', 'NOTE', 'CHAT'].includes(unit.kind)),
    people: promptPeople(project, visiblePersonIds), visualReferences, allowedInformationIds, informationGates,
    textOverlayUnitIds: units.filter((unit: ProposalUnit): boolean => ['SCREEN_TEXT', 'NOTE', 'CHAT'].includes(unit.kind)).map((unit: ProposalUnit): string => unit.id),
    textMappings: contextMappings(project, shot.segmentId),
  };
}

export function buildImageContext(project: Project, shotId: string): ImageContext {
  const shot: Shot = requireShot(project, shotId);
  const frame: StoryboardFrame | undefined = project.frames.filter((candidate: StoryboardFrame): boolean => candidate.shotId === shotId).sort((left: StoryboardFrame, right: StoryboardFrame): number => left.offsetMs - right.offsetMs)[0];
  if (frame === undefined) throw contractError('FRAME_NOT_FOUND', `${shotId}: 이미지 생성용 프레임을 찾을 수 없습니다.`, []);
  return imageContext(project, shot, frame);
}

export function buildFrameImageContext(project: Project, frameId: string): ImageContext {
  const frame: StoryboardFrame | undefined = project.frames.find((candidate: StoryboardFrame): boolean => candidate.id === frameId);
  if (frame === undefined) throw contractError('FRAME_NOT_FOUND', `프레임을 찾을 수 없습니다: ${frameId}`, []);
  return imageContext(project, requireShot(project, frame.shotId), frame);
}

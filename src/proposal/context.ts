import { contractError } from '../domain/errors.js';
import { requireShot } from '../domain/edit.js';
import type { Asset, Person, Profile, Project, Segment, Shot, SourceUnit, StoryboardFrame } from '../domain/schema.js';

export type ProposalPerson = Pick<Person, 'id' | 'name' | 'visualDescription'>;
export type ProposalUnit = Pick<SourceUnit, 'id' | 'kind' | 'text' | 'speakerId'>;
export type SegmentContext = {
  projectId: string; profile: Profile; segment: Pick<Segment, 'id' | 'mode' | 'startMs' | 'endMs'>;
  storyLocationId: string | null; sourceUnits: ProposalUnit[]; people: ProposalPerson[];
  instructions: { kind: string; text: string }[]; allowedInformationIds: string[];
};
export type ImageContext = {
  projectId: string; profile: Profile; shot: Pick<Shot, 'id' | 'startMs' | 'endMs' | 'action' | 'camera' | 'cameraAxis' | 'screenDirection' | 'visualLocationId' | 'presence' | 'continuityBefore' | 'continuityAfter'>;
  frame: Pick<StoryboardFrame, 'id' | 'offsetMs' | 'role' | 'description'>;
  sourceUnits: ProposalUnit[]; people: ProposalPerson[]; visualReferences: Pick<Asset, 'id' | 'kind' | 'description' | 'sha256' | 'version'>[];
  allowedInformationIds: string[]; textOverlayUnitIds: string[];
};

function requireAllowedInformation(project: Project, ids: readonly string[], startMs: number, context: string): void {
  for (const id of ids) {
    const rule = project.dataset.informationRules.find((value): boolean => value.id === id);
    if (rule === undefined) throw contractError('UNRESOLVED_PROMPT_INFORMATION', `${context}: ${id}의 공개 시점 정의가 필요합니다.`, []);
    if (rule.notBeforeMs > startMs) throw contractError('FORBIDDEN_PROMPT_INFORMATION', `${context}: ${id}는 ${rule.notBeforeMs}ms 이후에만 전달할 수 있습니다.`, []);
  }
}

function promptUnits(project: Project, ids: readonly string[], segmentId: string, startMs: number): ProposalUnit[] {
  return ids.map((id: string): ProposalUnit => {
    const unit: SourceUnit | undefined = project.dataset.units.find((value): boolean => value.id === id && value.segmentId === segmentId);
    if (unit === undefined) throw contractError('INVALID_PROMPT_SOURCE', `${id}: 선택 구간의 원문만 전달할 수 있습니다.`, []);
    requireAllowedInformation(project, unit.informationIds, startMs, unit.id);
    return { id: unit.id, kind: unit.kind, text: unit.text, speakerId: unit.speakerId };
  });
}

function promptPeople(project: Project, ids: readonly string[]): ProposalPerson[] {
  return [...new Set(ids)].map((id: string): ProposalPerson => {
    const person: Person | undefined = project.dataset.people.find((value): boolean => value.id === id);
    if (person === undefined) throw contractError('UNKNOWN_PROMPT_PERSON', `${id}: 인물 기준을 찾을 수 없습니다.`, []);
    return { id: person.id, name: person.name, visualDescription: person.visualDescription };
  });
}

function latestAssets(assets: readonly Asset[]): Asset[] {
  return assets.filter((asset: Asset): boolean => !assets.some((candidate: Asset): boolean => candidate.kind === asset.kind && candidate.subjectId === asset.subjectId && candidate.version > asset.version));
}

/** 컷 제안에 필요한 현재 구간만 투영한다. 원본 파일·전체 줄거리·인물 비밀은 포함하지 않는다. */
export function buildSegmentContext(project: Project, segmentId: string): SegmentContext {
  const segment: Segment | undefined = project.dataset.segments.find((value): boolean => value.id === segmentId);
  if (segment === undefined) throw contractError('SEGMENT_NOT_FOUND', `${segmentId}: 구간을 찾을 수 없습니다.`, []);
  const scene = project.dataset.scenes.find((value): boolean => value.id === segment.sceneId);
  if (scene === undefined) throw contractError('SCENE_NOT_FOUND', `${segment.sceneId}: 장면을 찾을 수 없습니다.`, []);
  const units: SourceUnit[] = project.dataset.units.filter((unit): boolean => unit.segmentId === segmentId);
  return {
    projectId: project.projectId, profile: project.profile,
    segment: { id: segment.id, mode: segment.mode, startMs: segment.startMs, endMs: segment.endMs }, storyLocationId: scene.storyLocationId,
    sourceUnits: promptUnits(project, units.map((unit): string => unit.id), segmentId, segment.startMs),
    people: promptPeople(project, [...scene.declaredCastIds, ...units.flatMap((unit): string[] => unit.speakerId === null ? [] : [unit.speakerId])]),
    instructions: project.dataset.instructions.filter((instruction): boolean => instruction.segmentId === segmentId).map((instruction) => ({ kind: instruction.kind, text: instruction.text })),
    allowedInformationIds: project.dataset.informationRules.filter((rule): boolean => rule.notBeforeMs <= segment.startMs).map((rule): string => rule.id),
  };
}

/** 그림 요청에는 선택한 컷의 시각 기준만 넣고, 정확한 글자는 별도 합성 트랙으로 남긴다. */
function imageContext(project: Project, shot: Shot, frame: StoryboardFrame): ImageContext {
  requireAllowedInformation(project, shot.informationIds, shot.startMs, shot.id);
  const units: ProposalUnit[] = promptUnits(project, shot.sourceUnitIds, shot.segmentId, shot.startMs);
  const visiblePersonIds: string[] = shot.presence.filter((presence): boolean => ['VISIBLE', 'HAND_ONLY', 'SILHOUETTE', 'ARCHIVE_IMAGE'].includes(presence.mode)).map((presence): string => presence.personId);
  const automaticReferenceIds: string[] = latestAssets(project.assets.filter((asset: Asset): boolean =>
    (asset.kind === 'character' && asset.subjectId !== null && visiblePersonIds.includes(asset.subjectId))
    || (asset.kind === 'location' && asset.subjectId !== null && asset.subjectId === shot.visualLocationId),
  )).map((asset: Asset): string => asset.id);
  const referenceIds: string[] = [...automaticReferenceIds, ...shot.propIds, ...shot.continuityBefore.map((state): string => state.assetId), ...shot.continuityAfter.map((state): string => state.assetId)];
  const visualReferences = [...new Set(referenceIds)].map((id: string) => {
    const asset: Asset | undefined = project.assets.find((value): boolean => value.id === id && ['character', 'location', 'prop'].includes(value.kind));
    if (asset === undefined) throw contractError('MISSING_VISUAL_REFERENCE', `${shot.id}: 시각 기준 자산 ${id}이 없습니다.`, []);
    return { id: asset.id, kind: asset.kind, description: asset.description, sha256: asset.sha256, version: asset.version };
  });
  return {
    projectId: project.projectId, profile: project.profile,
    shot: { id: shot.id, startMs: shot.startMs, endMs: shot.endMs, action: shot.action, camera: shot.camera, cameraAxis: shot.cameraAxis,
      screenDirection: shot.screenDirection, visualLocationId: shot.visualLocationId, presence: shot.presence, continuityBefore: shot.continuityBefore, continuityAfter: shot.continuityAfter },
    frame: { id: frame.id, offsetMs: frame.offsetMs, role: frame.role, description: frame.description },
    sourceUnits: units.filter((unit: ProposalUnit): boolean => !['SCREEN_TEXT', 'NOTE', 'CHAT'].includes(unit.kind)),
    people: promptPeople(project, visiblePersonIds),
    visualReferences, allowedInformationIds: [...shot.informationIds],
    textOverlayUnitIds: units.filter((unit: ProposalUnit): boolean => ['SCREEN_TEXT', 'NOTE', 'CHAT'].includes(unit.kind)).map((unit: ProposalUnit): string => unit.id),
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

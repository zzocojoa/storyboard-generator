import { assertNoErrors, contractError } from './errors.js';
import { reconcileTextCues } from './mapping.js';
import type { AudioCue, Project, Segment, Shot, SourceUnit, StoryboardFrame, TextCue, TextMappingDecision, TextPlacement } from './schema.js';
import { ProjectSchema } from './schema.js';
import { validateProject } from './validation.js';

type Identified = { id: string };
export type SourceImpactReport = {
  changedSourceFileIds: string[]; changedEntityIds: string[]; impactedSegmentIds: string[];
  impactedShotIds: string[]; lockedShotIds: string[]; canApply: boolean;
};

function changedIds(before: readonly Identified[], after: readonly Identified[]): string[] {
  const ids: string[] = [...new Set([...before.map((value: Identified): string => value.id), ...after.map((value: Identified): string => value.id)])];
  return ids.filter((id: string): boolean => JSON.stringify(before.find((value: Identified): boolean => value.id === id)) !== JSON.stringify(after.find((value: Identified): boolean => value.id === id)));
}

function addUnitSegments(project: Project, unitIds: readonly string[], result: Set<string>): void {
  for (const id of unitIds) {
    const segmentId: string | undefined = project.dataset.units.find((unit): boolean => unit.id === id)?.segmentId;
    if (segmentId !== undefined) result.add(segmentId);
  }
}

function addInstructionSegments(project: Project, instructionIds: readonly string[], result: Set<string>): void {
  for (const id of instructionIds) {
    const segmentId: string | undefined = project.dataset.instructions.find((instruction): boolean => instruction.id === id)?.segmentId;
    if (segmentId !== undefined) result.add(segmentId);
  }
}

function addPlacementSegments(project: Project, placementIds: readonly string[], result: Set<string>): void {
  for (const id of placementIds) {
    const segmentId: string | undefined = project.dataset.textPlacements.find((placement): boolean => placement.id === id)?.segmentId;
    if (segmentId !== undefined) result.add(segmentId);
  }
}

export function sourceImpact(current: Project, incoming: Project): SourceImpactReport {
  if (current.projectId !== incoming.projectId) throw contractError('PROJECT_MISMATCH', `원본 갱신은 같은 프로젝트 ID에만 적용할 수 있습니다. current=${current.projectId}, incoming=${incoming.projectId}`, []);
  const unitIds: string[] = changedIds(current.dataset.units, incoming.dataset.units);
  const segmentIds: string[] = changedIds(current.dataset.segments, incoming.dataset.segments);
  const sceneIds: string[] = changedIds(current.dataset.scenes, incoming.dataset.scenes);
  const personIds: string[] = changedIds(current.dataset.people, incoming.dataset.people);
  const locationIds: string[] = changedIds(current.dataset.locations, incoming.dataset.locations);
  const instructionIds: string[] = changedIds(current.dataset.instructions, incoming.dataset.instructions);
  const placementIds: string[] = changedIds(current.dataset.textPlacements, incoming.dataset.textPlacements);
  const informationIds: string[] = changedIds(current.dataset.informationRules, incoming.dataset.informationRules);
  const impacted: Set<string> = new Set<string>(segmentIds);
  addUnitSegments(current, unitIds, impacted); addUnitSegments(incoming, unitIds, impacted);
  addInstructionSegments(current, instructionIds, impacted); addInstructionSegments(incoming, instructionIds, impacted);
  addPlacementSegments(current, placementIds, impacted); addPlacementSegments(incoming, placementIds, impacted);
  for (const id of informationIds) {
    const currentRule = current.dataset.informationRules.find((rule): boolean => rule.id === id);
    const incomingRule = incoming.dataset.informationRules.find((rule): boolean => rule.id === id);
    if (currentRule !== undefined) impacted.add(currentRule.segmentId);
    if (incomingRule !== undefined) impacted.add(incomingRule.segmentId);
  }
  for (const sceneId of sceneIds) {
    for (const segment of [...current.dataset.segments, ...incoming.dataset.segments]) if (segment.sceneId === sceneId) impacted.add(segment.id);
  }
  for (const shot of current.shots) {
    if (shot.presence.some((presence): boolean => personIds.includes(presence.personId)) || (shot.visualLocationId !== null && locationIds.includes(shot.visualLocationId))) impacted.add(shot.segmentId);
  }
  if (JSON.stringify(current.handoff.profile) !== JSON.stringify(incoming.handoff.profile)) {
    for (const segment of [...current.dataset.segments, ...incoming.dataset.segments]) impacted.add(segment.id);
  }
  const impactedSegmentIds: string[] = [...impacted];
  const impactedShotIds: string[] = current.shots.filter((shot: Shot): boolean => impacted.has(shot.segmentId)).map((shot: Shot): string => shot.id);
  const lockedShotIds: string[] = current.shots.filter((shot: Shot): boolean => impacted.has(shot.segmentId) && (shot.approvalStatus === 'approved' || shot.lockedFields.length > 0)).map((shot: Shot): string => shot.id);
  const currentHashes: Map<string, string> = new Map(current.sources.map((source): [string, string] => [source.id, source.sha256]));
  const incomingHashes: Map<string, string> = new Map(incoming.sources.map((source): [string, string] => [source.id, source.sha256]));
  const sourceIds: string[] = [...new Set([...currentHashes.keys(), ...incomingHashes.keys()])];
  return {
    changedSourceFileIds: sourceIds.filter((id: string): boolean => currentHashes.get(id) !== incomingHashes.get(id)),
    changedEntityIds: [...segmentIds.map((id: string): string => `segment:${id}`), ...unitIds.map((id: string): string => `unit:${id}`),
      ...sceneIds.map((id: string): string => `scene:${id}`), ...personIds.map((id: string): string => `person:${id}`),
      ...locationIds.map((id: string): string => `location:${id}`), ...instructionIds.map((id: string): string => `instruction:${id}`),
      ...placementIds.map((id: string): string => `text-placement:${id}`), ...informationIds.map((id: string): string => `information-rule:${id}`)],
    impactedSegmentIds, impactedShotIds, lockedShotIds, canApply: lockedShotIds.length === 0,
  };
}

function remapFrames(frames: readonly StoryboardFrame[], shotIds: ReadonlyMap<string, string>, frameIds: ReadonlyMap<string, string>): StoryboardFrame[] {
  return frames.map((frame: StoryboardFrame): StoryboardFrame => ({ ...frame, id: frameIds.get(frame.id) as string, shotId: shotIds.get(frame.shotId) ?? frame.shotId }));
}

function decisionStillValid(current: Project, incoming: Project, decision: TextMappingDecision): boolean {
  const currentPlacement: TextPlacement | undefined = current.dataset.textPlacements.find((placement: TextPlacement): boolean => placement.id === decision.placementId);
  const incomingPlacement: TextPlacement | undefined = incoming.dataset.textPlacements.find((placement: TextPlacement): boolean => placement.id === decision.placementId);
  if (JSON.stringify(currentPlacement) !== JSON.stringify(incomingPlacement)) return false;
  if (decision.canonicalUnitId === null) return true;
  const currentUnit: SourceUnit | undefined = current.dataset.units.find((unit: SourceUnit): boolean => unit.id === decision.canonicalUnitId);
  const incomingUnit: SourceUnit | undefined = incoming.dataset.units.find((unit: SourceUnit): boolean => unit.id === decision.canonicalUnitId);
  return JSON.stringify(currentUnit) === JSON.stringify(incomingUnit);
}

function mergeTextMappingDecisions(current: Project, incoming: Project): TextMappingDecision[] {
  return incoming.textMappingDecisions.map((next: TextMappingDecision): TextMappingDecision => {
    const prior: TextMappingDecision | undefined = current.textMappingDecisions.find((decision: TextMappingDecision): boolean => decision.placementId === next.placementId);
    if (prior === undefined) return next;
    if (decisionStillValid(current, incoming, prior)) return prior;
    return { ...next, status: 'unresolved', note: '원본 또는 Placement 변경으로 다시 확인해야 합니다.' };
  });
}

/** 새 원본이 직접 영향을 주는 구간만 새 뼈대로 교체하고 나머지 사용자 편집은 보존한다. */
export function applySourceUpdate(current: Project, incoming: Project, prefix: string): Project {
  const impact: SourceImpactReport = sourceImpact(current, incoming);
  if (!impact.canApply) throw contractError('SOURCE_UPDATE_LOCKED_IMPACT', `원본 변경이 잠긴 컷에 영향을 줍니다. 먼저 검토하고 잠금을 해제하세요: ${impact.lockedShotIds.join(', ')}`, []);
  const impacted: Set<string> = new Set<string>(impact.impactedSegmentIds);
  const incomingImpactedShots: Shot[] = incoming.shots.filter((shot: Shot): boolean => impacted.has(shot.segmentId));
  const shotIds: Map<string, string> = new Map(incomingImpactedShots.map((shot: Shot, index: number): [string, string] => [shot.id, `${prefix}:shot:${index + 1}`]));
  const incomingImpactedFrames: StoryboardFrame[] = incoming.frames.filter((frame: StoryboardFrame): boolean => incomingImpactedShots.some((shot: Shot): boolean => shot.id === frame.shotId));
  const frameIds: Map<string, string> = new Map(incomingImpactedFrames.map((frame: StoryboardFrame, index: number): [string, string] => [frame.id, `${prefix}:frame:${index + 1}`]));
  const replacementShots: Shot[] = incomingImpactedShots.map((shot: Shot): Shot => ({ ...shot, id: shotIds.get(shot.id) as string,
    sourceLinks: shot.sourceLinks.map((link) => link.temporalAnchor.kind === 'frame'
      ? { ...link, temporalAnchor: { ...link.temporalAnchor, frameId: frameIds.get(link.temporalAnchor.frameId) ?? link.temporalAnchor.frameId } } : link),
  }));
  const preservedShots: Shot[] = current.shots.filter((shot: Shot): boolean => !impacted.has(shot.segmentId) && incoming.dataset.segments.some((segment: Segment): boolean => segment.id === shot.segmentId));
  const shots: Shot[] = incoming.dataset.segments.flatMap((segment: Segment): Shot[] => [...preservedShots, ...replacementShots].filter((shot: Shot): boolean => shot.segmentId === segment.id));
  const preservedFrames: StoryboardFrame[] = current.frames.filter((frame: StoryboardFrame): boolean => preservedShots.some((shot: Shot): boolean => shot.id === frame.shotId));
  const replacementFrames: StoryboardFrame[] = remapFrames(incomingImpactedFrames, shotIds, frameIds);
  const preservedAudio: AudioCue[] = current.audioCues.filter((cue: AudioCue): boolean => {
    const unit = current.dataset.units.find((candidate): boolean => candidate.id === cue.unitId);
    return unit !== undefined && !impacted.has(unit.segmentId) && incoming.dataset.units.some((candidate): boolean => candidate.id === unit.id);
  });
  const replacementAudio: AudioCue[] = incoming.audioCues.filter((cue: AudioCue): boolean => impacted.has(incoming.dataset.units.find((unit): boolean => unit.id === cue.unitId)?.segmentId ?? '')).map((cue: AudioCue, index: number): AudioCue => ({ ...cue, id: `${prefix}:audio:${index + 1}` }));
  const preservedText: TextCue[] = current.textCues.filter((cue: TextCue): boolean => !impacted.has(cue.segmentId) && incoming.dataset.segments.some((segment: Segment): boolean => segment.id === cue.segmentId));
  const replacementText: TextCue[] = incoming.textCues.filter((cue: TextCue): boolean => impacted.has(cue.segmentId)).map((cue: TextCue, index: number): TextCue => ({ ...cue, id: `${prefix}:text:${index + 1}` }));
  const textMappingDecisions: TextMappingDecision[] = mergeTextMappingDecisions(current, incoming);
  const combinedText: TextCue[] = [...preservedText, ...replacementText];
  const holdMs: number = Math.max(1, ...combinedText.map((cue: TextCue): number => cue.endMs - cue.startMs));
  const base: Project = { ...incoming, revision: current.revision, profile: current.profile,
    shots, frames: [...preservedFrames, ...replacementFrames], audioCues: [...preservedAudio, ...replacementAudio], textCues: [...preservedText, ...replacementText],
    textMappingDecisions, assets: current.assets, generationRecords: current.generationRecords };
  const next: Project = ProjectSchema.parse({ ...base, textCues: reconcileTextCues(base, textMappingDecisions, holdMs) });
  assertNoErrors(validateProject(next, incoming.dataset), 'INVALID_SOURCE_UPDATE');
  return next;
}

import { contractError } from '../domain/errors.js';
import { segmentReferenceAssets } from '../domain/production-resources.js';
import type { Project, Shot, ShotSourceLink, StoryboardFrame } from '../domain/schema.js';
import type { AutomaticSegmentPlan, AutomaticShot, AutomaticSource } from './plan-schema.js';

export type PlannedShots = { shots: Shot[]; frames: StoryboardFrame[] };

function assertProductionReferences(project: Project, segmentId: string, shot: AutomaticShot): void {
  const plan = project.productionPlan?.segments.find((value): boolean => value.segmentId === segmentId);
  if (plan === undefined) return;
  const references = segmentReferenceAssets(project, segmentId);
  const ids: Set<string> = new Set(references.map((asset): string => asset.id));
  const foreign: string[] = [...shot.propIds, ...shot.continuityBefore.map((value): string => value.assetId), ...shot.continuityAfter.map((value): string => value.assetId)].filter((id): boolean => !ids.has(id));
  if (foreign.length > 0) throw contractError('AUTOMATION_PRODUCTION_REFERENCE_SCOPE',
    `propIds와 continuityBefore/After.assetId에는 제작 자원 ID가 아닌 현재 구간의 실제 이미지 자산 ID가 필요합니다: ${JSON.stringify({ segmentId, receivedIds: [...new Set(foreign)], referenceAssets: references.map((asset) => ({ id: asset.id, kind: asset.kind })), resourceAssetBindings: (project.productionPlan?.resources ?? []).filter((resource): boolean => plan.resourceIds.includes(resource.id)).map((resource) => ({ resourceId: resource.id, referenceAssetId: resource.referenceAssetId })) })}`, []);
  const visible: string[] = shot.presence.filter((presence): boolean => ['VISIBLE', 'HAND_ONLY', 'SILHOUETTE', 'ARCHIVE_IMAGE'].includes(presence.mode)).map((presence): string => presence.personId);
  const missing: string[] = visible.filter((id): boolean => !references.some((asset): boolean => asset.kind === 'character' && asset.subjectId === id));
  if (shot.visualMode === 'sourced' && shot.visualLocationId !== null && !references.some((asset): boolean => asset.kind === 'location' && asset.subjectId === shot.visualLocationId)) missing.push(shot.visualLocationId);
  if (missing.length > 0) throw contractError('AUTOMATION_PRODUCTION_REFERENCE_SCOPE', `화면 인물·장소에 연결된 실제 기준 이미지가 필요합니다: ${missing.join(', ')}`, []);
  if (shot.visualMode === 'sourced' && plan.visualLocationId !== null && shot.visualLocationId === null) throw contractError('AUTOMATION_PRODUCTION_REFERENCE_SCOPE', `${segmentId}: 지정한 제작 장소를 미정으로 바꾸지 마세요.`, []);
}

export function plannedSourceLink(project: Project, segmentId: string, shot: Pick<Shot, 'startMs' | 'endMs'>, link: AutomaticSource): ShotSourceLink {
  if (!project.dataset.units.some((unit): boolean => unit.id === link.unitId && unit.segmentId === segmentId)) throw contractError('AUTOMATION_UNKNOWN_SOURCE', `${segmentId}: 다른 구간 또는 알 수 없는 원문입니다: ${link.unitId}`, []);
  if (link.endOffsetMs <= link.startOffsetMs || link.endOffsetMs > shot.endMs - shot.startMs) throw contractError('AUTOMATION_SOURCE_INTERVAL', `${link.unitId}: 원문 표시 구간 ${link.startOffsetMs}..${link.endOffsetMs}가 컷 내부에 있어야 합니다.`, []);
  return { unitId: link.unitId, usage: link.usage, status: 'confirmed', temporalAnchor: { kind: 'shot-offset', startOffsetMs: link.startOffsetMs, endOffsetMs: link.endOffsetMs, status: 'confirmed', basis: 'proposal' } };
}

/** 기존 프레임을 유지하고 새 원문 공개 시점의 키 프레임만 추가한다. */
export function sourceRevealFrames(shot: Shot, explicit: readonly StoryboardFrame[], idPrefix: string): StoryboardFrame[] {
  const offsets: Set<number> = new Set(explicit.map((frame): number => frame.offsetMs));
  if (offsets.size !== explicit.length) throw contractError('AUTOMATION_FRAME_COLLISION', `${shot.id}: 명시한 프레임의 시각이 중복됩니다.`, []);
  const derivedOffsets: number[] = [...new Set(shot.sourceLinks.filter((link): boolean => ['primary-visual', 'continued-visual'].includes(link.usage)).flatMap((link): number[] => link.temporalAnchor.kind === 'shot-offset' ? [link.temporalAnchor.startOffsetMs] : []))]
    .filter((offset): boolean => offset > 0 && !offsets.has(offset)).sort((left, right): number => left - right);
  // 새 원문이 공개되는 시각에는 앞선 그림을 계속 쓰지 않도록 별도 검토 프레임을 둔다.
  const derived: StoryboardFrame[] = derivedOffsets.map((offset): StoryboardFrame => ({ id: `${idPrefix}:reveal:${offset}`, shotId: shot.id, offsetMs: offset, role: 'key', description: '', imageAssetId: null, visualReview: 'pending' }));
  return [...explicit, ...derived].sort((left, right): number => left.offsetMs - right.offsetMs);
}

export function compilePlannedShots(project: Project, plan: AutomaticSegmentPlan, generationId: string, maxFrames: number): PlannedShots {
  const shots: Shot[] = plan.shots.map((input, index): Shot => {
    assertProductionReferences(project, plan.segmentId, input);
    const links: ShotSourceLink[] = input.sourceLinks.map((link): ShotSourceLink => plannedSourceLink(project, plan.segmentId, input, link));
    const directIds: Set<string> = new Set(links.filter((link): boolean => ['primary-visual', 'continued-visual'].includes(link.usage)).map((link): string => link.unitId));
    return { id: `${generationId}:shot:${index}`, segmentId: plan.segmentId, startMs: input.startMs, endMs: input.endMs,
      visualMode: input.visualMode, sourceLinks: links, action: input.action, camera: { ...input.camera }, visualLocationId: input.visualLocationId,
      presence: input.presence.map((value) => ({ ...value })), propIds: [...input.propIds], continuityBefore: input.continuityBefore.map((value) => ({ ...value })), continuityAfter: input.continuityAfter.map((value) => ({ ...value })),
      cameraAxis: input.cameraAxis, screenDirection: input.screenDirection,
      informationIds: [...new Set(project.dataset.units.filter((unit): boolean => directIds.has(unit.id)).flatMap((unit): string[] => unit.informationIds))],
      transitionOut: { ...input.transitionOut }, proposalOrigin: 'model', approvalStatus: 'proposed', lockedFields: [] };
  });
  const frames: StoryboardFrame[] = shots.flatMap((shot, index): StoryboardFrame[] => {
    const input: AutomaticShot | undefined = plan.shots[index];
    if (input === undefined) throw contractError('AUTOMATION_SHOT_PLAN_MISSING', `컷 계획을 찾을 수 없습니다: ${shot.id}`, []);
    const explicit: StoryboardFrame[] = input.frames.map((frame, index): StoryboardFrame => ({ ...frame, id: `${shot.id}:frame:${index}`, shotId: shot.id, imageAssetId: null, visualReview: 'pending' }));
    return sourceRevealFrames(shot, explicit, shot.id);
  });
  if (!Number.isSafeInteger(maxFrames) || maxFrames < 1 || frames.length > maxFrames) throw contractError('AUTOMATION_FRAME_BUDGET', `파생 프레임을 포함한 ${frames.length}개가 실행 한도 ${maxFrames}개를 초과합니다.`, []);
  return { shots, frames };
}

import { z } from 'zod';
import { assertNoErrors, contractError } from './errors.js';
import type { Issue, Project, Shot, ShotSourceLink, StoryboardFrame, TextMappingDecision, TextPlacement, TextPlacementInformationDecision } from './schema.js';
import { IdSchema, ProjectSchema } from './schema.js';
import { validateProject } from './validation.js';

export const TextPlacementInformationInputSchema = z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('unresolved'), informationIds: z.tuple([]), note: z.string().nullable() }),
  z.strictObject({ status: z.literal('non-informational'), informationIds: z.tuple([]), note: z.string().nullable() }),
  z.strictObject({ status: z.literal('informational'), informationIds: z.array(IdSchema).min(1), note: z.string().nullable() }),
]);
export type TextPlacementInformationInput = z.infer<typeof TextPlacementInformationInputSchema>;

export function isIndependentTextRelation(relation: TextMappingDecision['relation']): boolean {
  return relation === 'separate-element' || relation === 'standalone-placement';
}

function unresolvedDecision(mapping: TextMappingDecision): TextPlacementInformationDecision {
  return { id: `placement-info:${mapping.placementId}`, placementId: mapping.placementId, status: 'unresolved', informationIds: [], note: null };
}

export function createInitialPlacementInformationDecisions(mappings: readonly TextMappingDecision[]): TextPlacementInformationDecision[] {
  return mappings.filter((mapping: TextMappingDecision): boolean => isIndependentTextRelation(mapping.relation)).map(unresolvedDecision);
}

export function synchronizePlacementInformationDecisions(
  current: readonly TextPlacementInformationDecision[], previous: TextMappingDecision, next: TextMappingDecision,
): TextPlacementInformationDecision[] {
  const withoutPlacement: TextPlacementInformationDecision[] = current.filter((decision: TextPlacementInformationDecision): boolean => decision.placementId !== next.placementId);
  if (!isIndependentTextRelation(next.relation)) return withoutPlacement;
  const existing: TextPlacementInformationDecision | undefined = current.find((decision: TextPlacementInformationDecision): boolean => decision.placementId === next.placementId);
  if (isIndependentTextRelation(previous.relation) && existing !== undefined) return [...withoutPlacement, existing];
  return [...withoutPlacement, unresolvedDecision(next)];
}

function invalidateTextAnchors(shot: Shot): Shot {
  return { ...shot, approvalStatus: 'proposed', sourceLinks: shot.sourceLinks.map((link: ShotSourceLink): ShotSourceLink =>
    link.temporalAnchor.kind === 'shot-offset' && link.temporalAnchor.basis === 'text-cue'
      ? { ...link, status: 'mapping-required', temporalAnchor: { kind: 'unresolved', basis: 'mapping-change', status: 'review-required' } } : link) };
}

/** 독립 Placement의 정보성 판정을 저장하고 해당 시각 근거를 보수적으로 무효화한다. */
export function updatePlacementInformationDecision(project: Project, placementId: string, input: TextPlacementInformationInput): Project {
  const parsed: TextPlacementInformationInput = TextPlacementInformationInputSchema.parse(input);
  const placement: TextPlacement | undefined = project.dataset.textPlacements.find((candidate: TextPlacement): boolean => candidate.id === placementId);
  if (placement === undefined) throw contractError('TEXT_PLACEMENT_NOT_FOUND', `자막 위치를 찾을 수 없습니다: ${placementId}`, []);
  const mapping: TextMappingDecision | undefined = project.textMappingDecisions.find((candidate: TextMappingDecision): boolean => candidate.placementId === placementId);
  if (mapping === undefined || !isIndependentTextRelation(mapping.relation)) {
    throw contractError('PLACEMENT_INFORMATION_NOT_APPLICABLE', `${placementId}: 독립 Placement 관계에서만 정보 판정을 저장할 수 있습니다.`, []);
  }
  const unknownIds: string[] = parsed.informationIds.filter((id: string): boolean => !project.dataset.informationRules.some((rule): boolean => rule.id === id));
  if (unknownIds.length > 0) throw contractError('INVALID_PLACEMENT_INFORMATION_ID', `${placementId}: 존재하지 않는 Information ID입니다: ${unknownIds.join(', ')}`, []);
  const current: TextPlacementInformationDecision | undefined = project.textPlacementInformationDecisions.find((decision: TextPlacementInformationDecision): boolean => decision.placementId === placementId);
  if (current === undefined) throw contractError('PLACEMENT_INFORMATION_DECISION_NOT_FOUND', `${placementId}: 독립 정보 판정을 찾을 수 없습니다.`, []);
  const decision: TextPlacementInformationDecision = { ...current, ...parsed };
  const affectedShots: Shot[] = project.shots.filter((shot: Shot): boolean => shot.segmentId === placement.segmentId).map(invalidateTextAnchors);
  const affectedIds: Set<string> = new Set<string>(affectedShots.map((shot: Shot): string => shot.id));
  const candidate: Project = ProjectSchema.parse({ ...project,
    textPlacementInformationDecisions: project.textPlacementInformationDecisions.map((value: TextPlacementInformationDecision): TextPlacementInformationDecision => value.id === current.id ? decision : value),
    shots: project.shots.map((shot: Shot): Shot => affectedIds.has(shot.id) ? affectedShots.find((candidateShot: Shot): boolean => candidateShot.id === shot.id) ?? shot : shot),
    frames: project.frames.map((frame: StoryboardFrame): StoryboardFrame => affectedIds.has(frame.shotId) ? { ...frame, visualReview: 'pending' } : frame),
  });
  const errors: Issue[] = validateProject(candidate, project.dataset).filter((value: Issue): boolean => value.severity === 'error');
  assertNoErrors(errors, 'INVALID_PLACEMENT_INFORMATION_DECISION');
  return candidate;
}

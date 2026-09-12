import { audioCuesInSegment } from '../domain/audio-source.js';
import { z } from 'zod';
import { automaticAudioProtected, automaticShotProtected } from '../domain/edit-protection.js';
export { automaticShotProtected } from '../domain/edit-protection.js';
import { contractError } from '../domain/errors.js';
import { HashSchema, IdSchema } from '../domain/schema.js';
import type { Project, Shot } from '../domain/schema.js';
import { automaticHash } from './application-evidence.js';
import { AutomaticAudioTimingSchema, AutomaticSourceSchema } from './plan-schema.js';

const RepairTargetSchema = z.strictObject({ shotId: IdSchema, linkIndex: z.number().int().nonnegative(), unitId: IdSchema });
export const SourceRepairBasisSchema = z.strictObject({
  projectId: IdSchema, revision: z.number().int().nonnegative(), projectHash: HashSchema, segmentId: IdSchema,
  targets: z.array(RepairTargetSchema).max(4096), audioCueIds: z.array(IdSchema).max(256), speechCueIds: z.array(IdSchema).max(256),
});
export const SourceRepairPlanSchema = z.strictObject({
  schemaVersion: z.literal('1.0.0'), segmentId: IdSchema, summary: z.string().trim().min(1).max(4000),
  links: z.array(AutomaticSourceSchema.extend({ shotId: IdSchema, linkIndex: z.number().int().nonnegative() })).max(4096),
});
export const SourceRepairSpeechPlanSchema = SourceRepairPlanSchema.extend({ schemaVersion: z.literal('1.1.0'), audioTimings: z.array(AutomaticAudioTimingSchema).max(256) });
export const SourceRepairAudioPlanSchema = SourceRepairSpeechPlanSchema.extend({ schemaVersion: z.literal('1.2.0') });
export const SourceRepairResultSchema = z.discriminatedUnion('schemaVersion', [SourceRepairPlanSchema, SourceRepairSpeechPlanSchema, SourceRepairAudioPlanSchema]);
export type SourceRepairBasis = z.infer<typeof SourceRepairBasisSchema>;
export type SourceRepairPlan = z.infer<typeof SourceRepairResultSchema>;
export type SourceRepairScope = Pick<SourceRepairBasis, 'targets' | 'audioCueIds' | 'speechCueIds'>;

/** 기존 미정 링크·미측정 음원과 보호된 컷에 걸치지 않는 미등록 발화를 선택한다. */
export function sourceRepairScope(project: Project, segmentId: string): SourceRepairScope {
  const shots: Shot[] = project.shots.filter((shot): boolean => shot.segmentId === segmentId && !automaticShotProtected(project, shot));
  const selected = audioCuesInSegment(project, segmentId);
  const audioCueIds: string[] = selected.filter((cue): boolean => cue.assetId !== null && cue.timingStatus !== 'measured' && !automaticAudioProtected(project, cue)).map((cue): string => cue.id);
  const speechCueIds: string[] = selected.filter((cue): boolean => cue.assetId === null && cue.timingStatus === 'proposed'
    && ['dialogue', 'voiceover', 'panel'].includes(cue.kind) && !automaticAudioProtected(project, cue)).map((cue): string => cue.id);
  const audioUnits: Set<string> = new Set(project.audioCues.filter((cue): boolean => audioCueIds.includes(cue.id) || speechCueIds.includes(cue.id)).flatMap((cue): string[] => cue.unitId === null ? [] : [cue.unitId]));
  const targets: SourceRepairScope['targets'] = shots.flatMap((shot): SourceRepairScope['targets'] => shot.sourceLinks.flatMap((link, linkIndex): SourceRepairScope['targets'] => {
    const pending: boolean = link.status !== 'confirmed' || link.temporalAnchor.status !== 'confirmed';
    const changedAudio: boolean = link.usage === 'audio-only' && audioUnits.has(link.unitId) && link.temporalAnchor.basis === 'proposal';
    return pending || changedAudio ? [{ shotId: shot.id, linkIndex, unitId: link.unitId }] : [];
  }));
  return { targets, audioCueIds, speechCueIds };
}

export function createSourceRepairBasis(project: Project, segmentId: string): SourceRepairBasis {
  if (!project.dataset.segments.some((segment): boolean => segment.id === segmentId)) throw contractError('SEGMENT_NOT_FOUND', `연결 검토 구간이 없습니다: ${segmentId}`, []);
  const scope: SourceRepairScope = sourceRepairScope(project, segmentId);
  if (scope.targets.length === 0 && scope.audioCueIds.length === 0 && scope.speechCueIds.length === 0) throw contractError('AUTOMATION_NO_REPAIR', `${segmentId}: 보존된 컷에서 자동 보완할 미정 연결·음원이 없습니다.`, []);
  return SourceRepairBasisSchema.parse({ projectId: project.projectId, revision: project.revision, projectHash: automaticHash(project), segmentId, ...scope });
}

export function assertSourceRepairBasis(project: Project, input: SourceRepairBasis): void {
  const basis: SourceRepairBasis = SourceRepairBasisSchema.parse(input);
  if (basis.projectId !== project.projectId || basis.revision !== project.revision || basis.projectHash !== automaticHash(project)) throw contractError('AUTOMATION_STALE_PLAN', '연결 검토 이후 프로젝트가 변경되었습니다. 현재 컷 편집을 보존했습니다.', []);
  if (automaticHash(createSourceRepairBasis(project, basis.segmentId)) !== automaticHash(basis)) throw contractError('AUTOMATION_REPAIR_SCOPE', '보완할 링크·음원 범위가 현재 미정 입력과 다릅니다.', []);
}

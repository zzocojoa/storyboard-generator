import { z } from 'zod';
import { contractError } from '../domain/errors.js';
import type { GenerationRecord, Project, Shot, StoryboardFrame } from '../domain/schema.js';
import { stableJsonStringify } from '../io/stable-json.js';

export const StoryboardDensitySchema = z.strictObject({
  version: z.literal('1.0.0'), detail: z.enum(['source-led', 'concise', 'detailed']),
  longHoldReviewMs: z.number().int().min(1000).max(180000),
});
export type StoryboardDensity = z.infer<typeof StoryboardDensitySchema>;
export type StoryboardHold = { segmentId: string; shotId: string; frameId: string; startMs: number; endMs: number; durationMs: number };
export type StoryboardDensityReview = {
  version: '1.0.0'; revision: number; segmentIds: string[]; policy: StoryboardDensity;
  shotCount: number; frameCount: number; imageFrameCount: number; excludedImageFrameCount: number;
  roles: { start: number; key: number; end: number }; longHolds: StoryboardHold[];
};
export const densityDetailLabels: Record<StoryboardDensity['detail'], string> = { 'source-led': '원문에 맞춤', concise: '간략', detailed: '상세' };

/** 작품의 고정 컷 수가 아닌, 화면에서 수정할 수 있는 초기 연출 선호다. */
export function recommendedStoryboardDensity(): StoryboardDensity {
  return { version: '1.0.0', detail: 'source-led', longHoldReviewMs: 15000 };
}

function longShotHolds(shot: Shot, frames: readonly StoryboardFrame[], policy: StoryboardDensity): StoryboardHold[] {
  if (shot.visualMode !== 'sourced') return [];
  const ordered: StoryboardFrame[] = frames.filter((frame): boolean => frame.shotId === shot.id).toSorted((a, b): number => a.offsetMs - b.offsetMs);
  return ordered.flatMap((frame, index): StoryboardHold[] => {
    const startMs: number = shot.startMs + frame.offsetMs;
    const endMs: number = Math.min(shot.endMs, shot.startMs + (ordered[index + 1]?.offsetMs ?? shot.endMs - shot.startMs));
    return endMs - startMs > policy.longHoldReviewMs ? [{ segmentId: shot.segmentId, shotId: shot.id, frameId: frame.id, startMs, endMs, durationMs: endMs - startMs }] : [];
  });
}

/** 실제 파생 프레임까지 집계하며 긴 그림 표시는 연출 검토로 남기고 사람 승인을 바꾸지 않는다. */
export function inspectStoryboardDensity(project: Project, segmentIds: readonly string[], policy: StoryboardDensity): StoryboardDensityReview {
  StoryboardDensitySchema.parse(policy);
  if (new Set(segmentIds).size !== segmentIds.length || segmentIds.some((id): boolean => !project.dataset.segments.some((segment): boolean => segment.id === id))) throw contractError('AUTOMATION_DENSITY_SCOPE', '표현 밀도 검토에는 현재 프로젝트의 중복 없는 구간 ID가 필요합니다.', []);
  const shots: Shot[] = project.shots.filter((shot): boolean => segmentIds.includes(shot.segmentId));
  const shotIds: Set<string> = new Set(shots.map((shot): string => shot.id));
  const imageShotIds: Set<string> = new Set(shots.filter((shot): boolean => shot.visualMode === 'sourced').map((shot): string => shot.id));
  const frames: StoryboardFrame[] = project.frames.filter((frame): boolean => shotIds.has(frame.shotId));
  const imageFrameCount: number = frames.filter((frame): boolean => imageShotIds.has(frame.shotId)).length;
  return { version: '1.0.0', revision: project.revision, segmentIds: [...segmentIds], policy: structuredClone(policy),
    shotCount: shots.length, frameCount: frames.length, imageFrameCount, excludedImageFrameCount: frames.length - imageFrameCount,
    roles: { start: frames.filter((frame): boolean => frame.role === 'start').length, key: frames.filter((frame): boolean => frame.role === 'key').length, end: frames.filter((frame): boolean => frame.role === 'end').length },
    longHolds: shots.flatMap((shot): StoryboardHold[] => longShotHolds(shot, frames, policy)) };
}

/** 신규 계획의 표현 설정과 실제 개수만 해당 기록에 추가한다. 과거 생성 기록은 보존한다. */
export function recordStoryboardDensityReview(before: Project, candidate: Project, generationId: string, review: StoryboardDensityReview): Project {
  if (before.generationRecords.some((record): boolean => record.id === generationId)) throw contractError('AUTOMATION_DUPLICATE_GENERATION', `과거 기록에 표현 밀도 검토를 추가할 수 없습니다: ${generationId}`, []);
  const record: GenerationRecord | undefined = candidate.generationRecords.find((value): boolean => value.id === generationId);
  if (record === undefined) throw contractError('AUTOMATION_DENSITY_RECORD_MISSING', `표현 밀도 검토를 연결할 신규 기록이 없습니다: ${generationId}`, []);
  const envelope = z.record(z.string(), z.json()).parse(JSON.parse(record.prompt));
  const output: GenerationRecord = { ...record, prompt: stableJsonStringify({ ...envelope, densityReview: review }) };
  return { ...candidate, generationRecords: candidate.generationRecords.map((value): GenerationRecord => value.id === generationId ? output : value) };
}

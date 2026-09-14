import { z } from 'zod';

export const REVIEW_PLAYBACK_RATES = [0.5, 0.75, 1, 1.25, 1.5, 2] as const;
export const ReviewPlaybackRateSchema = z.union([z.literal(0.5), z.literal(0.75), z.literal(1), z.literal(1.25), z.literal(1.5), z.literal(2)]);
export type ReviewPlaybackRate = z.infer<typeof ReviewPlaybackRateSchema>;
const PreferenceSchema = z.strictObject({ version: z.literal(1), projectId: z.string(), rate: ReviewPlaybackRateSchema });

export function reviewPlaybackKey(projectId: string): string { return `cutroom:review-playback:1:${encodeURIComponent(projectId)}`; }

/** 검토 속도는 원문 시간표·합성 속도와 분리한 브라우저 선호다. 손상된 저장값을 추측하지 않는다. */
export function readReviewPlaybackRate(storage: Pick<Storage, 'getItem'>, projectId: string): ReviewPlaybackRate {
  const raw: string | null = storage.getItem(reviewPlaybackKey(projectId));
  if (raw === null) return 1;
  const record = PreferenceSchema.parse(JSON.parse(raw));
  if (record.projectId !== projectId) throw new Error('검토 속도 기록의 프로젝트가 일치하지 않습니다.');
  return record.rate;
}

export function writeReviewPlaybackRate(storage: Pick<Storage, 'setItem' | 'getItem'>, projectId: string, rate: ReviewPlaybackRate): void {
  const text: string = JSON.stringify(PreferenceSchema.parse({ version: 1, projectId, rate }));
  const key: string = reviewPlaybackKey(projectId);
  storage.setItem(key, text);
  if (storage.getItem(key) !== text) throw new Error('검토 속도 기록을 저장한 뒤 확인하지 못했습니다.');
}

/** 단조 시계의 경과 시간을 원본 ms로 환산한다. 음원·컷·글자는 이 위치를 함께 사용한다. */
export function reviewPlayhead(originMs: number, elapsedMs: number, rate: ReviewPlaybackRate, totalMs: number): number {
  return Math.min(totalMs, Math.floor(originMs + Math.max(0, elapsedMs) * rate));
}

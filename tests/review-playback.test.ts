import { describe, expect, it } from 'vitest';
import { BrowserAudioController } from '../web/src/audio-lifecycle.js';
import type { AudioElementPort } from '../web/src/audio-lifecycle.js';
import { readReviewPlaybackRate, reviewPlaybackKey, reviewPlayhead, writeReviewPlaybackRate } from '../web/src/review-playback.js';

describe('검토 재생 속도', (): void => {
  it('review_speed_keeps_project_preferences_separate_and_rejects_corrupt_or_unpersisted_records', (): void => {
    const records = new Map<string, string>();
    const storage = { getItem: (key: string): string | null => records.get(key) ?? null, setItem: (key: string, value: string): void => { records.set(key, value); } };
    expect(readReviewPlaybackRate(storage, 'A')).toBe(1);
    writeReviewPlaybackRate(storage, 'A', 0.5); writeReviewPlaybackRate(storage, 'B', 2);
    expect(readReviewPlaybackRate(storage, 'A')).toBe(0.5); expect(readReviewPlaybackRate(storage, 'B')).toBe(2);
    records.set(reviewPlaybackKey('A'), '{'); expect(() => readReviewPlaybackRate(storage, 'A')).toThrow();
    records.set(reviewPlaybackKey('A'), JSON.stringify({ version: 1, projectId: 'B', rate: 1 })); expect(() => readReviewPlaybackRate(storage, 'A')).toThrow('프로젝트');
    records.set(reviewPlaybackKey('A'), JSON.stringify({ version: 1, projectId: 'A', rate: 0 })); expect(() => readReviewPlaybackRate(storage, 'A')).toThrow();
    expect(() => writeReviewPlaybackRate({ getItem: storage.getItem, setItem: (): void => {} }, 'A', 1)).toThrow('확인하지 못했습니다');
    expect(() => writeReviewPlaybackRate({ getItem: storage.getItem, setItem: (): never => { throw new Error('Quota'); } }, 'A', 1)).toThrow('Quota');
  });

  it('review_speed_changes_media_deadline_and_corrects_delayed_audio_in_original_timeline_units', (): void => {
    let deadline: number = 0; let stop: (() => void) | null = null; let pauses: number = 0; let plays: number = 0; let nextTimer: number = 0;
    const canceled: number[] = [];
    const media: AudioElementPort = { currentTime: 0, volume: 1, playbackRate: 1, play: async (): Promise<void> => { plays += 1; }, pause: (): void => { pauses += 1; } };
    const controller = new BrowserAudioController(() => media, { schedule: (callback, delay): number => { deadline = delay; stop = callback; nextTimer += 1; return nextTimer; }, cancel: (timerId): void => { canceled.push(timerId); } });
    const cue = { id: 'cue', startMs: 1000, endMs: 5000, mix: { version: '1.0.0' as const, mode: 'manual' as const, volumeDb: -6, plannedInputHash: null, reason: '음량 검토', fadeInMs: 2000, fadeOutMs: 0 } };
    controller.start('A', cue, 2000, '/a.wav', 0.5, (error): never => { throw error; });
    expect(deadline).toBe(6000); expect(media.playbackRate).toBe(0.5); expect(media.currentTime).toBe(1);
    expect(media.volume).toBeCloseTo(0.25059, 4);
    controller.reconcile('A', 3200, true, 0.5); expect(media.currentTime).toBe(2.2); expect(media.volume).toBeCloseTo(0.50118, 4);
    if (stop === null) throw new Error('종료 타이머가 없습니다.');
    const previousStop: () => void = stop;
    controller.reconcile('A', 3200, true, 2);
    expect(deadline).toBe(900); expect(media.currentTime).toBe(2.2); expect(media.playbackRate).toBe(2);
    expect(plays).toBe(1); expect(pauses).toBe(0); expect(canceled).toEqual([1]);
    previousStop(); expect(controller.activeCount()).toBe(1);
    if (stop === null) throw new Error('종료 타이머가 없습니다.');
    (stop as () => void)(); expect(pauses).toBe(1); expect(controller.activeCount()).toBe(0);
  });

  it('review_clock_keeps_seek_origin_and_original_duration_at_slow_fast_and_end_boundaries', (): void => {
    expect(reviewPlayhead(5000, -10, 2, 17500)).toBe(5000);
    expect(reviewPlayhead(5000, 1000, 0.5, 17500)).toBe(5500);
    expect(reviewPlayhead(5500, 1000, 2, 17500)).toBe(7500);
    expect(reviewPlayhead(17500, 1000, 2, 17500)).toBe(17500);
  });
});

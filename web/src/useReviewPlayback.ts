import { useEffect, useState } from 'react';
import { readReviewPlaybackRate, writeReviewPlaybackRate } from './review-playback.js';
import type { ReviewPlaybackRate } from './review-playback.js';

type PlaybackState = { projectId: string | null; rate: ReviewPlaybackRate | null; error: string | null };
export type ReviewPlaybackPreference = { rate: ReviewPlaybackRate | null; error: string | null; setRate: (rate: ReviewPlaybackRate) => void };

/** 탭에서 선택한 속도를 유지하고, 프로젝트를 다시 열 때만 저장 선호를 읽는다. 복원은 재생을 시작하지 않는다. */
export function useReviewPlayback(projectId: string | null): ReviewPlaybackPreference {
  const [state, setState] = useState<PlaybackState>({ projectId: null, rate: null, error: null });
  useEffect((): void => {
    if (projectId === null) { setState({ projectId, rate: null, error: null }); return; }
    try { setState({ projectId, rate: readReviewPlaybackRate(window.localStorage, projectId), error: null }); }
    catch (error: unknown) { setState({ projectId, rate: null, error: `검토 속도를 복원하지 못했습니다. 속도를 다시 선택하세요. ${error instanceof Error ? error.message : String(error)}` }); }
  }, [projectId]);
  const setRate = (rate: ReviewPlaybackRate): void => {
    if (projectId === null) return;
    try { writeReviewPlaybackRate(window.localStorage, projectId, rate); setState({ projectId, rate, error: null }); }
    catch (error: unknown) { setState({ projectId, rate, error: `선택한 속도는 현재 화면에만 적용됩니다. 브라우저 저장 실패: ${error instanceof Error ? error.message : String(error)}` }); }
  };
  return { rate: state.projectId === projectId ? state.rate : null, error: state.projectId === projectId ? state.error : null, setRate };
}

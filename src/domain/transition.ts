import { issue } from './errors.js';
import type { Issue, Shot, Transition, TransitionIncomingExposure } from './schema.js';

export type TransitionVisualPolicy = {
  incomingExposure: TransitionIncomingExposure; transitionStartMs: number; transitionEndMs: number;
  incomingRevealMs: number | null; issues: Issue[];
};

/** 기존 전환 종류의 고유 의미만 사용하며 custom 메모를 해석하지 않는다. */
export function intrinsicIncomingExposure(kind: Transition['kind']): TransitionIncomingExposure {
  if (kind === 'cut' || kind === 'fade') return 'none';
  if (kind === 'custom') return 'review-required';
  return 'from-transition-start';
}

/** 안전성 판정용 노출 시점을 계산하며 영상 합성 방식과 분리한다. */
export function transitionVisualPolicy(transition: Transition, outgoing: Shot, incoming: Shot | null): TransitionVisualPolicy {
  const exposure: TransitionIncomingExposure = transition.incomingExposure ?? intrinsicIncomingExposure(transition.kind);
  const startMs: number = outgoing.endMs - transition.durationMs;
  const review: Issue[] = exposure === 'review-required' ? [issue('TRANSITION_VISUAL_POLICY_REVIEW_REQUIRED', 'conflict', outgoing.id, 'transitionOut.incomingExposure',
    '다음 영상의 노출 정책을 명시적으로 확정하세요. 전환 메모만으로 공개 시점을 판단하지 않습니다.', 'explicit incoming exposure', exposure, [])] : [];
  const invalidKind: boolean = exposure !== 'review-required' && transition.kind !== 'custom'
    && exposure !== intrinsicIncomingExposure(transition.kind) && !(transition.kind === 'fade' && exposure === 'after-black-midpoint');
  const kindIssues: Issue[] = invalidKind ? [issue('INVALID_TRANSITION_VISUAL_POLICY', 'conflict', outgoing.id, 'transitionOut.incomingExposure',
    '전환 종류와 다음 영상 노출 정책이 일치하지 않습니다. 종류 또는 노출 정책을 검토하세요.', intrinsicIncomingExposure(transition.kind), exposure, [])] : [];
  const timingValid: boolean = transition.kind === 'cut' ? transition.durationMs === 0 : transition.durationMs > 0 && startMs >= outgoing.startMs;
  const timingIssues: Issue[] = timingValid ? [] : [issue('INVALID_TRANSITION_DURATION', 'conflict', outgoing.id, 'transitionOut.durationMs',
    '전환 길이를 컷 내부의 유효한 시간으로 지정하세요.', transition.kind === 'cut' ? '0' : `1..${outgoing.endMs - outgoing.startMs}`, String(transition.durationMs), [])];
  const exposes: boolean = exposure === 'from-transition-start' || exposure === 'after-black-midpoint';
  const adjacencyIssues: Issue[] = exposes && (incoming === null || incoming.startMs !== outgoing.endMs) ? [issue('TRANSITION_INCOMING_SHOT_REQUIRED', 'conflict', outgoing.id, 'transitionOut',
    '이 전환에는 시간상 인접한 다음 컷이 필요합니다.', 'contiguous incoming shot', incoming?.id ?? null, [])] : [];
  const issues: Issue[] = [...review, ...kindIssues, ...timingIssues, ...adjacencyIssues];
  return { incomingExposure: exposure, transitionStartMs: startMs, transitionEndMs: outgoing.endMs,
    incomingRevealMs: exposes && issues.length === 0 ? startMs + (exposure === 'after-black-midpoint' ? Math.ceil(transition.durationMs / 2) : 0) : null, issues };
}

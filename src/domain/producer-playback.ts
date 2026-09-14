import { reviewProducerFrameBitmap } from './frame-output.js';
import type { Project, StoryboardFrame } from './schema.js';
import { resolveVisualPlaybackAt } from './visual-output.js';
import type { VisualOutputAtDecision } from './visual-output.js';

export type ProducerVisualDecision = Omit<VisualOutputAtDecision, 'channel'> & {
  channel: 'producer-review'; layer: 'current' | 'incoming'; visualReview: StoryboardFrame['visualReview'] | null;
};

function producerDecision(project: Project, decision: VisualOutputAtDecision, layer: ProducerVisualDecision['layer']): ProducerVisualDecision {
  return { ...decision, channel: 'producer-review', layer,
    visualReview: project.frames.find((frame): boolean => frame.id === decision.sourceFrameId)?.visualReview ?? null };
}

/** 검토할 현재 그림을 선택한다. Project와 사람 승인 상태는 변경하지 않는다. */
export function reviewProducerVisualAt(project: Project, playheadMs: number): ProducerVisualDecision {
  return producerDecision(project, resolveVisualPlaybackAt(project, playheadMs, 'program-monitor', reviewProducerFrameBitmap), 'current');
}

/** 전환의 실제 노출 시각에서 다음 그림의 원문 공개 조건을 동일하게 검사한다. */
export function reviewProducerTransitionAt(project: Project, playheadMs: number): ProducerVisualDecision {
  return producerDecision(project, resolveVisualPlaybackAt(project, playheadMs, 'transition-preview', reviewProducerFrameBitmap), 'incoming');
}

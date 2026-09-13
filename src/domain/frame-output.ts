import { frameInformationIds, reviewInformationEmission } from './emission.js';
import { issue } from './errors.js';
import { reviewIssuesForFrame } from './mapping.js';
import type { Asset, Issue, Project, Shot, StoryboardFrame } from './schema.js';
import { frameEvaluationAbsoluteMs } from './time.js';
import { transitionVisualPolicy } from './transition.js';
import { reviewVisualOutputAt } from './visual-output.js';

export type FrameOutputChannel = 'program-monitor' | 'transition-preview' | 'pdf-export' | 'csv-export' | 'safe-http' | 'readiness';
export type FrameOutputDecision = {
  frameId: string;
  channel: FrameOutputChannel;
  renderMode: 'bitmap' | 'black' | 'hold-previous' | 'blocked';
  renderBitmap: boolean;
  imageAssetId: string | null;
  sourceFrameId: string | null;
  issues: Issue[];
};

function uniqueIssues(values: readonly Issue[]): Issue[] {
  const keys: Set<string> = new Set<string>();
  return values.filter((value: Issue): boolean => {
    const key: string = `${value.code}\u0000${value.entityId}\u0000${value.field}`;
    if (keys.has(key)) return false;
    keys.add(key);
    return true;
  });
}

/** 검토용 원본 자산은 보존하면서 안전 출력 채널의 bitmap 사용 여부만 판정한다. */
export function reviewFrameOutput(project: Project, frameId: string, channel: FrameOutputChannel): FrameOutputDecision {
  const frame: StoryboardFrame | undefined = project.frames.find((candidate: StoryboardFrame): boolean => candidate.id === frameId);
  if (frame === undefined) {
    return { frameId, channel, renderMode: 'blocked', renderBitmap: false, imageAssetId: null, sourceFrameId: null, issues: [issue('FRAME_NOT_FOUND', 'conflict', frameId, 'id',
      '출력할 프레임을 찾을 수 없습니다.', 'existing frame', frameId, [])] };
  }
  const shot: Shot | undefined = project.shots.find((candidate: Shot): boolean => candidate.id === frame.shotId);
  if (shot !== undefined && channel === 'transition-preview') {
    const previous: Shot | undefined = project.shots[project.shots.indexOf(shot) - 1];
    const policy = previous === undefined ? null : transitionVisualPolicy(previous.transitionOut, previous, shot);
    if (previous === undefined || policy?.incomingRevealMs === null || policy === null || policy.incomingRevealMs >= previous.endMs) return {
      frameId, channel, renderMode: 'blocked', renderBitmap: false, imageAssetId: null, sourceFrameId: null,
      issues: policy !== null && policy.issues.length > 0 ? policy.issues : [issue('TRANSITION_PREVIEW_INACTIVE', 'conflict', frameId, 'transitionOut', '현재 전환은 다음 Frame을 먼저 노출하지 않습니다.', 'active incoming exposure', null, [])],
    };
    const resolved = reviewVisualOutputAt(project, policy.incomingRevealMs, channel);
    const frameIssues: Issue[] = shot.visualMode === 'sourced' && resolved.frameId !== frameId ? [issue('TRANSITION_FRAME_NOT_ACTIVE', 'conflict', frameId, 'offsetMs',
      '전환 시작 시각에는 이 Frame이 활성 상태가 아닙니다.', resolved.frameId, frameId, [])] : [];
    return { frameId, channel, renderMode: frameIssues.length === 0 ? resolved.renderMode : 'blocked', renderBitmap: resolved.imageAssetId !== null && resolved.renderMode !== 'blocked' && frameIssues.length === 0,
      imageAssetId: frameIssues.length === 0 ? resolved.imageAssetId : null, sourceFrameId: resolved.sourceFrameId, issues: [...resolved.issues, ...frameIssues] };
  }
  if (shot !== undefined && shot.visualMode !== 'sourced') {
    const resolved = reviewVisualOutputAt(project, frameEvaluationAbsoluteMs(shot, frame), channel);
    return { frameId, channel, renderMode: resolved.renderMode, renderBitmap: resolved.imageAssetId !== null && resolved.renderMode !== 'blocked',
      imageAssetId: resolved.imageAssetId, sourceFrameId: resolved.sourceFrameId, issues: resolved.issues };
  }
  return reviewFrameBitmap(project, frame, channel);
}

function frameReviewIssues(frame: StoryboardFrame): Issue[] {
  return frame.visualReview === 'accepted' ? [] : [issue(
    frame.visualReview === 'rejected' ? 'FRAME_OUTPUT_REJECTED' : 'FRAME_OUTPUT_REVIEW_REQUIRED', 'conflict', frame.id, 'visualReview',
    frame.visualReview === 'rejected' ? '거부된 프레임 이미지는 안전 출력에 사용할 수 없습니다.' : '검토가 끝나지 않은 프레임 이미지는 안전 출력에 사용할 수 없습니다.',
    'accepted', frame.visualReview, [],
  )];
}

/** 안전 출력은 사람의 그림 승인과 원문·시각 검사를 모두 요구한다. */
export function reviewFrameBitmap(project: Project, frame: StoryboardFrame, channel: FrameOutputChannel): FrameOutputDecision {
  if (channel === 'transition-preview') return reviewFrameOutput(project, frame.id, channel);
  return frameBitmapDecision(project, frame, channel, frameReviewIssues(frame));
}

/** 제작자에게 pending 그림을 검토용으로 보여 주되 거부·원문·시각 오류는 보존한다. */
export function reviewProducerFrameBitmap(project: Project, frame: StoryboardFrame, channel: FrameOutputChannel): FrameOutputDecision {
  return frameBitmapDecision(project, frame, channel, frame.visualReview === 'pending' ? [] : frameReviewIssues(frame));
}

function frameBitmapDecision(project: Project, frame: StoryboardFrame, channel: FrameOutputChannel, reviewIssues: readonly Issue[]): FrameOutputDecision {
  const frameId: string = frame.id;
  const shot: Shot | undefined = project.shots.find((candidate: Shot): boolean => candidate.id === frame.shotId);
  const asset: Asset | undefined = frame.imageAssetId === null ? undefined
    : project.assets.find((candidate: Asset): boolean => candidate.id === frame.imageAssetId);
  const assetIssues: Issue[] = frame.imageAssetId === null
    ? [issue('FRAME_IMAGE_REQUIRED_FOR_OUTPUT', 'conflict', frame.id, 'imageAssetId', '안전 출력에는 검토할 이미지가 필요합니다.', 'image asset', 'null', [])]
    : asset === undefined || asset.kind !== 'image'
      ? [issue('FRAME_OUTPUT_ASSET_INVALID', 'conflict', frame.id, 'imageAssetId', '프레임 이미지 자산을 찾을 수 없거나 유형이 다릅니다.', 'image asset', frame.imageAssetId, [])]
      : asset.subjectId !== frame.id
        ? [issue('FRAME_OUTPUT_ASSET_SUBJECT_MISMATCH', 'conflict', frame.id, 'imageAssetId', '이미지 자산의 대상 프레임이 일치하지 않습니다.', frame.id, String(asset.subjectId), [])] : [];
  const emissionIssues: Issue[] = shot === undefined ? [] : reviewInformationEmission(project, {
    entityId: frame.id, channel: 'image', informationIds: frameInformationIds(project, frame.id), atMs: frameEvaluationAbsoluteMs(shot, frame),
  });
  const issues: Issue[] = uniqueIssues([...assetIssues, ...reviewIssues, ...reviewIssuesForFrame(project, frame.id), ...emissionIssues]);
  return { frameId, channel, renderMode: issues.length === 0 ? 'bitmap' : 'blocked', renderBitmap: issues.length === 0, imageAssetId: frame.imageAssetId, sourceFrameId: frame.id, issues };
}

export function frameOutputPlaceholderText(decision: FrameOutputDecision, description: string): string {
  return `${decision.frameId}\n${decision.issues.map((value: Issue): string => value.code).join(', ') || description}`;
}

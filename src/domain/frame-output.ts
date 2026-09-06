import { frameInformationIds, reviewInformationEmission } from './emission.js';
import { issue } from './errors.js';
import { reviewIssuesForFrame } from './mapping.js';
import type { Asset, Issue, Project, Shot, StoryboardFrame } from './schema.js';
import { frameEvaluationAbsoluteMs } from './time.js';

export type FrameOutputChannel = 'program-monitor' | 'transition-preview' | 'pdf-export' | 'csv-export';
export type FrameOutputDecision = {
  frameId: string;
  channel: FrameOutputChannel;
  renderBitmap: boolean;
  imageAssetId: string | null;
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

function frameOutputEvaluationMs(project: Project, shot: Shot, frame: StoryboardFrame, channel: FrameOutputChannel): number {
  if (channel !== 'transition-preview') return frameEvaluationAbsoluteMs(shot, frame);
  const shotIndex: number = project.shots.findIndex((candidate: Shot): boolean => candidate.id === shot.id);
  const previousShot: Shot | undefined = shotIndex > 0 ? project.shots[shotIndex - 1] : undefined;
  if (previousShot === undefined || previousShot.endMs !== shot.startMs || previousShot.transitionOut.kind === 'cut') {
    return frameEvaluationAbsoluteMs(shot, frame);
  }
  return Math.max(previousShot.startMs, previousShot.endMs - previousShot.transitionOut.durationMs);
}

/** 검토용 원본 자산은 보존하면서 안전 출력 채널의 bitmap 사용 여부만 판정한다. */
export function reviewFrameOutput(project: Project, frameId: string, channel: FrameOutputChannel): FrameOutputDecision {
  const frame: StoryboardFrame | undefined = project.frames.find((candidate: StoryboardFrame): boolean => candidate.id === frameId);
  if (frame === undefined) {
    return { frameId, channel, renderBitmap: false, imageAssetId: null, issues: [issue('FRAME_NOT_FOUND', 'conflict', frameId, 'id',
      '출력할 프레임을 찾을 수 없습니다.', 'existing frame', frameId, [])] };
  }
  const asset: Asset | undefined = frame.imageAssetId === null ? undefined
    : project.assets.find((candidate: Asset): boolean => candidate.id === frame.imageAssetId);
  const assetIssues: Issue[] = frame.imageAssetId === null
    ? [issue('FRAME_IMAGE_REQUIRED_FOR_OUTPUT', 'conflict', frame.id, 'imageAssetId', '안전 출력에는 검토할 이미지가 필요합니다.', 'image asset', 'null', [])]
    : asset === undefined || asset.kind !== 'image'
      ? [issue('FRAME_OUTPUT_ASSET_INVALID', 'conflict', frame.id, 'imageAssetId', '프레임 이미지 자산을 찾을 수 없거나 유형이 다릅니다.', 'image asset', frame.imageAssetId, [])]
      : asset.subjectId !== frame.id
        ? [issue('FRAME_OUTPUT_ASSET_SUBJECT_MISMATCH', 'conflict', frame.id, 'imageAssetId', '이미지 자산의 대상 프레임이 일치하지 않습니다.', frame.id, String(asset.subjectId), [])] : [];
  const reviewIssues: Issue[] = frame.visualReview === 'accepted' ? [] : [issue(
    frame.visualReview === 'rejected' ? 'FRAME_OUTPUT_REJECTED' : 'FRAME_OUTPUT_REVIEW_REQUIRED', 'conflict', frame.id, 'visualReview',
    frame.visualReview === 'rejected' ? '거부된 프레임 이미지는 안전 출력에 사용할 수 없습니다.' : '검토가 끝나지 않은 프레임 이미지는 안전 출력에 사용할 수 없습니다.',
    'accepted', frame.visualReview, [],
  )];
  const shot: Shot | undefined = project.shots.find((candidate: Shot): boolean => candidate.id === frame.shotId);
  const emissionIssues: Issue[] = shot === undefined ? [] : reviewInformationEmission(project, {
    entityId: frame.id, channel: 'image', informationIds: frameInformationIds(project, frame.id), atMs: frameOutputEvaluationMs(project, shot, frame, channel),
  });
  const issues: Issue[] = uniqueIssues([...assetIssues, ...reviewIssues, ...reviewIssuesForFrame(project, frame.id), ...emissionIssues]);
  return { frameId, channel, renderBitmap: issues.length === 0, imageAssetId: frame.imageAssetId, issues };
}

export function frameOutputPlaceholderText(decision: FrameOutputDecision, description: string): string {
  return `${decision.frameId}\n${decision.issues.map((value: Issue): string => value.code).join(', ') || description}`;
}

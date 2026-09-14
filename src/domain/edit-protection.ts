import type { AudioCue, Project, Shot } from './schema.js';

/** 자동 작업이 변경할 수 없는 컷·그림 승인을 공통으로 판단한다. */
export function automaticShotProtected(project: Project, shot: Shot): boolean {
  return shot.approvalStatus === 'approved' || shot.lockedFields.length > 0
    || project.frames.some((frame): boolean => frame.shotId === shot.id && frame.visualReview === 'accepted');
}

/** 같은 원문이나 재생 구간을 사용하는 보호 컷도 음향 변경에서 보존한다. */
export function automaticAudioProtected(project: Project, cue: AudioCue): boolean {
  return project.shots.some((shot): boolean => automaticShotProtected(project, shot)
    && (shot.sourceLinks.some((link): boolean => link.unitId === cue.unitId) || shot.startMs < cue.endMs && cue.startMs < shot.endMs));
}

/** 명시적 음성 재생성은 컷 확정·잠금을 지킨다. 그림 승인은 그림과 공개 시각을 보존한 후보 검사로 보호한다. */
export function speechRetakeProtected(project: Project, cue: AudioCue): boolean {
  return project.shots.some((shot): boolean => (shot.approvalStatus === 'approved' || shot.lockedFields.length > 0)
    && (shot.sourceLinks.some((link): boolean => link.unitId === cue.unitId) || shot.startMs < cue.endMs && cue.startMs < shot.endMs));
}

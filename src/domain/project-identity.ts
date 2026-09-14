import { z } from 'zod';
import { contractError } from './errors.js';
import type { Project } from './schema.js';

/** 기존 저장본은 작업 ID가 원본 ID이며, 독립 콘티는 원본 식별자를 별도로 보존한다. */
export function sourceProjectId(project: Project): string {
  return project.storyboardIdentity === undefined ? project.projectId : project.storyboardIdentity.sourceProjectId;
}

export function validStoryboardIdentity(project: Project): boolean {
  return project.storyboardIdentity === undefined || (project.projectId.startsWith('storyboard:') && z.uuid().safeParse(project.projectId.slice(11)).success);
}

/** 생성 시 확정한 작업과 원본의 연결은 편집 과정에서 다른 이야기로 바꿀 수 없다. */
export function assertStoryboardIdentityTransition(previous: Project, next: Project): void {
  if (JSON.stringify(previous.storyboardIdentity) !== JSON.stringify(next.storyboardIdentity)) {
    throw contractError('STORYBOARD_IDENTITY_CHANGED', '콘티의 원본 식별 정보는 변경할 수 없습니다. 다른 원본은 별도 콘티로 시작하세요.', []);
  }
}

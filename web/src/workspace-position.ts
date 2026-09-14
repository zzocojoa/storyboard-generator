import { z } from 'zod';
import type { Project } from '../../src/domain/schema.js';

export const WorkspacePositionSchema = z.strictObject({
  version: z.literal(1), projectId: z.string(),
  page: z.enum(['overview', 'editor', 'settings', 'review']),
  inspector: z.enum(['direction', 'sources', 'frames', 'audio', 'text']),
  segmentId: z.string(), shotId: z.string(), playhead: z.number().int().nonnegative(),
});
export type WorkspacePosition = z.infer<typeof WorkspacePositionSchema>;
export function workspacePositionKey(projectId: string): string { return `cutroom:workspace:1:${encodeURIComponent(projectId)}`; }

export function readWorkspacePosition(storage: Pick<Storage, 'getItem'>, project: Project): WorkspacePosition | null {
  const raw: string | null = storage.getItem(workspacePositionKey(project.projectId));
  if (raw === null) return null;
  const saved: WorkspacePosition = WorkspacePositionSchema.parse(JSON.parse(raw) as unknown);
  if (saved.projectId !== project.projectId) throw new Error('작업 위치의 프로젝트가 일치하지 않습니다.');
  if (!project.dataset.segments.some((segment): boolean => segment.id === saved.segmentId)
    || !project.shots.some((shot): boolean => shot.id === saved.shotId && shot.segmentId === saved.segmentId)) {
    throw new Error('이전에 편집한 구간·컷이 현재 원본에 없습니다. 장면 목록에서 작업 위치를 다시 선택하세요.');
  }
  const duration: number = project.dataset.segments.at(-1)?.endMs ?? 0;
  if (saved.playhead > duration) throw new Error('저장한 재생 위치가 현재 영상 길이를 넘습니다. 재생 위치를 다시 선택하세요.');
  return saved;
}

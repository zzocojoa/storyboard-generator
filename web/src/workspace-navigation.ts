import type { Issue, Project, Shot } from '../../src/domain/schema.js';

export type WorkspacePage = 'overview' | 'editor' | 'settings' | 'review';
export type InspectorPage = 'direction' | 'sources' | 'frames' | 'audio' | 'text';
export type EditDestination = { segmentId: string; shotId: string; page: InspectorPage; settingsSection?: 'text-layout' | 'text-readability' | 'text-typography' };
export type ReviewGroup = { page: InspectorPage; title: string; description: string; issues: Issue[] };

export const inspectorPages: readonly { id: InspectorPage; label: string; hint: string }[] = [
  { id: 'direction', label: '연출', hint: '행동·카메라·등장인물을 정하고 컷을 저장하세요.' },
  { id: 'sources', label: '원문 연결', hint: '원문이 화면에 나타나는 구간과 공개 순서를 확인하세요.' },
  { id: 'frames', label: '그림', hint: '프레임을 설계하고 이미지를 생성·검토하세요.' },
  { id: 'audio', label: '음성', hint: '대사·음향 지시와 콘티 시각을 검토하세요. 실제 음성 재생은 선택 기능입니다.' },
  { id: 'text', label: '글자', hint: '구간의 문구 연결과 표시 시간을 확인하고 확정하세요.' },
];

export function issueEditorPage(issue: Issue): InspectorPage {
  if (/^(TEXT|PLACEMENT|CANONICAL|SCREEN_TEXT)/u.test(issue.code)) return 'text';
  if (/AUDIO|SPEECH|WAV/u.test(issue.code)) return 'audio';
  if (/^(FRAME|IMAGE|ASSET)/u.test(issue.code)) return 'frames';
  if (/SOURCE|INFORMATION|COVERAGE|ANCHOR/u.test(issue.code)) return 'sources';
  return 'direction';
}

/** 대상 엔티티의 실제 소속을 찾아 검토 항목에서 편집기로 이동한다. */
export function issueDestination(project: Project, issue: Issue): EditDestination | null {
  if (issue.field === 'textTypography') return { segmentId: project.dataset.segments[0]?.id ?? '', shotId: project.shots[0]?.id ?? '', page: 'text', settingsSection: 'text-typography' };
  const directShot: Shot | undefined = project.shots.find((shot: Shot): boolean => shot.id === issue.entityId);
  const frame = project.frames.find((value): boolean => value.id === issue.entityId);
  const frameShot = project.shots.find((value): boolean => value.id === frame?.shotId);
  const audio = project.audioCues.find((value): boolean => value.id === issue.entityId);
  const text = project.textCues.find((value): boolean => value.id === issue.entityId);
  const mapping = project.textMappingDecisions.find((value): boolean => value.id === issue.entityId);
  const placement = project.dataset.textPlacements.find((value): boolean => value.id === issue.entityId || value.id === mapping?.placementId);
  const unit = project.dataset.units.find((value): boolean => value.id === issue.entityId || value.id === audio?.unitId);
  const rule = project.dataset.informationRules.find((value): boolean => value.id === issue.entityId);
  const instruction = project.dataset.instructions.find((value): boolean => value.id === issue.entityId || value.id === audio?.instructionId);
  const segmentId: string | undefined = directShot?.segmentId ?? frameShot?.segmentId ?? text?.segmentId ?? placement?.segmentId ?? unit?.segmentId ?? rule?.segmentId
    ?? instruction?.segmentId ?? project.dataset.segments.find((value): boolean => value.id === issue.entityId)?.id;
  if (segmentId === undefined) return null;
  const shotId: string = directShot?.id ?? frameShot?.id ?? project.shots.find((value): boolean => value.segmentId === segmentId)?.id ?? '';
  return { segmentId, shotId, page: audio !== undefined ? 'audio' : text !== undefined || mapping !== undefined || placement !== undefined ? 'text' : issueEditorPage(issue),
    ...(issue.field === 'textLayout' ? { settingsSection: 'text-layout' as const } : issue.field === 'textReadability' ? { settingsSection: 'text-readability' as const } : {}) };
}

export function reviewGroups(issues: readonly Issue[]): ReviewGroup[] {
  return inspectorPages.map((page): ReviewGroup => ({ page: page.id, title: page.label, description: page.hint,
    issues: issues.filter((issue: Issue): boolean => issueEditorPage(issue) === page.id),
  })).filter((group: ReviewGroup): boolean => group.issues.length > 0);
}

export function segmentModeLabel(mode: string): string {
  const labels: Readonly<Record<string, string>> = { DRAMA: '재연', NARRATION: '내레이션', PANEL_REACTION: '패널', INTERVIEW: '인터뷰', B_ROLL: '보조 화면' };
  return labels[mode] ?? mode;
}

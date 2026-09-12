import type { Project, Shot } from '../../src/domain/schema.js';
import { audioCueSource } from '../../src/domain/audio-source.js';
import { activeBrowserDrafts, draftPrefix, readBrowserDrafts } from './browser-drafts.js';
import type { BrowserDraft, DraftStorage } from './browser-drafts.js';
import type { EditDestination, InspectorPage } from './workspace-navigation.js';

export type DraftArchiveDestination = { kind: 'settings' } | { kind: 'editor'; editor: EditDestination };
export type DraftArchiveTarget = { label: string; entityId: string | null; state: 'present' | 'missing' | 'unknown'; destination: DraftArchiveDestination | null };
export type DraftArchiveEntry = { record: BrowserDraft; target: DraftArchiveTarget; concurrent: boolean };
export type DraftArchiveIssue = { scope: string; message: string };
export type DraftArchive = { entries: DraftArchiveEntry[]; issues: DraftArchiveIssue[] };
type EditorScope = { scope: string; kind: string; entityId: string | null };
const labels: ReadonlyMap<string, string> = new Map([
  ['audio-instruction', '음향 지시 판정'],
  ['direction', '컷 연출'], ['visual-plan', '원문 연결'], ['frame', '프레임 설명·시각'],
  ['audio-timing', '음성 시각'], ['audio-mix', '음량·페이드'], ['speech-retake', '발화 선택 생성·발음 보완'],
  ['text-timing', '글자 시각'], ['text-presentation', '개별 글자 배치'],
  ['text-authority', '글자 본문 근거'], ['text-mapping', '원문·자막 연결'], ['placement-information', '글자 정보성'],
  ['profile', '제작 프로필'], ['text-layout', '글자 배치'], ['text-readability', '글자 읽기 기준'], ['text-typography', '글꼴과 언어'],
]);

/** 키의 프로젝트를 먼저 확인한다. 가져오기·생성 영수증·다른 프로젝트의 값은 읽지 않는다. */
function editorScope(key: string, projectId: string): EditorScope | null {
  const prefix: string = 'cutroom:draft:1:';
  if (!key.startsWith(prefix)) return null;
  let scope: string; let parts: unknown;
  try { scope = decodeURIComponent(key.slice(prefix.length, key.lastIndexOf(':'))); parts = JSON.parse(scope) as unknown; }
  catch (error: unknown) { if (error instanceof SyntaxError || error instanceof URIError) return null; throw error; }
  if (!Array.isArray(parts) || parts[0] !== projectId || typeof parts[1] !== 'string' || parts.length < 2 || parts.length > 3
    || parts.length === 3 && typeof parts[2] !== 'string' || !key.startsWith(draftPrefix(scope))) return null;
  return { scope, kind: parts[1], entityId: parts.length === 3 ? parts[2] as string : null };
}

function shotDestination(shot: Shot | undefined, page: InspectorPage): DraftArchiveDestination | null {
  return shot === undefined ? null : { kind: 'editor', editor: { segmentId: shot.segmentId, shotId: shot.id, page } };
}

function currentTarget(project: Project, scope: EditorScope): DraftArchiveTarget {
  const label: string = labels.get(scope.kind) ?? `이전 편집 항목 · ${scope.kind}`;
  const base = { label, entityId: scope.entityId };
  if (!labels.has(scope.kind)) return { ...base, state: 'unknown', destination: null };
  if (['profile', 'text-layout', 'text-readability', 'text-typography'].includes(scope.kind)) {
    return scope.entityId === null ? { ...base, state: 'present', destination: { kind: 'settings' } } : { ...base, state: 'unknown', destination: null };
  }
  if (scope.entityId === null) return { ...base, state: 'unknown', destination: null };
  const id: string = scope.entityId;
  let destination: DraftArchiveDestination | null;
  let exists: boolean;
  if (scope.kind === 'direction' || scope.kind === 'visual-plan') {
    const shot = project.shots.find((value): boolean => value.id === id); exists = shot !== undefined;
    destination = shotDestination(shot, scope.kind === 'direction' ? 'direction' : 'sources');
  } else if (scope.kind === 'frame') {
    const frame = project.frames.find((value): boolean => value.id === id); exists = frame !== undefined;
    destination = shotDestination(project.shots.find((value): boolean => value.id === frame?.shotId), 'frames');
  } else {
    let segmentId: string | undefined;
    if (scope.kind === 'audio-instruction') {
      const instruction = project.dataset.instructions.find((value): boolean => value.id === id); exists = instruction !== undefined; segmentId = instruction?.segmentId;
    } else if (scope.kind === 'audio-timing' || scope.kind === 'audio-mix' || scope.kind === 'speech-retake') {
      const cue = project.audioCues.find((value): boolean => value.id === id); exists = cue !== undefined;
      segmentId = cue === undefined ? undefined : audioCueSource(project, cue)?.segmentId;
    } else if (scope.kind === 'text-timing' || scope.kind === 'text-authority' || scope.kind === 'text-presentation') {
      const cue = project.textCues.find((value): boolean => value.id === id); exists = cue !== undefined; segmentId = cue?.segmentId;
    } else if (scope.kind === 'text-mapping') {
      const mapping = project.textMappingDecisions.find((value): boolean => value.id === id); exists = mapping !== undefined;
      segmentId = project.dataset.textPlacements.find((value): boolean => value.id === mapping?.placementId)?.segmentId;
    } else {
      const placement = project.dataset.textPlacements.find((value): boolean => value.id === id); exists = placement !== undefined; segmentId = placement?.segmentId;
    }
    destination = shotDestination(project.shots.find((value): boolean => value.segmentId === segmentId), scope.kind.startsWith('audio-') || scope.kind === 'speech-retake' ? 'audio' : 'text');
  }
  return { ...base, state: exists ? 'present' : 'missing', destination };
}

/** 임시 값의 과거 편집 스키마를 현재 입력으로 강제 변환하지 않고 JSON 그대로 열람한다. */
export function readProjectDraftArchive(storage: DraftStorage, project: Project): DraftArchive {
  const scopes: Map<string, EditorScope> = new Map();
  for (let index: number = 0; index < storage.length; index += 1) {
    const key: string | null = storage.key(index);
    if (key === null) throw new Error('임시 기록 목록이 조회 중 변경됐습니다. 기록 다시 읽기를 실행하세요.');
    const scope: EditorScope | null = editorScope(key, project.projectId); if (scope !== null) scopes.set(scope.scope, scope);
  }
  const entries: DraftArchiveEntry[] = []; const issues: DraftArchiveIssue[] = [];
  for (const scope of scopes.values()) {
    try {
      const records: BrowserDraft[] = activeBrowserDrafts(readBrowserDrafts(storage, scope.scope));
      for (const record of records) { draftArchiveText(record); draftArchiveBasis(record); }
      entries.push(...records.map((record: BrowserDraft): DraftArchiveEntry => ({ record, target: currentTarget(project, scope), concurrent: records.length > 1 })));
    } catch (error: unknown) {
      issues.push({ scope: scope.scope, message: `이 항목의 기록 형식·저장소를 확인하지 못했습니다. 원본 기록은 보존했습니다. ${error instanceof Error ? error.message : String(error)}` });
    }
  }
  return { entries: entries.sort((left, right): number => right.record.savedAt.localeCompare(left.record.savedAt) || left.record.id.localeCompare(right.record.id)), issues };
}

export function draftArchiveText(record: BrowserDraft): string {
  return JSON.stringify(JSON.parse(record.value!) as unknown, null, 2);
}

export function draftArchiveBasis(record: BrowserDraft): string {
  const basis = JSON.parse(record.basis) as [string, string];
  return JSON.stringify({ 기준: basis[1], 편집전값: JSON.parse(basis[0]) as unknown }, null, 2);
}

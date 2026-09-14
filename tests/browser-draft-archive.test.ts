import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { readProjectDraftArchive, draftArchiveBasis, draftArchiveText } from '../web/src/browser-draft-archive.js';
import { draftPrefix, draftReference, writeBrowserDraft } from '../web/src/browser-drafts.js';
import type { BrowserDraft, DraftStorage } from '../web/src/browser-drafts.js';
import { readinessOutline } from './readiness-fixtures.js';
import { automaticPlanProject } from './automatic-plan-helpers.js';
import { twoPropCandidate } from './prop-continuity-helpers.js';

function storageFixture(): DraftStorage {
  const values: Map<string, string> = new Map();
  return { get length(): number { return values.size; }, key: (index: number): string | null => [...values.keys()][index] ?? null,
    getItem: (key: string): string | null => values.get(key) ?? null, setItem: (key: string, value: string): void => { values.set(key, value); } };
}
function record(scope: string, value: unknown): BrowserDraft {
  return { version: 1, scope, id: randomUUID(), sequence: 1, savedAt: '2026-09-11T00:00:00.000Z',
    basis: JSON.stringify([JSON.stringify({ action: '편집 전 내용' }), '0']), value: JSON.stringify(value), replaces: [] };
}
function snapshot(storage: DraftStorage): string[] {
  return Array.from({ length: storage.length }, (_value: unknown, index: number): string => storage.getItem(storage.key(index)!)!);
}

it('browser_draft_archive_retains_reference_corrections_for_active_unused_and_missing_resources', async (): Promise<void> => {
  const original = (await twoPropCandidate(await automaticPlanProject())).project;
  const [unused, active] = original.productionPlan!.resources;
  const project = { ...original, productionPlan: { ...original.productionPlan!, segments: original.productionPlan!.segments.map((segment) => ({ ...segment, resourceIds: segment.resourceIds.filter((id): boolean => id !== unused!.id) })) } };
  const storage = storageFixture();
  for (const id of [active!.id, unused!.id, project.shots[0]!.id]) writeBrowserDraft(storage,
    record(JSON.stringify([project.projectId, 'reference-retake', id]), { baseResourceId: unused!.id, continuityReason: '같은 소품 원문 근거', correctionNote: '판형 유지 요청' }));
  const before = snapshot(storage); const archive = readProjectDraftArchive(storage, project);
  expect(archive.issues).toEqual([]); expect(archive.entries).toHaveLength(3);
  expect(archive.entries.find((entry): boolean => entry.target.entityId === active!.id)!.target).toEqual({ label: '기준 이미지 수정 요청·소품 연결', entityId: active!.id, state: 'present', destination: { kind: 'settings' } });
  for (const id of [unused!.id, project.shots[0]!.id]) expect(archive.entries.find((entry): boolean => entry.target.entityId === id)!.target).toMatchObject({ state: 'missing', destination: null });
  expect(archive.entries.every((entry): boolean => draftArchiveText(entry.record).includes('판형 유지 요청'))).toBe(true);
  expect(snapshot(storage)).toEqual(before);
});

it('browser_draft_archive_finds_missing_entities_and_keeps_cross_project_and_receipt_values_private', async (): Promise<void> => {
  const project = await readinessOutline(); const storage = storageFixture();
  const missing = record(JSON.stringify([project.projectId, 'direction', 'deleted-shot']), { action: '보관할 연출', formerlySupported: true });
  const oldSpeech = record(JSON.stringify([project.projectId, 'speech-retake', 'replaced-audio']), { readings: [{ source: '이전 원문', spoken: '이전 읽는 방법' }] });
  const current = record(JSON.stringify([project.projectId, 'frame', project.frames[0]!.id]), { description: '현재 프레임' });
  const unknown = record(JSON.stringify([project.projectId, 'old-kind', 'old-id']), { text: '옛 값' });
  const settings = record(JSON.stringify([project.projectId, 'profile']), { medium: 'unknown-old-value' });
  const other = record(JSON.stringify([`${project.projectId}:other`, 'direction', 'deleted-shot']), { action: '다른 프로젝트 비공개 내용' });
  const receipt = record(`review-bundle-attempts:${project.projectId}`, { recoveryKey: '복구 비공개 키' });
  for (const entry of [missing, oldSpeech, current, unknown, settings, other, receipt]) writeBrowserDraft(storage, entry);
  const before = snapshot(storage); const archive = readProjectDraftArchive(storage, project);
  expect(archive.issues).toEqual([]); expect(archive.entries).toHaveLength(5);
  expect(archive.entries.find((entry): boolean => entry.record.id === missing.id)!.target).toMatchObject({ state: 'missing', destination: null });
  expect(archive.entries.find((entry): boolean => entry.record.id === oldSpeech.id)!.target).toEqual({ label: '발화 선택 생성·발음 보완', entityId: 'replaced-audio', state: 'missing', destination: null });
  expect(archive.entries.find((entry): boolean => entry.record.id === current.id)!.target.destination).toEqual({ kind: 'editor', editor: { page: 'frames', shotId: project.frames[0]!.shotId, segmentId: project.shots[0]!.segmentId } });
  expect(archive.entries.find((entry): boolean => entry.record.id === unknown.id)!.target).toMatchObject({ state: 'unknown', destination: null });
  expect(archive.entries.find((entry): boolean => entry.record.id === settings.id)!.target.destination).toEqual({ kind: 'settings' });
  expect(draftArchiveText(missing)).toContain('formerlySupported'); expect(draftArchiveBasis(missing)).toContain('편집 전 내용');
  expect(JSON.stringify(archive)).not.toContain('다른 프로젝트 비공개 내용'); expect(JSON.stringify(archive)).not.toContain('복구 비공개 키'); expect(snapshot(storage)).toEqual(before);
});

it('browser_draft_archive_retains_concurrent_writers_and_applies_only_explicit_supersession', async (): Promise<void> => {
  const project = await readinessOutline(); const storage = storageFixture(); const scope: string = JSON.stringify([project.projectId, 'text-timing', 'removed-cue']);
  const first = record(scope, { endMs: -5 }); const second = record(scope, { endMs: 9000 });
  writeBrowserDraft(storage, first); writeBrowserDraft(storage, second);
  let archive = readProjectDraftArchive(storage, project); expect(archive.entries).toHaveLength(2); expect(archive.entries.every((entry): boolean => entry.concurrent)).toBe(true);
  const chosen: BrowserDraft = { ...second, sequence: 2, replaces: [draftReference(first)] }; writeBrowserDraft(storage, chosen);
  archive = readProjectDraftArchive(storage, project); expect(archive.entries.map((entry): string => entry.record.id)).toEqual([second.id]);
  writeBrowserDraft(storage, { ...first, sequence: 2, value: JSON.stringify({ endMs: 5000 }) });
  archive = readProjectDraftArchive(storage, project); expect(archive.entries).toHaveLength(2);
  const before = snapshot(storage); expect(archive.entries.every((entry): boolean => entry.target.state === 'missing')).toBe(true); expect(snapshot(storage)).toEqual(before);
});

it('browser_draft_archive_isolates_corrupt_scope_without_discarding_valid_drafts_or_invalid_baselines', async (): Promise<void> => {
  const project = await readinessOutline(); const storage = storageFixture();
  const good = record(JSON.stringify([project.projectId, 'frame', 'deleted-frame']), { description: '보존할 설명' });
  const broken = record(JSON.stringify([project.projectId, 'direction', 'deleted-shot']), { action: '보존' });
  const invalidBasis: BrowserDraft = { ...record(JSON.stringify([project.projectId, 'audio-mix', 'deleted-audio']), { volumeDb: -3 }), basis: JSON.stringify(['{invalid', '0']) };
  const tooDeep: BrowserDraft = { ...record(JSON.stringify([project.projectId, 'frame', 'damaged-depth']), null), value: '['.repeat(20000) + '0' + ']'.repeat(20000) };
  writeBrowserDraft(storage, good); writeBrowserDraft(storage, invalidBasis); storage.setItem(draftPrefix(broken.scope) + broken.id, '{corrupt');
  writeBrowserDraft(storage, tooDeep);
  const before = snapshot(storage); const archive = readProjectDraftArchive(storage, project);
  expect(archive.entries.map((entry): string => entry.record.id)).toEqual([good.id]); expect(archive.issues).toHaveLength(3);
  expect(archive.issues.every((issue): boolean => issue.message.includes('보존했습니다'))).toBe(true); expect(snapshot(storage)).toEqual(before);
});

it('browser_draft_archive_resolves_each_entity_kind_without_confusing_reused_identifiers', async (): Promise<void> => {
  const original = await readinessOutline(); const storage = storageFixture(); const reusedId: string = original.shots[0]!.id;
  const audio = { ...original.audioCues[0]!, id: reusedId };
  const project = { ...original, audioCues: [audio, ...original.audioCues.slice(1)] };
  const pairs: readonly [string, string][] = [['audio-timing', reusedId], ['audio-mix', reusedId], ['speech-retake', reusedId],
    ...project.textCues.flatMap((cue): [string, string][] => [['text-timing', cue.id], ['text-authority', cue.id]]),
    ...project.textMappingDecisions.map((value): [string, string] => ['text-mapping', value.id]),
    ...project.dataset.textPlacements.map((value): [string, string] => ['placement-information', value.id])];
  for (const [kind, id] of pairs) writeBrowserDraft(storage, record(JSON.stringify([project.projectId, kind, id]), { note: '검토할 값' }));
  const archive = readProjectDraftArchive(storage, project); expect(archive.issues).toEqual([]); expect(archive.entries).toHaveLength(pairs.length);
  for (const entry of archive.entries) {
    expect(entry.target.state).toBe('present'); expect(entry.target.destination?.kind).toBe('editor');
    if (entry.target.destination?.kind === 'editor') expect(entry.target.destination.editor.page).toBe(entry.record.scope.includes('audio-') || entry.record.scope.includes('speech-retake') ? 'audio' : 'text');
  }
  const unit = project.dataset.units.find((value): boolean => value.id === audio.unitId)!;
  expect(archive.entries.find((entry): boolean => entry.record.scope.includes('audio-mix'))!.target.destination).toMatchObject({ editor: { segmentId: unit.segmentId, page: 'audio' } });
});

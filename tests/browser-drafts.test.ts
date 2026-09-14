import { describe, expect, test } from 'vitest';
import { activeBrowserDrafts, draftPrefix, draftReference, readBrowserDrafts, writeBrowserDraft } from '../web/src/browser-drafts.js';
import type { BrowserDraft, DraftStorage } from '../web/src/browser-drafts.js';

function storageFixture(): DraftStorage {
  const data: Map<string, string> = new Map<string, string>();
  return { get length(): number { return data.size; }, key: (index: number): string | null => [...data.keys()][index] ?? null,
    getItem: (key: string): string | null => data.get(key) ?? null, setItem: (key: string, value: string): void => { data.set(key, value); } };
}
function record(id: string, value: string): BrowserDraft {
  return { version: 1, scope: 'project-a:direction:shot-1', id, sequence: 1, savedAt: '2026-09-11T00:00:00.000Z',
    basis: JSON.stringify([JSON.stringify('source'), '0']), value: JSON.stringify(value), replaces: [] };
}
const firstId: string = 'a851954e-a250-4448-aadf-0d25d0cf6f00';
const secondId: string = 'b851954e-a250-4448-aadf-0d25d0cf6f00';

describe('browser draft preservation', (): void => {
  test('browser_draft_fork_preserves_concurrent_writer_after_explicit_selection', (): void => {
    const storage: DraftStorage = storageFixture(); const first: BrowserDraft = record(firstId, 'first tab');
    writeBrowserDraft(storage, first);
    const second: BrowserDraft = { ...record(secondId, 'second tab'), replaces: [draftReference(first)] };
    writeBrowserDraft(storage, second);
    expect(activeBrowserDrafts(readBrowserDrafts(storage, first.scope))).toEqual([second]);
    const later: BrowserDraft = { ...first, sequence: 2, value: JSON.stringify('later first tab edit') };
    writeBrowserDraft(storage, later);
    expect(activeBrowserDrafts(readBrowserDrafts(storage, first.scope))).toHaveLength(2);
    const selection: BrowserDraft = { ...second, sequence: 2, replaces: [draftReference(later)] };
    writeBrowserDraft(storage, selection);
    expect(activeBrowserDrafts(readBrowserDrafts(storage, first.scope))).toEqual([selection]);
    expect(readBrowserDrafts(storage, first.scope)).toContainEqual(later);
  });
  test('browser_draft_discard_preserves_other_scope_and_rejects_stale_sequence', (): void => {
    const storage: DraftStorage = storageFixture(); const first: BrowserDraft = record(firstId, 'draft');
    const other: BrowserDraft = { ...record(secondId, 'other project'), scope: 'project-b:direction:shot-1' };
    writeBrowserDraft(storage, first); writeBrowserDraft(storage, other);
    const discard: BrowserDraft = { ...record(secondId, 'discard'), value: null, replaces: [draftReference(first)] };
    writeBrowserDraft(storage, discard);
    expect(activeBrowserDrafts(readBrowserDrafts(storage, first.scope))).toEqual([]);
    expect(activeBrowserDrafts(readBrowserDrafts(storage, other.scope))).toEqual([other]);
    expect((): void => writeBrowserDraft(storage, first)).toThrow('저장 순서');
    expect(readBrowserDrafts(storage, first.scope)).toContainEqual(first);
  });
  test('browser_draft_corruption_and_storage_denial_are_explicit_without_replacement', (): void => {
    const storage: DraftStorage = storageFixture(); const first: BrowserDraft = record(firstId, 'draft');
    const key: string = draftPrefix(first.scope) + first.id;
    storage.setItem(key, '{broken');
    expect((): BrowserDraft[] => readBrowserDrafts(storage, first.scope)).toThrow();
    expect((): void => writeBrowserDraft(storage, first)).toThrow();
    expect(storage.getItem(key)).toBe('{broken');
    const denied: DraftStorage = { ...storage, setItem: (): never => { throw new Error('QuotaExceededError'); } };
    expect((): void => writeBrowserDraft(denied, record(secondId, 'new'))).toThrow('QuotaExceededError');
  });
});

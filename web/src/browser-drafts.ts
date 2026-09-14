import { z } from 'zod';

const DraftReferenceSchema = z.strictObject({ id: z.string().uuid(), sequence: z.number().int().positive() });
export const BrowserDraftSchema = z.strictObject({
  version: z.literal(1), scope: z.string().min(1), id: z.string().uuid(), sequence: z.number().int().positive(),
  savedAt: z.string().datetime(), basis: z.string(), value: z.string().nullable(),
  replaces: z.array(DraftReferenceSchema),
});
export type BrowserDraft = z.infer<typeof BrowserDraftSchema>;
export type DraftReference = z.infer<typeof DraftReferenceSchema>;
export type DraftStorage = Pick<Storage, 'length' | 'key' | 'getItem' | 'setItem'>;

export function draftPrefix(scope: string): string { return `cutroom:draft:1:${encodeURIComponent(scope)}:`; }

export function draftReference(draft: BrowserDraft): DraftReference { return { id: draft.id, sequence: draft.sequence }; }

/** 각 화면 인스턴스는 자기 기록만 쓴다. 다른 탭의 새 수정은 이전 sequence의 대체 기록으로 숨겨지지 않는다. */
export function activeBrowserDrafts(records: readonly BrowserDraft[]): BrowserDraft[] {
  return records.filter((record: BrowserDraft): boolean => !records.some((other: BrowserDraft): boolean =>
    other.id !== record.id && other.replaces.some((reference: DraftReference): boolean =>
      reference.id === record.id && reference.sequence === record.sequence)))
    .filter((record: BrowserDraft): boolean => record.value !== null)
    .sort((left: BrowserDraft, right: BrowserDraft): number => right.savedAt.localeCompare(left.savedAt) || left.id.localeCompare(right.id));
}

export function readBrowserDrafts(storage: DraftStorage, scope: string): BrowserDraft[] {
  const prefix: string = draftPrefix(scope);
  const keys: string[] = Array.from({ length: storage.length }, (_value: unknown, index: number): string | null => storage.key(index))
    .filter((key: string | null): key is string => key !== null && key.startsWith(prefix));
  return keys.map((key: string): BrowserDraft => {
    const raw: string | null = storage.getItem(key);
    if (raw === null) throw new Error(`브라우저 임시 입력이 조회 중 변경되었습니다. 다시 확인하세요. ${key}`);
    const record: BrowserDraft = BrowserDraftSchema.parse(JSON.parse(raw) as unknown);
    const basis: unknown = JSON.parse(record.basis) as unknown;
    if (!Array.isArray(basis) || basis.length !== 2 || basis.some((part: unknown): boolean => typeof part !== 'string')) throw new Error(`임시 입력 기준 형식이 올바르지 않습니다. ${key}`);
    if (record.value !== null) JSON.parse(record.value);
    if (record.scope !== scope || key !== prefix + record.id || record.replaces.some((reference: DraftReference): boolean => reference.id === record.id)) {
      throw new Error(`브라우저 임시 입력의 식별자가 일치하지 않습니다. 원본 기록을 보존했습니다. ${key}`);
    }
    return record;
  });
}

export function writeBrowserDraft(storage: DraftStorage, record: BrowserDraft): void {
  const parsed: BrowserDraft = BrowserDraftSchema.parse(record);
  const key: string = draftPrefix(parsed.scope) + parsed.id;
  const previous: string | null = storage.getItem(key);
  if (previous !== null && BrowserDraftSchema.parse(JSON.parse(previous) as unknown).sequence !== parsed.sequence - 1) {
    throw new Error(`임시 입력의 저장 순서가 달라졌습니다. 기존 기록을 보존했습니다. ${key}`);
  }
  storage.setItem(key, JSON.stringify(parsed));
}

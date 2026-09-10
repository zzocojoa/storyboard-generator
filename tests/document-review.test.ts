import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { expect, it } from 'vitest';
import { inspectDocuments } from '../src/documents/compile.js';
import { readDocumentSources } from '../src/documents/io.js';
import { buildDocumentPackage, importDocumentPackage } from '../src/documents/package.js';
import { CodexAppReviewEngine } from '../src/documents/review-engine.js';
import type { DocumentReviewInput } from '../src/documents/review-input.js';
import type { ProductionPreset, ReviewState } from '../src/documents/review-model.js';
import { DocumentReviewService } from '../src/documents/review-service.js';
import { productionSettings, validateDocumentReviewResult } from '../src/documents/review-validation.js';
import type { DocumentSettings, DocumentSources } from '../src/documents/schema.js';
import { applyDocumentPreset, buildDocumentReviewAudit, mergeDocumentReview, reviewEntryKey } from '../web/src/document-review-state.js';
import type { ReviewDraft } from '../web/src/document-review-state.js';
import { completedReview, EMPTY_REVIEW_PRODUCTION, REVIEW_PRODUCTION, reviewTestInput, syntheticReviewResult, writeReviewEngineFixture } from './document-review-helpers.js';

it('document_review_validates_candidates_evidence_duplicates_and_no_false_document_claims', async (): Promise<void> => {
  const sources: DocumentSources = await readDocumentSources('tests/fixtures/documents');
  const input = reviewTestInput(sources, 'tests/fixtures/documents'); const result = syntheticReviewResult(sources);
  expect(validateDocumentReviewResult(sources, input.bindings, input.production, result)).toEqual(result);
  const first = result.suggestions[0]!;
  for (const invalid of [
    { ...result, suggestions: [{ ...first, value: 'invented-id' }, ...result.suggestions.slice(1)] },
    { ...result, suggestions: [{ ...first, origin: 'document' }, ...result.suggestions.slice(1)] },
    { ...result, suggestions: [{ ...first, evidence: [{ fileId: 'other-project', locator: 'line:7', quote: '민아' }] }, ...result.suggestions.slice(1)] },
    { ...result, suggestions: [{ ...first, evidence: [{ fileId: 'document-broadcast', locator: 'line:7', quote: '존재하지 않는 인용' }] }, ...result.suggestions.slice(1)] },
    { ...result, suggestions: [first, ...result.suggestions] },
    { ...result, suggestions: result.suggestions.slice(1) },
    { ...result, suggestions: result.suggestions.map((item) => item.field === 'people' ? { ...item, value: 'host' } : item) },
    { ...result, suggestions: result.suggestions.map((item) => item.key === 'fps' ? { ...item, value: '999/1' } : item) },
  ]) expect(() => validateDocumentReviewResult(sources, input.bindings, input.production, invalid)).toThrow();
  const unresolved = { ...result, suggestions: result.suggestions.map((item) => ({ ...item, origin: 'unresolved' as const, value: null, evidence: [] })) };
  expect(validateDocumentReviewResult(sources, input.bindings, input.production, unresolved)).toEqual(unresolved);
});

it('document_review_preserves_manual_edits_and_requires_confirmed_audit_for_package_roundtrip', async (): Promise<void> => {
  const sources = await readDocumentSources('tests/fixtures/documents'); const preview = inspectDocuments(sources, { people: [], scenes: [], units: [] }).preview;
  const state = completedReview(syntheticReviewResult(sources), preview.sourceFingerprint);
  const initial: ReviewDraft = { bindings: { people: [], scenes: [], units: [] }, production: EMPTY_REVIEW_PRODUCTION, entries: [] };
  const edited = mergeDocumentReview({ ...initial, production: { ...initial.production, fps: '25/1' } }, state, new Set([reviewEntryKey({ field: 'production', key: 'fps' })]));
  expect(edited.production.fps).toBe('25/1'); expect(edited.entries.some((entry): boolean => entry.key === 'fps')).toBe(false);
  const touchedEmpty = mergeDocumentReview(initial, state, new Set([reviewEntryKey({ field: 'production', key: 'fps' })]));
  expect(touchedEmpty.production.fps).toBe('');
  const draft = mergeDocumentReview(initial, state, new Set<string>());
  const next = inspectDocuments(sources, draft.bindings).preview;
  const settings: DocumentSettings = { formatVersion: '1.1.0', sourceFingerprint: preview.sourceFingerprint, packageVersion: 'reviewed', ...productionSettings(draft.production), bindings: draft.bindings,
    reviewAudit: buildDocumentReviewAudit(next, preview, draft, null) };
  expect(() => buildDocumentPackage(sources, settings)).toThrow(/확인 상태/u);
  const confirmed: DocumentSettings = { ...settings, reviewAudit: { ...settings.reviewAudit!, entries: settings.reviewAudit!.entries.map((entry) => ({ ...entry, confirmed: true })) } };
  const payload = buildDocumentPackage(sources, confirmed);
  expect(payload.files.find((file): boolean => file.path === 'document-settings.json')!.content).toContain('test-codex-model');
  const snapshots = payload.handoff.files.map((file) => ({ ...file, content: payload.files.find((item): boolean => item.path === file.path)!.content }));
  expect(importDocumentPackage(payload.handoff, snapshots).dataset.units).toHaveLength(4);
  expect(() => buildDocumentPackage(sources, { ...confirmed, profile: { ...confirmed.profile, aspectWidth: 9 } })).toThrow(/최종 값/u);
  expect(() => buildDocumentPackage(sources, { ...confirmed, reviewAudit: { ...confirmed.reviewAudit!, entries: confirmed.reviewAudit!.entries.slice(1) } })).toThrow(/누락/u);
  const preset: ProductionPreset = { id: '270f74ef-3237-42df-b54a-e6d9b1056498', name: '내 세로 영상', createdAt: '2026-09-10T00:00:00.000Z', fields: { ...REVIEW_PRODUCTION, width: '9', height: '16' } };
  const withPreset = applyDocumentPreset(draft, preset);
  expect(withPreset.production.width).toBe('9'); expect(withPreset.bindings).toEqual(draft.bindings);
  expect(withPreset.entries.filter((entry): boolean => entry.origin === 'preset')).toHaveLength(5);
});

it('document_review_engine_enforces_chatgpt_tools_json_and_execution_limits', async (): Promise<void> => {
  const root = await mkdtemp(join(tmpdir(), 'review-engine-')); const sources = await readDocumentSources('tests/fixtures/documents');
  try {
    for (const [behavior, error] of [['api-key', 'DOCUMENT_REVIEW_LOGIN_REQUIRED'], ['invalid-json', 'DOCUMENT_REVIEW_INVALID_JSON'], ['tool-request', 'DOCUMENT_REVIEW_TOOL_REQUEST'], ['timeout', 'DOCUMENT_REVIEW_TIMEOUT']] as const) {
      const engine = new CodexAppReviewEngine(await writeReviewEngineFixture(root, syntheticReviewResult(sources), behavior, 0), behavior === 'timeout' ? 150 : 2000);
      await expect(engine.run('입력', new AbortController().signal)).rejects.toMatchObject({ code: error });
    }
    const engine = new CodexAppReviewEngine(await writeReviewEngineFixture(root, syntheticReviewResult(sources), 'success', 0), 2000);
    expect((await engine.run('입력', new AbortController().signal)).model).toBe('test-codex-model');
    const slow = new CodexAppReviewEngine(await writeReviewEngineFixture(root, syntheticReviewResult(sources), 'timeout', 0), 3000);
    const controller = new AbortController(); const promise = slow.run('입력', controller.signal); controller.abort();
    await expect(promise).rejects.toMatchObject({ code: 'DOCUMENT_REVIEW_CANCELLED' });
    const missing = new CodexAppReviewEngine(join(root, 'missing-engine'), 500);
    await expect(missing.run('입력', new AbortController().signal)).rejects.toMatchObject({ code: 'DOCUMENT_REVIEW_ENGINE_UNAVAILABLE' });
  } finally { await rm(root, { recursive: true, force: true }); }
});

async function waitReview(service: DocumentReviewService, id: string): Promise<ReviewState> {
  for (let attempt: number = 0; attempt < 100; attempt += 1) { const state = await service.read(id); if (state.status !== 'running') return state; await setTimeout(20); }
  throw new Error('검토가 제한 시간 안에 종료되지 않았습니다.');
}

it('document_review_service_runs_deduplicates_cancels_retries_and_detects_changed_sources', async (): Promise<void> => {
  const root = await mkdtemp(join(tmpdir(), 'review-service-')); const directory = join(root, 'input'); await cp('tests/fixtures/documents', directory, { recursive: true });
  const sources = await readDocumentSources(directory); const input: DocumentReviewInput = reviewTestInput(sources, directory);
  const executable = await writeReviewEngineFixture(root, syntheticReviewResult(sources), 'success', 150);
  const service = new DocumentReviewService(join(root, 'reviews'), new CodexAppReviewEngine(executable, 3000)); await service.initialize();
  try {
    const pending = await service.start(input); expect((await service.start(input)).id).toBe(pending.id);
    await expect(service.start({ ...input, production: { ...input.production, fps: '24/1' } })).rejects.toMatchObject({ code: 'DOCUMENT_REVIEW_BUSY' });
    const completed = await waitReview(service, pending.id); expect(completed.status).toBe('completed');
    expect((await service.validate(pending.id, input)).status).toBe('completed');
    await expect(service.validate(pending.id, { ...input, production: { ...input.production, fps: '25/1' } })).rejects.toMatchObject({ code: 'DOCUMENT_REVIEW_BASIS_CHANGED' });
    const cancel = await service.start(input); expect(cancel.id).not.toBe(pending.id); expect((await service.cancel(cancel.id)).status).toBe('cancelled');
    const retry = await service.start(input); expect(retry.id).not.toBe(cancel.id); expect((await waitReview(service, retry.id)).status).toBe('completed');
    const preset = await service.savePreset('별도 스토리용', REVIEW_PRODUCTION); expect((await service.presets()).map((item) => item.id)).toEqual([preset.id]);
    const original = await readFile(join(directory, 'narration.md'), 'utf8'); await writeFile(join(directory, 'narration.md'), original + '\n변경\n');
    await expect(service.validate(retry.id, input)).rejects.toMatchObject({ code: 'INVALID_DOCUMENT_FINGERPRINT' });
    expect((await service.read(retry.id)).status).toBe('stale');
    await expect(service.start(input)).rejects.toMatchObject({ code: 'INVALID_DOCUMENT_FINGERPRINT' });
  } finally { await service.close(); await rm(root, { recursive: true, force: true }); }
});

it('document_review_restart_preserves_terminal_results_presets_and_marks_interrupted_work', async (): Promise<void> => {
  const root = await mkdtemp(join(tmpdir(), 'review-restart-')); const sources = await readDocumentSources('tests/fixtures/documents');
  const executable = await writeReviewEngineFixture(root, syntheticReviewResult(sources), 'success', 0); const reviewRoot = join(root, 'reviews');
  const first = new DocumentReviewService(reviewRoot, new CodexAppReviewEngine(executable, 2000)); await first.initialize();
  const preset = await first.savePreset('저장 프리셋', REVIEW_PRODUCTION);
  const running = await first.start(reviewTestInput(sources, 'tests/fixtures/documents')); const terminal = await waitReview(first, running.id); await first.close();
  const interruptedId = '7b98f43d-d2ca-45b1-83d4-304098eed0dd';
  await writeFile(join(reviewRoot, 'requests', `${interruptedId}.running.json`), JSON.stringify({ ...running, id: interruptedId }));
  const second = new DocumentReviewService(reviewRoot, new CodexAppReviewEngine(executable, 2000));
  try { await second.initialize(); expect(await second.read(running.id)).toEqual(terminal); expect((await second.read(interruptedId)).error?.code).toBe('DOCUMENT_REVIEW_INTERRUPTED'); expect((await second.presets())[0]!.id).toBe(preset.id); }
  finally { await second.close(); await rm(root, { recursive: true, force: true }); }
});

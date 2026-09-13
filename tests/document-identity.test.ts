import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, it, vi } from 'vitest';
import { readBuildManifest } from '../src/build.js';
import { CodexRequestStore } from '../src/codex/requests.js';
import { documentFingerprint, inspectDocuments } from '../src/documents/compile.js';
import { verifyIdentityEvidence } from '../src/documents/identity.js';
import { IdentityPreviewSchema } from '../src/documents/identity-schema.js';
import { readDocumentSources, writeDocumentPackage } from '../src/documents/io.js';
import { buildDocumentPackage } from '../src/documents/package.js';
import { documentReviewPrompt } from '../src/documents/review-context.js';
import type { DocumentSettings } from '../src/documents/schema.js';
import { settingsProductionFields } from '../src/documents/review-validation.js';
import { DocumentReviewService } from '../src/documents/review-service.js';
import type { DocumentReviewEngine, ReviewEngineResult } from '../src/documents/review-engine.js';
import type { IdentityBasis } from '../src/documents/identity-schema.js';
import { importPackage } from '../src/importers/import-package.js';
import { sha256SortedJson, sha256Text } from '../src/importers/integrity.js';
import { readPackage } from '../src/io/package.js';
import { createApp } from '../src/server/app.js';
import { ProjectStore } from '../src/server/store.js';
import { applyIdentityMatches, personConnections } from '../web/src/document-identity-state.js';
import { buildDocumentReviewAudit } from '../web/src/document-review-state.js';
import { documentTestSettings, PRODUCTION_DOCUMENT_BINDINGS, SYNTHETIC_DOCUMENT_BINDINGS } from './document-helpers.js';
import { productionIdentityEvidence, syntheticIdentityFiles } from './document-identity-helpers.js';
import { TEST_AUDIO_NORMALIZATION_OPTIONS } from './helpers.js';

it('document_saved_identity_revalidates_completed_evidence_after_restart_and_rejects_changed_or_foreign_sources', async (): Promise<void> => {
  const root: string = await mkdtemp(join(tmpdir(), 'saved-identity-'));
  const directory: string = resolve('tests/fixtures/production/09_PRODUCTION');
  const sources = await readDocumentSources(directory);
  const evidence = await productionIdentityEvidence(sources);
  const engine: DocumentReviewEngine = { run: async (): Promise<ReviewEngineResult> => ({ model: 'test-identity-engine', result: { summary: '연결 확인 완료', suggestions: [] } }) };
  const first = new DocumentReviewService(join(root, 'reviews'), engine);
  const basis: IdentityBasis = { directory, sourceFingerprint: documentFingerprint(sources), bindings: { people: [], scenes: [], units: [] } };
  let id: string = '';
  await first.initialize();
  try {
    const state = await first.start({ ...basis, bindings: PRODUCTION_DOCUMENT_BINDINGS, identityEvidence: evidence, presetId: null,
      production: settingsProductionFields(documentTestSettings(sources, PRODUCTION_DOCUMENT_BINDINGS)) });
    id = state.id;
    await vi.waitFor(async (): Promise<void> => { expect((await first.read(id)).status).toBe('completed'); });
  } finally { await first.close(); }
  const second = new DocumentReviewService(join(root, 'reviews'), engine);
  try {
    await second.initialize();
    const found = await second.findSavedIdentity(basis);
    expect(found?.reviewId).toBe(id);
    expect(found?.matches.find((match): boolean => match.name === '백기철')).toMatchObject({ targetId: 'CHAR-03', currentId: null });
    expect((await second.validateSavedIdentity(id, basis)).evidence).toEqual(evidence);
    await expect(second.findSavedIdentity({ ...basis, bindings: { ...basis.bindings, people: [{ key: '백기철', targetId: 'CHAR-02' }] } })).rejects.toMatchObject({ code: 'INVALID_IDENTITY_CONFLICT' });
    await expect(second.findSavedIdentity({ ...basis, sourceFingerprint: 'b'.repeat(64) })).rejects.toMatchObject({ code: 'INVALID_IDENTITY_BASIS' });
    const foreignSources = await readDocumentSources('tests/fixtures/documents');
    const foreign = { directory: resolve('tests/fixtures/documents'), sourceFingerprint: documentFingerprint(foreignSources), bindings: SYNTHETIC_DOCUMENT_BINDINGS };
    expect(await second.findSavedIdentity(foreign)).toBeNull();
    await expect(second.validateSavedIdentity(id, foreign)).rejects.toMatchObject({ code: 'SAVED_IDENTITY_NOT_AVAILABLE' });
    const inputPath: string = join(root, 'reviews/requests', `${id}.input.json`);
    await writeFile(inputPath, (await readFile(inputPath, 'utf8')).replace('CHAR-03', 'CHAR-04'));
    await expect(second.findSavedIdentity(basis)).rejects.toMatchObject({ code: 'INVALID_DOCUMENT_REVIEW_RECORD' });
  } finally { await second.close(); await rm(root, { recursive: true, force: true }); }
});

it('document_person_conclusions_distinguish_required_pending_conflicting_and_absent_people', async (): Promise<void> => {
  const sources = await readDocumentSources('tests/fixtures/production/09_PRODUCTION');
  const bindings = { people: [], scenes: [], units: [] };
  const preview = inspectDocuments(sources, bindings).preview;
  const before = structuredClone(preview);
  expect(personConnections(preview, bindings, []).filter((item): boolean => item.status === 'connected')).toHaveLength(3);
  expect(personConnections(preview, bindings, []).find((item): boolean => item.name === '백기철')).toMatchObject({ value: '', status: 'unresolved' });
  const selected = { ...bindings, people: [{ key: '백기철', targetId: 'CHAR-03' }] };
  const entry = { field: 'people' as const, key: '백기철', value: 'CHAR-03', origin: 'inference' as const, reason: '구분 근거를 검토한 제안', evidence: [], confirmed: false, reviewId: null, model: null };
  expect(personConnections(preview, selected, [entry]).find((item): boolean => item.name === '백기철')?.status).toBe('pending');
  expect(personConnections(preview, selected, [{ ...entry, confirmed: true }]).find((item): boolean => item.name === '백기철')?.status).toBe('connected');
  const duplicate = { ...selected, people: [...selected.people, { key: '윤서진', targetId: 'CHAR-03' }] };
  expect(personConnections(preview, duplicate, [{ ...entry, confirmed: true }]).filter((item): boolean => item.status === 'invalid')).toHaveLength(2);
  expect(personConnections({ ...preview, people: preview.people.map((choice) => ({ ...choice, selected: null, candidates: [] })) }, bindings, []).every((item): boolean => item.status === 'unresolved')).toBe(true);
  expect(personConnections({ ...preview, people: [] }, bindings, [])).toEqual([]);
  expect(preview).toEqual(before);
});

it('document_identity_proves_character_bindings_and_preserves_audited_package_roundtrip', async (): Promise<void> => {
  const sources = await readDocumentSources('tests/fixtures/production/09_PRODUCTION');
  const evidence = await productionIdentityEvidence(sources);
  const bindings = { people: [{ key: '강태균', targetId: 'CHAR-01' }, { key: '박도현', targetId: 'CHAR-05' }], scenes: [], units: [] };
  const preview = inspectDocuments(sources, bindings).preview;
  const base = documentTestSettings(sources, bindings);
  const draft = { bindings, production: settingsProductionFields(base), entries: [] };
  const before = structuredClone(draft);
  const matches = verifyIdentityEvidence(sources, bindings, evidence);
  expect(matches.filter((item): boolean => item.currentId === null).map((item): string => item.name).sort()).toEqual(['백기철', '오민주', '윤서진']);
  const applied = applyIdentityMatches(draft, matches);
  expect(draft).toEqual(before); expect(applied.production).toEqual(draft.production);
  expect(applied.entries).toHaveLength(3); expect(applied.bindings.people).toContainEqual({ key: '백기철', targetId: 'CHAR-03' });
  const settings: DocumentSettings = { ...base, formatVersion: '1.2.0', bindings: applied.bindings, identityEvidence: evidence,
    reviewAudit: buildDocumentReviewAudit(preview, inspectDocuments(sources, { people: [], scenes: [], units: [] }).preview, applied, null) };
  const payload = buildDocumentPackage(sources, settings);
  const project = importPackage(payload);
  expect(project.dataset.people.find((person): boolean => person.name === '윤서진')?.id).toBe('CHAR-02');
  expect(payload.files.find((file): boolean => file.path === 'document-settings.json')?.content).toContain('identity-document');
  const prompt: string = documentReviewPrompt(sources, inspectDocuments(sources, applied.bindings).preview, { input: { directory: '/selected',
    sourceFingerprint: documentFingerprint(sources), bindings: applied.bindings, production: applied.production, presetId: null, identityEvidence: evidence }, preset: null });
  expect(prompt).toContain('verifiedIdentities'); expect(prompt).toContain('CHAR-03');
  const invalid = structuredClone(settings); invalid.reviewAudit!.entries.find((entry): boolean => entry.origin === 'identity-document')!.evidence[0]!.locator = '/characters/100';
  expect(() => buildDocumentPackage(sources, invalid)).toThrow('인물 원본과 연결 근거');
  expect(() => buildDocumentPackage(sources, { ...settings, formatVersion: '1.1.0' })).toThrow('1.2.0');
});

it('document_identity_rejects_changed_hash_project_basis_and_existing_conflicts', async (): Promise<void> => {
  const sources = await readDocumentSources('tests/fixtures/production/09_PRODUCTION');
  const evidence = await productionIdentityEvidence(sources); const bindings = { people: [], scenes: [], units: [] };
  expect(() => verifyIdentityEvidence(sources, bindings, { ...evidence, projectId: 'another' })).toThrow('프로젝트');
  expect(() => verifyIdentityEvidence(sources, bindings, { ...evidence, sourceFingerprint: '0'.repeat(64) })).toThrow('버전');
  expect(() => verifyIdentityEvidence(sources, bindings, { ...evidence, characters: { ...evidence.characters, content: evidence.characters.content + ' ' } })).toThrow('원본 버전');
  const tampered: string = evidence.characters.content.replace('백기철', '다른이름');
  expect(() => verifyIdentityEvidence(sources, bindings, { ...evidence, characters: { content: tampered, sha256: sha256Text(tampered) } })).toThrow('제작 근거 → 인물 원본');
  expect(() => verifyIdentityEvidence(sources, { ...bindings, people: [{ key: '윤서진', targetId: 'CHAR-03' }] }, evidence)).toThrow('현재 CHAR-03, 원본 CHAR-02');
  expect(() => applyIdentityMatches({ bindings: { ...bindings, people: [{ key: '윤서진', targetId: 'CHAR-04' }] }, production: { fps: '', sampleRate: '', width: '', height: '', startTimecode: '' }, entries: [] },
    [{ name: '윤서진', currentId: null, targetId: 'CHAR-02', locator: '/characters/1' }])).toThrow('연결이 바뀌었습니다');
});

it('document_identity_api_detects_file_changes_origin_symlinks_and_saves_independent_story_evidence', async (): Promise<void> => {
  const root: string = await mkdtemp(join(tmpdir(), 'identity-api-'));
  const files = await syntheticIdentityFiles(root);
  const sources = await readDocumentSources(files.directory);
  await mkdir(join(root, 'web')); await writeFile(join(root, 'web/index.html'), '<!doctype html>');
  const store = new ProjectStore(join(root, 'data'));
  const app = await createApp({ host: '127.0.0.1', port: 4317, dataRoot: join(root, 'data'), webRoot: join(root, 'web'),
    pdfFontPath: resolve('assets/fonts/NanumGothic-Regular.ttf'), audioNormalization: TEST_AUDIO_NORMALIZATION_OPTIONS,
    codex: { requestRoot: join(root, 'requests'), speechVoice: 'Yuna' } }, store, new CodexRequestStore(join(root, 'requests'), readBuildManifest()));
  try {
    const body = { ...files, sourceFingerprint: documentFingerprint(sources), bindings: { ...SYNTHETIC_DOCUMENT_BINDINGS, people: [] } };
    const response = await app.inject({ method: 'POST', url: '/api/document-identities/preview', payload: body });
    expect(response.statusCode).toBe(200); const preview = IdentityPreviewSchema.parse(response.json());
    expect(preview.matches.map((match): string => match.targetId)).toEqual(['helper', 'host']);
    const foreign = await app.inject({ method: 'POST', url: '/api/document-identities/preview', headers: { origin: 'https://unrelated.test' }, payload: body });
    expect(foreign.json().error.code).toBe('FORBIDDEN_DOCUMENT_IDENTITY_ORIGIN');
    const original: string = await readFile(files.charactersPath, 'utf8');
    await writeFile(files.charactersPath, original + '\n');
    const changed = await app.inject({ method: 'POST', url: '/api/document-identities/validate', payload: { ...body, evidence: preview.evidence } });
    expect(changed.json().error.code).toBe('INVALID_IDENTITY_CHANGED');
    await writeFile(files.charactersPath, original);
    const link: string = join(root, 'linked.json'); await symlink(files.charactersPath, link);
    const unsafe = await app.inject({ method: 'POST', url: '/api/document-identities/preview', payload: { ...body, charactersPath: link } });
    expect(unsafe.statusCode).toBe(400);
    const valid = await app.inject({ method: 'POST', url: '/api/document-identities/validate', payload: { ...body, evidence: preview.evidence } });
    expect(valid.statusCode).toBe(200);
    const base = documentTestSettings(sources, body.bindings);
    const applied = applyIdentityMatches({ bindings: body.bindings, production: settingsProductionFields(base), entries: [] }, preview.matches);
    const automatic = inspectDocuments(sources, { people: [], scenes: [], units: [] }).preview;
    const settings: DocumentSettings = { ...base, formatVersion: '1.2.0', identityEvidence: preview.evidence, bindings: applied.bindings,
      reviewAudit: buildDocumentReviewAudit(inspectDocuments(sources, applied.bindings).preview, automatic, applied, null) };
    const created = await writeDocumentPackage(files.directory, settings, join(root, 'package'));
    await rm(files.charactersPath); await rm(files.footprintPath);
    const project = importPackage(await readPackage(created.handoffPath));
    expect(project.dataset.people.map((person): string => person.id).sort()).toEqual(['helper', 'host']);
    expect(project.sources.find((file): boolean => file.id === 'document-settings')?.content).toContain('identity-document');
    expect(await store.list()).toHaveLength(0);
  } finally { await app.close(); await rm(root, { recursive: true, force: true }); }
});

it('document_identity_rejects_duplicate_names_ids_and_foreign_character_candidates', async (): Promise<void> => {
  const sources = await readDocumentSources('tests/fixtures/production/09_PRODUCTION');
  const evidence = await productionIdentityEvidence(sources);
  for (const change of [{ from: '백기철', to: '윤서진', error: '중복 없이' }, { from: 'CHAR-03', to: 'CHAR-02', error: '중복 없이' }, { from: 'CHAR-03', to: 'foreign-id', error: '후보에 없습니다' }]) {
    const characters: string = evidence.characters.content.replace(change.from, change.to);
    const footprint: string = evidence.footprint.content.replace(sha256SortedJson(evidence.characters.content, '인물 원본'), sha256SortedJson(characters, '변경 인물 원본'));
    const manifest: string = sources.manifest.content.replace(sha256SortedJson(evidence.footprint.content, '제작 근거'), sha256SortedJson(footprint, '변경 제작 근거'));
    const modified = { ...sources, manifest: { ...sources.manifest, content: manifest, sha256: sha256Text(manifest) } };
    const updated = { ...evidence, sourceFingerprint: documentFingerprint(modified), characters: { content: characters, sha256: sha256Text(characters) }, footprint: { content: footprint, sha256: sha256Text(footprint) } };
    expect(() => verifyIdentityEvidence(modified, { people: [], scenes: [], units: [] }, updated)).toThrow(change.error);
  }
});

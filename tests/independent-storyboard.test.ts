import { legacyTextProject } from './legacy-text-helpers.js';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readBuildManifest } from '../src/build.js';
import { CodexRequestStore } from '../src/codex/requests.js';
import { buildDocumentPackage } from '../src/documents/package.js';
import { readDocumentSources } from '../src/documents/io.js';
import type { Project } from '../src/domain/schema.js';
import { applySourceUpdate, sourceImpact } from '../src/domain/source-update.js';
import { exportProjectJson } from '../src/exporters/json.js';
import { importPackage } from '../src/importers/import-package.js';
import { readPackage } from '../src/io/package.js';
import { parseProject } from '../src/io/project.js';
import { createIndependentStoryboard } from '../src/proposal/independent-storyboard.js';
import { createSourceOutline } from '../src/proposal/outline.js';
import { createApp } from '../src/server/app.js';
import { ProjectStore, projectStoreKey } from '../src/server/store.js';
import { documentTestSettings, SYNTHETIC_DOCUMENT_BINDINGS } from './document-helpers.js';
import { TEST_AUDIO_NORMALIZATION_OPTIONS } from './helpers.js';

describe('독립 콘티 생성', (): void => {
  it('independent_storyboard_preserves_source_identity_across_adapters_exports_and_source_updates', async (): Promise<void> => {
    const documents = await readDocumentSources('tests/fixtures/documents');
    const payloads = [await readPackage('tests/fixtures/native/storyboard_handoff.json'), await readPackage('tests/fixtures/production/storyboard_handoff.json'),
      buildDocumentPackage(documents, documentTestSettings(documents, SYNTHETIC_DOCUMENT_BINDINGS))];
    for (const payload of payloads) {
      const source: Project = importPackage(payload);
      const snapshot: Project = structuredClone(source);
      const independent: Project = createIndependentStoryboard(source, { handoffPath: 'unused.json', storyboardId: randomUUID(), name: '새 연출안', proposedTextHoldMs: 1800 });
      expect(source).toEqual(snapshot);
      expect(independent.projectId).not.toBe(source.projectId);
      expect(independent.handoff).toEqual(source.handoff); expect(independent.sources).toEqual(source.sources); expect(independent.dataset).toEqual(source.dataset);
      expect(independent.assets).toEqual([]); expect(independent.generationRecords).toEqual([]);
      expect(parseProject(JSON.parse(exportProjectJson(independent)) as unknown)).toEqual(independent);
      const incoming: Project = createSourceOutline(source, { proposedTextHoldMs: 1800 });
      expect(sourceImpact(independent, incoming).canApply).toBe(true);
      const updated: Project = applySourceUpdate(independent, incoming, 'update-test');
      expect(updated.projectId).toBe(independent.projectId); expect(updated.title).toBe('새 연출안');
      expect(updated.storyboardIdentity).toEqual(independent.storyboardIdentity);
      expect(parseProject(updated)).toEqual(updated);
      expect((): void => { sourceImpact(independent, { ...incoming, projectId: 'other-story' }); }).toThrow('같은 이야기');
      const { storyboardIdentity: _identity, ...withoutIdentity } = independent;
      expect((): void => { parseProject(withoutIdentity); }).toThrow('원본 ID');
      expect((): void => { parseProject({ ...independent, storyboardIdentity: { ...independent.storyboardIdentity, sourceProjectId: 'other-story' } }); }).toThrow('원본 ID');
      const legacy: Project = parseProject({ ...legacyTextProject(incoming), schemaVersion: '1.9.0' });
      expect(legacy).toEqual({ ...incoming, textLayoutControl: { version: '1.0.0', mode: 'manual', plannedInputHash: null } }); expect(legacy.storyboardIdentity).toBeUndefined();
    }
  });

  it('independent_storyboard_api_isolates_edits_retries_generation_and_reopen', async (): Promise<void> => {
    const root: string = await mkdtemp(join(tmpdir(), 'independent-storyboard-'));
    const webRoot: string = join(root, 'web'); await mkdir(webRoot);
    const store = new ProjectStore(join(root, 'data'));
    const requests = new CodexRequestStore(join(root, 'requests'), readBuildManifest());
    const app = await createApp({ host: '127.0.0.1', port: 4317, dataRoot: join(root, 'data'), webRoot,
      pdfFontPath: resolve('assets/fonts/NanumGothic-Regular.ttf'), audioNormalization: TEST_AUDIO_NORMALIZATION_OPTIONS,
      codex: { requestRoot: join(root, 'requests'), speechVoice: 'Yuna' } }, store, requests);
    try {
      const handoffPath: string = 'tests/fixtures/native/storyboard_handoff.json';
      const originalResponse = await app.inject({ method: 'POST', url: '/api/projects/import', payload: { handoffPath, proposedTextHoldMs: 2000 } });
      const original: Project = originalResponse.json<{ project: Project }>().project;
      const originalPath: string = join(root, 'data', projectStoreKey(original.projectId), 'project.json');
      const originalBytes: Buffer = await readFile(originalPath);
      const input = { handoffPath, storyboardId: randomUUID(), name: '새 콘티 하나', proposedTextHoldMs: 1800 };
      const first = await app.inject({ method: 'POST', url: '/api/projects/import-independent', payload: input });
      expect(first.statusCode, first.body).toBe(201);
      const a: Project = first.json<{ project: Project }>().project;
      const second = await app.inject({ method: 'POST', url: '/api/projects/import-independent', payload: { ...input, storyboardId: randomUUID(), name: '새 콘티 둘' } });
      expect(second.statusCode, second.body).toBe(201);
      const b: Project = second.json<{ project: Project }>().project;
      const aUrl: string = `/api/projects/${encodeURIComponent(a.projectId)}`;
      const edited = await app.inject({ method: 'PATCH', url: aUrl + '/profile', payload: { expectedRevision: 0, profile: { ...a.profile, visualStyle: '새 콘티 전용 스타일' } } });
      expect(edited.statusCode, edited.body).toBe(200);
      const retry = await app.inject({ method: 'POST', url: '/api/projects/import-independent', payload: input });
      expect(retry.statusCode).toBe(200); expect(retry.json().project.revision).toBe(1);
      expect(retry.json().project.profile.visualStyle).toBe('새 콘티 전용 스타일');
      const conflict = await app.inject({ method: 'POST', url: '/api/projects/import-independent', payload: { ...input, name: '같은 요청 다른 입력' } });
      expect(conflict.statusCode).toBe(409); expect(conflict.json().error.code).toBe('STORYBOARD_CREATION_CONFLICT');
      const invalid = await app.inject({ method: 'POST', url: '/api/projects/import-independent', payload: { ...input, storyboardId: '../original' } });
      expect(invalid.statusCode).toBe(400);
      const imageA = await app.inject({ method: 'POST', url: aUrl + '/frames/frame-1/generate', payload: { expectedRevision: 1 } });
      const imageB = await app.inject({ method: 'POST', url: `/api/projects/${encodeURIComponent(b.projectId)}/frames/frame-1/generate`, payload: { expectedRevision: 0 } });
      expect(imageA.statusCode, imageA.body).toBe(202); expect(imageB.statusCode, imageB.body).toBe(202);
      expect(imageA.json().request.id).not.toBe(imageB.json().request.id);
      expect(imageA.json().request.projectId).toBe(a.projectId); expect(imageB.json().request.projectId).toBe(b.projectId);
      await expect(store.update(a.projectId, 1, (current: Project): Project => ({ ...current, storyboardIdentity: { ...current.storyboardIdentity!, creationFingerprint: '0'.repeat(64) } }), [])).rejects.toMatchObject({ code: 'STORYBOARD_IDENTITY_CHANGED' });
      expect((await store.list()).length).toBe(3);
      expect(await store.read(b.projectId)).toEqual(b); expect(await readFile(originalPath)).toEqual(originalBytes);
      const exported = await app.inject({ method: 'GET', url: aUrl + '/export.json' });
      expect(exported.statusCode).toBe(200); expect(parseProject(exported.json()).storyboardIdentity).toEqual(a.storyboardIdentity);
      const pdf = await app.inject({ method: 'GET', url: aUrl + '/export.pdf?maturity=draft' }); expect(pdf.statusCode).toBe(200);
      await app.close();
      const reopened = new ProjectStore(join(root, 'data'));
      try { expect((await reopened.read(a.projectId)).revision).toBe(1); expect(await reopened.read(b.projectId)).toEqual(b); }
      finally { await reopened.close(); }
    } finally { await app.close(); await rm(root, { recursive: true, force: true }); }
  });
});

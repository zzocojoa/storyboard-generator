import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, it } from 'vitest';
import { readBuildManifest } from '../src/build.js';
import { CodexRequestStore } from '../src/codex/requests.js';
import { readDocumentSources } from '../src/documents/io.js';
import { DocumentPreviewSchema } from '../src/documents/schema.js';
import { createApp } from '../src/server/app.js';
import { ProjectStore } from '../src/server/store.js';
import { documentTestSettings, SYNTHETIC_DOCUMENT_BINDINGS } from './document-helpers.js';
import { TEST_AUDIO_NORMALIZATION_OPTIONS } from './helpers.js';

it('document_api_previews_creates_imports_and_rejects_invalid_or_existing_output', async (): Promise<void> => {
  const root: string = await mkdtemp(join(tmpdir(), 'document-api-'));
  const input: string = join(root, 'input'); await cp('tests/fixtures/documents', input, { recursive: true });
  const webRoot: string = join(root, 'web'); await mkdir(webRoot); await writeFile(join(webRoot, 'index.html'), '<!doctype html>');
  const store = new ProjectStore(join(root, 'data'));
  const app = await createApp({ host: '127.0.0.1', port: 4317, dataRoot: join(root, 'data'), webRoot,
    pdfFontPath: resolve('assets/fonts/NanumGothic-Regular.ttf'), audioNormalization: TEST_AUDIO_NORMALIZATION_OPTIONS,
    codex: { requestRoot: join(root, 'requests'), speechVoice: 'Yuna' } }, store, new CodexRequestStore(join(root, 'requests'), readBuildManifest()));
  try {
    const preview = await app.inject({ method: 'POST', url: '/api/document-packages/preview', payload: { directory: input, bindings: { people: [], scenes: [], units: [] } } });
    expect(preview.statusCode).toBe(200);
    expect(DocumentPreviewSchema.parse(preview.json().preview).projectId).toBe('plant-doc-demo');
    const settings = documentTestSettings(await readDocumentSources(input), SYNTHETIC_DOCUMENT_BINDINGS);
    const body = { directory: input, output: join(root, 'package'), settings };
    const missing = await app.inject({ method: 'POST', url: '/api/document-packages', payload: { ...body, settings: { ...settings, timebase: undefined } } });
    expect(missing.statusCode).toBe(400);
    const unresolved = await app.inject({ method: 'POST', url: '/api/document-packages', payload: { ...body, settings: { ...settings, bindings: { people: [], scenes: [], units: [] } } } });
    expect(unresolved.statusCode).toBe(400);
    expect(unresolved.json().error).toMatchObject({ code: 'DOCUMENT_MAPPING_REQUIRED', mutationBlocked: false, scope: 'request' });
    const created = await app.inject({ method: 'POST', url: '/api/document-packages', payload: body });
    expect(created.statusCode).toBe(201);
    const repeated = await app.inject({ method: 'POST', url: '/api/document-packages', payload: body });
    expect(repeated.statusCode).toBe(409);
    const imported = await app.inject({ method: 'POST', url: '/api/projects/import', payload: { handoffPath: created.json().handoffPath, proposedTextHoldMs: 2000 } });
    expect(imported.statusCode).toBe(201);
    expect(imported.json().project.dataset.units).toHaveLength(4);
    expect((await store.read('plant-doc-demo')).dataset.segments).toHaveLength(2);
    await writeFile(join(input, 'narration.md'), `${await readFile(join(input, 'narration.md'), 'utf8')}\n검토 뒤 변경\n`);
    const changed = await app.inject({ method: 'POST', url: '/api/document-packages', payload: { ...body, output: join(root, 'other-package') } });
    expect(changed.statusCode).toBe(400);
    expect(changed.json().error.code).toBe('INVALID_DOCUMENT_FINGERPRINT');
  } finally { await app.close(); await rm(root, { recursive: true, force: true }); }
});

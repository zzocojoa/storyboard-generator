import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { readBuildManifest } from '../src/build.js';
import { CodexRequestStore } from '../src/codex/requests.js';
import type { Project } from '../src/domain/schema.js';
import { createApp } from '../src/server/app.js';
import { ProjectStore } from '../src/server/store.js';
import { TEST_AUDIO_NORMALIZATION_OPTIONS } from './helpers.js';
import { finalFixture, readinessOutline } from './readiness-fixtures.js';

export type HardeningHttpFixture = { root: string; dataRoot: string; app: FastifyInstance; store: ProjectStore; project: Project };
export async function hardeningHttpFixture(): Promise<HardeningHttpFixture> {
  const root: string = await mkdtemp(join(tmpdir(), 'hardening-http-')); const dataRoot: string = join(root, 'data');
  const store: ProjectStore = new ProjectStore(dataRoot);
  try {
    const base: Project = await store.create(await readinessOutline()); const ready = await finalFixture();
    const project: Project = await store.update(base.projectId, base.revision, (): Project => ready.project, ready.project.assets.map((asset) => ({ relativePath: asset.path, content: ready.media.get(asset.id)! })));
    const webRoot: string = join(root, 'web'); await mkdir(join(webRoot, 'assets'), { recursive: true }); await writeFile(join(webRoot, 'index.html'), '<div id="root"></div>');
    const requestRoot: string = join(root, 'requests');
    const app: FastifyInstance = await createApp({ host: '127.0.0.1', port: 0, dataRoot, webRoot, pdfFontPath: resolve('assets/fonts/NanumGothic-Regular.ttf'),
      audioNormalization: TEST_AUDIO_NORMALIZATION_OPTIONS, codex: { requestRoot, speechVoice: 'Yuna' } }, store, new CodexRequestStore(requestRoot, readBuildManifest()));
    return { root, dataRoot, app, store, project };
  } catch (error: unknown) { await store.close(); await rm(root, { recursive: true, force: true }); throw error; }
}
export async function closeHardeningHttpFixture(value: HardeningHttpFixture): Promise<void> {
  await value.app.close(); await rm(value.root, { recursive: true, force: true });
}

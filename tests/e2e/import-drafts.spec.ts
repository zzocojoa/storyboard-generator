import { appendFile, cp, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, test } from '@playwright/test';
import type { Locator, Route } from '@playwright/test';
import type { FastifyInstance } from 'fastify';
import { readBuildManifest } from '../../src/build.js';
import { CodexRequestStore } from '../../src/codex/requests.js';
import { readDocumentSources, writeDocumentPackage } from '../../src/documents/io.js';
import { importPackage } from '../../src/importers/import-package.js';
import { readPackage } from '../../src/io/package.js';
import { createSourceOutline } from '../../src/proposal/outline.js';
import type { Project } from '../../src/domain/schema.js';
import { createApp } from '../../src/server/app.js';
import { ProjectStore } from '../../src/server/store.js';
import { documentTestSettings, SYNTHETIC_DOCUMENT_BINDINGS } from '../document-helpers.js';
import { TEST_AUDIO_NORMALIZATION_OPTIONS } from '../helpers.js';

async function fixture(): Promise<{ root: string; directory: string; path: string; original: Project; store: ProjectStore; app: FastifyInstance }> {
  const root: string = await mkdtemp(join(tmpdir(), 'import-drafts-')); const directory: string = join(root, 'source');
  await cp('tests/fixtures/documents', directory, { recursive: true });
  const sources = await readDocumentSources(directory);
  const { handoffPath: path } = await writeDocumentPackage(directory, documentTestSettings(sources, SYNTHETIC_DOCUMENT_BINDINGS), join(root, 'seed'));
  const original: Project = createSourceOutline(importPackage(await readPackage(path)), { proposedTextHoldMs: 2000 });
  const store = new ProjectStore(join(root, 'data'));
  const app = await createApp({ host: '127.0.0.1', port: 4317, dataRoot: join(root, 'data'), webRoot: resolve(process.env.CUTROOM_E2E_WEB_ROOT ?? 'dist/web'),
    pdfFontPath: resolve('assets/fonts/NanumGothic-Regular.ttf'), audioNormalization: TEST_AUDIO_NORMALIZATION_OPTIONS,
    codex: { requestRoot: join(root, 'requests'), speechVoice: 'Yuna' } }, store, new CodexRequestStore(join(root, 'requests'), readBuildManifest()));
  await store.create(original);
  return { root, directory, path, original, store, app };
}

async function connect(panel: Locator): Promise<void> {
  for (const binding of SYNTHETIC_DOCUMENT_BINDINGS.people) await panel.getByLabel('인물 ID: ' + binding.key, { exact: true }).selectOption(binding.targetId);
  for (const binding of SYNTHETIC_DOCUMENT_BINDINGS.scenes) await panel.getByLabel('장면 ID: ' + binding.key, { exact: true }).selectOption(binding.targetId);
  await panel.getByLabel('프레임레이트', { exact: true }).selectOption('30/1');
  await panel.getByLabel('음성 샘플레이트', { exact: true }).selectOption('48000');
  await panel.getByLabel('화면비 가로', { exact: true }).fill('16');
  await panel.getByLabel('화면비 세로', { exact: true }).fill('9');
}

test('e2e_storyboard_creation_retry_after_reload_reuses_id_and_preserves_later_server_edit', async ({ page }): Promise<void> => {
  const { root, path, original, store, app } = await fixture();
  try {
    const sentIds: string[] = [];
    page.on('request', (request): void => { if (request.url().endsWith('/api/projects/import-independent')) sentIds.push((request.postDataJSON() as { storyboardId: string }).storyboardId); });
    await page.goto(await app.listen({ host: '127.0.0.1', port: 0 }));
    await page.getByRole('button', { name: '＋ 새 콘티 시작', exact: true }).click();
    const panel: Locator = page.getByRole('dialog');
    await panel.getByLabel('handoff 파일 경로', { exact: true }).fill(path);
    await panel.getByLabel('새 콘티 이름', { exact: true }).fill('응답 복구 콘티');
    await panel.getByLabel('초안 글자 유지 시간 (ms)', { exact: true }).fill('2100');
    await page.route('**/api/projects/import-independent', async (route: Route): Promise<void> => { await route.fetch(); await route.abort('failed'); });
    await panel.getByRole('button', { name: '별도 콘티 생성·열기', exact: true }).click();
    await expect(panel.getByRole('alert')).toBeVisible();
    expect(sentIds).toHaveLength(1);
    const id: string = `storyboard:${sentIds[0]!}`;
    const edited: Project = await store.update(id, 0, (project: Project): Project => ({ ...project, title: '생성 뒤 편집한 이름' }), []);
    await page.unroute('**/api/projects/import-independent');
    await page.reload();
    await page.getByRole('button', { name: '＋ 새 콘티 시작', exact: true }).click();
    await expect(panel.getByLabel('새 콘티 이름', { exact: true })).toHaveValue('응답 복구 콘티');
    await expect(panel.getByLabel('handoff 파일 경로', { exact: true })).toHaveValue(path);
    expect(sentIds).toHaveLength(1);
    await panel.getByRole('button', { name: '별도 콘티 생성·열기', exact: true }).click();
    await expect(panel).not.toBeVisible();
    expect(sentIds).toEqual([sentIds[0], sentIds[0]]);
    expect(await store.list()).toHaveLength(2);
    expect(await store.read(id)).toEqual(edited);
    expect(await store.read(original.projectId)).toEqual(original);
  } finally { await page.context().close(); await app.close(); await rm(root, { recursive: true, force: true }); }
});

test('e2e_document_draft_recovery_revalidates_sources_and_recovers_lost_package_response', async ({ page }, testInfo): Promise<void> => {
  const { root, directory, original, store, app } = await fixture();
  try {
    let creates: number = 0; let reviews: number = 0;
    page.on('request', (request): void => {
      if (request.url().endsWith('/api/document-packages') && request.method() === 'POST') creates += 1;
      if (/\/api\/document-reviews(?:\/[^/]+\/start)?$/u.test(request.url()) && request.method() === 'POST') reviews += 1;
    });
    await page.goto(await app.listen({ host: '127.0.0.1', port: 0 }));
    await page.locator('.project-rail').getByRole('button', { name: /제작 문서 8개/ }).click();
    const panel: Locator = page.getByRole('dialog');
    await panel.getByLabel('제작 문서 폴더', { exact: true }).fill(directory);
    await panel.getByRole('button', { name: '문서 검토', exact: true }).click();
    await connect(panel);
    await panel.getByRole('button', { name: '생성 내용 확인', exact: true }).click();
    const output: string = join(root, 'new-package');
    await panel.getByLabel('새 패키지 폴더', { exact: true }).fill(output);
    await panel.getByLabel('패키지 버전', { exact: true }).fill('recover-01');
    await page.reload();
    await page.locator('.project-rail').getByRole('button', { name: /제작 문서 8개/ }).click();
    await expect(panel.getByLabel('패키지 버전', { exact: true })).toHaveValue('recover-01');
    await expect(panel.getByRole('button', { name: '패키지 생성', exact: true })).toBeDisabled();
    expect(creates).toBe(0); expect(reviews).toBe(0);
    await panel.getByRole('button', { name: '원본 다시 확인', exact: true }).click();
    await expect(panel.getByRole('button', { name: '패키지 생성', exact: true })).toBeEnabled();
    await page.route('**/api/document-packages', async (route: Route): Promise<void> => { await route.fetch(); await route.abort('failed'); });
    await panel.getByRole('button', { name: '패키지 생성', exact: true }).click();
    await expect(panel.getByRole('alert')).toBeVisible();
    const saved: string = await readFile(join(output, 'storyboard_handoff.json'), 'utf8');
    await page.unroute('**/api/document-packages');
    await page.reload();
    await page.locator('.project-rail').getByRole('button', { name: /제작 문서 8개/ }).click();
    await panel.getByRole('button', { name: '생성 결과 확인', exact: true }).click();
    await expect(panel.locator('.document-success')).toContainText(output);
    expect(creates).toBe(1); expect(reviews).toBe(0);
    await panel.getByRole('button', { name: '원본 다시 확인', exact: true }).click();
    await expect(panel.getByRole('button', { name: '별도 콘티 생성·열기', exact: true })).toBeEnabled();
    await panel.getByLabel('초안 글자 유지 시간 (ms)', { exact: true }).fill('2400');
    await page.reload();
    await appendFile(join(directory, 'narration.md'), '\n');
    await page.locator('.project-rail').getByRole('button', { name: /제작 문서 8개/ }).click();
    await expect(panel.getByLabel('초안 글자 유지 시간 (ms)', { exact: true })).toHaveValue('2400');
    await panel.getByRole('button', { name: '원본 다시 확인', exact: true }).click();
    await expect(panel.getByRole('alert')).toContainText('원본 문서가 변경');
    expect(await readFile(join(output, 'storyboard_handoff.json'), 'utf8')).toBe(saved);
    expect(await store.list()).toHaveLength(1);
    expect(await store.read(original.projectId)).toEqual(original);
    expect(creates).toBe(1); expect(reviews).toBe(0);
    await page.screenshot({ path: testInfo.outputPath('restored-package-source-change.png') });
  } finally { await page.context().close(); await app.close(); await rm(root, { recursive: true, force: true }); }
});

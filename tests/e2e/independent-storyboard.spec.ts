import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, test } from '@playwright/test';
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

type StoryboardFixture = { root: string; sourceDirectory: string; handoffPath: string; original: Project; store: ProjectStore; app: FastifyInstance };

async function fixture(): Promise<StoryboardFixture> {
  const root: string = await mkdtemp(join(tmpdir(), 'independent-ui-'));
  const sourceDirectory: string = resolve('tests/fixtures/documents');
  const sources = await readDocumentSources(sourceDirectory);
  const { handoffPath } = await writeDocumentPackage(sourceDirectory, documentTestSettings(sources, SYNTHETIC_DOCUMENT_BINDINGS), join(root, 'seed-package'));
  const original = createSourceOutline(importPackage(await readPackage(handoffPath)), { proposedTextHoldMs: 2000 });
  const store = new ProjectStore(join(root, 'data'));
  const app = await createApp({ host: '127.0.0.1', port: 4317, dataRoot: join(root, 'data'), webRoot: resolve('dist/web'),
    pdfFontPath: resolve('assets/fonts/NanumGothic-Regular.ttf'), audioNormalization: TEST_AUDIO_NORMALIZATION_OPTIONS,
    codex: { requestRoot: join(root, 'requests'), speechVoice: 'Yuna' } }, store, new CodexRequestStore(join(root, 'requests'), readBuildManifest()));
  await store.create(original);
  return { root, sourceDirectory, handoffPath, original, store, app };
}

test('e2e_existing_package_creates_independent_storyboard_in_list_and_reopens', async ({ page }, testInfo): Promise<void> => {
  const { root, handoffPath, original, store, app } = await fixture();
  try {
    await page.goto(await app.listen({ host: '127.0.0.1', port: 0 }));
    await page.getByRole('button', { name: '＋ 새 콘티 시작', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '패키지로 별도 콘티 시작' });
    await dialog.getByLabel('handoff 파일 경로', { exact: true }).fill(handoffPath);
    await dialog.getByLabel('새 콘티 이름', { exact: true }).fill('화분 이야기 — 두 번째 연출');
    await dialog.getByLabel('초안 글자 유지 시간 (ms)', { exact: true }).fill('2000');
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await dialog.locator('.document-scroll').evaluate((element: HTMLDivElement): boolean => element.scrollWidth <= element.clientWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath('independent-storyboard-mobile.png') });
    await dialog.getByRole('button', { name: '별도 콘티 생성·열기', exact: true }).click();
    await expect(dialog).not.toBeVisible();
    await expect(page.locator('.project-list .project-tile')).toHaveCount(2);
    await expect(page.locator('.project-tile.active')).toContainText('화분 이야기 — 두 번째 연출');
    await expect(page.locator('.topbar h1')).toHaveText('화분 이야기 — 두 번째 연출');
    expect(await store.read(original.projectId)).toEqual(original);
    const created = (await store.list()).find((item): boolean => item.projectId !== original.projectId)!;
    expect((await store.read(created.projectId)).handoff).toEqual(original.handoff);
    await page.reload();
    await page.getByRole('button', { name: '프로젝트', exact: true }).click();
    await page.locator('.project-tile').filter({ hasText: '화분 이야기 — 두 번째 연출' }).click();
    await expect(page.locator('.topbar h1')).toHaveText('화분 이야기 — 두 번째 연출');
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.screenshot({ path: testInfo.outputPath('independent-storyboard-list.png') });
    await page.getByRole('button', { name: '＋ 새 콘티 시작', exact: true }).click();
    await dialog.getByLabel('handoff 파일 경로', { exact: true }).fill(handoffPath);
    await dialog.getByLabel('새 콘티 이름', { exact: true }).fill('화분 이야기 — 두 번째 연출');
    await dialog.getByLabel('초안 글자 유지 시간 (ms)', { exact: true }).fill('2000');
    await dialog.getByRole('button', { name: '별도 콘티 생성·열기', exact: true }).click();
    await expect(dialog).not.toBeVisible();
    await expect(page.locator('.project-list .project-tile')).toHaveCount(3);
  } finally { await page.context().close(); await app.close(); await rm(root, { recursive: true, force: true }); }
});

test('e2e_document_package_completion_starts_separate_storyboard_for_same_story', async ({ page }): Promise<void> => {
  const { root, sourceDirectory, original, store, app } = await fixture();
  try {
    await page.goto(await app.listen({ host: '127.0.0.1', port: 0 }));
    await page.locator('.project-rail').getByRole('button', { name: /제작 문서 8개/ }).click();
    const dialog = page.getByRole('dialog', { name: '어떤 이야기를 만들까요?' });
    await dialog.getByLabel('제작 문서 폴더').fill(sourceDirectory);
    await dialog.getByRole('button', { name: '문서 검토', exact: true }).click();
    const panel = page.locator('.document-workflow').filter({ has: page.locator('#document-workflow-title') });
    for (const binding of SYNTHETIC_DOCUMENT_BINDINGS.people) await panel.getByLabel('인물 ID: ' + binding.key, { exact: true }).selectOption(binding.targetId);
    for (const binding of SYNTHETIC_DOCUMENT_BINDINGS.scenes) await panel.getByLabel('장면 ID: ' + binding.key, { exact: true }).selectOption(binding.targetId);
    await panel.getByLabel('프레임레이트', { exact: true }).selectOption('30/1');
    await panel.getByLabel('음성 샘플레이트', { exact: true }).selectOption('48000');
    await panel.getByLabel('화면비 가로', { exact: true }).fill('16'); await panel.getByLabel('화면비 세로', { exact: true }).fill('9');
    await panel.getByRole('button', { name: '생성 내용 확인', exact: true }).click();
    await panel.getByLabel('새 패키지 폴더', { exact: true }).fill(join(root, 'new-package'));
    await panel.getByLabel('패키지 버전', { exact: true }).fill('draft-02');
    await panel.getByRole('button', { name: '패키지 생성', exact: true }).click();
    await expect(panel.locator('.document-success')).toContainText('패키지 생성 완료');
    await expect(panel.getByRole('button', { name: '완료 · 편집기로 돌아가기', exact: true })).toHaveCount(0);
    await panel.getByLabel('새 콘티 이름', { exact: true }).fill('화분 이야기 — 새 패키지 콘티');
    await panel.getByLabel('초안 글자 유지 시간 (ms)', { exact: true }).fill('1800');
    await panel.getByRole('button', { name: '별도 콘티 생성·열기', exact: true }).click();
    await expect(panel).not.toBeVisible();
    await expect(page.locator('.project-list .project-tile')).toHaveCount(2);
    await expect(page.locator('.project-tile.active')).toContainText('화분 이야기 — 새 패키지 콘티');
    expect(await store.read(original.projectId)).toEqual(original);
    const created = (await store.list()).find((item): boolean => item.projectId !== original.projectId)!;
    expect((await store.read(created.projectId)).handoff.packageVersion).toBe('draft-02');
    expect((await store.read(created.projectId)).handoff.timebase.fpsNumerator).toBe(30);
  } finally { await page.context().close(); await app.close(); await rm(root, { recursive: true, force: true }); }
});

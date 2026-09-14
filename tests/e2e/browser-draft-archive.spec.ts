import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, test } from '@playwright/test';
import { readBuildManifest } from '../../src/build.js';
import { CodexRequestStore } from '../../src/codex/requests.js';
import type { Project } from '../../src/domain/schema.js';
import { createApp } from '../../src/server/app.js';
import { ProjectStore } from '../../src/server/store.js';
import type { BrowserDraft } from '../../web/src/browser-drafts.js';
import { TEST_AUDIO_NORMALIZATION_OPTIONS, TEST_TEXT_FONT_PATH } from '../helpers.js';
import { readinessOutline } from '../readiness-fixtures.js';

test('e2e_draft_archive_preserves_orphaned_edits_exports_and_observes_concurrent_writer_without_server_mutation', async ({ page }): Promise<void> => {
  const root: string = await mkdtemp(join(tmpdir(), 'cutroom-draft-archive-ui-')); const dataRoot: string = join(root, 'data');
  const store = new ProjectStore(dataRoot); const project: Project = await readinessOutline(); await store.create(project);
  const app = await createApp({ host: '127.0.0.1', port: 0, dataRoot, webRoot: resolve(process.env.CUTROOM_E2E_WEB_ROOT ?? 'dist/web'), pdfFontPath: TEST_TEXT_FONT_PATH,
    audioNormalization: TEST_AUDIO_NORMALIZATION_OPTIONS, codex: { requestRoot: join(root, 'requests'), speechVoice: 'Yuna' } }, store, new CodexRequestStore(join(root, 'requests'), readBuildManifest()));
  const mutations: string[] = []; const errors: string[] = [];
  page.on('request', (request): void => { if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method())) mutations.push(request.url()); });
  page.on('pageerror', (error: Error): void => { errors.push(error.message); });
  try {
    const origin: string = await app.listen({ host: '127.0.0.1', port: 0 }); await page.goto(origin);
    const inspector = page.getByRole('complementary', { name: '콘티 편집 패널' });
    await inspector.getByRole('textbox', { name: '행동·연출', exact: true }).fill('원본 변경 전 작성하던 연출');
    await inspector.getByRole('button', { name: '그림', exact: true }).click();
    await inspector.locator('.frame-editor').first().getByRole('textbox', { name: '프레임 설명', exact: true }).fill('사라진 프레임에도 남겨 둘 설명');
    const oldShotId: string = project.shots[0]!.id;
    const updated: Project = await store.update(project.projectId, project.revision, (current: Project): Project => ({ ...current,
      shots: current.shots.map((shot) => shot.id === oldShotId ? { ...shot, id: 'replacement-shot' } : shot),
      frames: current.frames.map((frame) => frame.shotId === oldShotId ? { ...frame, id: `replacement:${frame.id}`, shotId: 'replacement-shot' } : frame),
    }), []);
    await page.reload();
    await page.getByRole('navigation', { name: '콘티 작업 공간' }).getByRole('button', { name: '제작 현황', exact: true }).click();
    await page.getByText('미저장 편집 기록', { exact: true }).click();
    const archive = page.getByRole('region', { name: '미저장 편집 기록 보관함' });
    await expect(archive).toContainText('현재 대상이 없는 기록 2개');
    await archive.getByLabel('임시 기록 표시 범위').selectOption('missing');
    const direction = archive.locator('.draft-archive-entry').filter({ has: page.locator('summary').filter({ hasText: '컷 연출' }) });
    await direction.locator('summary').first().click();
    await expect(direction.getByLabel('보관된 작성 내용')).toHaveValue(/원본 변경 전 작성하던 연출/u);
    await expect(direction.getByRole('button', { name: '현재 편집 대상 열기' })).toHaveCount(0);
    await direction.getByText('편집을 시작할 때의 기준', { exact: true }).click();
    expect((JSON.parse(await direction.locator('pre').innerText()) as { 편집전값: { action: string } }).편집전값.action).toBe(project.shots[0]!.action);
    const before: Record<string, string> = await page.evaluate((): Record<string, string> => Object.fromEntries(Object.keys(localStorage)
      .filter((key): boolean => key.startsWith('cutroom:draft:1:')).map((key): [string, string] => [key, localStorage.getItem(key)!])));
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write'], { origin });
    await direction.getByRole('button', { name: '작성 내용 복사' }).click();
    const copied: string = await page.evaluate(async (): Promise<string> => navigator.clipboard.readText()); expect(copied).toContain('원본 변경 전 작성하던 연출');
    const downloading = page.waitForEvent('download'); await direction.getByRole('button', { name: '기록 JSON 보관' }).click();
    const download = await downloading; const path: string | null = await download.path(); expect(path).not.toBeNull();
    const saved = JSON.parse(await readFile(path!, 'utf8')) as { projectId: string; record: BrowserDraft };
    expect(saved.projectId).toBe(project.projectId); expect(saved.record.value).toContain('원본 변경 전 작성하던 연출');
    const second = await page.context().newPage(); await second.goto(origin);
    const remainingFrame = updated.frames.find((frame): boolean => frame.shotId !== 'replacement-shot')!;
    await second.evaluate(({ record, projectId, frame }): void => {
      const fork: BrowserDraft = { ...record, id: crypto.randomUUID(), sequence: 1, replaces: [], savedAt: new Date().toISOString(), value: JSON.stringify({ action: '다른 탭에서 남긴 연출' }) };
      localStorage.setItem(`cutroom:draft:1:${encodeURIComponent(fork.scope)}:${fork.id}`, JSON.stringify(fork));
      const other: BrowserDraft = { ...fork, id: crypto.randomUUID(), scope: JSON.stringify([`${projectId}:other`, 'direction', 'deleted-shot']), value: JSON.stringify({ action: '다른 프로젝트의 비공개 연출' }) };
      localStorage.setItem(`cutroom:draft:1:${encodeURIComponent(other.scope)}:${other.id}`, JSON.stringify(other));
      const current: BrowserDraft = { ...fork, id: crypto.randomUUID(), scope: JSON.stringify([projectId, 'frame', frame.id]),
        basis: JSON.stringify([JSON.stringify({ offsetMs: frame.offsetMs, role: frame.role, description: frame.description }), '1']),
        value: JSON.stringify({ offsetMs: frame.offsetMs, role: frame.role, description: '현재 대상에 남아 있는 메모' }) };
      localStorage.setItem(`cutroom:draft:1:${encodeURIComponent(current.scope)}:${current.id}`, JSON.stringify(current));
    }, { record: saved.record, projectId: project.projectId, frame: remainingFrame });
    await expect(archive).toContainText('현재 대상이 없는 기록 3개');
    await expect(direction.first()).toContainText('여러 화면의 기록');
    await expect(archive).not.toContainText('다른 프로젝트의 비공개 연출');
    for (const [key, value] of Object.entries(before)) expect(await page.evaluate((key: string): string | null => localStorage.getItem(key), key)).toBe(value);
    await page.setViewportSize({ width: 390, height: 844 });
    await archive.scrollIntoViewIfNeeded(); await page.screenshot({ path: '.local/validation/automation-runtime/browser-draft-archive-mobile.png' });
    expect(await page.evaluate((): boolean => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.setViewportSize({ width: 1280, height: 900 });
    await direction.first().scrollIntoViewIfNeeded(); await page.screenshot({ path: '.local/validation/automation-runtime/browser-draft-archive-desktop.png' });
    await archive.getByLabel('임시 기록 표시 범위').selectOption('all');
    await archive.getByLabel('임시 기록 검색').fill('현재 대상에 남아 있는 메모');
    const currentEntry = archive.locator('.draft-archive-entry'); await expect(currentEntry).toHaveCount(1); await currentEntry.locator('summary').first().click();
    await currentEntry.getByRole('button', { name: '현재 편집 대상 열기' }).click();
    await expect(inspector).toBeVisible();
    await expect(inspector.locator('.frame-editor').first().getByRole('textbox', { name: '프레임 설명', exact: true })).toHaveValue('현재 대상에 남아 있는 메모');
    expect(mutations).toEqual([]); expect(errors).toEqual([]); expect(await store.read(project.projectId)).toEqual(updated);
  } finally { await page.context().close(); await app.close(); await store.close(); await rm(root, { recursive: true, force: true }); }
});

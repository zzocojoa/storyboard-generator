import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, test } from '@playwright/test';
import { readBuildManifest } from '../../src/build.js';
import { CodexRequestStore } from '../../src/codex/requests.js';
import { createApp } from '../../src/server/app.js';
import { ProjectStore } from '../../src/server/store.js';
import { readProjectBackup } from '../../src/backup/snapshot.js';
import { sha256Text } from '../../src/importers/integrity.js';
import { TEST_AUDIO_NORMALIZATION_OPTIONS, TEST_TEXT_FONT_PATH } from '../helpers.js';
import { readinessOutline } from '../readiness-fixtures.js';

test('e2e_project_backup_preserves_drafts_recovers_lost_response_and_verifies_without_recreating', async ({ page }): Promise<void> => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'cutroom-project-backup-ui-'))); const dataRoot = join(root, 'data'); const store = new ProjectStore(dataRoot);
  const project = await readinessOutline(); await store.create(project);
  const before = await readFile(join(dataRoot, sha256Text(project.projectId), 'project.json'));
  const app = await createApp({ host: '127.0.0.1', port: 0, dataRoot, webRoot: resolve(process.env.CUTROOM_E2E_WEB_ROOT ?? 'dist/web'), pdfFontPath: TEST_TEXT_FONT_PATH,
    audioNormalization: TEST_AUDIO_NORMALIZATION_OPTIONS, codex: { requestRoot: join(root, 'requests'), speechVoice: 'Yuna' } }, store, new CodexRequestStore(join(root, 'requests'), readBuildManifest()));
  const requests: string[] = []; page.on('request', (request): void => { if (request.method() === 'POST' && request.url().includes('/backups')) requests.push(request.url()); });
  try {
    await page.goto(await app.listen({ host: '127.0.0.1', port: 0 }));
    await page.getByRole('navigation', { name: '콘티 작업 공간' }).getByRole('button', { name: '제작 현황', exact: true }).click();
    await page.getByText('저장된 콘티 백업', { exact: true }).click();
    const panel = page.getByRole('region', { name: '저장된 콘티 백업', exact: true });
    await panel.getByLabel('백업 상위 폴더', { exact: true }).fill(root); await panel.getByLabel('새 백업 폴더 이름', { exact: true }).fill('사용자 백업');
    await panel.getByRole('button', { name: '백업 내용 확인', exact: true }).click();
    await expect(panel.getByRole('region', { name: '백업 내용', exact: true })).toContainText('버전 1개');
    const requestCount = requests.length; await page.reload(); await page.getByText('저장된 콘티 백업', { exact: true }).click();
    await expect(panel.getByLabel('새 백업 폴더 이름')).toHaveValue('사용자 백업'); expect(requests.length).toBe(requestCount);
    await expect(panel.getByRole('button', { name: '이 내용으로 백업', exact: true })).toHaveCount(0);
    await panel.getByRole('button', { name: '백업 내용 확인', exact: true }).click();
    await expect(panel.getByRole('button', { name: '이 내용으로 백업', exact: true })).toBeVisible();
    await page.route('**/backups', async (route): Promise<void> => { await route.fetch(); await route.abort('failed'); });
    await panel.getByRole('button', { name: '이 내용으로 백업', exact: true }).click();
    await expect(panel.getByRole('alert')).toContainText('백업 파일 검증'); await page.unroute('**/backups');
    expect((await readProjectBackup(join(root, '사용자 백업'))).project).toEqual(project);
    const afterCreation = requests.length; await page.reload(); await page.getByText('저장된 콘티 백업', { exact: true }).click();
    await expect(panel.getByLabel('검증할 백업 폴더')).toHaveValue(join(root, '사용자 백업')); expect(requests.length).toBe(afterCreation);
    await expect(panel.getByRole('region', { name: '백업 검사 결과' })).toHaveCount(0);
    await panel.getByRole('button', { name: '백업 파일 검증', exact: true }).click();
    await expect(panel.getByRole('region', { name: '백업 검사 결과' })).toContainText('보관한 파일과 전체 버전 목록을 확인했습니다.');
    expect(requests.filter((url): boolean => url.endsWith('/backups'))).toHaveLength(1);
    expect(await readFile(join(dataRoot, sha256Text(project.projectId), 'project.json'))).toEqual(before);
    await panel.scrollIntoViewIfNeeded(); await page.screenshot({ path: '.local/validation/automation-runtime/project-backup-browser.png', fullPage: false });
  } finally { await app.close(); await rm(root, { recursive: true, force: true }); }
});

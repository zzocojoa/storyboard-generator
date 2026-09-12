import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, test } from '@playwright/test';
import { readBuildManifest } from '../../src/build.js';
import { CodexRequestStore } from '../../src/codex/requests.js';
import type { Project } from '../../src/domain/schema.js';
import { createApp } from '../../src/server/app.js';
import { ProjectStore } from '../../src/server/store.js';
import { TEST_AUDIO_NORMALIZATION_OPTIONS } from '../helpers.js';
import { readinessOutline } from '../readiness-fixtures.js';

test('e2e_browser_drafts_restore_location_and_compare_server_changes_without_mutation', async ({ page }): Promise<void> => {
  const root: string = await mkdtemp(join(tmpdir(), 'cutroom-draft-ui-')); const dataRoot: string = join(root, 'data');
  const store = new ProjectStore(dataRoot); const project: Project = await readinessOutline(); await store.create(project);
  const app = await createApp({ host: '127.0.0.1', port: 0, dataRoot, webRoot: resolve(process.env.CUTROOM_E2E_WEB_ROOT ?? 'dist/web'),
    pdfFontPath: resolve('assets/fonts/NanumGothic-Regular.ttf'), audioNormalization: TEST_AUDIO_NORMALIZATION_OPTIONS,
    codex: { requestRoot: join(root, 'requests'), speechVoice: 'Yuna' } }, store, new CodexRequestStore(join(root, 'requests'), readBuildManifest()));
  const mutations: string[] = [];
  page.on('request', (request): void => { if (['POST', 'PATCH', 'DELETE'].includes(request.method())) mutations.push(request.url()); });
  try {
    const base: string = await app.listen({ host: '127.0.0.1', port: 0 }); await page.goto(base);
    const inspector = page.getByRole('complementary', { name: '콘티 편집 패널' });
    const action = inspector.getByRole('textbox', { name: '행동·연출', exact: true });
    await action.fill('새로고침 전에 작성한 연출');
    await page.reload(); await expect(action).toHaveValue('새로고침 전에 작성한 연출');
    await expect(inspector).toContainText('작성 중이던 입력을 복원했습니다.');
    const navigation = page.getByRole('navigation', { name: '콘티 작업 공간' });
    await navigation.getByRole('button', { name: '제작 설정', exact: true }).click();
    const layout = page.getByRole('form', { name: '글자 배치 설정' });
    const reading = page.getByRole('form', { name: '글자 읽기 기준' });
    await layout.getByLabel('글자 크기 · 짧은 변의 %').fill('5');
    await reading.getByLabel('최소 표시 시간 ms').fill('-20');
    await page.reload();
    await expect(layout).toBeVisible();
    await expect(layout.getByLabel('글자 크기 · 짧은 변의 %')).toHaveValue('5');
    await expect(layout.getByLabel('배치 설정 방식')).toHaveValue('manual');
    await expect(reading.getByLabel('최소 표시 시간 ms')).toHaveValue('-20');
    await expect(reading.getByRole('button', { name: '읽기 기준 저장', exact: true })).toBeDisabled();
    await navigation.getByRole('button', { name: '컷 편집', exact: true }).click();
    await page.locator('.scene-rail .segment-row').nth(1).click();
    await expect(action).not.toHaveValue('새로고침 전에 작성한 연출');
    await page.locator('.scene-rail .segment-row').first().click();
    await expect(action).toHaveValue('새로고침 전에 작성한 연출');

    await inspector.getByRole('button', { name: '그림', exact: true }).click();
    const frame = inspector.locator('.frame-editor').first();
    await frame.getByRole('textbox', { name: '프레임 설명', exact: true }).fill('보존할 그림 설명');
    await page.getByRole('slider', { name: '재생 위치', exact: true }).evaluate((element: HTMLInputElement): void => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(element, '3000'); element.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await page.reload();
    await expect(frame.getByRole('textbox', { name: '프레임 설명', exact: true })).toHaveValue('보존할 그림 설명');
    await expect(page.getByRole('slider', { name: '재생 위치', exact: true })).toHaveValue('3000');
    await expect(page.getByRole('button', { name: '시간순 재생', exact: true })).toBeVisible();
    expect(mutations).toEqual([]);
    const latest: Project = await store.update(project.projectId, 0, (current: Project): Project => ({ ...current,
      shots: current.shots.map((shot, index) => index === 0 ? { ...shot, action: '다른 작업에서 저장한 연출' } : shot) }), []);
    await page.getByRole('button', { name: '새로고침', exact: true }).click();
    await expect(frame).toContainText('작성 이후 저장된 기준이 바뀌었습니다.');
    await expect(frame.getByRole('button', { name: '프레임 저장', exact: true })).toBeDisabled();
    await inspector.getByRole('button', { name: '연출', exact: true }).click();
    await expect(action).toHaveValue('새로고침 전에 작성한 연출');
    await expect(inspector.getByRole('button', { name: '컷 저장', exact: true })).toBeDisabled();
    const notice = inspector.getByRole('complementary', { name: '미저장 입력 복원' }).filter({ visible: true });
    await notice.scrollIntoViewIfNeeded();
    await page.screenshot({ path: '.local/validation/automation-runtime/browser-drafts-conflict.png' });
    await notice.getByText('현재 서버 값과 작성한 값 비교', { exact: true }).click();
    await expect(notice).toContainText('다른 작업에서 저장한 연출');
    await notice.getByRole('button', { name: '작성한 값을 현재 기준으로 검토', exact: true }).click();
    await expect(inspector.getByRole('button', { name: '컷 저장', exact: true })).toBeEnabled();
    expect(mutations).toEqual([]); expect((await store.read(project.projectId)).revision).toBe(latest.revision);
    await page.screenshot({ path: '.local/validation/automation-runtime/browser-drafts-restored.png' });
  } finally { await page.context().close(); await app.close(); await rm(root, { recursive: true, force: true }); }
});

test('e2e_browser_drafts_preserve_two_tabs_and_new_page_recovery', async ({ page }): Promise<void> => {
  const root: string = await mkdtemp(join(tmpdir(), 'cutroom-draft-tabs-')); const dataRoot: string = join(root, 'data');
  const store = new ProjectStore(dataRoot); const project: Project = await readinessOutline(); await store.create(project);
  const app = await createApp({ host: '127.0.0.1', port: 0, dataRoot, webRoot: resolve(process.env.CUTROOM_E2E_WEB_ROOT ?? 'dist/web'),
    pdfFontPath: resolve('assets/fonts/NanumGothic-Regular.ttf'), audioNormalization: TEST_AUDIO_NORMALIZATION_OPTIONS,
    codex: { requestRoot: join(root, 'requests'), speechVoice: 'Yuna' } }, store, new CodexRequestStore(join(root, 'requests'), readBuildManifest()));
  try {
    const base: string = await app.listen({ host: '127.0.0.1', port: 0 }); await page.goto(base);
    const second = await page.context().newPage(); await second.goto(base);
    await expect(second.getByRole('textbox', { name: '행동·연출', exact: true })).toHaveValue(project.shots[0]!.action);
    await page.getByRole('textbox', { name: '행동·연출', exact: true }).fill('첫 번째 탭의 연출');
    await second.getByRole('textbox', { name: '행동·연출', exact: true }).fill('두 번째 탭의 연출');
    await expect(page.getByRole('button', { name: '컷 저장', exact: true })).toBeDisabled();
    await expect(second.getByRole('button', { name: '컷 저장', exact: true })).toBeDisabled();
    await page.close(); await second.close();
    const reopened = await page.context().newPage(); await reopened.goto(base);
    const notice = reopened.getByRole('complementary', { name: '미저장 입력 복원' }).filter({ visible: true });
    await expect(notice).toContainText('다른 화면에서 작성한 입력이 있습니다.');
    const choices = notice.locator('details'); await expect(choices).toHaveCount(2);
    await choices.nth(0).locator('summary').click(); await choices.nth(1).locator('summary').click();
    await expect(notice).toContainText('첫 번째 탭의 연출'); await expect(notice).toContainText('두 번째 탭의 연출');
    await choices.filter({ hasText: '두 번째 탭의 연출' }).getByRole('button', { name: '이 입력 복원' }).click();
    await expect(reopened.getByRole('textbox', { name: '행동·연출', exact: true })).toHaveValue('두 번째 탭의 연출');
    await reopened.reload(); await expect(reopened.getByRole('textbox', { name: '행동·연출', exact: true })).toHaveValue('두 번째 탭의 연출');
    expect((await store.read(project.projectId)).revision).toBe(0);
  } finally { await page.context().close(); await app.close(); await rm(root, { recursive: true, force: true }); }
});

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { AutomationService } from '../../src/automation/service.js';
import { buildForSpeechVoice } from '../../src/build.js';
import { CodexRequestStore } from '../../src/codex/requests.js';
import type { Project } from '../../src/domain/schema.js';
import { createApp } from '../../src/server/app.js';
import { createExecutionHarness } from '../automatic-executor-helpers.js';
import { TEST_AUDIO_NORMALIZATION_OPTIONS } from '../helpers.js';

async function openStartForm(page: Page, address: string): Promise<void> {
  await page.goto(address);
  await page.getByRole('navigation', { name: '콘티 작업 공간' }).getByRole('button', { name: '제작 현황', exact: true }).click();
  await page.getByRole('region', { name: '자동 제작 시작 설정', exact: true }).waitFor();
  await page.getByText('제작 범위와 실행 설정', { exact: false }).click();
}

test('e2e_automation_start_drafts_preserve_invalid_inputs_forks_and_require_current_revision_without_launch', async ({ page }): Promise<void> => {
  const h = await createExecutionHarness(async (): Promise<void> => {});
  const root: string = await mkdtemp(join(tmpdir(), 'automation-start-draft-'));
  const service = new AutomationService({ services: h.services, onError: (_id, problem): void => { throw new Error(problem.message); } });
  await service.initialize(); await service.cancel(h.source.projectId, h.id);
  const app = await createApp({ host: '127.0.0.1', port: 0, dataRoot: join(root, 'unused'), webRoot: resolve(process.env['CUTROOM_E2E_WEB_ROOT'] ?? 'dist/web'),
    pdfFontPath: resolve('assets/fonts/NanumGothic-Regular.ttf'), audioNormalization: TEST_AUDIO_NORMALIZATION_OPTIONS,
    codex: { requestRoot: join(root, 'requests'), speechVoice: 'Yuna' } }, h.services.projects,
  new CodexRequestStore(join(root, 'requests'), buildForSpeechVoice('Yuna')), undefined, undefined, service);
  const context = page.context();
  const launches: string[] = [];
  context.on('request', (request): void => { if (request.method() === 'POST' && /\/automation(?:\/[^/]+\/(?:resume|cancel|pause))?$/.test(new URL(request.url()).pathname)) launches.push(request.url()); });
  try {
    const address: string = await app.listen({ host: '127.0.0.1', port: 0 });
    await openStartForm(page, address);
    const second: Page = await context.newPage(); await openStartForm(second, address);
    await page.getByLabel('자동 제작 모델').fill('first-tab-model');
    await second.getByLabel('자동 제작 모델').fill('second-tab-model');
    await expect(page.getByRole('region', { name: '자동 제작 시작 설정', exact: true })).toContainText('다른 화면에서 작성한 입력이 있습니다.');
    await page.close(); await second.close();
    const restored: Page = await context.newPage(); await openStartForm(restored, address);
    const form = restored.getByRole('region', { name: '자동 제작 시작 설정', exact: true });
    const start = form.getByRole('button', { name: /개 구간 자동 제작 시작$/ });
    await expect(start).toBeDisabled();
    const choice = form.getByRole('complementary', { name: '미저장 입력 복원' }).locator('details').filter({ hasText: 'first-tab-model' });
    await choice.locator('summary').click(); await choice.getByRole('button', { name: '이 입력 복원' }).click();
    await expect(form.getByLabel('자동 제작 모델')).toHaveValue('first-tab-model');
    await form.getByLabel('음성 제작', { exact: true }).selectOption('guide-voice');
    await form.getByLabel('전체 작업 수 한도').fill('-10');
    await form.getByLabel('공통 음성 이름', { exact: true }).fill('');
    await restored.reload();
    await form.getByText('제작 범위와 실행 설정', { exact: false }).click();
    await expect(form.getByLabel('전체 작업 수 한도')).toHaveValue('-10');
    await expect(form.getByLabel('공통 음성 이름', { exact: true })).toHaveValue('');
    await expect(form).toContainText('실행 설정을 확인하세요.');
    await expect(start).toBeDisabled();
    await form.getByLabel('전체 작업 수 한도').fill('40');
    await form.getByLabel('음성 제작', { exact: true }).selectOption('instructions-only');
    await expect(start).toBeEnabled();
    await expect(form.getByLabel('공통 음성 이름', { exact: true })).toHaveCount(0);
    await form.getByLabel('음성 제작', { exact: true }).selectOption('guide-voice');
    await expect(form.getByLabel('공통 음성 이름', { exact: true })).toHaveValue('');
    await expect(start).toBeDisabled();
    await form.getByLabel('공통 음성 이름', { exact: true }).fill('Yuna');
    await expect(start).toBeEnabled();
    await h.services.projects.update(h.source.projectId, 0, (project: Project): Project => ({ ...project, title: '다른 작업에서 수정한 제목' }), []);
    await restored.getByRole('button', { name: '새로고침', exact: true }).click();
    await expect(form).toContainText('작성 이후 저장된 기준이 바뀌었습니다.');
    await expect(start).toBeDisabled();
    await form.getByRole('button', { name: '작성한 값을 현재 기준으로 검토', exact: true }).click();
    await expect(start).toBeEnabled();
    await expect(form.getByLabel('자동 제작 모델')).toHaveValue('first-tab-model');
    expect(launches).toEqual([]);
    const runs = await service.list(h.source.projectId);
    expect(runs).toHaveLength(1); expect(runs[0]!.status).toBe('cancelled');
    expect((await h.services.projects.read(h.source.projectId)).revision).toBe(1);
    await form.scrollIntoViewIfNeeded();
    await restored.screenshot({ path: '.local/validation/automation-runtime/automation-start-restored.png' });
  } finally { await context.close(); await app.close(); await h.close(); await rm(root, { recursive: true, force: true }); }
});

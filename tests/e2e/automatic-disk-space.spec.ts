import { withTestVoiceCasting } from '../automatic-complete-engines.js';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { expect, test } from '@playwright/test';
import { AutomationDiskSpace } from '../../src/automation/disk-space.js';
import { AutomationService } from '../../src/automation/service.js';
import { buildForSpeechVoice } from '../../src/build.js';
import { CodexRequestStore } from '../../src/codex/requests.js';
import { createApp } from '../../src/server/app.js';
import type { AppConfig } from '../../src/server/config.js';
import { createExecutionHarness } from '../automatic-executor-helpers.js';
import { TEST_AUDIO_NORMALIZATION_OPTIONS } from '../helpers.js';

test('e2e_automatic_disk_shortage_shows_capacity_and_resumes_preserved_run', async ({ page }): Promise<void> => {
  const h = await createExecutionHarness(async (): Promise<void> => {});
  let available: bigint = 256n * 1024n * 1024n;
  const diskSpace = new AutomationDiskSpace({ project: join(h.root, 'data'), automation: join(h.root, 'automatic'), temporary: tmpdir() }, 1073741824,
    async (path) => ({ path, device: 'simulated-disk', availableBytes: available }));
  const service = new AutomationService({ services: { ...h.services, diskSpace, engines: () => withTestVoiceCasting(h.engine) }, onError: (_id, problem): void => { throw new Error(problem.message); } });
  await service.initialize(); await service.cancel(h.source.projectId, h.id);
  const config: AppConfig = { host: '127.0.0.1', port: 4317, dataRoot: join(h.root, 'data'), webRoot: resolve('dist/web'),
    pdfFontPath: resolve('assets/fonts/NanumGothic-Regular.ttf'), audioNormalization: TEST_AUDIO_NORMALIZATION_OPTIONS,
    codex: { requestRoot: join(h.root, 'requests'), speechVoice: 'Yuna' } };
  const app = await createApp(config, h.services.projects, new CodexRequestStore(config.codex.requestRoot, buildForSpeechVoice('Yuna')), undefined, undefined, service);
  try {
    await page.goto(await app.listen({ host: '127.0.0.1', port: 0 }));
    await page.getByRole('navigation', { name: '콘티 작업 공간' }).getByRole('button', { name: '제작 현황', exact: true }).click();
    const panel = page.getByRole('region', { name: 'Codex 자동 제작' });
    const storage = panel.getByRole('region', { name: '자동 제작 저장 공간' });
    await expect(storage).toContainText('공간을 확보한 뒤 이어 만드세요.');
    await panel.getByText('제작 범위와 실행 설정', { exact: false }).click();
    const checkboxes = panel.locator('.automatic-segment input');
    for (let index: number = 0; index < h.source.dataset.segments.length; index += 1) await checkboxes.nth(index).setChecked(h.source.dataset.segments[index]!.id === 'demonstration');
    await panel.getByRole('button', { name: '1개 구간 자동 제작 시작', exact: true }).click();
    await expect(panel.getByText('확인이 필요합니다', { exact: true })).toBeVisible();
    await expect(panel).toContainText('AUTOMATION_DISK_SPACE_LOW');
    const before = (await service.list(h.source.projectId))[0]!;
    expect(before.jobs.every((job): boolean => job.attempts === 0)).toBe(true);
    expect((await h.services.projects.read(h.source.projectId)).revision).toBe(0);
    await storage.scrollIntoViewIfNeeded(); await page.screenshot({ path: '.local/validation/automation-runtime/disk-space-paused-browser.png' });
    available = 20n * 1024n ** 3n;
    await storage.getByRole('button', { name: '저장 공간 다시 확인' }).click();
    await expect(storage).toContainText('현재 공간으로 제작을 시작할 수 있습니다.');
    await panel.getByRole('button', { name: '이어 만들기', exact: true }).click();
    await expect(panel.getByText('생성 결과 검토 대기', { exact: true })).toBeVisible({ timeout: 20000 });
    const after = (await service.list(h.source.projectId))[0]!;
    expect(after.id).toBe(before.id); expect(after.jobs.every((job): boolean => job.attempts === 1)).toBe(true);
    await storage.scrollIntoViewIfNeeded(); await page.screenshot({ path: '.local/validation/automation-runtime/disk-space-resumed-browser.png' });
    const project = await h.services.projects.read(h.source.projectId);
    expect(project.dataset).toEqual(h.source.dataset); expect(project.frames.every((frame): boolean => frame.visualReview !== 'accepted')).toBe(true);
  } finally { await app.close(); await service.close(); await h.close(); }
});

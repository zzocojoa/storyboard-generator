import { z } from 'zod';
import { IssueSchema } from '../../src/domain/schema.js';
import { audioCueSource } from '../../src/domain/audio-source.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, test } from '@playwright/test';
import { AutomationService } from '../../src/automation/service.js';
import { buildForSpeechVoice } from '../../src/build.js';
import { CodexRequestStore } from '../../src/codex/requests.js';
import { createApp } from '../../src/server/app.js';
import { createExecutionHarness } from '../automatic-executor-helpers.js';
import { TEST_AUDIO_NORMALIZATION_OPTIONS } from '../helpers.js';

test('기본 콘티 자동 제작은 음성 설정을 요구하지 않고 그림과 대사 검토로 이어진다', async ({ page }): Promise<void> => {
  const h = await createExecutionHarness(async (): Promise<void> => {});
  const root = await mkdtemp(join(tmpdir(), 'cutroom-optional-audio-ui-'));
  let speechCalls: number = 0; let catalogCalls: number = 0;
  const errors: string[] = [];
  const service = new AutomationService({ services: { ...h.services, engines: () => ({ ...h.engine,
    speech: { run: async (): Promise<never> => { speechCalls += 1; throw new Error('기본 콘티에서 음성을 생성했습니다.'); } },
    voiceCatalog: async (): Promise<never> => { catalogCalls += 1; throw new Error('기본 콘티에서 음성 목록을 조회했습니다.'); },
  }) }, onError: (_id, problem): void => { errors.push(problem.message); } });
  await service.initialize(); await service.cancel(h.source.projectId, h.id);
  const app = await createApp({ host: '127.0.0.1', port: 0, dataRoot: join(root, 'unused'), webRoot: resolve(process.env['CUTROOM_E2E_WEB_ROOT'] ?? 'dist/web'),
    pdfFontPath: resolve('assets/fonts/NanumGothic-Regular.ttf'), audioNormalization: TEST_AUDIO_NORMALIZATION_OPTIONS,
    codex: { requestRoot: join(root, 'requests'), speechVoice: 'not-installed' } }, h.services.projects,
  new CodexRequestStore(join(root, 'requests'), buildForSpeechVoice('not-installed')), undefined, undefined, service);
  page.on('pageerror', (error): void => { errors.push(error.message); });
  try {
    await page.goto(await app.listen({ host: '127.0.0.1', port: 0 }));
    await page.getByRole('navigation', { name: '콘티 작업 공간' }).getByRole('button', { name: '제작 현황', exact: true }).click();
    const panel = page.getByRole('region', { name: 'Codex 자동 제작' });
    await expect(panel.getByLabel('음성 제작', { exact: true })).toHaveValue('instructions-only');
    await panel.getByText('제작 범위와 실행 설정', { exact: false }).click();
    await expect(panel.getByLabel('공통 음성 이름', { exact: true })).toHaveCount(0);
    await panel.getByLabel('음성 제작', { exact: true }).selectOption('instructions-only');
    const checkboxes = panel.locator('.automatic-segment input');
    for (let i: number = 0; i < h.source.dataset.segments.length; i += 1) await checkboxes.nth(i).setChecked(h.source.dataset.segments[i]!.id === 'demonstration');
    await page.reload();
    await expect(panel.getByLabel('음성 제작', { exact: true })).toHaveValue('instructions-only');
    await panel.getByRole('button', { name: '1개 구간 자동 제작 시작', exact: true }).click();
    await expect(panel.getByText('생성 결과 검토 대기', { exact: true })).toBeVisible({ timeout: 20000 });
    const current = await h.services.projects.read(h.source.projectId);
    expect(current.assets.filter((asset): boolean => asset.kind === 'audio')).toEqual([]);
    expect(current.frames.some((frame): boolean => frame.imageAssetId !== null)).toBe(true);
    expect(speechCalls).toBe(0); expect(catalogCalls).toBe(0); expect(errors).toEqual([]);
    const response = await page.request.get(new URL(`/api/projects/${encodeURIComponent(current.projectId)}/final-readiness`, page.url()).href);
    expect(response.status()).toBe(200);
    const report = z.object({ issues: z.array(IssueSchema), optionalAudioIssues: z.array(IssueSchema) }).parse(await response.json());
    expect(report.issues.some((issue: { code: string }): boolean => issue.code === 'AUDIO_NOT_MEASURED')).toBe(false);
    expect(report.optionalAudioIssues.some((issue: { code: string }): boolean => issue.code === 'AUDIO_NOT_MEASURED')).toBe(true);
    const summaries = await h.services.projects.list();
    expect(summaries.find((summary): boolean => summary.projectId === current.projectId)?.blockedOutputCount).toBe(report.issues.length);
    await panel.screenshot({ path: '.local/validation/automation-runtime/optional-audio-browser.png' });
    await panel.getByRole('button', { name: '생성 결과 불러와 검토', exact: true }).click();
    const monitor = page.getByRole('dialog', { name: '콘티 시간순 재생' });
    const cue = current.audioCues.find((value): boolean => value.unitId === '안내-1')!;
    await monitor.getByRole('slider', { name: '검토 재생 위치' }).evaluate((input: HTMLInputElement, atMs: number): void => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, String(atMs));
      input.dispatchEvent(new Event('input', { bubbles: true }));
    }, cue.startMs);
    const notes = monitor.getByRole('region', { name: '대사·음향 지시' });
    await expect(notes).toContainText(audioCueSource(current, cue)!.text);
    await expect(notes.getByText('선택 음성 재생 안내', { exact: false })).toBeVisible();
    await expect(monitor.locator('.output-blocked').filter({ hasText: 'AUDIO_NOT_MEASURED' })).toHaveCount(0);
    await expect(page.locator('audio[data-storyboard-audio]')).toHaveCount(0);
    await monitor.getByRole('slider', { name: '검토 재생 위치' }).evaluate((input: HTMLInputElement, atMs: number): void => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, String(atMs));
      input.dispatchEvent(new Event('input', { bubbles: true }));
    }, cue.endMs);
    await expect(monitor.getByRole('region', { name: '대사·음향 지시' })).toHaveCount(0);
    expect(await h.services.projects.read(current.projectId)).toEqual(current);
  } finally { await page.context().close(); await app.close(); await h.close(); await rm(root, { recursive: true, force: true }); }
});

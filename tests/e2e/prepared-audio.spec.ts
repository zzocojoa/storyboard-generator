import { withTestVoiceCasting } from '../automatic-complete-engines.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, test } from '@playwright/test';
import { AutomationService } from '../../src/automation/service.js';
import { buildForSpeechVoice } from '../../src/build.js';
import { CodexRequestStore } from '../../src/codex/requests.js';
import { createApp } from '../../src/server/app.js';
import type { AppConfig } from '../../src/server/config.js';
import { createExecutionHarness } from '../automatic-executor-helpers.js';
import { pcmWav, TEST_AUDIO_NORMALIZATION_OPTIONS } from '../helpers.js';

test('e2e_external_wav_preparation_to_automatic_placement_preserves_asset_and_final_review', async ({ page }): Promise<void> => {
  const h = await createExecutionHarness(async (): Promise<void> => {});
  const root = await mkdtemp(join(tmpdir(), 'cutroom-prepared-ui-'));
  const service = new AutomationService({ services: { ...h.services, engines: () => withTestVoiceCasting(h.engine) }, onError: (_id, problem): void => { throw new Error(problem.message); } });
  await service.initialize(); await service.cancel(h.source.projectId, h.id);
  const config: AppConfig = { host: '127.0.0.1', port: 4317, dataRoot: join(root, 'unused-data'), webRoot: resolve('dist/web'),
    pdfFontPath: resolve('assets/fonts/NanumGothic-Regular.ttf'), audioNormalization: TEST_AUDIO_NORMALIZATION_OPTIONS,
    codex: { requestRoot: join(root, 'requests'), speechVoice: 'Yuna' } };
  const app = await createApp(config, h.services.projects, new CodexRequestStore(config.codex.requestRoot, buildForSpeechVoice('Yuna')), undefined, undefined, service);
  try {
    const url = await app.listen({ host: '127.0.0.1', port: 0 }); await page.goto(url);
    await page.getByRole('navigation', { name: '콘티 작업 공간' }).getByRole('button', { name: '컷 편집', exact: true }).click();
    await page.locator('.scene-rail button').nth(h.source.dataset.segments.findIndex((segment): boolean => segment.id === 'demonstration')).click();
    await page.getByRole('navigation', { name: '선택 컷 편집 항목' }).getByRole('button', { name: '음성', exact: true }).click();
    const sound = page.locator('.track-editor').filter({ has: page.locator('header b', { hasText: /^SFX$/ }) });
    await expect(sound.getByRole('button', { name: 'WAV 등록', exact: true })).toHaveCount(0);
    await sound.locator('input[type=file]').setInputFiles({ name: '잘못된음원.wav', mimeType: 'audio/wav', buffer: Buffer.from('not a WAV') });
    await sound.getByRole('button', { name: 'WAV 준비 · 자동 제작으로 이동' }).click();
    await expect(page.locator('.notice')).toBeVisible(); expect((await h.services.projects.read(h.source.projectId)).revision).toBe(0);
    await sound.locator('input[type=file]').setInputFiles({ name: '검증 효과음.wav', mimeType: 'audio/wav', buffer: pcmWav(200, 44100, 2, 24) });
    await sound.getByRole('button', { name: 'WAV 준비 · 자동 제작으로 이동' }).click();
    const panel = page.getByRole('region', { name: 'Codex 자동 제작' }); await expect(panel).toBeVisible();
    const prepared = await h.services.projects.read(h.source.projectId); const cue = prepared.audioCues.find((value): boolean => value.kind === 'sfx')!;
    expect(cue).toMatchObject({ timingStatus: 'prepared', startMs: 5000, endMs: 13500 }); expect(prepared.revision).toBe(1);
    const asset = prepared.assets.find((value): boolean => value.id === cue.assetId)!;
    const bytes = (await h.services.projects.asset(prepared.projectId, asset.id)).content;
    const safeBefore = await app.inject({ method: 'GET', url: `/api/projects/${encodeURIComponent(prepared.projectId)}/output/audio/${cue.id}` });
    expect(safeBefore.statusCode).toBe(400); expect(safeBefore.body).toContain('AUDIO_PLACEMENT_REQUIRED');
    const normalize = await app.inject({ method: 'POST', url: `/api/projects/${encodeURIComponent(prepared.projectId)}/audio/${cue.id}/normalize`, payload: { expectedRevision: 1 } });
    expect(normalize.statusCode).toBe(400); expect(normalize.body).toContain('AUDIO_ASSET_ALREADY_NORMALIZED');
    expect((await h.services.projects.read(prepared.projectId)).audioCues.find((value): boolean => value.id === cue.id)!.timingStatus).toBe('prepared');
    const conflict = await page.request.post(`${url}/api/projects/${encodeURIComponent(prepared.projectId)}/audio/${cue.id}/prepare`, { multipart: {
      expectedRevision: '0', file: { name: 'duplicate.wav', mimeType: 'audio/wav', buffer: pcmWav(200, 48000, 1, 16) },
    } });
    expect(conflict.status()).toBe(409); expect((await h.services.projects.read(prepared.projectId)).revision).toBe(1);
    await panel.getByLabel('음성 제작', { exact: true }).selectOption('guide-voice');
    await panel.getByText('제작 범위와 실행 설정', { exact: false }).click();
    const checkboxes = panel.locator('.automatic-segment input');
    for (let i: number = 0; i < prepared.dataset.segments.length; i += 1) await checkboxes.nth(i).setChecked(prepared.dataset.segments[i]!.id === 'demonstration');
    await panel.getByRole('button', { name: '1개 구간 자동 제작 시작', exact: true }).click();
    await expect(panel.getByText('생성 결과 검토 대기', { exact: true })).toBeVisible({ timeout: 20000 });
    const result = await h.services.projects.read(prepared.projectId);
    expect(result.audioCues.find((value): boolean => value.id === cue.id)).toMatchObject({ timingStatus: 'measured', assetId: asset.id, startMs: 8000, endMs: 8200 });
    expect(result.assets.find((value): boolean => value.id === asset.id)).toEqual(asset);
    expect((await h.services.projects.asset(result.projectId, asset.id)).content).toEqual(bytes);
    expect(result.generationRecords.filter((record): boolean => record.provider === 'macos-speech')).toHaveLength(1);
    const safeAfter = await app.inject({ method: 'GET', url: `/api/projects/${encodeURIComponent(result.projectId)}/output/audio/${cue.id}` });
    expect(safeAfter.statusCode).toBe(200); expect(safeAfter.rawPayload).toEqual(bytes);
    expect((await h.services.projects.finalReadiness(result.projectId)).finalReady).toBe(false);
    expect(result.dataset).toEqual(h.source.dataset);
    await panel.getByRole('button', { name: '생성 결과 불러와 검토' }).click();
    const monitor = page.getByRole('dialog', { name: '콘티 시간순 재생' });
    await expect(monitor).toContainText('제작자 검토 · 미승인 결과 포함');
    await monitor.getByRole('button', { name: 'CLOSE', exact: true }).click();
    await page.getByRole('navigation', { name: '콘티 작업 공간' }).getByRole('button', { name: '컷 편집', exact: true }).click();
    await page.getByRole('navigation', { name: '선택 컷 편집 항목' }).getByRole('button', { name: '음성', exact: true }).click();
    await expect(sound).toContainText('MEASURED');
    await expect(sound.locator('audio[data-storyboard-review]')).toHaveJSProperty('duration', 0.2);
    await sound.scrollIntoViewIfNeeded();
    await page.screenshot({ path: '.local/validation/automation-runtime/prepared-audio-ui.png' });
  } finally { await page.context().close(); await app.close(); await h.close(); await rm(root, { recursive: true, force: true }); }
});

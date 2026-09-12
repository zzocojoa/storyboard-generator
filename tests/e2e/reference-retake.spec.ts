import { join, resolve } from 'node:path';
import { expect, test } from '@playwright/test';
import { AutomationService } from '../../src/automation/service.js';
import { buildForSpeechVoice } from '../../src/build.js';
import { CodexRequestStore } from '../../src/codex/requests.js';
import type { Project } from '../../src/domain/schema.js';
import { createApp } from '../../src/server/app.js';
import { createExecutionHarness } from '../automatic-executor-helpers.js';
import { TEST_AUDIO_NORMALIZATION_OPTIONS, TEST_TEXT_FONT_PATH } from '../helpers.js';
import { referenceRetakeCandidate } from '../reference-retake-helpers.js';
import { twoPropCandidate } from '../prop-continuity-helpers.js';

test('e2e_reference_retake_reviews_one_resource_runs_without_chat_and_compares_preserved_versions', async ({ page }): Promise<void> => {
  const h = await createExecutionHarness(async (): Promise<void> => {});
  let imageCalls: number = 0;
  const service = new AutomationService({ services: { ...h.services, engines: () => ({ ...h.engine, image: { run: async (input, signal) => { imageCalls += 1; return h.engine.image.run(input, signal); } },
    model: { run: async (): Promise<never> => { throw new Error('기준 재생성에서 컷 모델을 호출하면 안 됩니다.'); } },
    speech: { run: async (): Promise<never> => { throw new Error('기준 재생성에서 음성을 호출하면 안 됩니다.'); } } }) }, onError: (_id, problem): void => { throw new Error(problem.message); } });
  await service.initialize(); await service.cancel(h.source.projectId, h.id);
  const prepared = await referenceRetakeCandidate(h.source);
  const before = await h.services.projects.update(h.source.projectId, 0, (): Project => prepared.project, prepared.writes);
  const resource = before.productionPlan!.resources[0]!;
  const requests = join(h.root, 'requests');
  const app = await createApp({ host: '127.0.0.1', port: 0, dataRoot: join(h.root, 'unused'), webRoot: resolve(process.env['CUTROOM_E2E_WEB_ROOT'] ?? 'dist/web'),
    pdfFontPath: TEST_TEXT_FONT_PATH, audioNormalization: TEST_AUDIO_NORMALIZATION_OPTIONS, codex: { requestRoot: requests, speechVoice: 'Yuna' } },
    h.services.projects, new CodexRequestStore(requests, buildForSpeechVoice('Yuna')), undefined, undefined, service);
  const errors: string[] = []; page.on('pageerror', (error): void => { errors.push(error.message); });
  try {
    await page.goto(await app.listen({ host: '127.0.0.1', port: 0 }));
    await page.getByRole('navigation', { name: '콘티 작업 공간' }).getByRole('button', { name: '제작 설정', exact: true }).click();
    const panel = page.getByRole('region', { name: '자동 제작 기준 이미지 검토' });
    await panel.getByLabel('검토할 제작 기준').selectOption(resource.id);
    await expect(panel.getByRole('img', { name: '현재 기준 이미지 · 검토용' })).toHaveJSProperty('naturalWidth', before.profile.aspectWidth * 10);
    expect(imageCalls).toBe(0); expect((await h.services.projects.read(before.projectId)).revision).toBe(before.revision);
    await panel.getByRole('button', { name: '선택 기준만 다시 생성', exact: true }).click();
    await expect(panel.getByText('새 기준 생성 완료 · 결과를 불러와 이전 버전과 비교하세요.', { exact: true })).toBeVisible();
    await panel.getByRole('button', { name: '새 기준 결과 불러오기', exact: true }).click();
    await expect(panel.getByLabel('이전 기준 비교')).toBeVisible();
    await panel.getByLabel('이전 기준 비교').selectOption(resource.referenceAssetId!);
    await expect(panel.getByRole('img', { name: '보존된 이전 기준 이미지', exact: true })).toHaveJSProperty('naturalWidth', before.profile.aspectWidth * 10);
    await expect(panel.getByRole('img', { name: '현재 기준 이미지 · 검토용' })).toHaveJSProperty('naturalWidth', before.profile.aspectWidth * 10);
    const current = await h.services.projects.read(before.projectId);
    expect(imageCalls).toBe(1); expect(current.revision).toBe(before.revision + 1);
    expect(current.dataset).toEqual(before.dataset); expect(current.frames).toEqual(before.frames); expect(current.audioCues).toEqual(before.audioCues);
    expect(current.assets.slice(0, before.assets.length)).toEqual(before.assets); expect(current.productionPlan!.resources[0]!.referenceAssetId).not.toBe(resource.referenceAssetId);
    await page.setViewportSize({ width: 430, height: 900 }); await panel.scrollIntoViewIfNeeded();
    await page.screenshot({ path: '.local/validation/automation-runtime/reference-retake-mobile.png' });
    await page.reload();
    await panel.getByLabel('검토할 제작 기준').selectOption(resource.id);
    await expect(panel.getByText('새 기준 생성 완료 · 결과를 불러와 이전 버전과 비교하세요.', { exact: true })).toBeVisible();
    expect(imageCalls).toBe(1); expect(errors).toEqual([]);
  } finally { await app.close(); await service.close(); await h.close(); }
});

test('e2e_prop_continuity_retake_selects_prior_shape_and_keeps_old_versions', async ({ page }): Promise<void> => {
  const h = await createExecutionHarness(async (): Promise<void> => {});
  let imageCalls: number = 0;
  const service = new AutomationService({ services: { ...h.services, engines: () => ({ ...h.engine, image: { run: async (input, signal) => {
    imageCalls += 1; expect(input.references).toHaveLength(1); expect(input.references[0]?.label).toContain('표 구획'); return h.engine.image.run(input, signal);
  } } }) }, onError: (_id, problem): void => { throw new Error(problem.message); } });
  await service.initialize(); await service.cancel(h.source.projectId, h.id);
  const candidate = await twoPropCandidate(h.source);
  const before = await h.services.projects.update(h.source.projectId, 0, (): Project => candidate.project, candidate.writes);
  const [base, target] = before.productionPlan!.resources;
  const requests = join(h.root, 'requests');
  const app = await createApp({ host: '127.0.0.1', port: 0, dataRoot: join(h.root, 'unused'), webRoot: resolve(process.env['CUTROOM_E2E_WEB_ROOT'] ?? 'dist/web'),
    pdfFontPath: TEST_TEXT_FONT_PATH, audioNormalization: TEST_AUDIO_NORMALIZATION_OPTIONS, codex: { requestRoot: requests, speechVoice: 'Yuna' } },
    h.services.projects, new CodexRequestStore(requests, buildForSpeechVoice('Yuna')), undefined, undefined, service);
  try {
    await page.goto(await app.listen({ host: '127.0.0.1', port: 0 }));
    await page.getByRole('navigation', { name: '콘티 작업 공간' }).getByRole('button', { name: '제작 설정', exact: true }).click();
    const panel = page.getByRole('region', { name: '자동 제작 기준 이미지 검토' });
    await panel.getByLabel('검토할 제작 기준').selectOption(target!.id);
    await panel.getByLabel('이어 쓸 소품 기준').selectOption(base!.id);
    const regenerate = panel.getByRole('button', { name: '선택 기준만 다시 생성', exact: true });
    await expect(regenerate).toBeDisabled();
    await panel.getByLabel('같은 소품으로 판단한 근거').fill('앞선 종이를 그대로 펼치는 원문 확인');
    await expect(panel.getByRole('img', { name: '모양을 이어 쓸 이전 소품', exact: true })).toHaveJSProperty('naturalWidth', before.profile.aspectWidth * 10);
    expect(imageCalls).toBe(0); expect((await h.services.projects.read(before.projectId)).revision).toBe(before.revision);
    await regenerate.click();
    await expect(panel.getByText('새 기준 생성 완료 · 결과를 불러와 이전 버전과 비교하세요.', { exact: true })).toBeVisible();
    await panel.getByRole('button', { name: '새 기준 결과 불러오기', exact: true }).click();
    await panel.getByLabel('이전 기준 비교').selectOption(target!.referenceAssetId!);
    await expect(panel.getByRole('img', { name: '보존된 이전 기준 이미지', exact: true })).toHaveJSProperty('naturalWidth', before.profile.aspectWidth * 10);
    const current = await h.services.projects.read(before.projectId);
    expect(current.revision).toBe(before.revision + 1); expect(imageCalls).toBe(1);
    expect(current.productionPlan!.resources[0]).toEqual(base);
    expect(current.productionPlan!.resources[1]?.propContinuity).toEqual({ resourceId: base!.id, reason: '앞선 종이를 그대로 펼치는 원문 확인' });
    expect(current.assets.slice(0, before.assets.length)).toEqual(before.assets); expect(current.dataset).toEqual(before.dataset);
    await page.reload(); await panel.getByLabel('검토할 제작 기준').selectOption(target!.id);
    await expect(panel.getByLabel('이어 쓸 소품 기준')).toHaveValue(base!.id);
    await expect(panel.getByLabel('같은 소품으로 판단한 근거')).toHaveValue('앞선 종이를 그대로 펼치는 원문 확인');
    expect(imageCalls).toBe(1);
  } finally { await app.close(); await service.close(); await h.close(); }
});

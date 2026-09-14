import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, test } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';
import { AutomationService } from '../../src/automation/service.js';
import { createSegmentPlanBasis } from '../../src/automation/plan-basis.js';
import { compileAutomaticSegmentPlan } from '../../src/automation/plan-compiler.js';
import { buildForSpeechVoice } from '../../src/build.js';
import { CodexRequestStore } from '../../src/codex/requests.js';
import type { Project } from '../../src/domain/schema.js';
import { createApp } from '../../src/server/app.js';
import { createExecutionHarness } from '../automatic-executor-helpers.js';
import { automaticPlanProvenance, demonstrationPlan, stagedPlanSpeech } from '../automatic-plan-helpers.js';
import { nativeData, nativePackage, TEST_AUDIO_NORMALIZATION_OPTIONS, withNativeData } from '../helpers.js';

async function writeChangedSource(directory: string, text: string): Promise<string> {
  const payload = await nativePackage(); const data = nativeData(payload);
  const units = data.units.map((unit) => ({ ...unit, text: unit.id === '안내-1' ? text : unit.text,
    informationIds: unit.segmentId === 'demonstration' ? [`reveal:${unit.id}`] : unit.informationIds }));
  const incoming = withNativeData(payload, { ...data, units, informationRules: units.filter((unit): boolean => unit.segmentId === 'demonstration')
    .map((unit) => ({ id: `reveal:${unit.id}`, segmentId: unit.segmentId, notBeforeMs: 5000,
      notBeforeUnitId: unit.id, notBeforeUnitOrder: unit.order, precision: 'unit-order' as const })) });
  await mkdir(directory);
  for (const file of incoming.files) await writeFile(join(directory, file.path), file.content);
  const path: string = join(directory, 'storyboard_handoff.json');
  await writeFile(path, JSON.stringify({ ...incoming.handoff, packageVersion: 'source-update-integration' }));
  return path;
}

async function openSpeechEditor(page: Page): Promise<Locator> {
  await page.getByRole('navigation', { name: '콘티 작업 공간' }).getByRole('button', { name: '컷 편집', exact: true }).click();
  await page.getByRole('button', { name: /DEMONSTRATION|시연/ }).first().click();
  await page.getByRole('navigation', { name: '선택 컷 편집 항목' }).getByRole('button', { name: '음성', exact: true }).click();
  await page.locator('summary').filter({ hasText: '발화 선택 생성·비교' }).click();
  return page.getByRole('region', { name: '선택 발화 자동 생성', exact: true });
}

test('e2e_real_source_update_replaces_affected_targets_keeps_orphaned_drafts_and_preserves_media_history_without_generation', async ({ page }, testInfo): Promise<void> => {
  const h = await createExecutionHarness(async (): Promise<void> => {});
  const root: string = await mkdtemp(join(tmpdir(), 'cutroom-source-draft-integration-'));
  const calls: string[] = []; const mutations: string[] = []; const pageErrors: string[] = [];
  const catalog = [{ name: 'Yuna', locale: 'ko_KR', sample: '안녕하세요.' }, { name: 'Eddy (한국어(대한민국))', locale: 'ko_KR', sample: '안내합니다.' }];
  const service = new AutomationService({ services: { ...h.services, engines: () => ({ ...h.engine,
    model: { run: async (): Promise<never> => { calls.push('model'); throw new Error('원본 변경·입력 복원 중 모델이 실행됐습니다.'); } },
    image: { run: async (): Promise<never> => { calls.push('image'); throw new Error('원본 변경·입력 복원 중 그림 생성이 실행됐습니다.'); } },
    speech: { run: async (): Promise<never> => { calls.push('speech'); throw new Error('원본 변경·입력 복원 중 음성 생성이 실행됐습니다.'); } },
  }) }, onError: (): void => {}, listSpeechVoices: async () => catalog });
  await service.initialize(); await service.cancel(h.source.projectId, h.id);
  const prepared = compileAutomaticSegmentPlan(h.source, createSegmentPlanBasis(h.source, 'demonstration', ['shot-2']),
    demonstrationPlan(h.source), [stagedPlanSpeech(h.source)], [], automaticPlanProvenance(), 64);
  const project: Project = await h.services.projects.update(h.source.projectId, 0, () => prepared.project, prepared.writes);
  const originalCue = project.audioCues.find((cue): boolean => cue.unitId === '안내-1')!;
  const sourceText: string = project.dataset.units.find((unit): boolean => unit.id === originalCue.unitId)!.text;
  const replacementText: string = '받침에 고인 물을 먼저 비우고 흙의 상태를 확인하세요.';
  const handoffPath: string = await writeChangedSource(join(root, 'incoming'), replacementText);
  const storedRoot: string = join(h.root, 'data', createHash('sha256').update(project.projectId).digest('hex'));
  const originalAssets: { path: string; bytes: Buffer }[] = await Promise.all(project.assets.map(async (asset): Promise<{ path: string; bytes: Buffer }> => ({
    path: join(storedRoot, asset.path), bytes: await readFile(join(storedRoot, asset.path)),
  })));
  const originalVersion: Buffer = await readFile(join(storedRoot, 'versions', '000001.json'));
  const app = await createApp({ host: '127.0.0.1', port: 0, dataRoot: join(h.root, 'data'),
    webRoot: resolve(process.env['CUTROOM_E2E_WEB_ROOT'] ?? 'dist/web'), pdfFontPath: resolve('assets/fonts/NanumGothic-Regular.ttf'),
    audioNormalization: TEST_AUDIO_NORMALIZATION_OPTIONS, codex: { requestRoot: join(root, 'requests'), speechVoice: 'Yuna' } },
  h.services.projects, new CodexRequestStore(join(root, 'requests'), buildForSpeechVoice('Yuna')), undefined, undefined, service);
  page.on('request', (request): void => { if (['POST', 'PATCH', 'PUT', 'DELETE'].includes(request.method())) mutations.push(new URL(request.url()).pathname); });
  page.on('pageerror', (error): void => { pageErrors.push(error.message); });
  try {
    await page.goto(await app.listen({ host: '127.0.0.1', port: 0 }));
    const speech: Locator = await openSpeechEditor(page);
    await speech.getByLabel('새 목소리').selectOption('Eddy (한국어(대한민국))');
    await speech.getByLabel('합성 속도', { exact: true }).fill('155');
    await speech.getByRole('button', { name: '읽는 방법 추가' }).click();
    await speech.getByLabel('원문 표현 1', { exact: true }).fill(sourceText.slice(0, 2));
    await speech.getByLabel('읽을 표기 1', { exact: true }).fill('이전 원문 전용 보완');
    await page.getByRole('navigation', { name: '선택 컷 편집 항목' }).getByRole('button', { name: '연출', exact: true }).click();
    await page.getByRole('textbox', { name: '행동·연출', exact: true }).fill('원본 변경 전 작성한 손동작 연출 메모');
    const draftEntries: Record<string, string> = await page.evaluate((): Record<string, string> => Object.fromEntries(Object.keys(localStorage)
      .filter((key): boolean => key.startsWith('cutroom:draft:1:')).map((key): [string, string] => [key, localStorage.getItem(key)!])));
    expect(Object.keys(draftEntries).length).toBeGreaterThanOrEqual(2);

    await page.getByRole('navigation', { name: '콘티 작업 공간' }).getByRole('button', { name: '제작 설정', exact: true }).click();
    const source: Locator = page.getByRole('region', { name: '원본 업데이트', exact: true });
    await source.getByLabel('새 handoff 파일 경로', { exact: true }).fill(handoffPath);
    await source.getByRole('button', { name: '변경 영향 확인', exact: true }).click();
    await expect(source.getByRole('button', { name: '새 원본 적용', exact: true })).toBeEnabled();
    const applied = page.waitForResponse((response): boolean => response.url().endsWith('/source-update/apply') && response.request().method() === 'POST');
    await source.getByRole('button', { name: '새 원본 적용', exact: true }).click();
    const response = await applied; expect(response.status(), await response.text()).toBe(200);
    const updated: Project = await h.services.projects.read(project.projectId);
    expect(updated.revision).toBe(project.revision + 1);
    expect(updated.dataset.units.find((unit): boolean => unit.id === originalCue.unitId)?.text).toBe(replacementText);
    expect(updated.audioCues.some((cue): boolean => cue.id === originalCue.id)).toBe(false);
    expect(updated.audioCues.find((cue): boolean => cue.unitId === originalCue.unitId)).toMatchObject({ assetId: null, timingStatus: 'proposed' });
    expect(updated.shots.filter((shot): boolean => shot.segmentId !== 'demonstration')).toEqual(project.shots.filter((shot): boolean => shot.segmentId !== 'demonstration'));
    expect(updated.assets).toEqual(project.assets); expect(updated.generationRecords).toEqual(project.generationRecords);
    for (const asset of originalAssets) expect(await readFile(asset.path)).toEqual(asset.bytes);
    expect(await readFile(join(storedRoot, 'versions', '000001.json'))).toEqual(originalVersion);

    await page.reload();
    const currentSpeech: Locator = await openSpeechEditor(page);
    await expect(currentSpeech.locator('[aria-label="합성할 낭독문"]')).toContainText(replacementText);
    await expect(currentSpeech.getByLabel('원문 표현 1', { exact: true })).toHaveCount(0);
    await expect(currentSpeech.getByLabel('새 목소리')).toHaveValue('');
    await expect(currentSpeech.getByRole('button', { name: '이 발화만 자동 생성', exact: true })).toBeDisabled();
    await page.getByRole('navigation', { name: '선택 컷 편집 항목' }).getByRole('button', { name: '연출', exact: true }).click();
    await expect(page.getByRole('textbox', { name: '행동·연출', exact: true })).not.toHaveValue('원본 변경 전 작성한 손동작 연출 메모');
    await page.getByRole('navigation', { name: '콘티 작업 공간' }).getByRole('button', { name: '제작 현황', exact: true }).click();
    await page.getByText('미저장 편집 기록', { exact: true }).click();
    const archive: Locator = page.getByRole('region', { name: '미저장 편집 기록 보관함' });
    await archive.getByLabel('임시 기록 표시 범위').selectOption('missing');
    await archive.getByLabel('임시 기록 검색').fill('이전 원문 전용 보완');
    const entry: Locator = archive.locator('.draft-archive-entry'); await expect(entry).toHaveCount(1);
    await entry.locator('summary').first().click();
    await expect(entry.getByLabel('보관된 작성 내용')).toHaveValue(/이전 원문 전용 보완/u);
    await expect(entry).toContainText('현재 콘티에 원래 편집 대상이 없습니다.');
    await expect(entry.getByRole('button', { name: '현재 편집 대상 열기' })).toHaveCount(0);
    await archive.getByLabel('임시 기록 검색').fill('원본 변경 전 작성한 손동작 연출 메모');
    await expect(archive.locator('.draft-archive-entry')).toHaveCount(1);
    for (const [key, value] of Object.entries(draftEntries)) expect(await page.evaluate((key: string): string | null => localStorage.getItem(key), key)).toBe(value);
    expect(mutations.filter((path): boolean => path.endsWith('/source-update/apply'))).toHaveLength(1);
    expect(mutations.filter((path): boolean => path.endsWith('/speech-retakes') || path.endsWith('/automation'))).toEqual([]);
    expect(calls).toEqual([]); expect(pageErrors).toEqual([]);
    expect(await h.services.projects.read(project.projectId)).toEqual(updated);
    await page.screenshot({ path: testInfo.outputPath('source-updated-drafts-preserved.png') });
  } finally { await page.context().close(); await app.close(); await h.close(); await rm(root, { recursive: true, force: true }); }
});

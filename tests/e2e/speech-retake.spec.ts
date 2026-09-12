import { speechPronunciationEvidence } from '../../src/codex/speech-pronunciation.js';
import { speechReadingText } from '../../src/domain/speech-pronunciation.js';
import type { SpeechGenerationInput } from '../../src/codex/speech-engine.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, test } from '@playwright/test';
import { AutomationService } from '../../src/automation/service.js';
import { createSegmentPlanBasis } from '../../src/automation/plan-basis.js';
import { compileAutomaticSegmentPlan } from '../../src/automation/plan-compiler.js';
import { buildForSpeechVoice } from '../../src/build.js';
import { CodexRequestStore } from '../../src/codex/requests.js';
import type { SpeechVoice } from '../../src/codex/speech-engine.js';
import { inspectAudioFileBytes } from '../../src/domain/media-inspection.js';
import { createApp } from '../../src/server/app.js';
import { createExecutionHarness } from '../automatic-executor-helpers.js';
import { automaticPlanProvenance, demonstrationPlan, stagedPlanSpeech } from '../automatic-plan-helpers.js';
import { pcmWav, TEST_AUDIO_NORMALIZATION_OPTIONS } from '../helpers.js';

test('e2e_speech_retake_restores_selection_runs_without_chat_and_compares_preserved_audio_versions', async ({ page }): Promise<void> => {
  const h = await createExecutionHarness(async (): Promise<void> => {}); const root = await mkdtemp(join(tmpdir(), 'cutroom-retake-browser-'));
  const calls: SpeechVoice[] = []; const inputs: SpeechGenerationInput[] = [];
  const catalog = [{ name: 'Yuna', locale: 'ko_KR', sample: '안녕하세요.' }, { name: 'Eddy (한국어(대한민국))', locale: 'ko_KR', sample: '안내합니다.' }];
  const service = new AutomationService({ services: { ...h.services, engines: () => ({
    model: { run: async (): Promise<never> => { throw new Error('발화 재생성은 모델을 호출하지 않아야 합니다.'); } },
    image: { run: async (): Promise<never> => { throw new Error('발화 재생성은 그림을 호출하지 않아야 합니다.'); } }, voiceCatalog: async () => catalog,
    speech: { run: async (input) => { calls.push(input.voice); inputs.push(structuredClone(input)); const original = stagedPlanSpeech(await h.services.projects.read(h.source.projectId)).result;
      const bytes = pcmWav(2600, input.sampleRate, 1, 16); return { ...original, voice: input.voice, bytes, ...(input.pronunciation === undefined ? {} : { pronunciation: speechPronunciationEvidence(input.unit.text, input.pronunciation)! }), inspection: inspectAudioFileBytes(bytes, 'audio/wav') }; } },
  }) }, onError: (): void => {}, listSpeechVoices: async () => catalog });
  await service.initialize(); await service.cancel(h.source.projectId, h.id);
  const before = compileAutomaticSegmentPlan(h.source, createSegmentPlanBasis(h.source, 'demonstration', ['shot-2']), demonstrationPlan(h.source), [stagedPlanSpeech(h.source)], [], automaticPlanProvenance(), 64);
  const project = await h.services.projects.update(h.source.projectId, 0, () => before.project, before.writes);
  const cue = project.audioCues.find((value): boolean => value.unitId === '안내-1')!;
  const app = await createApp({ host: '127.0.0.1', port: 0, dataRoot: join(root, 'unused'), webRoot: resolve(process.env['CUTROOM_E2E_WEB_ROOT'] ?? 'dist/web'),
    pdfFontPath: resolve('assets/fonts/NanumGothic-Regular.ttf'), audioNormalization: TEST_AUDIO_NORMALIZATION_OPTIONS,
    codex: { requestRoot: join(root, 'requests'), speechVoice: 'Yuna' } }, h.services.projects,
  new CodexRequestStore(join(root, 'requests'), buildForSpeechVoice('Yuna')), undefined, undefined, service);
  const address = await app.listen({ host: '127.0.0.1', port: 0 });
  try {
    await page.goto(address);
    await page.getByRole('navigation', { name: '콘티 작업 공간' }).getByRole('button', { name: '컷 편집', exact: true }).click();
    await page.getByRole('button', { name: /DEMONSTRATION|시연/ }).first().click();
    await page.getByRole('navigation', { name: '선택 컷 편집 항목' }).getByRole('button', { name: '음성', exact: true }).click();
    await page.locator('summary').filter({ hasText: '발화 선택 생성·비교' }).click();
    const form = page.getByRole('region', { name: '선택 발화 자동 생성', exact: true });
    await expect(form.getByLabel('새 목소리')).toHaveValue('Yuna');
    await form.getByLabel('새 목소리').selectOption('Eddy (한국어(대한민국))');
    await form.getByLabel('합성 속도', { exact: true }).fill('160'); await form.getByLabel('종료 허용 시각', { exact: true }).fill('9000');
    const source = project.dataset.units.find((unit): boolean => unit.id === cue.unitId)!.text;
    const pronunciation = [{ sourceText: source.slice(0, 2), occurrence: 1, readAs: '낭독 보완' }];
    await form.getByRole('button', { name: '읽는 방법 추가' }).click();
    await form.getByLabel('원문 표현 1', { exact: true }).fill('없는 원문 표현');
    await form.getByLabel('읽을 표기 1', { exact: true }).fill('낭독 보완');
    await expect(form.getByRole('button', { name: '이 발화만 자동 생성', exact: true })).toBeDisabled();
    await form.getByLabel('원문 표현 1', { exact: true }).fill(pronunciation[0]!.sourceText);
    await expect(form.locator('[aria-label="합성할 낭독문"]')).toContainText(speechReadingText(source, pronunciation));
    await page.reload(); await page.locator('summary').filter({ hasText: '발화 선택 생성·비교' }).click();
    await expect(form.getByLabel('읽을 표기 1', { exact: true })).toHaveValue('낭독 보완');
    await expect(form.getByLabel('새 목소리')).toHaveValue('Eddy (한국어(대한민국))'); expect(calls).toHaveLength(0);
    await form.getByRole('button', { name: '이 발화만 자동 생성', exact: true }).click();
    await expect(form.getByText('선택 발화 실행: 생성·저장 완료 — 청취 검토 대기', { exact: true })).toBeVisible();
    await form.getByRole('button', { name: '새 음원 불러와 비교' }).click();
    const comparison = page.getByRole('region', { name: '이전 음원 비교', exact: true });
    await comparison.getByLabel('보존된 이전 음원').selectOption(cue.assetId!);
    const current = await h.services.projects.read(project.projectId);
    expect(current.revision).toBe(2); expect(current.assets.slice(0, -1)).toEqual(project.assets);
    expect(calls).toEqual([{ name: 'Eddy (한국어(대한민국))', rateWordsPerMinute: 160 }]);
    expect(inputs[0]?.pronunciation).toEqual(pronunciation); expect(inputs[0]?.unit.text).toBe(source);
    expect(current.dataset).toEqual(project.dataset); expect(current.textCues).toEqual(project.textCues);
    expect(current.shots).toEqual(project.shots); expect(current.frames).toEqual(project.frames);
    const editor = page.locator('.track-editor').filter({ hasText: project.dataset.units.find((unit): boolean => unit.id === cue.unitId)!.text });
    await expect(editor.locator('audio')).toHaveCount(2);
    await expect.poll(async (): Promise<number[]> => editor.locator('audio').evaluateAll((elements): number[] => elements.map((element): number => (element as HTMLAudioElement).duration))).toEqual([2.6, 2.3]);
    const screenshot = process.env['CUTROOM_RETAKE_SCREENSHOT'];
    if (screenshot !== undefined) {
      await form.getByLabel('원문 표현 1', { exact: true }).scrollIntoViewIfNeeded();
      await page.screenshot({ path: screenshot, fullPage: false });
    }
    await page.route(`**/api/projects/${project.projectId}`, async (route): Promise<void> => {
      await route.fulfill({ json: { project: { ...current, revision: current.revision + 1, dataset: { ...current.dataset,
        units: current.dataset.units.map((unit) => unit.id === cue.unitId ? { ...unit, text: source + ' 확인 후 진행합니다.' } : unit) } } } });
    });
    await page.evaluate((): void => { localStorage.clear(); });
    await page.reload();
    await page.getByRole('navigation', { name: '콘티 작업 공간' }).getByRole('button', { name: '컷 편집', exact: true }).click();
    await page.getByRole('button', { name: /DEMONSTRATION|시연/ }).first().click();
    await page.getByRole('navigation', { name: '선택 컷 편집 항목' }).getByRole('button', { name: '음성', exact: true }).click();
    await page.locator('summary').filter({ hasText: '발화 선택 생성·비교' }).click();
    await expect(form).toContainText('기존 음원 생성 후 원문이 변경됐습니다.');
    await expect(form.getByLabel('읽을 표기 1', { exact: true })).toHaveValue('낭독 보완');
    await expect(form.getByRole('button', { name: '이 발화만 자동 생성', exact: true })).toBeDisabled();
    await form.getByLabel('변경된 원문에서 발음 보완을 다시 확인했습니다').check();
    await expect(form.getByRole('button', { name: '이 발화만 자동 생성', exact: true })).toBeEnabled();
    expect(calls).toHaveLength(1);

  } finally { await app.close(); await h.close(); await rm(root, { recursive: true, force: true }); }
});

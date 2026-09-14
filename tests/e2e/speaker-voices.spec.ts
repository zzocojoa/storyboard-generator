import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { AutomationService } from '../../src/automation/service.js';
import { buildForSpeechVoice } from '../../src/build.js';
import { CodexRequestStore } from '../../src/codex/requests.js';
import { contractError } from '../../src/domain/errors.js';
import { createApp } from '../../src/server/app.js';
import { createExecutionHarness } from '../automatic-executor-helpers.js';
import { TEST_AUDIO_NORMALIZATION_OPTIONS } from '../helpers.js';
import type { BrowserDraft } from '../../web/src/browser-drafts.js';
import type { AutomationStartDraft } from '../../web/src/automation-start-draft.js';
import { z } from 'zod';

async function fixture() {
  const h = await createExecutionHarness(async (): Promise<void> => {});
  const root: string = await mkdtemp(join(tmpdir(), 'speaker-voices-browser-'));
  h.engine.model.run = async (_input, signal): Promise<never> => new Promise((_resolve, reject): void => {
    const stop = (): void => { reject(contractError('AUTOMATION_CANCELLED', '검증용 모델 실행 중지', [])); };
    if (signal.aborted) stop(); else signal.addEventListener('abort', stop, { once: true });
  });
  const service = new AutomationService({ services: h.services, onError: (): void => {}, listSpeechVoices: async () => [
    { name: 'Yuna', locale: 'ko_KR', sample: '안녕하세요' }, { name: 'Eddy (한국어(대한민국))', locale: 'ko_KR', sample: '목소리를 들어보세요' }, { name: 'Test English', locale: 'en_US', sample: 'Hello' },
  ] });
  await service.initialize(); await service.cancel(h.source.projectId, h.id);
  const app = await createApp({ host: '127.0.0.1', port: 0, dataRoot: join(root, 'unused'), webRoot: resolve(process.env['CUTROOM_E2E_WEB_ROOT'] ?? 'dist/web'),
    pdfFontPath: resolve('assets/fonts/NanumGothic-Regular.ttf'), audioNormalization: TEST_AUDIO_NORMALIZATION_OPTIONS,
    codex: { requestRoot: join(root, 'requests'), speechVoice: 'Yuna' } }, h.services.projects,
  new CodexRequestStore(join(root, 'requests'), buildForSpeechVoice('Yuna')), undefined, undefined, service);
  const address: string = await app.listen({ host: '127.0.0.1', port: 0 });
  return { ...h, service, address, close: async (): Promise<void> => { await app.close(); await h.close(); await rm(root, { recursive: true, force: true }); } };
}

async function openForm(page: Page, address: string): Promise<void> {
  await page.goto(address);
  await page.getByRole('navigation', { name: '콘티 작업 공간' }).getByRole('button', { name: '제작 현황', exact: true }).click();
  await page.getByLabel('음성 제작', { exact: true }).selectOption('guide-voice');
  await page.getByText('제작 범위와 실행 설정', { exact: false }).click();
}

test('e2e_speaker_voices_restore_without_generation_and_send_exact_per_person_settings_on_start', async ({ page }): Promise<void> => {
  const h = await fixture(); const launches: string[] = [];
  page.on('request', (request): void => { if (request.method() === 'POST' && new URL(request.url()).pathname.endsWith('/automation')) launches.push(request.postData()!); });
  try {
    await openForm(page, h.address);
    const form = page.getByRole('region', { name: '자동 제작 시작 설정', exact: true });
    const voices = form.getByRole('region', { name: '인물별 가이드 음성', exact: true });
    await voices.getByLabel('음성 후보 언어').selectOption('ko_KR');
    await expect(voices.locator('datalist option')).toHaveCount(2);
    await voices.getByLabel('안내자 개별 음성 지정').check();
    await voices.getByLabel('안내자 음성 이름', { exact: true }).fill('Eddy (한국어(대한민국))');
    await voices.getByLabel('안내자 말하기 속도', { exact: true }).fill('160');
    await page.reload(); await page.getByText('제작 범위와 실행 설정', { exact: false }).click();
    await expect(voices.getByLabel('안내자 개별 음성 지정')).toBeChecked();
    await expect(voices.getByLabel('안내자 음성 이름', { exact: true })).toHaveValue('Eddy (한국어(대한민국))');
    await expect(voices.getByLabel('안내자 말하기 속도', { exact: true })).toHaveValue('160');
    expect(launches).toEqual([]);
    await voices.scrollIntoViewIfNeeded(); await page.screenshot({ path: '.local/validation/automation-runtime/speaker-voices-desktop.png' });
    await page.setViewportSize({ width: 390, height: 844 }); await voices.scrollIntoViewIfNeeded();
    await page.screenshot({ path: '.local/validation/automation-runtime/speaker-voices-mobile.png' });
    expect(await voices.evaluate((element): boolean => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
    await form.getByRole('button', { name: /개 구간 자동 제작 시작$/ }).click();
    await expect.poll(async (): Promise<number> => (await h.service.list(h.source.projectId)).length).toBe(2);
    expect(launches).toHaveLength(1);
    expect(JSON.parse(launches[0]!).settings).toMatchObject({ voice: { name: 'Yuna', rateWordsPerMinute: 180 }, speakerVoices: [{ speakerId: 'CHAR-01', voice: { name: 'Eddy (한국어(대한민국))', rateWordsPerMinute: 160 } }] });
    const runs = await h.services.runs.list();
    expect(runs.find((snapshot): boolean => snapshot.run.id !== h.id)!.run.settings).toMatchObject({ speakerVoices: [{ speakerId: 'CHAR-01', voice: { name: 'Eddy (한국어(대한민국))', rateWordsPerMinute: 160 } }] });
    expect((await h.services.projects.read(h.source.projectId)).revision).toBe(0);
  } finally { await h.close(); }
});

test('e2e_speaker_voices_show_uninstalled_names_and_preserve_restored_missing_speakers_until_explicit_removal', async ({ page }): Promise<void> => {
  const h = await fixture();
  try {
    await openForm(page, h.address);
    const form = page.getByRole('region', { name: '자동 제작 시작 설정', exact: true });
    const voices = form.getByRole('region', { name: '인물별 가이드 음성', exact: true });
    await voices.getByLabel('안내자 개별 음성 지정').check(); await voices.getByLabel('안내자 음성 이름', { exact: true }).fill('Not Installed');
    await expect(voices.getByRole('alert')).toContainText('현재 설치 목록에 없는 음성');
    await form.getByRole('button', { name: /개 구간 자동 제작 시작$/ }).click();
    await expect(page.getByText(/설치 음성 목록에 없습니다: Not Installed/)).toBeVisible();
    expect(await h.service.list(h.source.projectId)).toHaveLength(1);
    await voices.getByLabel('안내자 음성 이름', { exact: true }).fill('Yuna');
    await page.evaluate((): void => {
      const keys: string[] = Object.keys(localStorage).filter((key): boolean => key.startsWith('cutroom:draft:1:') && decodeURIComponent(key).includes('automation-start:'));
      if (keys.length === 0) throw new Error('보관된 시작 설정이 없습니다.');
      for (const key of keys) {
        const record: BrowserDraft = JSON.parse(localStorage.getItem(key)!) as BrowserDraft;
        if (record.value === null) continue;
        const value: AutomationStartDraft = JSON.parse(record.value) as AutomationStartDraft;
        localStorage.setItem(key, JSON.stringify({ ...record, value: JSON.stringify({ ...value, settings: { ...value.settings, speakerVoices: [{ speakerId: 'previous-speaker', voice: { name: 'Yuna', rateWordsPerMinute: 180 } }] } }) }));
      }
    });
    await h.services.projects.update(h.source.projectId, 0, (project) => ({ ...project, title: '현재 원본 기준의 제목' }), []);
    await page.reload(); await page.getByText('제작 범위와 실행 설정', { exact: false }).click();
    await expect(form).toContainText('현재 프로젝트에 발화가 없는 화자의 음성 설정');
    await expect(voices).toContainText('현재 발화에 없는 화자: previous-speaker · Yuna');
    await expect(form.getByRole('button', { name: /개 구간 자동 제작 시작$/ })).toBeDisabled();
    await voices.getByRole('button', { name: '없는 화자의 음성 설정 제거' }).click();
    await expect(form.getByRole('button', { name: /개 구간 자동 제작 시작$/ })).toBeDisabled();
    await form.getByRole('button', { name: '작성한 값을 현재 기준으로 검토', exact: true }).click();
    await expect(form.getByRole('button', { name: /개 구간 자동 제작 시작$/ })).toBeEnabled();
    await expect(voices.getByLabel('안내자 개별 음성 지정')).not.toBeChecked();
    expect(await h.service.list(h.source.projectId)).toHaveLength(1);
  } finally { await h.close(); }
});

test('e2e_automatic_voice_casting_runs_from_start_and_displays_saved_voice_and_reason', async ({ page }): Promise<void> => {
  const h = await fixture();
  const waiting = h.engine.model.run;
  h.engine.voiceCatalog = async () => [{ name: 'Eddy (한국어(대한민국))', locale: 'ko_KR', sample: '목소리를 들어보세요' }];
  h.engine.model.run = async (input, signal) => JSON.stringify(input.outputSchema).includes('"assignments"')
    ? { model: 'browser-casting-test', turnId: 'browser-casting', result: z.json().parse({ version: '1.0.0', status: 'ready', summary: '안내 화자의 한국어 음성',
      assignments: [{ speakerId: 'CHAR-01', language: 'ko', voice: { name: 'Eddy (한국어(대한민국))', rateWordsPerMinute: 160 }, reason: '한국어 원문과 차분한 화분 관리 안내 역할에 맞춘 제안입니다.' }] }) }
    : waiting(input, signal);
  try {
    await openForm(page, h.address);
    const form = page.getByRole('region', { name: '자동 제작 시작 설정', exact: true });
    const voices = form.getByRole('region', { name: '인물별 가이드 음성', exact: true });
    await voices.getByLabel('음성 배정 방식').selectOption('automatic');
    // 글자 배치 검토와 독립적으로 음성 자동 배정의 실행·게시를 확인한다.
    await form.getByLabel('글자 배치 계획').selectOption('preserve');
    await expect(voices).toContainText('미등록 발화 생성 전에 Codex가 배정합니다.');
    await form.getByRole('button', { name: /개 구간 자동 제작 시작$/ }).click();
    await expect.poll(async () => (await h.services.projects.read(h.source.projectId)).voiceCasting?.assignments[0]?.voice.name).toBe('Eddy (한국어(대한민국))');
    const run = (await h.service.list(h.source.projectId)).find((entry): boolean => entry.id !== h.id)!;
    await h.service.pause(h.source.projectId, run.id);
    await page.reload();
    const review = page.getByRole('region', { name: '자동 배정한 가이드 음성', exact: true });
    await expect(review).toContainText('현재 원문에 맞춘 배정');
    await expect(review).toContainText('Eddy (한국어(대한민국)) · ko_KR · 160 단어/분');
    await review.getByText('배정 근거', { exact: true }).click();
    await expect(review).toContainText('한국어 원문과 차분한 화분 관리 안내 역할에 맞춘 제안입니다.');
    const current = await h.services.projects.read(h.source.projectId);
    expect(current.dataset).toEqual(h.source.dataset); expect(current.assets).toEqual([]);
    expect(current.revision).toBe(1); expect(current.frames.every((frame): boolean => frame.visualReview !== 'accepted')).toBe(true);
    await review.scrollIntoViewIfNeeded(); await page.screenshot({ path: '.local/validation/automation-runtime/voice-casting-browser.png' });
  } finally { await h.close(); }
});

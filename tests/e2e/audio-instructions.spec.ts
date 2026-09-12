import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, test } from '@playwright/test';
import { build } from 'vite';
import { compileAudioInstructionPlan } from '../../src/automation/plan-audio-instructions.js';
import { buildForSpeechVoice } from '../../src/build.js';
import { CodexRequestStore } from '../../src/codex/requests.js';
import { readDocumentSources } from '../../src/documents/io.js';
import { buildDocumentPackage } from '../../src/documents/package.js';
import { sharedAudioInstructions } from '../../src/domain/shared-audio-scope.js';
import { applySourceUpdate } from '../../src/domain/source-update.js';
import { importPackage } from '../../src/importers/import-package.js';
import { createSourceOutline } from '../../src/proposal/outline.js';
import { createApp } from '../../src/server/app.js';
import type { AppConfig } from '../../src/server/config.js';
import { ProjectStore } from '../../src/server/store.js';
import { audioInstructionFixture, audioPlaceholderFixture } from '../audio-instruction-helpers.js';
import { occurrencePlan, occurrenceProject } from '../audio-occurrence-helpers.js';
import { automaticPlanProvenance } from '../automatic-plan-helpers.js';
import { documentTestSettings, PRODUCTION_DOCUMENT_BINDINGS } from '../document-helpers.js';
import { nativeData, pcmWav, TEST_AUDIO_NORMALIZATION_OPTIONS, withNativeData } from '../helpers.js';

test('e2e_audio_occurrences_show_distinct_sources_and_times_and_preserve_edits_until_explicit_review', async ({ page }): Promise<void> => {
  const root = await mkdtemp(join(tmpdir(), 'cutroom-occurrences-ui-'));
  const config: AppConfig = { host: '127.0.0.1', port: 0, dataRoot: join(root, 'data'), webRoot: resolve('dist/web'),
    pdfFontPath: resolve('assets/fonts/NanumGothic-Regular.ttf'), audioNormalization: TEST_AUDIO_NORMALIZATION_OPTIONS,
    codex: { requestRoot: join(root, 'requests'), speechVoice: 'not-installed' } };
  const store = new ProjectStore(config.dataRoot); const source = await occurrenceProject(); await store.create(source);
  const generated = await store.update(source.projectId, 0, (current) => compileAudioInstructionPlan(current, 'demonstration', occurrencePlan(), automaticPlanProvenance()), []);
  const app = await createApp(config, store, new CodexRequestStore(config.codex.requestRoot, buildForSpeechVoice('not-installed')));
  try {
    await page.goto(await app.listen({ host: '127.0.0.1', port: 0 }));
    await page.getByRole('navigation', { name: '콘티 작업 공간' }).getByRole('button', { name: '제작 현황', exact: true }).click();
    await page.getByRole('region', { name: '음향 준비 현황' }).getByRole('listitem').filter({ hasText: '물이 흙에 닿는 소리' }).getByRole('button', { name: '이 음향 준비하기', exact: true }).click();
    const editor = page.getByRole('article', { name: 'ambient-instruction 음향 지시 검토' });
    const occurrences = editor.getByRole('region', { name: '발생별 음향 배치' });
    await expect(occurrences.getByRole('group', { name: '소리 1', exact: true }).getByLabel('소리 인용')).toHaveValue('물이 흙에 닿는 소리');
    await expect(occurrences.getByRole('group', { name: '소리 2', exact: true }).getByLabel('소리 인용')).toHaveValue('컵을 내려놓는 소리');
    for (const value of [{ text: '물이 흙에 닿는 소리', start: 6000, end: 6500 }, { text: '컵을 내려놓는 소리', start: 11000, end: 11500 }]) {
      const track = page.locator('.track-editor').filter({ has: page.locator('p', { hasText: new RegExp(`^${value.text}$`) }) });
      await expect(track).toHaveCount(1);
      await track.getByLabel('START MS').fill(String(value.start)); await track.getByLabel('END MS').fill(String(value.end));
      const [response] = await Promise.all([
        page.waitForResponse((entry): boolean => entry.request().method() === 'PATCH' && new URL(entry.url()).pathname.includes('/audio/')),
        track.getByRole('button', { name: '타이밍 저장', exact: true }).click(),
      ]);
      expect(response.status()).toBe(200);
    }
    await expect(occurrences).toContainText('6000–6500 ms'); await expect(occurrences).toContainText('11000–11500 ms');
    const reason = occurrences.getByRole('group', { name: '소리 1', exact: true }).getByLabel('발생 근거');
    await reason.fill('물을 붓는 순간의 별도 소리로 확인했습니다.');
    await page.reload(); await expect(reason).toHaveValue('물을 붓는 순간의 별도 소리로 확인했습니다.');
    await expect(editor.getByRole('button', { name: '음향 판정 확인', exact: true })).toBeDisabled();
    const [response] = await Promise.all([
      page.waitForResponse((entry): boolean => entry.request().method() === 'PATCH' && new URL(entry.url()).pathname.endsWith('/audio-instructions/ambient-instruction')),
      editor.getByRole('button', { name: '음향 판정 저장', exact: true }).click(),
    ]);
    expect(response.status()).toBe(200); await expect(editor).toContainText('직접 설정 · 검토 대기');
    await page.reload(); await expect(occurrences).toContainText('6000–6500 ms'); await expect(occurrences).toContainText('11000–11500 ms');
    const saved = await store.read(source.projectId); const decision = saved.audioInstructionDecisions!.find((value): boolean => value.instructionId === 'ambient-instruction')!;
    expect(decision.occurrences).toHaveLength(2); expect(decision.cueIds).toEqual(generated.audioInstructionDecisions![0]!.cueIds);
    expect(decision.occurrences![0]!.reason).toBe('물을 붓는 순간의 별도 소리로 확인했습니다.'); expect(decision.reviewStatus).toBe('proposed');
    const [confirmed] = await Promise.all([
      page.waitForResponse((entry): boolean => entry.request().method() === 'POST' && new URL(entry.url()).pathname.endsWith('/audio-instructions/ambient-instruction/confirm')),
      editor.getByRole('button', { name: '음향 판정 확인', exact: true }).click(),
    ]);
    expect(confirmed.status()).toBe(200);
    const after = await store.read(source.projectId);
    expect(after.audioInstructionDecisions!.find((value): boolean => value.instructionId === 'ambient-instruction')?.reviewStatus).toBe('confirmed');
    for (const key of ['dataset', 'sources', 'assets', 'frames', 'generationRecords'] as const) expect(after[key]).toEqual(generated[key]);
    expect(after.audioCues.every((cue): boolean => cue.assetId === null)).toBe(true);
    await occurrences.getByRole('button', { name: '소리 발생 추가', exact: true }).click();
    const unfinished = occurrences.getByRole('group', { name: '소리 3', exact: true });
    await unfinished.getByLabel('소리 인용').fill('');
    await page.reload(); await expect(unfinished.getByLabel('소리 인용')).toHaveValue('');
    await expect(unfinished.getByLabel('발생 근거')).toHaveValue('');
    await expect(editor.getByRole('button', { name: '음향 판정 저장', exact: true })).toBeDisabled();
    expect(await store.read(source.projectId)).toEqual(after);
    const payload = { handoff: source.handoff, files: source.sources.map((value) => ({ path: value.path, content: value.content })) };
    const data = nativeData(payload);
    const incoming = createSourceOutline(importPackage(withNativeData(payload, { ...data,
      units: data.units.filter((unit): boolean => unit.id !== '동작'), informationRules: data.informationRules.filter((rule): boolean => rule.id !== 'reveal:동작'),
    })), { proposedTextHoldMs: 2000 });
    const updated = await store.update(source.projectId, after.revision, (current) => applySourceUpdate(current, incoming, 'occurrence-source-update'), []);
    await page.reload();
    await page.getByRole('button', { name: 'DEMONSTRATION 00:05:00', exact: true }).click();
    await page.getByRole('navigation', { name: '선택 컷 편집 항목' }).getByRole('button', { name: '음성', exact: true }).click();
    await page.getByRole('button', { name: '현재 작업 위치 다시 기억', exact: true }).click();
    await editor.getByRole('button', { name: '작성한 값을 현재 기준으로 검토', exact: true }).click();
    const first = occurrences.getByRole('group', { name: '소리 1', exact: true });
    await expect(first.getByLabel('소리 원문')).toHaveValue('동작');
    await expect(first.getByLabel('소리 원문').locator('option:checked')).toHaveText('원본에서 사라진 연결 · 동작');
    await first.getByLabel('발생 근거').fill('원문 변경 후 이전 소리 연결을 다시 확인합니다.');
    await page.reload(); await expect(first.getByLabel('발생 근거')).toHaveValue('원문 변경 후 이전 소리 연결을 다시 확인합니다.');
    await expect(first.getByLabel('소리 인용')).toHaveValue('물이 흙에 닿는 소리');
    expect(await store.read(source.projectId)).toEqual(updated);
  } finally { await app.close(); await store.close(); await rm(root, { recursive: true, force: true }); }
});

test('e2e_shared_audio_review_shows_applied_segments_without_repeating_sound_and_preserves_scope_after_reload', async ({ page }): Promise<void> => {
  const root = await mkdtemp(join(tmpdir(), 'cutroom-shared-audio-ui-'));
  const config: AppConfig = { host: '127.0.0.1', port: 0, dataRoot: join(root, 'data'), webRoot: resolve('dist/web'),
    pdfFontPath: resolve('assets/fonts/NanumGothic-Regular.ttf'), audioNormalization: TEST_AUDIO_NORMALIZATION_OPTIONS,
    codex: { requestRoot: join(root, 'requests'), speechVoice: 'not-installed' } };
  const documents = await readDocumentSources('tests/fixtures/production/09_PRODUCTION');
  const source = createSourceOutline(importPackage(buildDocumentPackage(documents, documentTestSettings(documents, PRODUCTION_DOCUMENT_BINDINGS))), { proposedTextHoldMs: 2000 });
  const first = source.dataset.segments[0]!;
  const instructions = source.dataset.instructions.filter((instruction): boolean => instruction.segmentId === first.id && ['music', 'ambience'].includes(instruction.kind));
  const ambient = instructions.find((instruction): boolean => instruction.kind === 'ambience')!;
  const store = new ProjectStore(config.dataRoot); await store.create(source);
  await store.update(source.projectId, 0, (current) => compileAudioInstructionPlan(current, first.id, {
    schemaVersion: '1.0.0', segmentId: first.id, summary: '장면 공통 지시의 적용 위치를 첫 구간으로 정한 화면 검증 제안',
    decisions: instructions.map((instruction) => ({ instructionId: instruction.id, resolution: 'required', cueIds: [], informationIds: [], sourceEvidence: [],
      sharedScope: { version: '1.0.0', instructionIds: sharedAudioInstructions(current, instruction).map((value): string => value.id),
        requiredSegmentIds: [first.id], sourceEvidence: [], reason: '장면 공통 소리는 첫 구간에서 사용하고 뒤 내레이션에 반복하지 않는 검토용 제안입니다.' },
      reason: '원문 지시와 적용 구간을 검토하세요. 실제 WAV는 선택 사항입니다.' })),
  }, automaticPlanProvenance()), []);
  const app = await createApp(config, store, new CodexRequestStore(config.codex.requestRoot, buildForSpeechVoice('not-installed')));
  try {
    await page.goto(await app.listen({ host: '127.0.0.1', port: 0 }));
    await page.getByRole('navigation', { name: '콘티 작업 공간' }).getByRole('button', { name: '제작 현황', exact: true }).click();
    await page.getByRole('region', { name: '음향 준비 현황' }).getByRole('listitem').filter({ hasText: ambient.text }).getByRole('button', { name: '이 음향 준비하기', exact: true }).click();
    const editor = page.getByRole('article', { name: `${ambient.id} 음향 지시 검토` });
    const scope = editor.getByRole('region', { name: '공통 음향 적용 구간' });
    await expect(scope).toContainText(`${first.id} · ${first.mode}`);
    await expect(scope).toContainText('현재 구간에 배치합니다.');
    await expect(scope).toContainText('뒤 내레이션에 반복하지 않는');
    await page.reload(); await expect(scope).toContainText(`${first.id} · ${first.mode}`);
    const before = await store.read(source.projectId);
    await editor.getByLabel('음향 필요 여부').selectOption('none');
    await editor.getByRole('textbox', { name: '판정 근거', exact: true }).fill('제작자가 이 구간의 추가 음향을 제외했습니다.');
    const [saved] = await Promise.all([
      page.waitForResponse((response): boolean => response.request().method() === 'PATCH' && new URL(response.url()).pathname.endsWith(`/audio-instructions/${encodeURIComponent(ambient.id)}`)),
      editor.getByRole('button', { name: '음향 판정 저장', exact: true }).click(),
    ]);
    expect(saved.status()).toBe(200); await expect(scope).toHaveCount(0);
    await expect(editor.getByLabel('음향 필요 여부')).toHaveValue('none');
    const after = await store.read(source.projectId);
    expect(after.audioInstructionDecisions!.find((decision): boolean => decision.instructionId === ambient.id)).toMatchObject({ resolution: 'none', sharedScope: null, origin: 'manual', reviewStatus: 'proposed' });
    expect(after.dataset).toEqual(source.dataset); expect(after.sources).toEqual(source.sources); expect(after.assets).toEqual([]);
    expect(after.generationRecords).toEqual(before.generationRecords); expect(after.shots).toEqual(before.shots);
  } finally { await app.close(); await store.close(); await rm(root, { recursive: true, force: true }); }
});

test('e2e_audio_instruction_shows_exact_script_evidence_and_keeps_it_through_manual_review', async ({ page }): Promise<void> => {
  const root = await mkdtemp(join(tmpdir(), 'cutroom-audio-evidence-ui-'));
  const config: AppConfig = { host: '127.0.0.1', port: 0, dataRoot: join(root, 'data'), webRoot: resolve('dist/web'),
    pdfFontPath: resolve('assets/fonts/NanumGothic-Regular.ttf'), audioNormalization: TEST_AUDIO_NORMALIZATION_OPTIONS,
    codex: { requestRoot: join(root, 'requests'), speechVoice: 'not-installed' } };
  const store = new ProjectStore(config.dataRoot); const source = await audioPlaceholderFixture(); await store.create(source);
  const evidence = [{ unitId: '동작', quote: '문을 두드리는 소리가 들린다.' }];
  await store.update(source.projectId, 0, (current) => compileAudioInstructionPlan(current, 'demonstration', {
    schemaVersion: '1.0.0', segmentId: 'demonstration', summary: '빈칸 대신 실제 지문의 소리를 연결한다.', decisions: [
      { instructionId: 'music-instruction', resolution: 'none', cueIds: [], informationIds: [], sourceEvidence: [], reason: '명시적 음악 부재' },
      { instructionId: 'ambient-instruction', resolution: 'required', cueIds: [], informationIds: ['reveal:동작'], sourceEvidence: evidence, reason: '지문에 문 두드리는 소리가 명시되어 있다.' },
    ],
  }, automaticPlanProvenance()), []);
  const app = await createApp(config, store, new CodexRequestStore(config.codex.requestRoot, buildForSpeechVoice('not-installed')));
  try {
    await page.goto(await app.listen({ host: '127.0.0.1', port: 0 }));
    await page.getByRole('navigation', { name: '콘티 작업 공간' }).getByRole('button', { name: '제작 현황', exact: true }).click();
    const preparation = page.getByRole('region', { name: '음향 준비 현황' }).getByRole('listitem').filter({ hasText: evidence[0]!.quote });
    await expect(preparation).toContainText(evidence[0]!.quote);
    await preparation.getByRole('button', { name: '이 음향 준비하기', exact: true }).click();
    const editor = page.getByRole('article', { name: 'ambient-instruction 음향 지시 검토' });
    await expect(editor.getByRole('region', { name: '소리의 대본 근거' })).toContainText(evidence[0]!.quote);
    await editor.getByRole('textbox', { name: '판정 근거', exact: true }).fill('실제 대본을 대조했고 문 두드림 지시를 유지합니다.');
    const [saved] = await Promise.all([
      page.waitForResponse((response): boolean => response.request().method() === 'PATCH' && new URL(response.url()).pathname.endsWith('/audio-instructions/ambient-instruction')),
      editor.getByRole('button', { name: '음향 판정 저장', exact: true }).click(),
    ]);
    expect(saved.status()).toBe(200);
    await expect(editor).toContainText('직접 설정 · 검토 대기');
    await expect(editor.getByRole('button', { name: '음향 판정 저장', exact: true })).toBeDisabled();
    await page.reload();
    await expect(editor.getByRole('region', { name: '소리의 대본 근거' })).toContainText(evidence[0]!.quote);
    const current = await store.read(source.projectId);
    expect(current.audioInstructionDecisions!.find((decision): boolean => decision.instructionId === 'ambient-instruction')).toMatchObject({ sourceEvidence: evidence, origin: 'manual', reviewStatus: 'proposed' });
    expect(current.dataset).toEqual(source.dataset); expect(current.sources).toEqual(source.sources); expect(current.assets).toEqual([]);
  } finally { await app.close(); await store.close(); await rm(root, { recursive: true, force: true }); }
});

test('e2e_audio_instruction_proposal_review_wav_preparation_and_reload_preserve_originals_and_unapproved_draft', async ({ page }): Promise<void> => {
  const root = await mkdtemp(join(tmpdir(), 'cutroom-instructions-ui-'));
  const config: AppConfig = { host: '127.0.0.1', port: 4317, dataRoot: join(root, 'data'), webRoot: join(root, 'web'),
    pdfFontPath: resolve('assets/fonts/NanumGothic-Regular.ttf'), audioNormalization: TEST_AUDIO_NORMALIZATION_OPTIONS,
    codex: { requestRoot: join(root, 'requests'), speechVoice: 'Yuna' } };
  await build({ build: { outDir: config.webRoot }, logLevel: 'warn' });
  const store = new ProjectStore(config.dataRoot); const source = await audioInstructionFixture(); await store.create(source);
  await store.update(source.projectId, 0, (current) => compileAudioInstructionPlan(current, 'demonstration', {
    schemaVersion: '1.0.0', segmentId: 'demonstration', summary: '원문 음악 부재와 별도 물소리 준비', decisions: [
      { instructionId: 'music-instruction', resolution: 'none', cueIds: [], informationIds: [], reason: '배경 음악 없음이라고 원문에 명시되어 있습니다.' },
      { instructionId: 'ambient-instruction', resolution: 'required', cueIds: [], informationIds: [], reason: '물 흐르는 소리는 별도 WAV가 필요합니다.' },
    ],
  }, automaticPlanProvenance()), []);
  const app = await createApp(config, store, new CodexRequestStore(config.codex.requestRoot, buildForSpeechVoice('Yuna')));
  try {
    const url = await app.listen({ host: '127.0.0.1', port: 0 }); await page.goto(url);
    await page.getByRole('navigation', { name: '콘티 작업 공간' }).getByRole('button', { name: '제작 현황', exact: true }).click();
    const preparation = page.getByRole('region', { name: '음향 준비 현황' });
    const waterPreparation = preparation.getByRole('listitem').filter({ hasText: '물 흐르는 소리' });
    await expect(waterPreparation).toContainText('재생하려면 WAV 준비');
    await expect(preparation).not.toContainText('배경 음악 없음');
    await waterPreparation.getByRole('button', { name: '이 음향 준비하기', exact: true }).click();
    await expect(page.getByRole('navigation', { name: '선택 컷 편집 항목' }).getByRole('button', { name: '음성', exact: true })).toHaveAttribute('aria-current', 'page');
    const music = page.getByRole('article', { name: 'music-instruction 음향 지시 검토' });
    const ambience = page.getByRole('article', { name: 'ambient-instruction 음향 지시 검토' });
    await expect(music.getByLabel('음향 필요 여부')).toHaveValue('none');
    await expect(ambience.getByLabel('음향 필요 여부')).toHaveValue('required');
    await expect(ambience).toContainText('음원 등록은 기본 콘티 완료 조건에 포함되지 않습니다.');
    await expect(ambience.locator('p').filter({ hasText: /^물 흐르는 소리는 별도 WAV가 필요합니다\.$/ })).toBeVisible();
    await music.getByRole('button', { name: '음향 판정 확인', exact: true }).click();
    await expect(music.getByRole('button', { name: '음향 판정 확인', exact: true })).toBeDisabled();
    const sound = page.locator('.track-editor').filter({ has: page.locator('p', { hasText: /^물 흐르는 소리$/ }) });
    await expect(sound).toHaveCount(1);
    await sound.locator('input[type=file]').setInputFiles({ name: '검증 물소리.wav', mimeType: 'audio/wav', buffer: pcmWav(1000, 44100, 2, 24) });
    const [preparationResponse] = await Promise.all([
      page.waitForResponse((response): boolean => response.request().method() === 'POST' && new URL(response.url()).pathname.endsWith('/prepare')),
      sound.getByRole('button', { name: 'WAV 준비 · 자동 제작으로 이동' }).click(),
    ]);
    expect(preparationResponse.status()).toBe(201);
    const prepared = await store.read(source.projectId); const cue = prepared.audioCues.find((value): boolean => value.instructionId === 'ambient-instruction')!;
    expect(prepared.revision).toBe(3);
    expect(cue).toMatchObject({ unitId: null, timingStatus: 'prepared' }); expect(cue.assetId).not.toBeNull();
    const bytes = (await store.asset(source.projectId, cue.assetId!)).content;
    await expect(waterPreparation).toContainText('WAV 준비됨 · 자동 배치 필요');
    await page.reload();
    await expect(waterPreparation).toContainText('WAV 준비됨 · 자동 배치 필요');
    await waterPreparation.getByRole('button', { name: '이 음향 준비하기', exact: true }).click();
    await expect(ambience.getByText(/재생 음원 준비됨 · 배치 검토 필요/)).toBeVisible();
    await ambience.getByLabel('판정 근거').fill('직접 들어본 후 물소리를 선택할 예정입니다.');
    await page.reload();
    await expect(ambience.getByLabel('판정 근거')).toHaveValue('직접 들어본 후 물소리를 선택할 예정입니다.');
    await expect(ambience.getByRole('button', { name: '음향 판정 확인', exact: true })).toBeDisabled();
    const after = await store.read(source.projectId); expect(after).toEqual(prepared); expect(after.dataset).toEqual(source.dataset); expect(after.sources).toEqual(source.sources);
    expect((await store.asset(source.projectId, cue.assetId!)).content).toEqual(bytes);
    const final = await app.inject({ method: 'GET', url: `/api/projects/${encodeURIComponent(source.projectId)}/final-readiness` });
    expect(final.body).toContain('AUDIO_PLACEMENT_REQUIRED'); expect(final.body).toContain('AUDIO_INSTRUCTION_REVIEW_REQUIRED');
  } finally { await app.close(); await store.close(); await rm(root, { recursive: true, force: true }); }
});

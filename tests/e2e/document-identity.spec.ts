import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, test } from '@playwright/test';
import type { Locator } from '@playwright/test';
import { readBuildManifest } from '../../src/build.js';
import { CodexRequestStore } from '../../src/codex/requests.js';
import type { DocumentReviewResult } from '../../src/documents/review-model.js';
import { DocumentSettingsSchema } from '../../src/documents/schema.js';
import { createApp } from '../../src/server/app.js';
import { ProjectStore } from '../../src/server/store.js';
import { readPackage } from '../../src/io/package.js';
import { importPackage } from '../../src/importers/import-package.js';
import { SYNTHETIC_DOCUMENT_BINDINGS } from '../document-helpers.js';
import { syntheticIdentityFiles } from '../document-identity-helpers.js';
import { writeReviewEngineFixture } from '../document-review-helpers.js';
import { TEST_AUDIO_NORMALIZATION_OPTIONS } from '../helpers.js';

async function identityApp(root: string, executable: string): Promise<Awaited<ReturnType<typeof createApp>>> {
  return createApp({ host: '127.0.0.1', port: 4317, dataRoot: join(root, 'data'), webRoot: resolve(process.env.CUTROOM_E2E_WEB_ROOT ?? 'dist/web'),
    pdfFontPath: resolve('assets/fonts/NanumGothic-Regular.ttf'), audioNormalization: TEST_AUDIO_NORMALIZATION_OPTIONS,
    codex: { requestRoot: join(root, 'requests'), speechVoice: 'Yuna' }, documentReview: { executable, requestRoot: join(root, 'reviews'), timeoutMs: 3000 } },
  new ProjectStore(join(root, 'data')), new CodexRequestStore(join(root, 'requests'), readBuildManifest()));
}

async function fillIdentityPaths(panel: Locator, characters: string, footprint: string): Promise<void> {
  await panel.getByLabel('인물 원본 파일', { exact: true }).fill(characters);
  await panel.getByLabel('제작 근거 파일', { exact: true }).fill(footprint);
  await panel.getByRole('button', { name: '인물 근거 확인', exact: true }).click();
  await expect(panel.locator('.document-identity-results')).toContainText('검증 완료');
}

test('e2e_identity_supplement_resolves_three_people_preserves_confirmed_choices_and_reopens_package', async ({ page }, testInfo): Promise<void> => {
  const root: string = await mkdtemp(join(tmpdir(), 'identity-real-ui-'));
  const directory: string = join(root, 'input'); await cp('tests/fixtures/production/09_PRODUCTION', directory, { recursive: true });
  const initial: DocumentReviewResult = { summary: '인물 세 명은 이름과 ID의 대응 근거가 필요합니다.', suggestions: [
    ...['백기철', '윤서진', '오민주'].map((key) => ({ field: 'people' as const, key, value: null, origin: 'unresolved' as const, reason: '동일한 출연 집합이므로 인물표로 보완하세요.', evidence: [] })),
    ...[{ key: '강태균', value: 'CHAR-01' }, { key: '박도현', value: 'CHAR-05' }].map((person) => ({ ...person, field: 'people' as const, origin: 'inference' as const,
      reason: '검증 자료의 명시적 연결 제안', evidence: [{ fileId: 'document-broadcast', locator: 'line:16', quote: '강태균' }] })),
    ...[{ key: 'fps', value: '30/1' }, { key: 'sampleRate', value: '48000' }, { key: 'width', value: '16' }, { key: 'height', value: '9' }].map((setting) => ({ ...setting, field: 'production' as const, origin: 'recommendation' as const, reason: '테스트 제작 추천', evidence: [] })),
  ] };
  const executable: string = await writeReviewEngineFixture(root, initial, 'success', 0);
  const app = await identityApp(root, executable);
  try {
    await page.goto(await app.listen({ host: '127.0.0.1', port: 0 }));
    await page.locator('.welcome').getByRole('button', { name: /제작 문서 8개/ }).click();
    const panel: Locator = page.getByRole('dialog');
    await panel.getByLabel('제작 문서 폴더').fill(directory);
    await panel.getByRole('button', { name: '문서 검토', exact: true }).click();
    await panel.getByRole('button', { name: 'Codex로 검토하고 채우기', exact: true }).click();
    await expect(panel.locator('.document-review-note')).toContainText('6개 입력값');
    const connections: Locator = panel.getByRole('region', { name: '인물 연결 3/8명 완료' });
    await expect(connections.getByRole('row').filter({ hasText: '백기철' })).toContainText('ID 결정 보류');
    await expect(connections.getByRole('row').filter({ hasText: '강태균' })).toContainText('CHAR-01');
    await connections.getByRole('button', { name: '강태균 → CHAR-01 확정', exact: true }).click();
    await panel.getByRole('button', { name: '입력된 제안 모두 확인', exact: true }).click();
    await expect(panel.locator('.document-identity-needed')).toHaveCount(3);
    await expect(panel.locator('.document-review-results > details')).toHaveAttribute('open', '');
    await expect(panel.locator('.document-progress-note')).toContainText('제작 설정 입력 완료');
    const reviewed: string = await writeReviewEngineFixture(root, { summary: '보충 인물 원본 확인 완료. 현재 연결·제작 설정을 유지합니다.', suggestions: [] }, 'success', 100);
    await cp(reviewed, executable);
    await panel.getByRole('button', { name: '인물 보충 파일 지정하기', exact: true }).click();
    await expect(panel.getByLabel('인물 원본 파일', { exact: true })).toBeFocused();
    await panel.getByLabel('인물 원본 파일', { exact: true }).fill(resolve('tests/fixtures/production/02_CHARACTER/characters.json'));
    await panel.getByLabel('제작 근거 파일', { exact: true }).fill(resolve('tests/fixtures/production/06_SCENE/production_footprint.json'));
    await page.setViewportSize({ width: 375, height: 812 });
    expect(await panel.locator('.document-scroll').evaluate((element: HTMLDivElement): boolean => element.scrollWidth <= element.clientWidth)).toBe(true);
    await panel.getByRole('button', { name: '근거 확인 후 자동 연결', exact: true }).click();
    await expect(panel.locator('.document-review-note')).toContainText('보충 인물 근거 검토를 완료');
    await expect(panel.getByLabel('인물 ID: 백기철', { exact: true })).toHaveValue('CHAR-03');
    await expect(panel.getByLabel('인물 ID: 윤서진', { exact: true })).toHaveValue('CHAR-02');
    await expect(panel.getByLabel('인물 ID: 오민주', { exact: true })).toHaveValue('CHAR-04');
    await expect(panel.getByLabel('프레임레이트', { exact: true })).toHaveValue('30/1');
    await expect(panel.locator('.document-identity-needed')).toHaveCount(0);
    await expect(panel.locator('.document-stats')).toContainText('연결 확인 필요0개');
    const completed: Locator = panel.getByRole('region', { name: '인물 연결 8/8명 완료' });
    for (const [name, id] of [['백기철', 'CHAR-03'], ['윤서진', 'CHAR-02'], ['오민주', 'CHAR-04']] as const) {
      await expect(completed.getByRole('row').filter({ hasText: name })).toContainText(id);
      await expect(completed.getByRole('row').filter({ hasText: name })).toContainText('보충 인물표 확인 · 연결 완료');
    }
    await expect(completed).toContainText('보충 파일을 추가할 필요 없이');
    await page.screenshot({ path: testInfo.outputPath('identity-completed-mobile.png') });
    await panel.getByRole('button', { name: '생성 내용 확인', exact: true }).click();
    await panel.getByLabel('패키지 버전', { exact: true }).fill('identity-verified');
    await panel.getByLabel('새 패키지 폴더', { exact: true }).fill(join(root, 'package'));
    await panel.getByRole('button', { name: '패키지 생성', exact: true }).click();
    await expect(panel.locator('.document-success')).toContainText('패키지 생성 완료');
    const settings = DocumentSettingsSchema.parse(JSON.parse(await readFile(join(root, 'package/document-settings.json'), 'utf8')));
    expect(settings.formatVersion).toBe('1.2.0'); expect(settings.identityEvidence).toBeDefined();
    expect(settings.reviewAudit!.entries.filter((entry): boolean => entry.origin === 'identity-document')).toHaveLength(3);
    expect(settings.reviewAudit!.entries.filter((entry): boolean => entry.origin === 'inference' && entry.confirmed)).toHaveLength(2);
    const project = importPackage(await readPackage(join(root, 'package/storyboard_handoff.json')));
    expect(project.dataset.people.find((person): boolean => person.name === '오민주')?.id).toBe('CHAR-04');
    await panel.getByRole('button', { name: '2 연결·설정', exact: true }).click();
    await expect(panel.locator('.document-identity-applied')).toBeVisible();
    await expect(completed).toBeVisible();
    await panel.getByRole('button', { name: '3 생성·불러오기', exact: true }).click();
    await expect(panel.locator('.document-success')).toBeVisible();
    await page.reload();
    await page.locator('.welcome').getByRole('button', { name: /제작 문서 8개/ }).click();
    await panel.getByRole('button', { name: '원본 다시 확인', exact: true }).click();
    await expect(panel.locator('.document-success')).toBeVisible();
    await panel.getByRole('button', { name: '2 연결·설정', exact: true }).click();
    await expect(completed).toBeVisible();
    await panel.getByRole('button', { name: '3 생성·불러오기', exact: true }).click();
    await panel.getByRole('button', { name: '다른 패키지 만들기', exact: true }).click();
    await panel.getByLabel('제작 문서 폴더').fill(directory);
    await panel.getByRole('button', { name: '문서 검토', exact: true }).click();
    await expect(panel.getByLabel('인물 원본 파일', { exact: true })).toHaveValue('');
    await expect(panel.getByLabel('제작 근거 파일', { exact: true })).toHaveValue('');
    const restored: Locator = panel.getByRole('region', { name: '인물 연결 3/8명 완료' });
    await expect(restored.getByRole('row').filter({ hasText: '백기철' })).toContainText('선택할 ID: CHAR-03');
    await expect(restored.getByRole('row').filter({ hasText: '윤서진' })).toContainText('선택할 ID: CHAR-02');
    await expect(restored.getByRole('row').filter({ hasText: '오민주' })).toContainText('선택할 ID: CHAR-04');
    await page.screenshot({ path: testInfo.outputPath('identity-recommended-before-apply.png') });
    await panel.getByLabel('프레임레이트', { exact: true }).selectOption('30/1');
    await panel.getByLabel('음성 샘플레이트', { exact: true }).selectOption('48000');
    await panel.getByLabel('화면비 가로', { exact: true }).fill('16');
    await panel.getByLabel('화면비 세로', { exact: true }).fill('9');
    await restored.getByRole('button', { name: '확인된 5명 자동 선택', exact: true }).click();
    await expect(completed).toBeVisible();
    await expect(panel.getByLabel('인물 ID: 백기철', { exact: true })).toHaveValue('CHAR-03');
    await expect(panel.getByLabel('인물 ID: 윤서진', { exact: true })).toHaveValue('CHAR-02');
    await expect(panel.getByLabel('인물 ID: 오민주', { exact: true })).toHaveValue('CHAR-04');
    await expect(panel.locator('.document-review-note')).toContainText('보충 인물 근거 검토를 완료');
  } finally {
    const diagnostic: Buffer = await readFile(executable + '.rpc.jsonl').catch((error: unknown): Buffer => Buffer.from(JSON.stringify({ fixtureLogError: String(error) })));
    await testInfo.attach('identity-engine-rpc', { body: diagnostic, contentType: 'application/x-ndjson' });
    await page.context().close(); await app.close(); await rm(root, { recursive: true, force: true });
  }
});

test('e2e_identity_auto_connect_rejects_source_change_without_filling_people', async ({ page }): Promise<void> => {
  const root: string = await mkdtemp(join(tmpdir(), 'identity-auto-change-'));
  const files = await syntheticIdentityFiles(root);
  const executable: string = await writeReviewEngineFixture(root, { summary: '실행되면 안 되는 검토', suggestions: [] }, 'success', 0);
  const app = await identityApp(root, executable);
  try {
    await page.goto(await app.listen({ host: '127.0.0.1', port: 0 }));
    await page.locator('.welcome').getByRole('button', { name: /제작 문서 8개/ }).click();
    const panel: Locator = page.getByRole('dialog');
    await panel.getByLabel('제작 문서 폴더').fill(files.directory);
    await panel.getByRole('button', { name: '문서 검토', exact: true }).click();
    for (const binding of SYNTHETIC_DOCUMENT_BINDINGS.scenes) await panel.getByLabel('장면 ID: ' + binding.key, { exact: true }).selectOption(binding.targetId);
    await panel.getByLabel('인물 원본 파일', { exact: true }).fill(files.charactersPath);
    await panel.getByLabel('제작 근거 파일', { exact: true }).fill(files.footprintPath);
    await page.route('**/api/document-identities/validate', async (route): Promise<void> => {
      await writeFile(files.charactersPath, (await readFile(files.charactersPath, 'utf8')) + '\n');
      await route.continue();
    });
    await panel.getByRole('button', { name: '근거 확인 후 자동 연결', exact: true }).click();
    await expect(panel.locator('.document-identity [role=alert]')).toBeVisible();
    await expect(panel.getByLabel('인물 ID: 민아', { exact: true })).toHaveValue('');
    await expect(panel.getByLabel('인물 ID: 준', { exact: true })).toHaveValue('');
    await expect(panel.getByRole('region', { name: '인물 연결 0/2명 완료' })).toBeVisible();
    await expect(panel.locator('.document-review-note')).toHaveCount(0);
  } finally { await page.context().close(); await app.close(); await rm(root, { recursive: true, force: true }); }
});

test('e2e_identity_supplement_supports_independent_story_and_blocks_changed_basis', async ({ page }): Promise<void> => {
  const root: string = await mkdtemp(join(tmpdir(), 'identity-synthetic-ui-'));
  const files = await syntheticIdentityFiles(root);
  const executable: string = await writeReviewEngineFixture(root, { summary: '독립 스토리의 인물 근거를 확인했습니다.', suggestions: [] }, 'success', 0);
  const app = await identityApp(root, executable);
  try {
    await page.goto(await app.listen({ host: '127.0.0.1', port: 0 }));
    await page.locator('.welcome').getByRole('button', { name: /제작 문서 8개/ }).click();
    const panel: Locator = page.getByRole('dialog');
    await panel.getByLabel('제작 문서 폴더').fill(files.directory);
    await panel.getByRole('button', { name: '문서 검토', exact: true }).click();
    for (const binding of SYNTHETIC_DOCUMENT_BINDINGS.scenes) await panel.getByLabel('장면 ID: ' + binding.key, { exact: true }).selectOption(binding.targetId);
    await panel.getByLabel('프레임레이트', { exact: true }).selectOption('25/1');
    await panel.getByLabel('음성 샘플레이트', { exact: true }).selectOption('44100');
    await panel.getByLabel('화면비 가로', { exact: true }).fill('9'); await panel.getByLabel('화면비 세로', { exact: true }).fill('16');
    await fillIdentityPaths(panel, files.charactersPath, files.footprintPath);
    await panel.getByLabel('인물 ID: 민아', { exact: true }).selectOption('helper');
    await expect(panel.getByRole('button', { name: '연결 적용하고 Codex 검토', exact: true })).toHaveCount(0);
    await panel.getByRole('button', { name: '인물 근거 확인', exact: true }).click();
    await expect(panel.locator('.document-identity [role=alert]')).toContainText('이미 민아');
    await panel.getByLabel('인물 ID: 민아', { exact: true }).selectOption('');
    await panel.getByRole('button', { name: '인물 근거 확인', exact: true }).click();
    await panel.getByRole('button', { name: '연결 적용하고 Codex 검토', exact: true }).click();
    await expect(panel.locator('.document-review-note')).toContainText('검토를 완료');
    await expect(panel.getByLabel('인물 ID: 민아', { exact: true })).toHaveValue('host');
    await expect(panel.getByLabel('인물 ID: 준', { exact: true })).toHaveValue('helper');
    await expect(panel.getByLabel('프레임레이트', { exact: true })).toHaveValue('25/1');
    await panel.getByRole('button', { name: '보충 근거 해제', exact: true }).click();
    await expect(panel.getByLabel('인물 ID: 민아', { exact: true })).toHaveValue('');
    await expect(panel.getByLabel('인물 ID: 준', { exact: true })).toHaveValue('');
    await expect(panel.getByLabel('화면비 가로', { exact: true })).toHaveValue('9');
  } finally { await page.context().close(); await app.close(); await rm(root, { recursive: true, force: true }); }
});

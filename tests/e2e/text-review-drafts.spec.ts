import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, test } from '@playwright/test';
import { readBuildManifest } from '../../src/build.js';
import { CodexRequestStore } from '../../src/codex/requests.js';
import { updateTextMappingDecision } from '../../src/domain/mapping.js';
import type { NativeDataset, Project } from '../../src/domain/schema.js';
import { applySourceUpdate } from '../../src/domain/source-update.js';
import { importPackage } from '../../src/importers/import-package.js';
import { createSourceOutline } from '../../src/proposal/outline.js';
import { createApp } from '../../src/server/app.js';
import { ProjectStore } from '../../src/server/store.js';
import { nativeData, nativePackage, TEST_AUDIO_NORMALIZATION_OPTIONS, withNativeData } from '../helpers.js';

test('e2e_text_review_drafts_restore_without_confirmation_and_preserve_missing_targets', async ({ page }): Promise<void> => {
  const root: string = await mkdtemp(join(tmpdir(), 'cutroom-text-review-drafts-'));
  const payload = await nativePackage(); const data: NativeDataset = nativeData(payload);
  const source: NativeDataset = { ...data, informationRules: [{ id: 'soil-information', segmentId: 'SEG-001',
    notBeforeMs: 0, notBeforeUnitId: null, notBeforeUnitOrder: null, precision: 'exact-time' }] };
  const outline: Project = createSourceOutline(importPackage(withNativeData(payload, source)), { proposedTextHoldMs: 2000 });
  const independent: Project = updateTextMappingDecision(outline, 'text-mapping-1', { canonicalUnitId: null, relation: 'standalone-placement',
    status: 'confirmed', renderCanonicalSeparately: false, canonicalStartMs: null, canonicalEndMs: null, note: null });
  const project: Project = { ...independent,
    textCues: [...independent.textCues, { id: 'legacy-review-cue', segmentId: 'SEG-001', authority: 'review-required', unitId: null, placementId: null,
      mappingDecisionId: null, text: '연결을 검토할 글자', startMs: 0, endMs: 1000, kind: 'overlay', timingStatus: 'proposed' }] };
  const store = new ProjectStore(join(root, 'data')); await store.create(project);
  const app = await createApp({ host: '127.0.0.1', port: 0, dataRoot: join(root, 'data'), webRoot: resolve(process.env.CUTROOM_E2E_WEB_ROOT ?? 'dist/web'),
    pdfFontPath: resolve('assets/fonts/NanumGothic-Regular.ttf'), audioNormalization: TEST_AUDIO_NORMALIZATION_OPTIONS,
    codex: { requestRoot: join(root, 'requests'), speechVoice: 'Yuna' } }, store, new CodexRequestStore(join(root, 'requests'), readBuildManifest()));
  const mutations: string[] = [];
  page.on('request', (request): void => { if (['POST', 'PATCH', 'DELETE'].includes(request.method())) mutations.push(request.url()); });
  try {
    await page.goto(await app.listen({ host: '127.0.0.1', port: 0 }));
    const inspector = page.getByRole('complementary', { name: '콘티 편집 패널' });
    await inspector.getByRole('button', { name: '글자', exact: true }).click();
    const information = inspector.getByRole('article', { name: '독립 글자 정보 검토 · title-placement' });
    const authority = inspector.getByRole('region', { name: '글자 본문 근거 연결' });
    await expect(authority.getByRole('button', { name: '권한 확정', exact: true })).toBeDisabled();
    await information.getByRole('checkbox', { name: /soil-information/u }).check();
    await information.getByLabel('정보 연결 검토 메모').fill('흙 상태 정보가 포함된 독립 글자');
    await authority.getByLabel('본문 근거 종류').selectOption('placement');
    await authority.getByLabel('연결할 근거').selectOption('title-placement');
    await page.reload();
    await expect(information.getByRole('checkbox', { name: /soil-information/u })).toBeChecked();
    await expect(information.getByLabel('정보 연결 검토 메모')).toHaveValue('흙 상태 정보가 포함된 독립 글자');
    await expect(authority.getByLabel('본문 근거 종류')).toHaveValue('placement');
    await expect(authority.getByLabel('연결할 근거')).toHaveValue('title-placement');
    await authority.getByLabel('본문 근거 종류').selectOption('source-unit');
    await expect(authority.getByLabel('연결할 근거')).toHaveValue('');
    await expect(authority.getByRole('button', { name: '권한 확정', exact: true })).toBeDisabled();
    await authority.getByLabel('연결할 근거').selectOption('제목');
    await page.locator('.scene-rail .segment-row').nth(1).click();
    await expect(authority).not.toBeVisible();
    await page.locator('.scene-rail .segment-row').first().click();
    await expect(authority.getByLabel('연결할 근거')).toHaveValue('제목');
    expect(mutations).toEqual([]);
    expect((await store.read(project.projectId)).revision).toBe(0);

    await store.update(project.projectId, 0, (current: Project): Project => ({ ...current, title: '다른 작업에서 수정한 제목' }), []);
    await page.getByRole('button', { name: '새로고침', exact: true }).click();
    await expect(information.getByRole('button', { name: 'Information 연결', exact: true })).toBeDisabled();
    await expect(authority.getByRole('button', { name: '권한 확정', exact: true })).toBeDisabled();
    await information.getByRole('button', { name: '작성한 값을 현재 기준으로 검토', exact: true }).click();
    await authority.getByRole('button', { name: '작성한 값을 현재 기준으로 검토', exact: true }).click();
    await expect(information.getByRole('button', { name: 'Information 연결', exact: true })).toBeEnabled();
    await expect(authority.getByRole('button', { name: '권한 확정', exact: true })).toBeEnabled();
    expect(mutations).toEqual([]);

    const incoming: Project = createSourceOutline(importPackage(withNativeData(payload, { ...source, informationRules: [],
      units: source.units.map((unit) => unit.id === '제목' ? { ...unit, id: '새-제목' } : unit),
      textPlacements: source.textPlacements.map((placement) => placement.unitId === '제목' ? { ...placement, unitId: '새-제목' } : placement),
    })), { proposedTextHoldMs: 2000 });
    await store.update(project.projectId, 1, (current: Project): Project => {
      const changed: Project = applySourceUpdate(current, incoming, 'source-review-update');
      const mapping = changed.textMappingDecisions.find((value) => value.placementId === 'title-placement')!;
      const reviewed: Project = updateTextMappingDecision(changed, mapping.id, { canonicalUnitId: null, relation: 'standalone-placement', status: 'confirmed',
        renderCanonicalSeparately: false, canonicalStartMs: null, canonicalEndMs: null, note: null });
      return { ...reviewed, textCues: [...reviewed.textCues.filter((cue) => cue.id !== 'legacy-review-cue'), project.textCues.find((cue) => cue.id === 'legacy-review-cue')!] };
    }, []);
    await page.reload();
    await page.getByRole('article', { name: 'source-review-update:shot:1 컷 선택', exact: true }).click();
    await inspector.getByRole('button', { name: '글자', exact: true }).click();
    await information.getByRole('button', { name: '작성한 값을 현재 기준으로 검토', exact: true }).click();
    await authority.getByRole('button', { name: '작성한 값을 현재 기준으로 검토', exact: true }).click();
    await expect(information).toContainText('복원한 정보 ID가 현재 원본에 없습니다.');
    await expect(authority).toContainText('복원한 근거가 현재 구간에 없습니다.');
    await expect(authority.getByLabel('연결할 근거')).toHaveValue('제목');
    await expect(information.getByRole('button', { name: 'Information 연결', exact: true })).toBeDisabled();
    await expect(authority.getByRole('button', { name: '권한 확정', exact: true })).toBeDisabled();
    await information.getByRole('checkbox', { name: '현재 원본에 없는 정보 · soil-information', exact: true }).click();
    await expect(information.getByRole('checkbox', { name: '현재 원본에 없는 정보 · soil-information', exact: true })).toHaveCount(0);
    await expect(information.getByLabel('정보 연결 검토 메모')).toHaveValue('흙 상태 정보가 포함된 독립 글자');
    await expect(information.getByRole('button', { name: 'Non-informational', exact: true })).toBeEnabled();
    expect(mutations).toEqual([]);
    const current: Project = await store.read(project.projectId);
    expect(current.revision).toBe(2);
    expect(current.textPlacementInformationDecisions[0]?.status).toBe('unresolved');
    expect(current.textCues.find((cue) => cue.id === 'legacy-review-cue')?.authority).toBe('review-required');
  } finally { await page.context().close(); await app.close(); await rm(root, { recursive: true, force: true }); }
});

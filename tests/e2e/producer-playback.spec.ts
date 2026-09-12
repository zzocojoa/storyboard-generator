import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, test } from '@playwright/test';
import { readBuildManifest } from '../../src/build.js';
import { CodexRequestStore } from '../../src/codex/requests.js';
import type { Project } from '../../src/domain/schema.js';
import { sha256Text } from '../../src/importers/integrity.js';
import { createApp } from '../../src/server/app.js';
import { ProjectStore } from '../../src/server/store.js';
import { TEST_AUDIO_NORMALIZATION_OPTIONS } from '../helpers.js';
import { producerPlaybackFixture } from '../producer-playback-helpers.js';

test('e2e_producer_review_plays_pending_frames_in_order_and_preserves_final_and_project', async ({ page }): Promise<void> => {
  const root: string = await mkdtemp(join(tmpdir(), 'producer-ui-')); const dataRoot: string = join(root, 'data');
  const store: ProjectStore = new ProjectStore(dataRoot); const fixture = await producerPlaybackFixture();
  await store.create(fixture.source); const project = await store.update(fixture.source.projectId, 0, (): Project => fixture.project, fixture.writes);
  const original: Buffer = await readFile(join(dataRoot, sha256Text(project.projectId), 'project.json'));
  const app = await createApp({ host: '127.0.0.1', port: 0, dataRoot, webRoot: resolve(process.env.CUTROOM_E2E_WEB_ROOT ?? 'dist/web'), pdfFontPath: resolve('assets/fonts/NanumGothic-Regular.ttf'),
    audioNormalization: TEST_AUDIO_NORMALIZATION_OPTIONS, codex: { requestRoot: join(root, 'requests'), speechVoice: 'Yuna' } }, store, new CodexRequestStore(join(root, 'requests'), readBuildManifest()));
  try {
    const base: string = await app.listen({ host: '127.0.0.1', port: 0 }); await page.goto(base);
    await page.getByRole('button', { name: '초안 미리보기', exact: true }).click();
    const monitor = page.getByRole('dialog', { name: '콘티 시간순 재생' });
    const seek = async (atMs: number): Promise<void> => {
      await monitor.getByRole('slider', { name: '검토 재생 위치' }).evaluate((input: HTMLInputElement, value: number): void => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, String(value)); input.dispatchEvent(new Event('input', { bubbles: true }));
      }, atMs);
    };
    await seek(5000); await expect(monitor).toContainText('제작자 검토 · 미승인 결과 포함');
    const current = monitor.getByRole('img', { name: '현재 재생 프레임', exact: true });
    await expect(current).toHaveJSProperty('naturalWidth', 90);
    const first: string = (await current.getAttribute('src'))!;
    const frame = await monitor.locator('.monitor-frame').boundingBox();
    expect(frame).not.toBeNull(); expect(frame!.width / frame!.height).toBeCloseTo(project.profile.aspectWidth / project.profile.aspectHeight, 2);
    await seek(6000); await expect(current).toHaveAttribute('src', first);
    await seek(8000); await expect(current).not.toHaveAttribute('src', first);
    const key: string = (await current.getAttribute('src'))!;
    await seek(13498); await expect(current).toHaveAttribute('src', key);
    await seek(13499); await expect(current).not.toHaveAttribute('src', key);
    await seek(5000); await monitor.getByRole('button', { name: '검토 재생', exact: true }).click();
    await expect(monitor.getByRole('slider', { name: '검토 재생 위치' })).not.toHaveValue('5000');
    await monitor.getByRole('button', { name: '검토 일시 정지', exact: true }).click();
    await page.screenshot({ path: '.local/validation/automation-runtime/producer-review-ui.png' });
    await monitor.getByRole('button', { name: '이 그림 편집', exact: true }).click();
    await expect(monitor).toHaveCount(0);
    await expect(page.getByRole('navigation', { name: '선택 컷 편집 항목' }).getByRole('button', { name: '그림', exact: true })).toHaveAttribute('aria-current', 'page');
    await page.getByRole('navigation', { name: '콘티 작업 공간' }).getByRole('button', { name: '검토·출력', exact: true }).click();
    await page.getByRole('button', { name: '최종 재생 검사', exact: true }).click();
    await expect(monitor).toContainText('FRAME_OUTPUT_REVIEW_REQUIRED'); await expect(current).toHaveCount(0);
    const path: string = `/api/projects/${encodeURIComponent(project.projectId)}`;
    const safe = await page.request.get(base + path + '/output/visual?atMs=5000'); expect(safe.status()).toBe(409);
    const review = await page.request.get(base + path + '/review/visual?atMs=5000&revision=1'); expect(review.status()).toBe(200);
    expect(review.headers()['cache-control']).toBe('no-store'); expect(review.headers()['x-cutroom-visual-review']).toBe('pending');
    expect((await page.request.get(base + path + '/review/visual?atMs=5000&revision=0')).status()).toBe(409);
    expect((await page.request.get(base + path + '/review/visual?atMs=5000')).status()).toBe(400);
    expect((await page.request.get(base + path + '/output/visual?atMs=5000&channel=producer-review')).status()).toBe(400);
    expect((await page.request.get(base + path + '/export.pdf?maturity=final')).status()).toBe(409);
    expect(await readFile(join(dataRoot, sha256Text(project.projectId), 'project.json'))).toEqual(original);
  } finally { await page.context().close(); await app.close(); await rm(root, { recursive: true, force: true }); }
});

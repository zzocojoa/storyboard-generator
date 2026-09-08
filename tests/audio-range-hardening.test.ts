import { afterEach, describe, expect, it } from 'vitest';
import { closeHardeningHttpFixture, hardeningHttpFixture } from './hardening-http-fixtures.js';
import type { HardeningHttpFixture } from './hardening-http-fixtures.js';

const fixtures: HardeningHttpFixture[] = [];
afterEach(async (): Promise<void> => { for (const value of fixtures.splice(0)) await closeHardeningHttpFixture(value); });
async function fixture(): Promise<HardeningHttpFixture> { const value = await hardeningHttpFixture(); fixtures.push(value); return value; }
async function rejectedRange(range: string): Promise<void> {
  const value = await fixture(); const url: string = `/api/projects/${value.project.projectId}/output/audio/${value.project.audioCues[0]!.id}`;
  const full = await value.app.inject({ method: 'GET', url }); const response = await value.app.inject({ method: 'GET', url, headers: { range } });
  expect(response.statusCode).toBe(416); expect(response.headers).toMatchObject({ 'content-range': `bytes */${full.rawPayload.length}`, 'accept-ranges': 'bytes', 'cache-control': 'no-store' });
  expect(response.json().error).toMatchObject({ code: 'INVALID_MEDIA_RANGE', scope: 'request', mutationBlocked: false });
}
describe('Audio Range 응답 계약', (): void => {
  it('invalid_audio_range_returns_416_with_content_range', async (): Promise<void> => { await rejectedRange('bytes=999999999-'); });
  it('unsatisfiable_suffix_range_returns_416_with_full_size', async (): Promise<void> => { await rejectedRange('bytes=-0'); });
  it('multi_range_request_is_rejected_with_content_range', async (): Promise<void> => { await rejectedRange('bytes=0-5,9-15'); });
  it('valid_partial_audio_range_returns_206', async (): Promise<void> => {
    const value = await fixture(); const url: string = `/api/projects/${value.project.projectId}/output/audio/${value.project.audioCues[0]!.id}`;
    const full = await value.app.inject({ method: 'GET', url }); const response = await value.app.inject({ method: 'GET', url, headers: { range: 'bytes=44-63' } });
    expect(response.statusCode).toBe(206); expect(response.rawPayload).toEqual(full.rawPayload.subarray(44, 64)); expect(response.headers['content-range']).toBe(`bytes 44-63/${full.rawPayload.length}`);
  });
  it('full_audio_request_returns_200_with_accept_ranges', async (): Promise<void> => {
    const value = await fixture(); const response = await value.app.inject({ method: 'GET', url: `/api/projects/${value.project.projectId}/output/audio/${value.project.audioCues[0]!.id}` });
    expect(response.statusCode).toBe(200); expect(response.rawPayload.subarray(0, 4).toString()).toBe('RIFF'); expect(response.headers).toMatchObject({ 'accept-ranges': 'bytes', 'cache-control': 'no-store' });
  });
});

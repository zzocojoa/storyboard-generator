import { writeNodeFixture } from './node-process-fixture.js';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { CodexImageEngine, inspectGeneratedImage } from '../src/codex/image-engine.js';
import { MAX_IMAGE_REFERENCE_SOURCES } from '../src/codex/image-reference-presentation.js';
import { sha256Bytes } from '../src/importers/integrity.js';
import { MAX_IMAGE_BYTES } from '../src/domain/media-inspection.js';
import type { JsonValue } from '../src/io/stable-json.js';

async function testPng(width: number, height: number): Promise<Buffer> {
  return sharp({ create: { width, height, channels: 3, background: '#718164' } }).png().toBuffer();
}

function imageItem(bytes: Buffer): Record<string, JsonValue> {
  return { type: 'imageGeneration', id: 'image-result', status: 'completed', result: bytes.toString('base64'), revisedPrompt: '검토용 합성 프레임', failure: null, savedPath: '/untrusted/model-path.png' };
}

async function imageFixture(root: string, images: readonly JsonValue[]): Promise<string> {
  const executable: string = join(root, 'image-engine.mjs');
  await writeNodeFixture(executable, `#!${process.execPath}
import { createInterface } from 'node:readline';
import { appendFileSync } from 'node:fs';
const images = ${JSON.stringify(images)};
const send = value => process.stdout.write(JSON.stringify(value) + '\\n');
createInterface({ input: process.stdin }).on('line', line => {
  appendFileSync(${JSON.stringify(join(root, 'transcript.jsonl'))}, line + '\\n');
  const { id, method } = JSON.parse(line);
  if (method === 'initialize') send({ id, result: {} });
  if (method === 'account/read') send({ id, result: { account: { type: 'chatgpt' } } });
  if (method === 'config/read') send({ id, result: { config: {} } });
  if (method === 'thread/start') send({ id, result: { thread: { id: 'image-thread' }, model: 'fixture-model', modelProvider: 'openai', approvalPolicy: 'never', sandbox: { type: 'workspaceWrite', networkAccess: false, writableRoots: [] } } });
  if (method === 'turn/start') {
    send({ id, result: { turn: { id: 'image-turn' } } });
    for (const item of images) send({ method: 'item/completed', params: { threadId: 'image-thread', turnId: 'image-turn', item } });
    send({ method: 'turn/completed', params: { threadId: 'image-thread', turn: { id: 'image-turn', status: 'completed', error: null } } });
  }
});
`);
  return executable;
}

describe('Codex image engine', (): void => {
  it('automation_image_result_checks_bytes_hash_and_aspect_without_reading_model_paths', async (): Promise<void> => {
    const bytes: Buffer = await testPng(160, 90);
    const result = await inspectGeneratedImage(imageItem(bytes), { width: 16, height: 9 });
    expect(result.bytes.equals(bytes)).toBe(true);
    expect(result.inspection).toMatchObject({ width: 160, height: 90, mimeType: 'image/png' });
    expect(result.inspection.sha256).toMatch(/^[a-f0-9]{64}$/u);
    await expect(inspectGeneratedImage(imageItem(bytes), { width: 1, height: 1 })).rejects.toMatchObject({ code: 'CODEX_IMAGE_ASPECT_MISMATCH' });
    await expect(inspectGeneratedImage(imageItem(await testPng(1672, 941)), { width: 16, height: 9 })).resolves.toMatchObject({ inspection: { width: 1672, height: 941 } });
  });

  it('automation_image_result_rejects_failed_corrupt_oversized_and_noncanonical_data', async (): Promise<void> => {
    const item: Record<string, JsonValue> = imageItem(await testPng(16, 9));
    await expect(inspectGeneratedImage({ ...item, failure: { type: 'usageLimitExceeded', limitId: 'image', resetsAt: null } }, { width: 16, height: 9 })).rejects.toMatchObject({ code: 'CODEX_IMAGE_GENERATION_FAILED' });
    await expect(inspectGeneratedImage({ ...item, result: 'a'.repeat(Math.ceil(MAX_IMAGE_BYTES / 3) * 4 + 4) }, { width: 16, height: 9 })).rejects.toMatchObject({ code: 'CODEX_IMAGE_SIZE_INVALID' });
    for (const result of ['https://example.com/image.png', '/tmp/image.png', 'Zm9=', '%%%%']) {
      await expect(inspectGeneratedImage({ ...item, result }, { width: 16, height: 9 })).rejects.toMatchObject({ code: 'CODEX_IMAGE_ENCODING_INVALID' });
    }
    await expect(inspectGeneratedImage({ ...item, result: Buffer.from('not an image').toString('base64') }, { width: 16, height: 9 })).rejects.toMatchObject({ code: 'ASSET_CONTENT_CORRUPT' });
  });

  it('automation_image_engine_sends_checked_reference_bytes_and_returns_one_pending_asset_candidate', async (): Promise<void> => {
    const root: string = await mkdtemp(join(tmpdir(), 'cutroom-image-test-'));
    try {
      const bytes: Buffer = await testPng(160, 90);
      const executable: string = await imageFixture(root, [imageItem(bytes)]);
      const engine: CodexImageEngine = new CodexImageEngine({ executable, model: 'fixture-model', timeoutMs: 2000 });
      const result = await engine.run({ prompt: '현재 프레임의 화분', aspectRatio: { width: 16, height: 9 }, references: [{ label: '화분 기준', bytes, mimeType: 'image/png' }] }, new AbortController().signal);
      expect(result).toMatchObject({ model: 'fixture-model', turnId: 'image-turn', itemId: 'image-result' });
      expect(result.bytes.equals(bytes)).toBe(true);
      const transcript: string = await readFile(join(root, 'transcript.jsonl'), 'utf8');
      expect(transcript).toContain('"features.image_generation":true');
      expect(transcript).toContain('"features.shell_tool":false');
      expect(transcript).toContain(`data:image/png;base64,${bytes.toString('base64')}`);
      expect(transcript).not.toContain('/untrusted/model-path.png');
      expect(result).not.toHaveProperty('approval');
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('automation_image_engine_rejects_missing_multiple_and_unchecked_references', async (): Promise<void> => {
    const bytes: Buffer = await testPng(16, 9);
    for (const items of [[], [imageItem(bytes), { ...imageItem(bytes), id: 'second' }]]) {
      const root: string = await mkdtemp(join(tmpdir(), 'cutroom-image-count-'));
      try {
        const executable: string = await imageFixture(root, items);
        const engine: CodexImageEngine = new CodexImageEngine({ executable, model: null, timeoutMs: 2000 });
        await expect(engine.run({ prompt: '화분', aspectRatio: { width: 16, height: 9 }, references: [] }, new AbortController().signal)).rejects.toMatchObject({ code: items.length === 0 ? 'CODEX_IMAGE_RESULT_COUNT' : 'CODEX_GENERATION_LIMIT' });
      } finally { await rm(root, { recursive: true, force: true }); }
    }
    const engine: CodexImageEngine = new CodexImageEngine({ executable: '/unused', model: null, timeoutMs: 2000 });
    await expect(engine.run({ prompt: '화분', aspectRatio: { width: 16, height: 9 }, references: [{ label: '손상된 참조', bytes: Buffer.from('broken'), mimeType: 'image/png' }] }, new AbortController().signal)).rejects.toMatchObject({ code: 'ASSET_CONTENT_CORRUPT' });
    await expect(engine.run({ prompt: '화분', aspectRatio: { width: 16, height: 9 }, references: Array.from({ length: MAX_IMAGE_REFERENCE_SOURCES + 1 }, () => ({ label: '참조', bytes, mimeType: 'image/png' as const })) }, new AbortController().signal)).rejects.toMatchObject({ code: 'CODEX_IMAGE_REFERENCES_LIMIT' });
  });

  it('automation_image_engine_transmits_all_eight_references_as_four_numbered_boards_with_provenance', async (): Promise<void> => {
    const root: string = await mkdtemp(join(tmpdir(), 'cutroom-image-boards-'));
    try {
      const bytes: Buffer = await testPng(160, 90); const executable: string = await imageFixture(root, [imageItem(bytes)]);
      const engine = new CodexImageEngine({ executable, model: 'fixture-model', timeoutMs: 2000 });
      const result = await engine.run({ prompt: '세 인물과 식탁의 소품', aspectRatio: { width: 16, height: 9 }, references: Array.from({ length: 8 }, (_value, index) => ({ label: `기준 ${index + 1}`, bytes, mimeType: 'image/png' as const })) }, new AbortController().signal);
      const lines: string[] = (await readFile(join(root, 'transcript.jsonl'), 'utf8')).trim().split('\n');
      const turn = lines.map((line): { method: string; params: { input: { type: string; text?: string; url?: string }[] } } => JSON.parse(line)).find((value): boolean => value.method === 'turn/start')!;
      expect(turn.params.input.filter((item): boolean => item.type === 'image')).toHaveLength(4);
      expect(result.referencePresentation?.sources.map((value): string => value.sha256)).toEqual(Array.from({ length: 8 }, (): string => sha256Bytes(bytes)));
      expect(result.referencePresentation?.sources.map((value): string => value.label)).toEqual(Array.from({ length: 8 }, (_value, index): string => `기준 ${index + 1}`));
      const prompt: string = turn.params.input[0]!.text!;
      expect(prompt).toContain('"mode":"contact-sheets"'); expect(prompt).toContain('기준 1'); expect(prompt).toContain('기준 8');
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});

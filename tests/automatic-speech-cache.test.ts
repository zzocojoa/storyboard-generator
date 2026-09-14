import { speechPronunciationEvidence } from '../src/codex/speech-pronunciation.js';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { AutomaticSpeechCache } from '../src/automation/speech-cache.js';
import type { SpeechCacheFault, SpeechCacheScope } from '../src/automation/speech-cache.js';
import type { SpeechGenerationInput, SpeechGenerationResult } from '../src/codex/speech-engine.js';
import { inspectAudioFileBytes } from '../src/domain/media-inspection.js';
import { sha256Text } from '../src/importers/integrity.js';
import { automaticPlanProject, stagedPlanSpeech } from './automatic-plan-helpers.js';
import { pcmWav } from './helpers.js';

async function cacheHarness(fault: SpeechCacheFault) {
  const root: string = await mkdtemp(join(tmpdir(), 'cutroom-speech-cache-'));
  const cache = new AutomaticSpeechCache(root, fault); await cache.initialize();
  const project = await automaticPlanProject();
  const unitId: string = stagedPlanSpeech(project).result.unitId;
  const input: SpeechGenerationInput = { unit: project.dataset.units.find((unit): boolean => unit.id === unitId)!, voice: { name: 'Yuna', rateWordsPerMinute: 180 }, sampleRate: 48000 };
  const scope: SpeechCacheScope = { runId: randomUUID(), projectId: project.projectId, settingsHash: 'a'.repeat(64) };
  const engine = { run: vi.fn(async (request: SpeechGenerationInput): Promise<SpeechGenerationResult> => {
    const bytes: Buffer = pcmWav(100, request.sampleRate, 1, 16);
    return { unitId: request.unit.id, sourceTextHash: sha256Text(request.unit.text), voice: { ...request.voice }, bytes, inspection: inspectAudioFileBytes(bytes, 'audio/wav') };
  }) };
  return { root, cache, input, scope, engine, close: async (): Promise<void> => { await rm(root, { recursive: true, force: true }); } };
}
const limit: number = 4 * 1024 * 1024;
const signal: AbortSignal = new AbortController().signal;

describe('미반영 가이드 음성 보존', (): void => {
  it('speech_pronunciation_cache_separates_readings_and_rejects_unbound_results', async (): Promise<void> => {
    const h = await cacheHarness(async (): Promise<void> => {});
    try {
      const original = await h.cache.generate(h.scope, h.input, h.engine, limit, signal);
      const pronunciation = [{ sourceText: h.input.unit.text.slice(0, 2), occurrence: 1, readAs: '무를' }];
      const input = { ...h.input, pronunciation };
      await expect(h.cache.generate(h.scope, input, h.engine, limit, signal)).rejects.toMatchObject({ code: 'SPEECH_PRONUNCIATION_MISMATCH' });
      const engine = { run: vi.fn(async (request: SpeechGenerationInput): Promise<SpeechGenerationResult> => ({ ...await h.engine.run(request), pronunciation: speechPronunciationEvidence(request.unit.text, request.pronunciation)! })) };
      const changed = await h.cache.generate(h.scope, input, engine, limit, signal);
      expect(changed.cacheEvidence?.key).not.toBe(original.cacheEvidence?.key);
      const reopened = new AutomaticSpeechCache(h.root, async (): Promise<void> => {}); await reopened.initialize();
      const restored = await reopened.generate(h.scope, input, engine, limit, signal);
      expect(restored.pronunciation).toEqual(changed.pronunciation); expect(restored.bytes).toEqual(changed.bytes);
      expect(restored.cacheEvidence?.reused).toBe(true); expect(engine.run).toHaveBeenCalledOnce();
      const plain = await reopened.generate(h.scope, h.input, engine, limit, signal);
      expect(plain.pronunciation).toBeUndefined(); expect(plain.cacheEvidence?.key).toBe(original.cacheEvidence?.key);
    } finally { await h.close(); }
  });

  it('automatic_speech_cache_reopens_verified_audio_with_original_generation_time_without_resynthesis', async (): Promise<void> => {
    const h = await cacheHarness(async (): Promise<void> => {});
    try {
      const before = structuredClone(h.input);
      const first = await h.cache.generate(h.scope, h.input, h.engine, limit, signal);
      const reopened = new AutomaticSpeechCache(h.root, async (): Promise<void> => {}); await reopened.initialize();
      const reused = await reopened.generate(h.scope, h.input, h.engine, limit, signal);
      expect(reused.bytes).toEqual(first.bytes); expect(reused.inspection).toEqual(first.inspection);
      expect(reused.cacheEvidence).toEqual({ ...first.cacheEvidence, reused: true });
      expect(first.cacheEvidence?.reused).toBe(false); expect(h.engine.run).toHaveBeenCalledTimes(1); expect(h.input).toEqual(before);
      expect(await reopened.bytes(h.scope.runId)).toBeGreaterThan(first.bytes.length);
    } finally { await h.close(); }
  });
  it('automatic_speech_cache_separates_runs_projects_source_voice_rate_and_build', async (): Promise<void> => {
    const h = await cacheHarness(async (): Promise<void> => {});
    try {
      const scopes: SpeechCacheScope[] = [h.scope, { ...h.scope, runId: randomUUID() }, { ...h.scope, projectId: 'another-story' }, { ...h.scope, settingsHash: 'b'.repeat(64) }];
      for (const scope of scopes) await h.cache.generate(scope, h.input, h.engine, limit, signal);
      const inputs: SpeechGenerationInput[] = [{ ...h.input, unit: { ...h.input.unit, text: '달라진 원문' } }, { ...h.input, voice: { ...h.input.voice, name: 'Other' } },
        { ...h.input, voice: { ...h.input.voice, rateWordsPerMinute: 160 } }, { ...h.input, sampleRate: 44100 }];
      for (const input of inputs) await h.cache.generate(h.scope, input, h.engine, limit, signal);
      expect(h.engine.run).toHaveBeenCalledTimes(8);
    } finally { await h.close(); }
  });
  it('automatic_speech_cache_recovers_complete_staging_and_publication_interruptions', async (): Promise<void> => {
    for (const point of ['after-staging', 'after-publication'] as const) {
      const h = await cacheHarness(async (at): Promise<void> => { if (at === point) throw new Error('검증용 게시 중단'); });
      try {
        await expect(h.cache.generate(h.scope, h.input, h.engine, limit, signal)).rejects.toThrow('검증용 게시 중단');
        const before: number = await h.cache.bytes(h.scope.runId);
        const reopened = new AutomaticSpeechCache(h.root, async (): Promise<void> => {}); await reopened.initialize();
        const result = await reopened.generate(h.scope, h.input, h.engine, limit, signal);
        expect(result.cacheEvidence?.reused).toBe(true); expect(h.engine.run).toHaveBeenCalledTimes(1);
        expect(await reopened.bytes(h.scope.runId)).toBe(before);
        expect(await readdir(join(h.root, 'speech', h.scope.runId))).toEqual([`${result.cacheEvidence!.key}.speech`]);
      } finally { await h.close(); }
    }
  });
  it('automatic_speech_cache_rejects_tampered_audio_and_symlinks_without_regeneration', async (): Promise<void> => {
    const h = await cacheHarness(async (): Promise<void> => {});
    try {
      const result = await h.cache.generate(h.scope, h.input, h.engine, limit, signal);
      const path: string = join(h.root, 'speech', h.scope.runId, `${result.cacheEvidence!.key}.speech`);
      const bytes: Buffer = await readFile(path); bytes[bytes.length - 1] = 1; await writeFile(path, bytes);
      await expect(h.cache.generate(h.scope, h.input, h.engine, limit, signal)).rejects.toMatchObject({ code: 'AUTOMATION_SPEECH_CACHE_CORRUPT' });
      await rm(path); await symlink(join(h.root, 'elsewhere'), path);
      await expect(h.cache.generate(h.scope, h.input, h.engine, limit, signal)).rejects.toMatchObject({ code: 'STORE_PATH_UNSAFE' });
      expect(h.engine.run).toHaveBeenCalledTimes(1);
    } finally { await h.close(); }
  });
  it('automatic_speech_cache_refuses_changed_engine_input_forged_voice_and_byte_budget', async (): Promise<void> => {
    const h = await cacheHarness(async (): Promise<void> => {});
    try {
      const original = h.engine.run.getMockImplementation()!;
      h.engine.run.mockImplementationOnce(async (input) => { input.unit.text = '변조된 대사'; return original(input); });
      await expect(h.cache.generate(h.scope, h.input, h.engine, limit, signal)).rejects.toMatchObject({ code: 'AUTOMATION_SPEECH_CACHE_BINDING' });
      h.engine.run.mockImplementationOnce(async (input) => ({ ...await original(input), voice: { name: 'Wrong', rateWordsPerMinute: 180 } }));
      await expect(h.cache.generate(h.scope, h.input, h.engine, limit, signal)).rejects.toMatchObject({ code: 'AUTOMATION_SPEECH_CACHE_BINDING' });
      await expect(h.cache.generate(h.scope, h.input, h.engine, 100, signal)).rejects.toMatchObject({ code: 'AUTOMATION_STAGING_BUDGET' });
      expect(await h.cache.bytes(h.scope.runId)).toBe(0);
    } finally { await h.close(); }
  });
  it('automatic_speech_cache_cancellation_preserves_only_completed_publication_and_serializes_generation', async (): Promise<void> => {
    const h = await cacheHarness(async (): Promise<void> => {});
    try {
      const controller = new AbortController(); const original = h.engine.run.getMockImplementation()!;
      h.engine.run.mockImplementationOnce(async (input) => { const result = await original(input); controller.abort(); return result; });
      await expect(h.cache.generate(h.scope, h.input, h.engine, limit, controller.signal)).rejects.toMatchObject({ code: 'AUTOMATION_CANCELLED' });
      expect(await h.cache.bytes(h.scope.runId)).toBe(0);
      const results = await Promise.all([h.cache.generate(h.scope, h.input, h.engine, limit, signal), h.cache.generate(h.scope, h.input, h.engine, limit, signal)]);
      expect(results.map((result) => result.cacheEvidence?.reused).sort()).toEqual([false, true]);
      expect(h.engine.run).toHaveBeenCalledTimes(2);
    } finally { await h.close(); }
  });
});

import { writeNodeFixture } from './node-process-fixture.js';
import { speechReadingText } from '../src/domain/speech-pronunciation.js';
import { lstat, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { LocalSpeechEngine } from '../src/codex/speech-engine.js';
import type { SpeechEngineOptions, SpeechGenerationInput } from '../src/codex/speech-engine.js';
import { sha256Text } from '../src/importers/integrity.js';
import { pcmWav } from './helpers.js';

type SpeechCase = 'success' | 'missing-voice' | 'failed' | 'hang' | 'wrong-rate' | 'corrupt';
const INPUT: SpeechGenerationInput = { unit: { id: 'source-voice', segmentId: 'part-1', order: 1, kind: 'DIALOGUE', text: '따옴표 " 그대로, `literal` $(literal) 유지합니다.', speakerId: null, informationIds: ['unresolved-information'], sourceRefs: [{ fileId: 'original', locator: 'line:1', originalId: null }] }, voice: { name: 'Test Voice', rateWordsPerMinute: 180 }, sampleRate: 48000 };

async function speechFixture(root: string, behavior: SpeechCase): Promise<SpeechEngineOptions> {
  const sayExecutable: string = join(root, 'say.mjs');
  const convertExecutable: string = join(root, 'convert.mjs');
  await writeNodeFixture(sayExecutable, `#!${process.execPath}
import { readFileSync, writeFileSync } from 'node:fs';
const args = process.argv.slice(2);
const behavior = ${JSON.stringify(behavior)};
if (args.join(' ') === '-v ?') { process.stdout.write(behavior === 'missing-voice' ? 'Other Voice en_US # hello\\n' : 'Test Voice ko_KR # 안녕하세요\\n'); }
else {
  writeFileSync(${JSON.stringify(join(root, 'synthesis.json'))}, JSON.stringify({ cwd: process.cwd(), pid: process.pid, args, text: readFileSync(args[args.indexOf('-f') + 1], 'utf8') }));
  if (behavior === 'hang') setInterval(() => {}, 1000);
  else if (behavior === 'failed') { process.stderr.write('synthesis failed'); process.exitCode = 7; }
  else writeFileSync(args[args.indexOf('-o') + 1], 'intermediate');
}
`);
  const wav: Buffer = behavior === 'corrupt' ? Buffer.from('not-wav') : pcmWav(1250, behavior === 'wrong-rate' ? 44100 : 48000, 1, 16);
  await writeNodeFixture(convertExecutable, `#!${process.execPath}
import { writeFileSync } from 'node:fs';
writeFileSync(process.argv.at(-1), Buffer.from(${JSON.stringify(wav.toString('base64'))}, 'base64'));
`);
  return { sayExecutable, convertExecutable, timeoutMs: 1500 };
}

async function checkSpeech(behavior: SpeechCase, check: (engine: LocalSpeechEngine, root: string) => Promise<void>): Promise<void> {
  const root: string = await mkdtemp(join(tmpdir(), 'cutroom-speech-test-'));
  try { await check(new LocalSpeechEngine(await speechFixture(root, behavior)), root); }
  finally { await rm(root, { recursive: true, force: true }); }
}

describe('Local staged guide voice', (): void => {
  it('speech_pronunciation_changes_only_selected_occurrence_and_records_actual_engine_input', async (): Promise<void> => {
    await checkSpeech('success', async (engine, root): Promise<void> => {
      const text = 'AI는 2개, AI는 3개입니다.';
      const input = { ...INPUT, unit: { ...INPUT.unit, text }, pronunciation: [{ sourceText: 'AI', occurrence: 2, readAs: '에이아이' }, { sourceText: '3개', occurrence: 1, readAs: '세 개' }] };
      const before = JSON.stringify(input); const result = await engine.run(input, new AbortController().signal);
      const recorded = JSON.parse(await readFile(join(root, 'synthesis.json'), 'utf8')) as { text: string };
      expect(recorded.text).toBe('AI는 2개, 에이아이는 세 개입니다.');
      expect(result.sourceTextHash).toBe(sha256Text(text));
      expect(result.pronunciation).toEqual({ replacements: input.pronunciation, spokenTextHash: sha256Text(recorded.text) });
      expect(JSON.stringify(input)).toBe(before);
    });
  });

  it('speech_pronunciation_rejects_missing_overlapping_empty_and_control_injection_before_synthesis', (): void => {
    const changes = [{ sourceText: 'AI', occurrence: 1, readAs: '에이아이' }];
    expect(speechReadingText('AI AI', changes)).toBe('에이아이 AI');
    expect(() => speechReadingText('AI', [{ ...changes[0]!, occurrence: 2 }])).toThrowError(expect.objectContaining({ code: 'SPEECH_PRONUNCIATION_SOURCE_MISSING' }));
    expect(() => speechReadingText('AI', [...changes, ...changes])).toThrowError(expect.objectContaining({ code: 'SPEECH_PRONUNCIATION_OVERLAP' }));
    expect(() => speechReadingText('AI', [{ ...changes[0]!, readAs: ' ' }])).toThrowError(expect.objectContaining({ code: 'SPEECH_PRONUNCIATION_EMPTY' }));
    expect(() => speechReadingText('AI', [{ ...changes[0]!, readAs: '[[rate 1]]' }])).toThrowError(expect.objectContaining({ code: 'SPEECH_CONTROL_SEQUENCE_UNSUPPORTED' }));
    expect(() => speechReadingText('[AI', [{ ...changes[0]!, readAs: '[rate 1]]' }])).toThrowError(expect.objectContaining({ code: 'SPEECH_CONTROL_SEQUENCE_UNSUPPORTED' }));
    expect(speechReadingText('🪴 AI', changes)).toBe('🪴 에이아이');
  });

  it('automation_speech_stages_exact_spoken_source_before_timeline_and_gate_decisions', async (): Promise<void> => {
    await checkSpeech('success', async (engine, root): Promise<void> => {
      const before: string = JSON.stringify(INPUT);
      const result = await engine.run(INPUT, new AbortController().signal);
      expect(result).toMatchObject({ unitId: INPUT.unit.id, sourceTextHash: sha256Text(INPUT.unit.text), voice: INPUT.voice,
        inspection: { durationMs: 1250, sampleRate: 48000, channels: 1, codec: 'pcm_s16le' } });
      expect(JSON.stringify(INPUT)).toBe(before);
      const recorded = JSON.parse(await readFile(join(root, 'synthesis.json'), 'utf8')) as { cwd: string; text: string; args: string[] };
      expect(recorded.text).toBe(INPUT.unit.text);
      expect(recorded.args).not.toContain(INPUT.unit.text);
      expect(recorded.args.slice(0, 4)).toEqual(['-v', 'Test Voice', '-r', '180']);
      await expect(lstat(recorded.cwd)).rejects.toMatchObject({ code: 'ENOENT' });
      expect(result).not.toHaveProperty('approval');
    });
  });

  it('automation_speech_rejects_uninstalled_voices_nonspoken_source_and_inline_controls', async (): Promise<void> => {
    await checkSpeech('missing-voice', async (engine, root): Promise<void> => {
      await expect(engine.run(INPUT, new AbortController().signal)).rejects.toMatchObject({ code: 'SPEECH_VOICE_NOT_INSTALLED' });
      await expect(readFile(join(root, 'synthesis.json'))).rejects.toMatchObject({ code: 'ENOENT' });
    });
    const engine: LocalSpeechEngine = new LocalSpeechEngine({ sayExecutable: '/unused', convertExecutable: '/unused', timeoutMs: 1000 });
    for (const kind of ['ACTION', 'SCREEN_TEXT', 'CHAT', 'NOTE', 'SOUND', 'MUSIC'] as const) {
      await expect(engine.run({ ...INPUT, unit: { ...INPUT.unit, kind } }, new AbortController().signal)).rejects.toMatchObject({ code: 'SPEECH_SOURCE_NOT_SPOKEN' });
    }
    await expect(engine.run({ ...INPUT, unit: { ...INPUT.unit, text: '[[rate 1]]원문' } }, new AbortController().signal)).rejects.toMatchObject({ code: 'SPEECH_CONTROL_SEQUENCE_UNSUPPORTED' });
  });

  it('automation_speech_rejects_command_failures_corrupt_audio_and_unrequested_output_rate', async (): Promise<void> => {
    for (const [behavior, code] of [['failed', 'SPEECH_COMMAND_FAILED'], ['wrong-rate', 'SPEECH_OUTPUT_FORMAT_MISMATCH'], ['corrupt', 'UNSUPPORTED_AUDIO_CONTAINER']] as const) {
      await checkSpeech(behavior, async (engine): Promise<void> => { await expect(engine.run(INPUT, new AbortController().signal)).rejects.toMatchObject({ code }); });
    }
  });

  it('automation_speech_waits_for_cancelled_process_exit_before_removing_staging', async (): Promise<void> => {
    await checkSpeech('hang', async (engine, root): Promise<void> => {
      await expect(engine.run(INPUT, new AbortController().signal)).rejects.toMatchObject({ code: 'SPEECH_GENERATION_TIMEOUT' });
      const recorded = JSON.parse(await readFile(join(root, 'synthesis.json'), 'utf8')) as { cwd: string; pid: number };
      await expect(lstat(recorded.cwd)).rejects.toMatchObject({ code: 'ENOENT' });
      expect((): void => { process.kill(recorded.pid, 0); }).toThrow();
    });
    await checkSpeech('hang', async (engine): Promise<void> => {
      const controller: AbortController = new AbortController();
      const timer: NodeJS.Timeout = setTimeout((): void => { controller.abort(); }, 250);
      try { await expect(engine.run(INPUT, controller.signal)).rejects.toMatchObject({ code: 'SPEECH_GENERATION_CANCELLED' }); }
      finally { clearTimeout(timer); }
    });
  });
});

import { speechReadingText } from '../domain/speech-pronunciation.js';
import type { SpeechPronunciation } from '../domain/speech-pronunciation.js';
import { speechPronunciationEvidence } from './speech-pronunciation.js';
import type { SpeechPronunciationEvidence } from './speech-pronunciation.js';
import { constants } from 'node:fs';
import { mkdtemp, open, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { SpeechVoiceSchema } from '../domain/speech-voice.js';
import type { SpeechVoice } from '../domain/speech-voice.js';
import { contractError } from '../domain/errors.js';
import { inspectAudioFileBytes, MAX_AUDIO_BYTES } from '../domain/media-inspection.js';
import type { InspectedAudioFile } from '../domain/media-inspection.js';
import type { SourceUnit } from '../domain/schema.js';
import { unitAudioKind } from '../domain/unit-media.js';
import { sha256Text } from '../importers/integrity.js';
import { runSpeechCommand } from './speech-command.js';
import { readInstalledSpeechVoices } from './speech-voices.js';

export type { SpeechVoice } from '../domain/speech-voice.js';
export type SpeechGenerationInput = { unit: SourceUnit; voice: SpeechVoice; sampleRate: 44100 | 48000 | 96000; pronunciation?: SpeechPronunciation };
export type SpeechCacheEvidence = { key: string; generatedAt: string; reused: boolean };
export type SpeechGenerationResult = { unitId: string; sourceTextHash: string; voice: SpeechVoice; bytes: Buffer; inspection: InspectedAudioFile; cacheEvidence?: SpeechCacheEvidence; pronunciation?: SpeechPronunciationEvidence };
export type SpeechEngineOptions = { sayExecutable: string; convertExecutable: string; timeoutMs: number };
export interface SpeechGenerationEngine { run(input: SpeechGenerationInput, signal: AbortSignal): Promise<SpeechGenerationResult> }


async function readStagedAudio(path: string): Promise<Buffer> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.size <= 0 || before.size > MAX_AUDIO_BYTES) throw contractError('SPEECH_OUTPUT_SIZE_INVALID', `가이드 음성 출력이 정규 WAV 또는 허용 크기가 아닙니다: bytes=${before.size}, maxBytes=${MAX_AUDIO_BYTES}`, []);
    const bytes: Buffer = await handle.readFile();
    const after = await handle.stat();
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || bytes.length !== after.size) throw contractError('SPEECH_OUTPUT_CHANGED', '가이드 음성 파일을 읽는 동안 내용이 바뀌었습니다.', []);
    return bytes;
  } finally { await handle.close(); }
}

/** 원문을 바꾸지 않고 임시 WAV를 측정한다. Gate·배치·승인은 이후 후보 검증에서 처리한다. */
export class LocalSpeechEngine implements SpeechGenerationEngine {
  readonly #options: SpeechEngineOptions;
  constructor(options: SpeechEngineOptions) { this.#options = { ...options }; }

  async run(input: SpeechGenerationInput, signal: AbortSignal): Promise<SpeechGenerationResult> {
    if (signal.aborted) throw contractError('SPEECH_GENERATION_CANCELLED', '시작 전에 가이드 음성 생성이 취소됐습니다.', []);
    const kind = unitAudioKind(input.unit);
    if (kind !== 'dialogue' && kind !== 'voiceover' && kind !== 'panel') throw contractError('SPEECH_SOURCE_NOT_SPOKEN', `낭독할 수 없는 원문 종류입니다: unitId=${input.unit.id}, kind=${input.unit.kind}`, []);
    const voice: SpeechVoice = SpeechVoiceSchema.parse(input.voice);
    z.literal([44100, 48000, 96000]).parse(input.sampleRate);
    if (!Number.isSafeInteger(this.#options.timeoutMs) || this.#options.timeoutMs <= 0) throw contractError('SPEECH_OPTIONS_INVALID', '음성 생성 제한 시간은 양의 정수여야 합니다.', []);
    const spoken: string = speechReadingText(input.unit.text, input.pronunciation);
    const pronunciation = speechPronunciationEvidence(input.unit.text, input.pronunciation);
    const combined: AbortSignal = AbortSignal.any([signal, AbortSignal.timeout(this.#options.timeoutMs)]);
    const root: string = await mkdtemp(join(tmpdir(), 'cutroom-speech-'));
    try {
      const installed = await readInstalledSpeechVoices(this.#options.sayExecutable, root, combined);
      if (!installed.some((entry): boolean => entry.name === voice.name)) throw contractError('SPEECH_VOICE_NOT_INSTALLED', `지정한 macOS 음성이 설치되지 않았습니다: voice=${voice.name}. 해당 음성을 설치하거나 제작 설정에서 다른 설치 음성을 선택하세요.`, []);
      const textPath: string = join(root, 'source.txt');
      const intermediatePath: string = join(root, 'guide.aiff');
      const outputPath: string = join(root, 'guide.wav');
      await writeFile(textPath, spoken, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
      await runSpeechCommand(this.#options.sayExecutable, ['-v', voice.name, '-r', String(voice.rateWordsPerMinute), '-f', textPath, '-o', intermediatePath], root, combined);
      await runSpeechCommand(this.#options.convertExecutable, ['-f', 'WAVE', '-d', `LEI16@${input.sampleRate}`, intermediatePath, outputPath], root, combined);
      const bytes: Buffer = await readStagedAudio(outputPath);
      const inspection: InspectedAudioFile = inspectAudioFileBytes(bytes, 'audio/wav');
      if (inspection.sampleRate !== input.sampleRate || inspection.codec !== 'pcm_s16le') throw contractError('SPEECH_OUTPUT_FORMAT_MISMATCH', `실제 가이드 음성 형식이 설정과 다릅니다: expected=${input.sampleRate}/pcm_s16le, actual=${inspection.sampleRate}/${inspection.codec}`, []);
      if (combined.aborted) throw contractError(signal.aborted ? 'SPEECH_GENERATION_CANCELLED' : 'SPEECH_GENERATION_TIMEOUT', '가이드 음성 결과 검사 중 실행이 중단됐습니다.', []);
      return { unitId: input.unit.id, sourceTextHash: sha256Text(input.unit.text), voice, bytes, inspection, ...(pronunciation === undefined ? {} : { pronunciation }) };
    } finally { await rm(root, { recursive: true, force: true }); }
  }
}

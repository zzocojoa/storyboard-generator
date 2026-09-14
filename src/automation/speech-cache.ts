import { assertSpeechPronunciation, SpeechPronunciationEvidenceSchema } from '../codex/speech-pronunciation.js';
import { SpeechVoiceSchema } from '../domain/speech-voice.js';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { RequestLockManager } from '../codex/request-lock.js';
import type { SpeechGenerationEngine, SpeechGenerationInput, SpeechGenerationResult } from '../codex/speech-engine.js';
import { contractError } from '../domain/errors.js';
import { inspectAudioFileBytes, MAX_AUDIO_BYTES } from '../domain/media-inspection.js';
import { HashSchema, IdSchema } from '../domain/schema.js';
import { unitAudioKind } from '../domain/unit-media.js';
import { parseJson, sha256Bytes, sha256Text } from '../importers/integrity.js';
import { stableJsonStringify } from '../io/stable-json.js';
import { SafeStoreFilesystem, sameFileIdentity } from '../server/safe-filesystem.js';
import { automaticHash } from './application-evidence.js';

const ScopeSchema = z.strictObject({ runId: z.uuid(), projectId: IdSchema, settingsHash: HashSchema });
export type SpeechCacheScope = z.infer<typeof ScopeSchema>;
export type SpeechCacheFault = (point: 'after-staging' | 'after-publication') => Promise<void>;
const HeaderSchema = z.strictObject({
  version: z.literal(1), scope: ScopeSchema, key: HashSchema, inputHash: HashSchema, generatedAt: z.iso.datetime(),
  unitId: IdSchema, sourceTextHash: HashSchema,
  voice: SpeechVoiceSchema, pronunciation: SpeechPronunciationEvidenceSchema.optional(),
  inspection: z.strictObject({ mimeType: z.literal('audio/wav'), durationMs: z.number().int().positive(), sampleRate: z.literal([44100, 48000, 96000]),
    channels: z.literal([1, 2]), codec: z.literal('pcm_s16le'), sha256: HashSchema }),
});
type SpeechCacheHeader = z.infer<typeof HeaderSchema>;
const HEADER_LIMIT: number = 16 * 1024;
const CACHE_FILE_LIMIT: number = MAX_AUDIO_BYTES + HEADER_LIMIT + 40;
const CACHE_ENTRY_LIMIT: number = 16384;

function cancelled(signal: AbortSignal): void {
  if (signal.aborted) throw contractError('AUTOMATION_CANCELLED', '가이드 음성 준비가 중단되었습니다. 저장을 마친 음성은 재개 시 다시 검사합니다.', []);
}

function requireResult(input: SpeechGenerationInput, result: SpeechGenerationResult): void {
  assertSpeechPronunciation(input.unit.text, input.pronunciation, result.pronunciation);
  const kind = unitAudioKind(input.unit);
  const inspection = inspectAudioFileBytes(result.bytes, 'audio/wav');
  if (!['dialogue', 'voiceover', 'panel'].includes(kind ?? '') || result.unitId !== input.unit.id || result.sourceTextHash !== sha256Text(input.unit.text)
    || automaticHash(result.voice) !== automaticHash(input.voice) || automaticHash(inspection) !== automaticHash(result.inspection)
    || inspection.sampleRate !== input.sampleRate || inspection.codec !== 'pcm_s16le') {
    throw contractError('AUTOMATION_SPEECH_CACHE_BINDING', `가이드 음성의 원문·음성 설정·실제 WAV가 요청과 다릅니다: unitId=${input.unit.id}`, []);
  }
}

function pack(header: SpeechCacheHeader, bytes: Buffer): Buffer {
  const json: Buffer = Buffer.from(stableJsonStringify(HeaderSchema.parse(header)));
  if (json.length > HEADER_LIMIT) throw contractError('AUTOMATION_SPEECH_CACHE_HEADER', '가이드 음성 저장 근거가 16KB를 초과했습니다.', []);
  const prefix: Buffer = Buffer.alloc(8); prefix.write('CRSP', 0, 'ascii'); prefix.writeUInt32BE(json.length, 4);
  const payload: Buffer = Buffer.concat([prefix, json, bytes]);
  return Buffer.concat([payload, Buffer.from(sha256Bytes(payload), 'hex')]);
}

function unpack(content: Buffer, scope: SpeechCacheScope, input: SpeechGenerationInput, key: string): SpeechGenerationResult {
  if (content.length < 41 || content.toString('ascii', 0, 4) !== 'CRSP'
    || sha256Bytes(content.subarray(0, -32)) !== content.subarray(-32).toString('hex')) throw contractError('AUTOMATION_SPEECH_CACHE_CORRUPT', `가이드 음성 저장 형식 또는 전체 해시가 손상됐습니다: key=${key}`, []);
  const length: number = content.readUInt32BE(4);
  if (length === 0 || length > HEADER_LIMIT || length + 40 >= content.length) throw contractError('AUTOMATION_SPEECH_CACHE_CORRUPT', `가이드 음성 근거 길이가 잘못됐습니다: key=${key}`, []);
  const header = HeaderSchema.parse(parseJson(content.toString('utf8', 8, 8 + length), `speech-cache:${key}`));
  if (header.key !== key || header.inputHash !== automaticHash(input) || automaticHash(header.scope) !== automaticHash(scope)) {
    throw contractError('AUTOMATION_SPEECH_CACHE_BINDING', `다른 실행·프로젝트·입력의 가이드 음성입니다: key=${key}`, []);
  }
  const result: SpeechGenerationResult = { unitId: header.unitId, sourceTextHash: header.sourceTextHash, voice: header.voice,
    inspection: header.inspection, ...(header.pronunciation === undefined ? {} : { pronunciation: header.pronunciation }), bytes: Buffer.from(content.subarray(8 + length, -32)), cacheEvidence: { key, generatedAt: header.generatedAt, reused: true } };
  requireResult(input, result);
  return result;
}

/** 미반영 음성을 실행별로 보존한다. 중단된 완성 파일만 복구하며 손상 파일을 재합성으로 숨기지 않는다. */
export class AutomaticSpeechCache {
  readonly #fs: SafeStoreFilesystem;
  readonly #locks: RequestLockManager;
  readonly #fault: SpeechCacheFault;

  constructor(root: string, fault: SpeechCacheFault) {
    this.#fs = new SafeStoreFilesystem(root); this.#fault = fault;
    this.#locks = new RequestLockManager(this.#fs, async (_original, assertOwnership): Promise<void> => { await assertOwnership(); });
  }
  async initialize(): Promise<void> {
    await this.#fs.initialize();
    for (const name of ['.locks', '.recovery-claims', 'speech']) await this.#fs.ensureDirectory(this.#fs.path(name));
  }
  async bytes(runId: string): Promise<number> {
    z.uuid().parse(runId);
    const path = this.#fs.path('speech', runId);
    if (await this.#fs.kind(path) === 'missing') return 0;
    const entries = await this.#fs.entries(path);
    if (entries.length > CACHE_ENTRY_LIMIT) throw contractError('AUTOMATION_SPEECH_CACHE_LIMIT', `저장 음성 파일 수 한도를 초과했습니다: runId=${runId}`, []);
    const identities: Set<string> = new Set();
    let total: number = 0;
    for (const entry of entries) {
      if (!/^(?:[a-f0-9]{64}\.speech|\.[a-f0-9]{64}\.[a-f0-9-]{36}\.pending)$/u.test(entry.name)) throw contractError('AUTOMATION_SPEECH_CACHE_UNEXPECTED_FILE', `알 수 없는 음성 저장 파일을 보존합니다: runId=${runId}, file=${entry.name}`, []);
      const metadata = await this.#fs.fileMetadata(this.#fs.path('speech', runId, entry.name));
      if (metadata.size <= 0 || metadata.size > CACHE_FILE_LIMIT) throw contractError('AUTOMATION_SPEECH_CACHE_LIMIT', `음성 저장 파일 크기가 잘못됐습니다: file=${entry.name}, bytes=${metadata.size}`, []);
      const identity: string = `${metadata.dev}:${metadata.ino}`;
      if (!identities.has(identity)) { identities.add(identity); total += metadata.size; }
    }
    return total;
  }
  async generate(scopeInput: SpeechCacheScope, inputValue: SpeechGenerationInput, engine: SpeechGenerationEngine, maxBytes: number, signal: AbortSignal): Promise<SpeechGenerationResult> {
    const scope: SpeechCacheScope = ScopeSchema.parse(scopeInput);
    const input: SpeechGenerationInput = structuredClone(inputValue);
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) throw contractError('AUTOMATION_STAGING_BUDGET', '음성 준비 파일의 잔여 바이트 한도가 잘못됐습니다.', []);
    cancelled(signal);
    const key: string = automaticHash({ scope, inputHash: automaticHash(input) });
    const directory = this.#fs.path('speech', scope.runId);
    const path = this.#fs.path('speech', scope.runId, `${key}.speech`);
    const lock = await this.#locks.acquire(sha256Text(`speech:${scope.runId}`));
    try {
      cancelled(signal); await this.#fs.ensureDirectory(directory);
      const used: number = await this.bytes(scope.runId);
      if (used > maxBytes) throw contractError('AUTOMATION_STAGING_BUDGET', `기존 음성 준비 파일이 잔여 한도를 초과했습니다: bytes=${used}, maxBytes=${maxBytes}`, []);
      const pending = (await this.#fs.entries(directory)).filter((entry): boolean => entry.name.startsWith(`.${key}.`) && entry.name.endsWith('.pending'));
      if (pending.length > 1) throw contractError('AUTOMATION_SPEECH_CACHE_AMBIGUOUS', `같은 음성의 중단 파일이 여러 개입니다. 파일을 보존하고 점검하세요: key=${key}`, []);
      const stage = pending[0] === undefined ? null : this.#fs.path('speech', scope.runId, pending[0].name);
      const exists = await this.#fs.exists(path);
      if (stage !== null) {
        unpack(await this.#fs.readBounded(stage, CACHE_FILE_LIMIT), scope, input, key);
        const identity = await this.#fs.identity(stage);
        if (exists && !sameFileIdentity(identity, await this.#fs.identity(path))) throw contractError('AUTOMATION_SPEECH_CACHE_AMBIGUOUS', `게시 파일과 중단 파일의 소유권이 다릅니다: key=${key}`, []);
        if (!exists) { await this.#locks.verify(lock); await this.#fs.syncFile(stage, identity); await this.#fs.hardLink(stage, path); await this.#fs.syncDirectory(directory); }
        await this.#fs.unlinkFile(stage, identity); await this.#fs.syncDirectory(directory);
      }
      if (exists || stage !== null) { cancelled(signal); return unpack(await this.#fs.readBounded(path, CACHE_FILE_LIMIT), scope, input, key); }
      if ((await this.#fs.entries(directory)).length >= CACHE_ENTRY_LIMIT - 1 || used >= maxBytes) throw contractError('AUTOMATION_STAGING_BUDGET', '가이드 음성을 추가할 파일 수 또는 바이트 한도가 없습니다.', []);
      const generatedAt: string = new Date().toISOString();
      const result: SpeechGenerationResult = await engine.run(structuredClone(input), signal);
      cancelled(signal); requireResult(input, result);
      const content: Buffer = pack({ version: 1, scope, key, inputHash: automaticHash(input), generatedAt, unitId: result.unitId,
        sourceTextHash: result.sourceTextHash, voice: result.voice, ...(result.pronunciation === undefined ? {} : { pronunciation: result.pronunciation }), inspection: HeaderSchema.shape.inspection.parse(result.inspection) }, result.bytes);
      if (used + content.length > maxBytes) throw contractError('AUTOMATION_STAGING_BUDGET', `가이드 음성 준비 파일이 잔여 한도를 초과합니다: used=${used}, incoming=${content.length}, maxBytes=${maxBytes}`, []);
      await this.#locks.verify(lock); cancelled(signal);
      const temporary = this.#fs.path('speech', scope.runId, `.${key}.${randomUUID()}.pending`);
      const identity = await this.#fs.writeExclusiveWithIdentity(temporary, content);
      await this.#fs.syncDirectory(directory); await this.#fault('after-staging');
      await this.#locks.verify(lock);
      await this.#fs.hardLink(temporary, path); await this.#fs.syncDirectory(directory); await this.#fault('after-publication');
      await this.#fs.unlinkFile(temporary, identity); await this.#fs.syncDirectory(directory);
      cancelled(signal);
      const saved = unpack(await this.#fs.readBounded(path, CACHE_FILE_LIMIT), scope, input, key);
      return { ...saved, cacheEvidence: { key, generatedAt, reused: false } };
    } finally { await this.#locks.release(lock); }
  }
}

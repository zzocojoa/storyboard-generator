import { readFile } from 'node:fs/promises';
import { runtimeGenerationConfigHash } from '../build-fingerprint.js';
import type { AudioNormalizer } from '../domain/audio-normalizer.js';
import { contractError } from '../domain/errors.js';
import { applyGeneratedImage, applyGeneratedProposal, applyGeneratedSpeech } from '../domain/media.js';
import type { GeneratedMutation } from '../domain/media.js';
import type { GeneratorBuildProvenance, Project } from '../domain/schema.js';
import { parseJson, sha256Bytes } from '../importers/integrity.js';
import { SegmentProposalSchema } from '../proposal/model.js';
import type { ProjectStore } from '../server/store.js';
import { applyHash } from './apply-evidence.js';
import { requestErrorCode } from './request-lock.js';
import type { CodexRequestStore } from './requests.js';
import type { CodexRequest } from './schema.js';
import { buildCodexWork } from './work.js';

/** 한 번 읽은 입력 바이트를 적용과 재시도 비교에서 공유한다. Commit 복구에서만 입력 파일 부재를 허용한다. */
function resultInput(path: string): () => Promise<Buffer | null> {
  let content: Promise<Buffer | null> | undefined;
  return (): Promise<Buffer | null> => {
    content ??= readFile(path).catch((error: unknown): null => {
      if (requestErrorCode(error) === 'ENOENT') return null;
      throw error;
    });
    return content;
  };
}
function requireInput(bytes: Buffer | null, path: string): Buffer {
  if (bytes === null) throw contractError('CODEX_RESULT_INPUT_NOT_FOUND', `적용 전 생성 결과 파일이 필요합니다. path=${path}`, []);
  return bytes;
}
function proposalHash(bytes: Buffer, path: string): string {
  return applyHash(SegmentProposalSchema.parse(parseJson(bytes.toString('utf8'), path)));
}

export async function applyCodexProposal(
  requestId: string, inputPath: string, store: ProjectStore, requests: CodexRequestStore, now: string,
): Promise<Project> {
  const input = resultInput(inputPath);
  return requests.applyResult(requestId, 'proposal', store, now, async (request: CodexRequest, project: Project): Promise<{ mutation: GeneratedMutation; resultSha256: string }> => {
    const work = await buildCodexWork(request, project, store, requests.buildManifest());
    if (work.kind !== 'proposal') throw contractError('CODEX_REQUEST_KIND_MISMATCH', `${request.id}: 컷 제안 작업이 아닙니다.`, []);
    const bytes: Buffer = requireInput(await input(), inputPath);
    const mutation: GeneratedMutation = applyGeneratedProposal(project, request.targetId, `codex:${request.id}`, request.createdAt, {
      generatorBuild: request.generatorBuild as GeneratorBuildProvenance, proposal: SegmentProposalSchema.parse(parseJson(bytes.toString('utf8'), inputPath)),
      provider: 'codex-app', prompt: work.prompt, model: 'codex-app-current-model', requestId: request.id,
    });
    return { mutation, resultSha256: proposalHash(bytes, inputPath) };
  }, async (): Promise<string | null> => { const bytes: Buffer | null = await input(); return bytes === null ? null : proposalHash(bytes, inputPath); });
}

export async function applyCodexImage(
  requestId: string, inputPath: string, store: ProjectStore, requests: CodexRequestStore, now: string,
): Promise<Project> {
  const input = resultInput(inputPath);
  return requests.applyResult(requestId, 'image', store, now, async (request: CodexRequest, project: Project): Promise<{ mutation: GeneratedMutation; resultSha256: string }> => {
    const work = await buildCodexWork(request, project, store, requests.buildManifest());
    if (work.kind !== 'image') throw contractError('CODEX_REQUEST_KIND_MISMATCH', `${request.id}: 이미지 작업이 아닙니다.`, []);
    const bytes: Buffer = requireInput(await input(), inputPath);
    const mutation: GeneratedMutation = await applyGeneratedImage(project, request.targetId, `codex:${request.id}`, request.createdAt, {
      generatorBuild: request.generatorBuild as GeneratorBuildProvenance, bytes, provider: 'codex-app', prompt: work.prompt,
      model: 'codex-imagegen', requestId: request.id, mimeType: 'image/png',
      referenceHashes: [...new Set(work.references.map((reference): string => reference.sha256))],
    });
    return { mutation, resultSha256: sha256Bytes(bytes) };
  }, async (): Promise<string | null> => { const bytes: Buffer | null = await input(); return bytes === null ? null : sha256Bytes(bytes); });
}

export async function applyCodexSpeech(
  requestId: string, inputPath: string, voice: string, store: ProjectStore, requests: CodexRequestStore, now: string,
  normalizer: AudioNormalizer,
): Promise<Project> {
  const input = resultInput(inputPath);
  return requests.applyResult(requestId, 'speech', store, now, async (request: CodexRequest, project: Project): Promise<{ mutation: GeneratedMutation; resultSha256: string }> => {
    if (requests.buildManifest().runtimeGenerationConfigSha256 !== runtimeGenerationConfigHash(voice)) throw contractError('CODEX_REQUEST_BUILD_CHANGED', '음성 등록 Voice와 요청 실행 Build의 음성 설정이 다릅니다.', []);
    const work = await buildCodexWork(request, project, store, requests.buildManifest());
    if (work.kind !== 'speech') throw contractError('CODEX_REQUEST_KIND_MISMATCH', `${request.id}: 음성 작업이 아닙니다.`, []);
    const bytes: Buffer = requireInput(await input(), inputPath);
    const mutation: GeneratedMutation = await applyGeneratedSpeech(project, request.targetId, `codex:${request.id}`, request.createdAt, {
      generatorBuild: request.generatorBuild as GeneratorBuildProvenance, bytes, provider: 'codex-app', prompt: work.prompt,
      model: `macos-say:${voice}`, requestId: request.id, mimeType: 'audio/wav',
    }, normalizer);
    return { mutation, resultSha256: applyHash({ sha256: sha256Bytes(bytes), voice }) };
  }, async (): Promise<string | null> => { const bytes: Buffer | null = await input(); return bytes === null ? null : applyHash({ sha256: sha256Bytes(bytes), voice }); });
}

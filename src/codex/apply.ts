import { readFile } from 'node:fs/promises';
import type { AudioNormalizer } from '../domain/audio-normalizer.js';
import { contractError } from '../domain/errors.js';
import { applyGeneratedImage, applyGeneratedProposal, applyGeneratedSpeech } from '../domain/media.js';
import type { GenerationRecord, Project } from '../domain/schema.js';
import { parseJson } from '../importers/integrity.js';
import { readUtf8 } from '../io/package.js';
import { SegmentProposalSchema } from '../proposal/model.js';
import type { GeneratedMutation } from '../domain/media.js';
import type { ProjectStore } from '../server/store.js';
import type { CodexRequestStore } from './requests.js';
import type { CodexRequest, CodexRequestKind, GeneratedImage, GeneratedSpeech, ProposedSegment } from './schema.js';
import type { CodexWork, ImageWork, ProposalWork, SpeechWork } from './work.js';
import { buildCodexWork } from './work.js';

function generationId(requestId: string): string {
  return `codex:${requestId}`;
}

function requirePendingKind(request: CodexRequest, kind: CodexRequestKind): void {
  if (request.status !== 'pending') throw contractError('CODEX_REQUEST_SETTLED', `${request.id}: 이미 ${request.status} 상태인 요청입니다.`, []);
  if (request.kind !== kind) throw contractError('CODEX_REQUEST_KIND_MISMATCH', `${request.id}: ${kind} 결과를 ${request.kind} 요청에 적용할 수 없습니다.`, []);
}

async function alreadyApplied(request: CodexRequest, project: Project, requests: CodexRequestStore, now: string): Promise<Project | null> {
  const record: GenerationRecord | undefined = project.generationRecords.find((candidate: GenerationRecord): boolean => candidate.id === generationId(request.id));
  if (record === undefined) return null;
  await requests.complete(request.id, project.revision, now);
  return project;
}

async function applyMutation(
  request: CodexRequest, mutation: GeneratedMutation, store: ProjectStore, requests: CodexRequestStore, expectedRevision: number, now: string,
): Promise<Project> {
  const writes = mutation.relativePath === null || mutation.content === null ? [] : [{ relativePath: mutation.relativePath, content: mutation.content }];
  const project: Project = await store.update(request.projectId, expectedRevision, (): Project => mutation.project, writes);
  await requests.complete(request.id, project.revision, now);
  return project;
}

export async function applyCodexProposal(
  requestId: string, inputPath: string, store: ProjectStore, requests: CodexRequestStore, now: string,
): Promise<Project> {
  const request: CodexRequest = await requests.read(requestId);
  requirePendingKind(request, 'proposal');
  const project: Project = await store.read(request.projectId);
  const prior: Project | null = await alreadyApplied(request, project, requests, now);
  if (prior !== null) return prior;
  const work: CodexWork = await buildCodexWork(request, project, store);
  if (work.kind !== 'proposal') throw contractError('CODEX_REQUEST_KIND_MISMATCH', `${request.id}: 컷 제안 작업이 아닙니다.`, []);
  const proposalWork: ProposalWork = work;
  const result: ProposedSegment = { proposal: SegmentProposalSchema.parse(parseJson(await readUtf8(inputPath), inputPath)), provider: 'codex-app',
    prompt: proposalWork.prompt, model: 'codex-app-current-model', requestId: request.id };
  const mutation: GeneratedMutation = applyGeneratedProposal(project, request.targetId, generationId(request.id), request.createdAt, result);
  return applyMutation(request, mutation, store, requests, project.revision, now);
}

export async function applyCodexImage(
  requestId: string, inputPath: string, store: ProjectStore, requests: CodexRequestStore, now: string,
): Promise<Project> {
  const request: CodexRequest = await requests.read(requestId);
  requirePendingKind(request, 'image');
  const project: Project = await store.read(request.projectId);
  const prior: Project | null = await alreadyApplied(request, project, requests, now);
  if (prior !== null) return prior;
  const work: CodexWork = await buildCodexWork(request, project, store);
  if (work.kind !== 'image') throw contractError('CODEX_REQUEST_KIND_MISMATCH', `${request.id}: 이미지 작업이 아닙니다.`, []);
  const imageWork: ImageWork = work;
  const result: GeneratedImage = { bytes: await readFile(inputPath), provider: 'codex-app', prompt: imageWork.prompt,
    model: 'codex-imagegen', requestId: request.id, mimeType: 'image/png', referenceHashes: imageWork.references.map((reference): string => reference.sha256) };
  const mutation: GeneratedMutation = await applyGeneratedImage(project, request.targetId, generationId(request.id), request.createdAt, result);
  return applyMutation(request, mutation, store, requests, project.revision, now);
}

export async function applyCodexSpeech(
  requestId: string, inputPath: string, voice: string, store: ProjectStore, requests: CodexRequestStore, now: string,
  normalizer: AudioNormalizer,
): Promise<Project> {
  const request: CodexRequest = await requests.read(requestId);
  requirePendingKind(request, 'speech');
  const project: Project = await store.read(request.projectId);
  const prior: Project | null = await alreadyApplied(request, project, requests, now);
  if (prior !== null) return prior;
  const work: CodexWork = await buildCodexWork(request, project, store);
  if (work.kind !== 'speech') throw contractError('CODEX_REQUEST_KIND_MISMATCH', `${request.id}: 음성 작업이 아닙니다.`, []);
  const speechWork: SpeechWork = work;
  const result: GeneratedSpeech = { bytes: await readFile(inputPath), provider: 'codex-app', prompt: speechWork.prompt,
    model: `macos-say:${voice}`, requestId: request.id, mimeType: 'audio/wav' };
  const mutation: GeneratedMutation = await applyGeneratedSpeech(project, request.targetId, generationId(request.id), request.createdAt, result, normalizer);
  return applyMutation(request, mutation, store, requests, project.revision, now);
}

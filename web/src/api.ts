import { z } from 'zod';
import { ProjectSchema } from '../../src/domain/schema.js';
import type { Project } from '../../src/domain/schema.js';

const RequestFailureSchema = z.strictObject({ id: z.uuid(), kind: z.enum(['proposal', 'image', 'speech']), projectId: z.string(), targetId: z.string(),
  error: z.strictObject({ code: z.string(), message: z.string() }).nullable() });
const StorageRecoverySchema = z.strictObject({ projectId: z.string(), transactionId: z.string(),
  outcome: z.enum(['committed', 'rolled-back', 'restored-previous', 'staging-removed', 'stale-lock-removed',
    'create-committed', 'create-rolled-back', 'create-superseded', 'root-create-lock-removed']) });
const StorageRecoveryBlockSchema = z.strictObject({ version: z.literal(1), projectId: z.string(), directoryName: z.string(),
  transactionId: z.string(), code: z.string(), message: z.string(), detectedAt: z.string() });
const StatusSchema = z.strictObject({ provider: z.literal('codex-app'), totalRequests: z.number().int().nonnegative(), completedRequests: z.number().int().nonnegative(),
  pendingRequests: z.number().int().nonnegative(), failedRequests: z.number().int().nonnegative(), repeatedRequests: z.number().int().nonnegative(),
  averageLatencyMs: z.number().int().nonnegative().nullable(), maximumLatencyMs: z.number().int().nonnegative().nullable(), apiCostUsd: z.null(), costNote: z.string(),
  recentFailures: z.array(RequestFailureSchema), generationInstruction: z.string(), aiVoiceDisclosure: z.string(),
  storageRecovery: z.array(StorageRecoverySchema), storageRecoveryBlocks: z.array(StorageRecoveryBlockSchema) });
const SummarySchema = z.strictObject({ projectId: z.string(), title: z.string(), revision: z.number(), durationMs: z.number(), shots: z.number(),
  framesWithAsset: z.number(), framesAccepted: z.number(), framesOutputSafe: z.number(), framesTotal: z.number(),
  audioWithAsset: z.number(), audioMeasured: z.number(), audioPlayable: z.number(), audioRepairRequired: z.number(), audioTotal: z.number(),
  textPlayable: z.number(), textTotal: z.number(), blockedOutputCount: z.number(), issues: z.number(), updatedAt: z.string() });
const CodexRequestSchema = z.strictObject({ id: z.uuid(), kind: z.enum(['proposal', 'image', 'speech']), projectId: z.string(), targetId: z.string(),
  basisHash: z.string(), status: z.enum(['pending', 'completed', 'failed']), createdAt: z.string(), updatedAt: z.string(), resultRevision: z.number().nullable(),
  error: z.strictObject({ code: z.string(), message: z.string() }).nullable() });
const SourceImpactSchema = z.strictObject({ changedSourceFileIds: z.array(z.string()), changedEntityIds: z.array(z.string()), impactedSegmentIds: z.array(z.string()),
  impactedShotIds: z.array(z.string()), lockedShotIds: z.array(z.string()), canApply: z.boolean() });

export type AppStatus = z.infer<typeof StatusSchema>;
export type ProjectSummary = z.infer<typeof SummarySchema>;
export type CodexRequest = z.infer<typeof CodexRequestSchema>;
export type SourceImpact = z.infer<typeof SourceImpactSchema>;
export type ApiErrorCategory = 'validation' | 'not-found' | 'conflict' | 'locked' | 'unavailable' | 'internal';

const ErrorResponseSchema = z.strictObject({ error: z.strictObject({
  code: z.string(), message: z.string(), issues: z.array(z.unknown()),
  category: z.enum(['validation', 'not-found', 'conflict', 'locked', 'unavailable', 'internal']),
  retryable: z.boolean(), operatorActionRequired: z.boolean(),
}) });

export class ApiError extends Error {
  readonly code: string;
  readonly status: number;
  readonly category: ApiErrorCategory;
  readonly retryable: boolean;
  readonly operatorActionRequired: boolean;
  readonly issues: readonly unknown[];
  constructor(code: string, message: string, status: number, category: ApiErrorCategory, retryable: boolean,
    operatorActionRequired: boolean, issues: readonly unknown[]) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
    this.category = category;
    this.retryable = retryable;
    this.operatorActionRequired = operatorActionRequired;
    this.issues = [...issues];
  }
}

export function apiErrorMessage(error: unknown): string {
  if (!(error instanceof ApiError)) return error instanceof Error ? error.message : String(error);
  if (error.code === 'PROJECT_BUSY') return '프로젝트 생성 또는 다른 작업이 진행 중입니다. 완료 후 다시 불러오거나 재시도하세요.';
  if (error.code === 'PROJECT_ALREADY_EXISTS') return '같은 Project가 이미 저장돼 있습니다.';
  if (error.category === 'locked') return `STORAGE RECOVERY REQUIRED\n해당 Project는 저장소 복구 전 변경할 수 없습니다.\n${error.message}`;
  if (error.category === 'unavailable') return `STORAGE TEMPORARILY UNAVAILABLE\n잠시 후 다시 시도하세요.\n${error.message}`;
  if (error.category === 'conflict') return `다른 작업이 진행 중이거나 Revision이 변경됐습니다. Project를 다시 불러온 후 재시도하세요.\n${error.message}`;
  if (error.category === 'validation') return `입력 또는 편집 조건을 수정하세요.\n${error.message}`;
  return error.message;
}

export function isStorageRecoveryError(error: unknown): boolean {
  return error instanceof ApiError && error.category === 'locked' && error.operatorActionRequired;
}

export function shouldRetryApiError(error: unknown): boolean {
  return error instanceof ApiError && error.retryable && error.category !== 'locked';
}

async function request(path: string, init: RequestInit): Promise<unknown> {
  const response: Response = await fetch(path, init);
  const data: unknown = await response.json();
  if (!response.ok) {
    const parsed = ErrorResponseSchema.safeParse(data);
    if (parsed.success) throw new ApiError(parsed.data.error.code, parsed.data.error.message, response.status,
      parsed.data.error.category, parsed.data.error.retryable, parsed.data.error.operatorActionRequired, parsed.data.error.issues);
    throw new ApiError(`HTTP_${response.status}`, `요청이 실패했습니다. status=${response.status}`, response.status,
      response.status === 404 ? 'not-found' : response.status === 409 ? 'conflict' : response.status === 423 ? 'locked'
        : response.status === 503 ? 'unavailable' : response.status >= 500 ? 'internal' : 'validation',
      response.status === 409 || response.status === 503, response.status === 423, []);
  }
  return data;
}

function json(method: string, body: unknown): RequestInit {
  return { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}

export async function fetchStatus(): Promise<AppStatus> {
  return StatusSchema.parse(await request('/api/status', {}));
}

export async function listProjects(): Promise<ProjectSummary[]> {
  return z.strictObject({ projects: z.array(SummarySchema) }).parse(await request('/api/projects', {})).projects;
}

export async function fetchProject(projectId: string): Promise<Project> {
  return z.strictObject({ project: ProjectSchema }).parse(await request(`/api/projects/${encodeURIComponent(projectId)}`, {})).project;
}

export async function importProject(handoffPath: string, proposedTextHoldMs: number): Promise<Project> {
  return z.strictObject({ project: ProjectSchema }).parse(await request('/api/projects/import', json('POST', { handoffPath, proposedTextHoldMs }))).project;
}

export async function mutateProject(projectId: string, path: string, method: 'DELETE' | 'PATCH' | 'POST', body: unknown): Promise<Project> {
  return z.strictObject({ project: ProjectSchema }).parse(await request(`/api/projects/${encodeURIComponent(projectId)}${path}`, json(method, body))).project;
}

export async function uploadAudioAsset(projectId: string, cueId: string, expectedRevision: number, file: File): Promise<Project> {
  const form: FormData = new FormData();
  form.append('expectedRevision', String(expectedRevision));
  form.append('file', file, file.name);
  const data: unknown = await request(`/api/projects/${encodeURIComponent(projectId)}/audio/${encodeURIComponent(cueId)}/asset`, { method: 'POST', body: form });
  return z.strictObject({ project: ProjectSchema, audio: z.strictObject({ durationMs: z.number(), sampleRate: z.number(), channels: z.number(), codec: z.string(), sha256: z.string() }) }).parse(data).project;
}

export async function normalizeAudioAsset(projectId: string, cueId: string, expectedRevision: number): Promise<Project> {
  const data: unknown = await request(`/api/projects/${encodeURIComponent(projectId)}/audio/${encodeURIComponent(cueId)}/normalize`, json('POST', { expectedRevision }));
  return z.strictObject({ project: ProjectSchema, audio: z.strictObject({ durationMs: z.number(), sampleRate: z.number(), channels: z.number(), codec: z.string(), sha256: z.string() }),
    replacedAssetId: z.string() }).parse(data).project;
}

export async function queueCodexRequest(projectId: string, path: string, expectedRevision: number): Promise<CodexRequest> {
  return z.strictObject({ request: CodexRequestSchema }).parse(await request(`/api/projects/${encodeURIComponent(projectId)}${path}`, json('POST', { expectedRevision }))).request;
}

export async function previewSourceUpdate(projectId: string, handoffPath: string, proposedTextHoldMs: number, expectedRevision: number): Promise<SourceImpact> {
  const data: unknown = await request(`/api/projects/${encodeURIComponent(projectId)}/source-impact`, json('POST', { handoffPath, proposedTextHoldMs, expectedRevision }));
  return z.strictObject({ impact: SourceImpactSchema }).parse(data).impact;
}

export async function updateProjectSource(projectId: string, handoffPath: string, proposedTextHoldMs: number, expectedRevision: number): Promise<Project> {
  const data: unknown = await request(`/api/projects/${encodeURIComponent(projectId)}/source-update`, json('POST', { handoffPath, proposedTextHoldMs, expectedRevision }));
  return z.strictObject({ project: ProjectSchema }).parse(data).project;
}

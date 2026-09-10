import { CodexRequestSchema } from '../../src/codex/request-schema.js';
import { ApplyStatusSchema } from '../../src/codex/apply-schema.js';
import { BuildManifestSchema } from '../../src/build-schema.js';
import { z } from 'zod';
import { DocumentPreviewSchema } from '../../src/documents/schema.js';
import type { DocumentBindings, DocumentPreview, DocumentSettings } from '../../src/documents/schema.js';
import type { DocumentReviewInput } from '../../src/documents/review-input.js';
import { ProductionPresetSchema, ReviewRuntimeStatusSchema, ReviewStateSchema } from '../../src/documents/review-model.js';
import type { ProductionFields, ProductionPreset, ReviewRuntimeStatus, ReviewState } from '../../src/documents/review-model.js';
import { IssueSchema, ProjectSchema } from '../../src/domain/schema.js';
import type { FinalReadinessReport } from '../../src/domain/final-readiness.js';
import type { Project } from '../../src/domain/schema.js';

const RequestFailureSchema = z.strictObject({ id: z.uuid(), kind: z.enum(['proposal', 'image', 'speech']), projectId: z.string(), targetId: z.string(),
  error: z.strictObject({ code: z.string(), message: z.string() }).nullable() });
const StorageRecoverySchema = z.strictObject({ projectId: z.string(), transactionId: z.string(),
  outcome: z.enum(['committed', 'rolled-back', 'restored-previous', 'staging-removed', 'stale-lock-removed',
    'create-committed', 'create-rolled-back', 'create-superseded', 'root-create-lock-removed']) });
const StorageRecoveryBlockSchema = z.strictObject({ version: z.literal(1), projectId: z.string(), directoryName: z.string(),
  transactionId: z.string(), code: z.string(), message: z.string(), detectedAt: z.string() });
const ActiveStorageSchema = z.strictObject({ projectId: z.string(), transactionId: z.string(), host: z.string(), pid: z.number().int().positive(),
  processInstanceId: z.string().nullable(), detectedAt: z.string() });
const InvalidRecoveryMarkerSchema = z.strictObject({ fileName: z.string(), quarantinedPath: z.string(), code: z.string(), message: z.string(), detectedAt: z.string() });
const ProcessHeartbeatSchema = z.strictObject({ processInstanceId: z.string(), healthy: z.boolean(), lastSuccessAt: z.string().nullable(),
  lastError: z.strictObject({ code: z.string(), message: z.string() }).nullable() });
const StatusSchema = z.strictObject({ build: BuildManifestSchema, provider: z.literal('codex-app'), totalRequests: z.number().int().nonnegative(), completedRequests: z.number().int().nonnegative(),
  pendingRequests: z.number().int().nonnegative(), applyingRequests: z.number().int().nonnegative(), applyRecovery: z.array(ApplyStatusSchema), supersededRequests: z.number().int().nonnegative(), failedRequests: z.number().int().nonnegative(), repeatedRequests: z.number().int().nonnegative(),
  averageLatencyMs: z.number().int().nonnegative().nullable(), maximumLatencyMs: z.number().int().nonnegative().nullable(), apiCostUsd: z.null(), costNote: z.string(),
  recentFailures: z.array(RequestFailureSchema), generationInstruction: z.string(), aiVoiceDisclosure: z.string(),
  storageRecovery: z.array(StorageRecoverySchema), storageRecoveryBlocks: z.array(StorageRecoveryBlockSchema),
  invalidRecoveryMarkers: z.array(InvalidRecoveryMarkerSchema), processHeartbeat: ProcessHeartbeatSchema,
  activeUpdateErrors: z.array(z.strictObject({ projectId: z.string(), transactionId: z.string(), code: z.string(), message: z.string(), detectedAt: z.string() })),
  activeCreates: z.array(ActiveStorageSchema), activeUpdates: z.array(ActiveStorageSchema) });
const SummarySchema = z.strictObject({ projectId: z.string(), title: z.string(), revision: z.number(), durationMs: z.number(), shots: z.number(),
  frameRateNumerator: z.number().int().positive(), frameRateDenominator: z.number().int().positive(), dropFrame: z.boolean(), startTimecode: z.string(),
  sampleRate: z.literal([44100, 48000, 96000]),
  framesWithAsset: z.number(), framesAccepted: z.number(), framesOutputSafe: z.number(), framesTotal: z.number(),
  audioWithAsset: z.number(), audioMeasured: z.number(), audioPlayable: z.number(), audioRepairRequired: z.number(), audioTotal: z.number(),
  visualTimelineSafe: z.boolean(), visualCoverageGapCount: z.number(), shotsOutputSafe: z.number(), shotsTotal: z.number(),
  textConfirmed: z.number(), textProposed: z.number(), finalOutputReady: z.boolean(),
  textPlayable: z.number(), textTotal: z.number(), blockedOutputCount: z.number(), issues: z.number(), updatedAt: z.string() });
const SourceImpactSchema = z.strictObject({ changedSourceFileIds: z.array(z.string()), changedEntityIds: z.array(z.string()), impactedSegmentIds: z.array(z.string()),
  impactedShotIds: z.array(z.string()), lockedShotIds: z.array(z.string()), canApply: z.boolean() });

export type AppStatus = z.infer<typeof StatusSchema>;
export type ProjectSummary = z.infer<typeof SummarySchema>;
export type CodexRequest = z.infer<typeof CodexRequestSchema>;
export type SourceImpact = z.infer<typeof SourceImpactSchema>;
export type AssetIntegrityIssue = { projectId: string; assetId: string; outputTargetIds: string[]; code: string; message: string };
export type ApiErrorCategory = 'validation' | 'not-found' | 'conflict' | 'locked' | 'unavailable' | 'internal';
export type ApiErrorScope = 'request' | 'project' | 'asset' | 'service';

const ErrorResponseSchema = z.strictObject({ error: z.strictObject({
  code: z.string(), message: z.string(), issues: z.array(z.unknown()),
  category: z.enum(['validation', 'not-found', 'conflict', 'locked', 'unavailable', 'internal']),
  scope: z.enum(['request', 'project', 'asset', 'service']), retryable: z.boolean(), operatorActionRequired: z.boolean(),
  projectId: z.string().nullable(), resourceId: z.string().nullable(), mutationBlocked: z.boolean(),
}) });

export class ApiError extends Error {
  readonly code: string;
  readonly status: number;
  readonly category: ApiErrorCategory;
  readonly retryable: boolean;
  readonly operatorActionRequired: boolean;
  readonly issues: readonly unknown[];
  readonly scope: ApiErrorScope;
  readonly projectId: string | null;
  readonly resourceId: string | null;
  readonly mutationBlocked: boolean;
  constructor(code: string, message: string, status: number, category: ApiErrorCategory, retryable: boolean,
    operatorActionRequired: boolean, issues: readonly unknown[], context?: {
      scope: ApiErrorScope; projectId: string | null; resourceId: string | null; mutationBlocked: boolean;
    }) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
    this.category = category;
    this.retryable = retryable;
    this.operatorActionRequired = operatorActionRequired;
    this.issues = [...issues];
    this.scope = context?.scope ?? (category === 'locked' ? 'project' : category === 'internal' || category === 'unavailable' ? 'service' : 'request');
    this.projectId = context?.projectId ?? null;
    this.resourceId = context?.resourceId ?? null;
    this.mutationBlocked = context?.mutationBlocked ?? (category === 'locked' && this.scope === 'project');
  }
}

export function apiErrorMessage(error: unknown): string {
  if (!(error instanceof ApiError)) return error instanceof Error ? error.message : String(error);
  if (error.code === 'NETWORK_REQUEST_FAILED') return error.message;
  if (error.code === 'FINAL_OUTPUT_NOT_READY') return `FINAL OUTPUT NOT READY\n${error.message}`;
  if (error.code === 'PROJECT_BUSY') return '프로젝트 생성 또는 다른 작업이 진행 중입니다. 완료 후 다시 불러오거나 재시도하세요.';
  if (error.code === 'DOCUMENT_OUTPUT_EXISTS') return '출력 폴더가 이미 존재합니다. 다른 새 폴더를 지정하세요.\n' + error.message;
  if (error.code === 'PROJECT_ALREADY_EXISTS') return '같은 Project가 이미 저장돼 있습니다.';
  if (error.category === 'locked' && error.scope === 'request') return `REQUEST RECOVERY REQUIRED\n생성 결과의 적용 상태를 확인하세요.\n${error.message}`;
  if (error.category === 'locked' && error.scope === 'asset') return `ASSET REPAIR REQUIRED\n해당 자산의 안전 출력이 차단됐습니다.\n${error.message}`;
  if (error.category === 'locked') return `STORAGE RECOVERY REQUIRED\n해당 Project는 저장소 복구 전 변경할 수 없습니다.\n${error.message}`;
  if (error.category === 'unavailable') return `STORAGE TEMPORARILY UNAVAILABLE\n잠시 후 다시 시도하세요.\n${error.message}`;
  if (error.category === 'conflict') return `다른 작업이 진행 중이거나 Revision이 변경됐습니다. Project를 다시 불러온 후 재시도하세요.\n${error.message}`;
  if (error.category === 'validation') return `입력 또는 편집 조건을 수정하세요.\n${error.message}`;
  return error.message;
}

export function isStorageRecoveryError(error: unknown): boolean {
  return error instanceof ApiError && error.category === 'locked' && error.scope === 'project' && error.mutationBlocked;
}

export function isAssetIntegrityError(error: unknown): boolean {
  return error instanceof ApiError && error.category === 'locked' && error.scope === 'asset' && error.resourceId !== null;
}

export function shouldRetryApiError(error: unknown): boolean {
  return error instanceof ApiError && error.retryable && error.category !== 'locked';
}

async function request(path: string, init: RequestInit): Promise<unknown> {
  let response: Response;
  try { response = await fetch(path, init); }
  catch (error: unknown) {
    if (!(error instanceof TypeError)) throw error;
    throw new ApiError('NETWORK_REQUEST_FAILED', '서버에 연결하지 못했습니다. CUTROOM 서버 실행 상태를 확인한 뒤 재시도하세요.\n'
      + (init.method ?? 'GET') + ' ' + path + ': ' + error.message, 0, 'unavailable', true, false, []);
  }
  const data: unknown = await response.json();
  if (!response.ok) {
    const parsed = ErrorResponseSchema.safeParse(data);
    if (parsed.success) throw new ApiError(parsed.data.error.code, parsed.data.error.message, response.status,
      parsed.data.error.category, parsed.data.error.retryable, parsed.data.error.operatorActionRequired, parsed.data.error.issues,
      { scope: parsed.data.error.scope, projectId: parsed.data.error.projectId, resourceId: parsed.data.error.resourceId,
        mutationBlocked: parsed.data.error.mutationBlocked });
    throw new ApiError(`HTTP_${response.status}`, `요청이 실패했습니다. status=${response.status}`, response.status,
      response.status === 404 ? 'not-found' : response.status === 409 ? 'conflict' : response.status === 423 ? 'locked'
        : response.status === 503 ? 'unavailable' : response.status >= 500 ? 'internal' : 'validation',
      response.status === 409 || response.status === 503, response.status === 423, [],
      { scope: response.status === 423 ? 'project' : response.status >= 500 ? 'service' : 'request',
        projectId: null, resourceId: null, mutationBlocked: response.status === 423 });
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

export async function fetchAssetIntegrity(projectId: string): Promise<AssetIntegrityIssue[]> {
  const IssueSchema = z.strictObject({ projectId: z.string(), assetId: z.string(), outputTargetIds: z.array(z.string()), code: z.string(), message: z.string() });
  return z.strictObject({ issues: z.array(IssueSchema) })
    .parse(await request(`/api/projects/${encodeURIComponent(projectId)}/asset-integrity`, {})).issues;
}

export async function importProject(handoffPath: string, proposedTextHoldMs: number): Promise<Project> {
  return z.strictObject({ project: ProjectSchema }).parse(await request('/api/projects/import', json('POST', { handoffPath, proposedTextHoldMs }))).project;
}

export async function previewDocumentPackage(directory: string, bindings: DocumentBindings): Promise<DocumentPreview> {
  return z.strictObject({ preview: DocumentPreviewSchema }).parse(await request('/api/document-packages/preview', json('POST', { directory, bindings }))).preview;
}

export async function createDocumentPackage(directory: string, output: string, settings: DocumentSettings): Promise<{ handoffPath: string; projectId: string }> {
  return z.strictObject({ handoffPath: z.string(), projectId: z.string() }).parse(await request('/api/document-packages', json('POST', { directory, output, settings })));
}

export async function documentReviewStatus(): Promise<ReviewRuntimeStatus> { return ReviewRuntimeStatusSchema.parse(await request('/api/document-reviews/status', {})); }
export async function listDocumentPresets(): Promise<ProductionPreset[]> { return z.strictObject({ presets: z.array(ProductionPresetSchema) }).parse(await request('/api/document-presets', {})).presets; }
export async function saveDocumentPreset(name: string, fields: ProductionFields): Promise<ProductionPreset> {
  return z.strictObject({ preset: ProductionPresetSchema }).parse(await request('/api/document-presets', json('POST', { name, fields }))).preset;
}
export async function startDocumentReview(input: DocumentReviewInput): Promise<ReviewState> {
  return z.strictObject({ review: ReviewStateSchema }).parse(await request('/api/document-reviews', json('POST', input))).review;
}
export async function readDocumentReview(id: string): Promise<ReviewState> { return z.strictObject({ review: ReviewStateSchema }).parse(await request(`/api/document-reviews/${encodeURIComponent(id)}`, {})).review; }
export async function cancelDocumentReview(id: string): Promise<ReviewState> { return z.strictObject({ review: ReviewStateSchema }).parse(await request(`/api/document-reviews/${encodeURIComponent(id)}/cancel`, json('POST', {}))).review; }
export async function validateDocumentReview(id: string, input: DocumentReviewInput): Promise<ReviewState> {
  return z.strictObject({ review: ReviewStateSchema }).parse(await request(`/api/document-reviews/${encodeURIComponent(id)}/validate`, json('POST', input))).review;
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

export async function fetchFinalReadiness(projectId: string): Promise<FinalReadinessReport> {
  return z.strictObject({ projectId: z.string(), revision: z.number().int().nonnegative(),
    stage: z.enum(['generated', 'reviewed', 'text-confirmed', 'visual-timeline-safe', 'final-ready']), finalReady: z.boolean(),
    counts: z.strictObject({ textTotal: z.number(), textConfirmed: z.number(), textProposed: z.number(), shotsTotal: z.number(), shotsApproved: z.number(),
      visualTimelineSafe: z.number(), visualCoverageGapCount: z.number(), framesTotal: z.number(), framesAccepted: z.number(), audioTotal: z.number(), audioPlayable: z.number() }),
    issues: z.array(IssueSchema),
  }).parse(await request(`/api/projects/${encodeURIComponent(projectId)}/final-readiness`, {}));
}

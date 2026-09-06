import { z } from 'zod';
import { ProjectSchema } from '../../src/domain/schema.js';
import type { Project } from '../../src/domain/schema.js';

const RequestFailureSchema = z.strictObject({ id: z.uuid(), kind: z.enum(['proposal', 'image', 'speech']), projectId: z.string(), targetId: z.string(),
  error: z.strictObject({ code: z.string(), message: z.string() }).nullable() });
const StatusSchema = z.strictObject({ provider: z.literal('codex-app'), totalRequests: z.number().int().nonnegative(), completedRequests: z.number().int().nonnegative(),
  pendingRequests: z.number().int().nonnegative(), failedRequests: z.number().int().nonnegative(), repeatedRequests: z.number().int().nonnegative(),
  averageLatencyMs: z.number().int().nonnegative().nullable(), maximumLatencyMs: z.number().int().nonnegative().nullable(), apiCostUsd: z.null(), costNote: z.string(),
  recentFailures: z.array(RequestFailureSchema), generationInstruction: z.string(), aiVoiceDisclosure: z.string(),
  storageRecovery: z.array(z.strictObject({ projectId: z.string(), transactionId: z.string(),
    outcome: z.enum(['committed', 'rolled-back', 'restored-previous', 'staging-removed', 'stale-lock-removed']) })) });
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

export class ApiError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
  }
}

async function request(path: string, init: RequestInit): Promise<unknown> {
  const response: Response = await fetch(path, init);
  const data: unknown = await response.json();
  if (!response.ok) {
    const parsed = z.object({ error: z.object({ code: z.string(), message: z.string() }) }).safeParse(data);
    throw new ApiError(parsed.success ? parsed.data.error.code : `HTTP_${response.status}`, parsed.success ? parsed.data.error.message : `요청이 실패했습니다. status=${response.status}`);
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

import { z } from 'zod';
import { ProjectSchema } from '../../src/domain/schema.js';
import type { Project } from '../../src/domain/schema.js';

const StatusSchema = z.strictObject({ provider: z.literal('openai'), configured: z.boolean(),
  models: z.strictObject({ proposal: z.string(), image: z.string(), speech: z.string() }), aiVoiceDisclosure: z.string() });
const SummarySchema = z.strictObject({ projectId: z.string(), title: z.string(), revision: z.number(), durationMs: z.number(), shots: z.number(),
  framesReady: z.number(), framesTotal: z.number(), audioReady: z.number(), audioTotal: z.number(), issues: z.number(), updatedAt: z.string() });
const JobSchema = z.strictObject({ id: z.string(), kind: z.enum(['proposal', 'image', 'speech']), status: z.enum(['queued', 'running', 'succeeded', 'failed']),
  createdAt: z.string(), updatedAt: z.string(), result: z.strictObject({ projectId: z.string(), revision: z.number() }).nullable(),
  error: z.strictObject({ code: z.string(), message: z.string(), issues: z.array(z.unknown()) }).nullable() });
const SourceImpactSchema = z.strictObject({ changedSourceFileIds: z.array(z.string()), changedEntityIds: z.array(z.string()), impactedSegmentIds: z.array(z.string()),
  impactedShotIds: z.array(z.string()), lockedShotIds: z.array(z.string()), canApply: z.boolean() });

export type AppStatus = z.infer<typeof StatusSchema>;
export type ProjectSummary = z.infer<typeof SummarySchema>;
export type JobRecord = z.infer<typeof JobSchema>;
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

export async function mutateProject(projectId: string, path: string, method: 'PATCH' | 'POST', body: unknown): Promise<Project> {
  return z.strictObject({ project: ProjectSchema }).parse(await request(`/api/projects/${encodeURIComponent(projectId)}${path}`, json(method, body))).project;
}

export async function startJob(projectId: string, path: string, expectedRevision: number): Promise<JobRecord> {
  return z.strictObject({ job: JobSchema }).parse(await request(`/api/projects/${encodeURIComponent(projectId)}${path}`, json('POST', { expectedRevision }))).job;
}

export async function fetchJob(jobId: string): Promise<JobRecord> {
  return z.strictObject({ job: JobSchema }).parse(await request(`/api/jobs/${encodeURIComponent(jobId)}`, {})).job;
}

export async function previewSourceUpdate(projectId: string, handoffPath: string, proposedTextHoldMs: number, expectedRevision: number): Promise<SourceImpact> {
  const data: unknown = await request(`/api/projects/${encodeURIComponent(projectId)}/source-impact`, json('POST', { handoffPath, proposedTextHoldMs, expectedRevision }));
  return z.strictObject({ impact: SourceImpactSchema }).parse(data).impact;
}

export async function updateProjectSource(projectId: string, handoffPath: string, proposedTextHoldMs: number, expectedRevision: number): Promise<Project> {
  const data: unknown = await request(`/api/projects/${encodeURIComponent(projectId)}/source-update`, json('POST', { handoffPath, proposedTextHoldMs, expectedRevision }));
  return z.strictObject({ project: ProjectSchema }).parse(data).project;
}

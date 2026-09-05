import { randomUUID } from 'node:crypto';
import { stat } from 'node:fs/promises';
import Fastify from 'fastify';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import fastifyStatic from '@fastify/static';
import { z, ZodError } from 'zod';
import type { GenerationConnector, ImageReference } from '../connectors/generation.js';
import { approveShot, mergeShots, reorderShots, setShotLocks, splitShot, updateShotContent } from '../domain/edit.js';
import { contractError } from '../domain/errors.js';
import { setFrameReview, updateFrameDescription, updateProjectProfile } from '../domain/frame.js';
import { addReferenceAsset, applyGeneratedImage, applyGeneratedProposal, applyGeneratedSpeech } from '../domain/media.js';
import { IdSchema, LockedFieldSchema, ProfileSchema, ShotContentSchema } from '../domain/schema.js';
import type { AudioCue, Project } from '../domain/schema.js';
import { applySourceUpdate, sourceImpact } from '../domain/source-update.js';
import { exportShotCsv } from '../exporters/csv.js';
import { exportProjectJson } from '../exporters/json.js';
import { exportProjectPdf } from '../exporters/pdf.js';
import { importPackage } from '../importers/import-package.js';
import { readPackage } from '../io/package.js';
import { buildFrameImageContext, buildSegmentContext } from '../proposal/context.js';
import { createSourceOutline } from '../proposal/outline.js';
import type { AppConfig } from './config.js';
import { createJobQueue } from './jobs.js';
import type { JobQueue, JobRecord } from './jobs.js';
import type { AssetWrite, ProjectStore } from './store.js';

const ProjectParamsSchema = z.strictObject({ projectId: IdSchema });
const ShotParamsSchema = ProjectParamsSchema.extend({ shotId: IdSchema });
const FrameParamsSchema = ProjectParamsSchema.extend({ frameId: IdSchema });
const CueParamsSchema = ProjectParamsSchema.extend({ cueId: IdSchema });
const JobParamsSchema = z.strictObject({ jobId: IdSchema });
const RevisionSchema = z.strictObject({ expectedRevision: z.number().int().nonnegative() });
const ImportBodySchema = z.strictObject({ handoffPath: z.string().min(1), proposedTextHoldMs: z.number().int().positive() });
const UpdateShotBodySchema = z.strictObject({ expectedRevision: z.number().int().nonnegative(), content: ShotContentSchema });
const SplitBodySchema = z.strictObject({ expectedRevision: z.number().int().nonnegative(), atMs: z.number().int().nonnegative() });
const MergeBodySchema = z.strictObject({ expectedRevision: z.number().int().nonnegative(), secondShotId: IdSchema });
const ReorderBodySchema = z.strictObject({ expectedRevision: z.number().int().nonnegative(), segmentId: IdSchema, orderedShotIds: z.array(IdSchema).min(1) });
const LocksBodySchema = z.strictObject({ expectedRevision: z.number().int().nonnegative(), fields: z.array(LockedFieldSchema) });
const ProfileBodySchema = z.strictObject({ expectedRevision: z.number().int().nonnegative(), profile: ProfileSchema });
const FrameBodySchema = z.strictObject({ expectedRevision: z.number().int().nonnegative(), description: z.string() });
const FrameReviewBodySchema = z.strictObject({ expectedRevision: z.number().int().nonnegative(), review: z.enum(['pending', 'accepted', 'rejected']) });
const ReferenceBodySchema = z.strictObject({ expectedRevision: z.number().int().nonnegative(), kind: z.enum(['character', 'location', 'prop']),
  subjectId: IdSchema.nullable(), description: z.string().min(1), mimeType: z.enum(['image/png', 'image/jpeg', 'image/webp']), base64: z.string().min(1) });

export type ConnectorFactory = () => GenerationConnector;

function assets(mutation: { relativePath: string | null; content: Buffer | null }): AssetWrite[] {
  return mutation.relativePath === null || mutation.content === null ? [] : [{ relativePath: mutation.relativePath, content: mutation.content }];
}

function jobResponse(job: JobRecord): { job: JobRecord } {
  return { job };
}

function requireSpeechCue(cue: AudioCue): void {
  if (!['dialogue', 'voiceover', 'panel'].includes(cue.kind)) {
    throw contractError('SPEECH_CUE_REQUIRED', `${cue.id}: 대사·내레이션·패널 발화만 가이드 음성으로 만들 수 있습니다.`, []);
  }
}

function statusCode(error: Error): number {
  const code: string = 'code' in error && typeof error.code === 'string' ? error.code : error.name;
  if (code.endsWith('_NOT_FOUND')) return 404;
  if (['REVISION_CONFLICT', 'PROJECT_ALREADY_EXISTS', 'PROJECT_BUSY'].includes(code)) return 409;
  if (error instanceof ZodError || code.startsWith('INVALID_') || code.startsWith('MISSING_') || code.startsWith('DUPLICATE_') || code.startsWith('UNSAFE_') || code.startsWith('UNKNOWN_') || code.startsWith('FORBIDDEN_') || code.endsWith('_LOCKED')) return 400;
  return 500;
}

function errorBody(error: Error): { error: { code: string; message: string; issues: unknown[] } } {
  const code: string = 'code' in error && typeof error.code === 'string' ? error.code : error.name;
  const issues: unknown[] = error instanceof ZodError ? error.issues : 'issues' in error && Array.isArray(error.issues) ? error.issues : [];
  return { error: { code, message: error.message, issues } };
}

async function ensureWebRoot(path: string): Promise<void> {
  try {
    const metadata = await stat(path);
    if (!metadata.isDirectory()) throw contractError('INVALID_WEB_ROOT', `웹 빌드 경로가 디렉터리가 아닙니다: ${path}`, []);
  } catch (error: unknown) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') throw contractError('MISSING_WEB_BUILD', `웹 화면을 먼저 빌드하세요: ${path}`, []);
    throw error;
  }
}

export async function createApp(config: AppConfig, store: ProjectStore, connectorFactory: ConnectorFactory): Promise<FastifyInstance> {
  await ensureWebRoot(config.webRoot);
  await store.initialize();
  const app: FastifyInstance = Fastify({ logger: { level: 'info' }, bodyLimit: 28 * 1024 * 1024 });
  const jobs: JobQueue = createJobQueue(randomUUID, (): string => new Date().toISOString());

  app.setErrorHandler((error: Error, _request: FastifyRequest, reply: FastifyReply): void => {
    reply.status(statusCode(error)).send(errorBody(error));
  });

  app.get('/api/status', async (): Promise<object> => ({ provider: 'openai', configured: typeof process.env.OPENAI_API_KEY === 'string' && process.env.OPENAI_API_KEY.trim() !== '',
    models: { proposal: config.generation.proposalModel, image: config.generation.imageModel, speech: config.generation.speechModel }, aiVoiceDisclosure: '가이드 음성은 AI가 생성합니다.' }));
  app.get('/api/projects', async (): Promise<object> => ({ projects: await store.list() }));
  app.get('/api/projects/:projectId', async (request: FastifyRequest): Promise<object> => {
    const { projectId } = ProjectParamsSchema.parse(request.params);
    return { project: await store.read(projectId) };
  });
  app.post('/api/projects/import', async (request: FastifyRequest, reply: FastifyReply): Promise<object> => {
    const body = ImportBodySchema.parse(request.body);
    const project: Project = createSourceOutline(importPackage(await readPackage(body.handoffPath)), { proposedTextHoldMs: body.proposedTextHoldMs });
    reply.status(201);
    return { project: await store.create(project) };
  });
  app.post('/api/projects/:projectId/source-impact', async (request: FastifyRequest): Promise<object> => {
    const { projectId } = ProjectParamsSchema.parse(request.params);
    const body = ImportBodySchema.extend({ expectedRevision: z.number().int().nonnegative() }).parse(request.body);
    const current: Project = await store.read(projectId);
    if (current.revision !== body.expectedRevision) throw contractError('REVISION_CONFLICT', `${projectId}: expected=${body.expectedRevision}, actual=${current.revision}`, []);
    const incoming: Project = createSourceOutline(importPackage(await readPackage(body.handoffPath)), { proposedTextHoldMs: body.proposedTextHoldMs });
    return { impact: sourceImpact(current, incoming) };
  });
  app.post('/api/projects/:projectId/source-update', async (request: FastifyRequest): Promise<object> => {
    const { projectId } = ProjectParamsSchema.parse(request.params);
    const body = ImportBodySchema.extend({ expectedRevision: z.number().int().nonnegative() }).parse(request.body);
    const incoming: Project = createSourceOutline(importPackage(await readPackage(body.handoffPath)), { proposedTextHoldMs: body.proposedTextHoldMs });
    const prefix: string = `source-update:${randomUUID()}`;
    return { project: await store.update(projectId, body.expectedRevision, (current: Project): Project => applySourceUpdate(current, incoming, prefix), []) };
  });
  app.patch('/api/projects/:projectId/profile', async (request: FastifyRequest): Promise<object> => {
    const { projectId } = ProjectParamsSchema.parse(request.params);
    const body = ProfileBodySchema.parse(request.body);
    return { project: await store.update(projectId, body.expectedRevision, (project: Project): Project => updateProjectProfile(project, body.profile), []) };
  });
  app.patch('/api/projects/:projectId/shots/:shotId', async (request: FastifyRequest): Promise<object> => {
    const { projectId, shotId } = ShotParamsSchema.parse(request.params);
    const body = UpdateShotBodySchema.parse(request.body);
    return { project: await store.update(projectId, body.expectedRevision, (project: Project): Project => updateShotContent(project, shotId, body.content), []) };
  });
  app.post('/api/projects/:projectId/shots/:shotId/split', async (request: FastifyRequest): Promise<object> => {
    const { projectId, shotId } = ShotParamsSchema.parse(request.params);
    const body = SplitBodySchema.parse(request.body);
    const id: string = randomUUID();
    return { project: await store.update(projectId, body.expectedRevision, (project: Project): Project => splitShot(project, shotId, body.atMs, `${id}:shot`, `${id}:frame`), []) };
  });
  app.post('/api/projects/:projectId/shots/:shotId/merge', async (request: FastifyRequest): Promise<object> => {
    const { projectId, shotId } = ShotParamsSchema.parse(request.params);
    const body = MergeBodySchema.parse(request.body);
    return { project: await store.update(projectId, body.expectedRevision, (project: Project): Project => mergeShots(project, shotId, body.secondShotId), []) };
  });
  app.post('/api/projects/:projectId/shots/reorder', async (request: FastifyRequest): Promise<object> => {
    const { projectId } = ProjectParamsSchema.parse(request.params);
    const body = ReorderBodySchema.parse(request.body);
    return { project: await store.update(projectId, body.expectedRevision, (project: Project): Project => reorderShots(project, body.segmentId, body.orderedShotIds), []) };
  });
  app.post('/api/projects/:projectId/shots/:shotId/locks', async (request: FastifyRequest): Promise<object> => {
    const { projectId, shotId } = ShotParamsSchema.parse(request.params);
    const body = LocksBodySchema.parse(request.body);
    return { project: await store.update(projectId, body.expectedRevision, (project: Project): Project => setShotLocks(project, shotId, body.fields), []) };
  });
  app.post('/api/projects/:projectId/shots/:shotId/approve', async (request: FastifyRequest): Promise<object> => {
    const { projectId, shotId } = ShotParamsSchema.parse(request.params);
    const body = RevisionSchema.parse(request.body);
    return { project: await store.update(projectId, body.expectedRevision, (project: Project): Project => approveShot(project, shotId), []) };
  });
  app.patch('/api/projects/:projectId/frames/:frameId', async (request: FastifyRequest): Promise<object> => {
    const { projectId, frameId } = FrameParamsSchema.parse(request.params);
    const body = FrameBodySchema.parse(request.body);
    return { project: await store.update(projectId, body.expectedRevision, (project: Project): Project => updateFrameDescription(project, frameId, body.description), []) };
  });
  app.post('/api/projects/:projectId/frames/:frameId/review', async (request: FastifyRequest): Promise<object> => {
    const { projectId, frameId } = FrameParamsSchema.parse(request.params);
    const body = FrameReviewBodySchema.parse(request.body);
    return { project: await store.update(projectId, body.expectedRevision, (project: Project): Project => setFrameReview(project, frameId, body.review), []) };
  });
  app.post('/api/projects/:projectId/references', async (request: FastifyRequest, reply: FastifyReply): Promise<object> => {
    const { projectId } = ProjectParamsSchema.parse(request.params);
    const body = ReferenceBodySchema.parse(request.body);
    const bytes: Buffer = Buffer.from(body.base64, 'base64');
    const current: Project = await store.read(projectId);
    const mutation = addReferenceAsset(current, { id: `${randomUUID()}:reference`, kind: body.kind, subjectId: body.subjectId, description: body.description, mimeType: body.mimeType, bytes });
    const project: Project = await store.update(projectId, body.expectedRevision, (): Project => mutation.project, assets(mutation));
    reply.status(201);
    return { project };
  });
  app.post('/api/projects/:projectId/segments/:segmentId/propose', async (request: FastifyRequest, reply: FastifyReply): Promise<object> => {
    const params = z.strictObject({ projectId: IdSchema, segmentId: IdSchema }).parse(request.params);
    const body = RevisionSchema.parse(request.body);
    const generationId: string = randomUUID();
    const job: JobRecord = jobs.start('proposal', async () => {
      const current: Project = await store.read(params.projectId);
      const result = await connectorFactory().propose(buildSegmentContext(current, params.segmentId));
      const mutation = applyGeneratedProposal(current, params.segmentId, generationId, new Date().toISOString(), result);
      const project: Project = await store.update(params.projectId, body.expectedRevision, (): Project => mutation.project, []);
      return { projectId: project.projectId, revision: project.revision };
    });
    reply.status(202);
    return jobResponse(job);
  });
  app.post('/api/projects/:projectId/frames/:frameId/generate', async (request: FastifyRequest, reply: FastifyReply): Promise<object> => {
    const { projectId, frameId } = FrameParamsSchema.parse(request.params);
    const body = RevisionSchema.parse(request.body);
    const generationId: string = randomUUID();
    const job: JobRecord = jobs.start('image', async () => {
      const current: Project = await store.read(projectId);
      const context = buildFrameImageContext(current, frameId);
      const references: ImageReference[] = await Promise.all(context.visualReferences.map(async (reference): Promise<ImageReference> => {
        const file = await store.asset(projectId, reference.id);
        return { id: reference.id, bytes: file.content, mimeType: file.mimeType, sha256: reference.sha256 };
      }));
      const result = await connectorFactory().image(context, references);
      const mutation = applyGeneratedImage(current, frameId, generationId, new Date().toISOString(), result);
      const project: Project = await store.update(projectId, body.expectedRevision, (): Project => mutation.project, assets(mutation));
      return { projectId: project.projectId, revision: project.revision };
    });
    reply.status(202);
    return jobResponse(job);
  });
  app.post('/api/projects/:projectId/audio/:cueId/generate', async (request: FastifyRequest, reply: FastifyReply): Promise<object> => {
    const { projectId, cueId } = CueParamsSchema.parse(request.params);
    const body = RevisionSchema.parse(request.body);
    const generationId: string = randomUUID();
    const job: JobRecord = jobs.start('speech', async () => {
      const current: Project = await store.read(projectId);
      const cue = current.audioCues.find((candidate): boolean => candidate.id === cueId);
      if (cue === undefined) throw contractError('AUDIO_CUE_NOT_FOUND', `오디오 큐를 찾을 수 없습니다: ${cueId}`, []);
      requireSpeechCue(cue);
      const unit = current.dataset.units.find((candidate): boolean => candidate.id === cue.unitId);
      if (unit === undefined) throw contractError('SOURCE_UNIT_NOT_FOUND', `오디오 큐의 원문을 찾을 수 없습니다: ${cue.unitId}`, []);
      const result = await connectorFactory().speech(unit.text);
      const mutation = applyGeneratedSpeech(current, cueId, generationId, new Date().toISOString(), result);
      const project: Project = await store.update(projectId, body.expectedRevision, (): Project => mutation.project, assets(mutation));
      return { projectId: project.projectId, revision: project.revision };
    });
    reply.status(202);
    return jobResponse(job);
  });
  app.get('/api/jobs/:jobId', async (request: FastifyRequest): Promise<object> => {
    const { jobId } = JobParamsSchema.parse(request.params);
    const job: JobRecord | null = jobs.get(jobId);
    if (job === null) throw contractError('JOB_NOT_FOUND', `생성 작업을 찾을 수 없습니다: ${jobId}`, []);
    return jobResponse(job);
  });
  app.get('/api/projects/:projectId/assets/:assetId', async (request: FastifyRequest, reply: FastifyReply): Promise<Buffer> => {
    const params = z.strictObject({ projectId: IdSchema, assetId: IdSchema }).parse(request.params);
    const asset = await store.asset(params.projectId, params.assetId);
    reply.header('Content-Type', asset.mimeType).header('Cache-Control', 'private, max-age=31536000, immutable');
    return asset.content;
  });
  app.get('/api/projects/:projectId/export.json', async (request: FastifyRequest, reply: FastifyReply): Promise<string> => {
    const { projectId } = ProjectParamsSchema.parse(request.params);
    reply.header('Content-Type', 'application/json; charset=utf-8').header('Content-Disposition', 'attachment; filename="storyboard.json"');
    return exportProjectJson(await store.read(projectId));
  });
  app.get('/api/projects/:projectId/export.csv', async (request: FastifyRequest, reply: FastifyReply): Promise<string> => {
    const { projectId } = ProjectParamsSchema.parse(request.params);
    reply.header('Content-Type', 'text/csv; charset=utf-8').header('Content-Disposition', 'attachment; filename="storyboard.csv"');
    return exportShotCsv(await store.read(projectId));
  });
  app.get('/api/projects/:projectId/export.pdf', async (request: FastifyRequest, reply: FastifyReply): Promise<Buffer> => {
    const { projectId } = ProjectParamsSchema.parse(request.params);
    const project: Project = await store.read(projectId);
    const pdf: Buffer = await exportProjectPdf(project, config.pdfFontPath, async (assetId: string): Promise<Buffer> => (await store.asset(projectId, assetId)).content);
    reply.header('Content-Type', 'application/pdf').header('Content-Disposition', 'attachment; filename="storyboard.pdf"');
    return pdf;
  });

  await app.register(fastifyStatic, { root: config.webRoot, wildcard: true });
  app.setNotFoundHandler((request: FastifyRequest, reply: FastifyReply): void => {
    if (request.url.startsWith('/api/')) {
      reply.status(404).send({ error: { code: 'ROUTE_NOT_FOUND', message: `API 경로를 찾을 수 없습니다: ${request.method} ${request.url}`, issues: [] } });
      return;
    }
    void reply.sendFile('index.html');
  });
  return app;
}

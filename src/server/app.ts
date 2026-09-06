import { randomUUID } from 'node:crypto';
import { stat } from 'node:fs/promises';
import Fastify from 'fastify';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import fastifyStatic from '@fastify/static';
import { z, ZodError } from 'zod';
import { codexRequestMetrics } from '../codex/metrics.js';
import type { CodexRequestStore } from '../codex/requests.js';
import type { CodexRequest, CodexRequestKind } from '../codex/schema.js';
import { codexRequestBasis } from '../codex/work.js';
import { approveShot, mergeShots, reorderShots, setShotLocks, splitShot, updateShotContent } from '../domain/edit.js';
import { contractError } from '../domain/errors.js';
import { addStoryboardFrame, setFrameReview, StoryboardFrameInputSchema, updateProjectProfile, updateStoryboardFrame } from '../domain/frame.js';
import { mappingReviewIssues, MoveShotSourceLinkInputSchema, moveShotSourceLink, ShotSourceLinksInputSchema, TextMappingDecisionInputSchema, updateShotSourceLinks, updateTextMappingDecision } from '../domain/mapping.js';
import { addReferenceAsset } from '../domain/media.js';
import { IdSchema, LockedFieldSchema, ProfileSchema, ShotContentSchema } from '../domain/schema.js';
import type { Project } from '../domain/schema.js';
import { deleteReviewTextCue, resolveTextCueAuthority, TextCueAuthorityResolutionInputSchema } from '../domain/text.js';
import { applySourceUpdate, sourceImpact } from '../domain/source-update.js';
import { AudioCueTimingInputSchema, TextCueTimingInputSchema, updateAudioCueTiming, updateTextCueTiming } from '../domain/tracks.js';
import { exportShotCsv } from '../exporters/csv.js';
import { exportProjectJson } from '../exporters/json.js';
import { exportProjectPdf } from '../exporters/pdf.js';
import { importPackage } from '../importers/import-package.js';
import { readPackage } from '../io/package.js';
import { createSourceOutline } from '../proposal/outline.js';
import type { AppConfig } from './config.js';
import type { AssetWrite, ProjectStore } from './store.js';

const ProjectParamsSchema = z.strictObject({ projectId: IdSchema });
const ShotParamsSchema = ProjectParamsSchema.extend({ shotId: IdSchema });
const FrameParamsSchema = ProjectParamsSchema.extend({ frameId: IdSchema });
const CueParamsSchema = ProjectParamsSchema.extend({ cueId: IdSchema });
const CodexRequestParamsSchema = z.strictObject({ requestId: z.uuid() });
const RevisionSchema = z.strictObject({ expectedRevision: z.number().int().nonnegative() });
const ImportBodySchema = z.strictObject({ handoffPath: z.string().min(1), proposedTextHoldMs: z.number().int().positive() });
const UpdateShotBodySchema = z.strictObject({ expectedRevision: z.number().int().nonnegative(), content: ShotContentSchema });
const SplitBodySchema = z.strictObject({ expectedRevision: z.number().int().nonnegative(), atMs: z.number().int().nonnegative() });
const MergeBodySchema = z.strictObject({ expectedRevision: z.number().int().nonnegative(), secondShotId: IdSchema });
const ReorderBodySchema = z.strictObject({ expectedRevision: z.number().int().nonnegative(), segmentId: IdSchema, orderedShotIds: z.array(IdSchema).min(1) });
const LocksBodySchema = z.strictObject({ expectedRevision: z.number().int().nonnegative(), fields: z.array(LockedFieldSchema) });
const ProfileBodySchema = z.strictObject({ expectedRevision: z.number().int().nonnegative(), profile: ProfileSchema });
const FrameBodySchema = z.strictObject({ expectedRevision: z.number().int().nonnegative(), frame: StoryboardFrameInputSchema });
const CreateFrameBodySchema = z.strictObject({ expectedRevision: z.number().int().nonnegative(), frame: StoryboardFrameInputSchema });
const FrameReviewBodySchema = z.strictObject({ expectedRevision: z.number().int().nonnegative(), review: z.enum(['pending', 'accepted', 'rejected']) });
const AudioCueBodySchema = z.strictObject({ expectedRevision: z.number().int().nonnegative(), timing: AudioCueTimingInputSchema });
const TextCueBodySchema = z.strictObject({ expectedRevision: z.number().int().nonnegative(), timing: TextCueTimingInputSchema });
const TextCueAuthorityBodySchema = z.strictObject({ expectedRevision: z.number().int().nonnegative(), resolution: TextCueAuthorityResolutionInputSchema });
const TextMappingBodySchema = z.strictObject({ expectedRevision: z.number().int().nonnegative(), decision: TextMappingDecisionInputSchema });
const SourceLinksBodySchema = z.strictObject({ expectedRevision: z.number().int().nonnegative(), mapping: ShotSourceLinksInputSchema });
const MoveSourceLinkBodySchema = z.strictObject({ expectedRevision: z.number().int().nonnegative(), move: MoveShotSourceLinkInputSchema });
const ReferenceBodySchema = z.strictObject({ expectedRevision: z.number().int().nonnegative(), kind: z.enum(['character', 'location', 'prop']),
  subjectId: IdSchema.nullable(), description: z.string().min(1), mimeType: z.enum(['image/png', 'image/jpeg', 'image/webp']), base64: z.string().min(1) });

function assets(mutation: { relativePath: string | null; content: Buffer | null }): AssetWrite[] {
  return mutation.relativePath === null || mutation.content === null ? [] : [{ relativePath: mutation.relativePath, content: mutation.content }];
}

function requestResponse(request: CodexRequest): { request: CodexRequest } { return { request }; }

async function queueRequest(kind: CodexRequestKind, projectId: string, targetId: string, expectedRevision: number,
  store: ProjectStore, requests: CodexRequestStore): Promise<CodexRequest> {
  const project: Project = await store.read(projectId);
  if (project.revision !== expectedRevision) throw contractError('REVISION_CONFLICT', `${projectId}: expected=${expectedRevision}, actual=${project.revision}`, []);
  return requests.create(kind, projectId, targetId, codexRequestBasis(project, kind, targetId), new Date().toISOString());
}

function statusCode(error: Error): number {
  const code: string = 'code' in error && typeof error.code === 'string' ? error.code : error.name;
  if (code.endsWith('_NOT_FOUND')) return 404;
  if (['REVISION_CONFLICT', 'PROJECT_ALREADY_EXISTS', 'PROJECT_BUSY'].includes(code)) return 409;
  if (error instanceof ZodError || code.startsWith('INVALID_') || code.startsWith('MISSING_') || code.startsWith('DUPLICATE_') || code.startsWith('UNSAFE_') || code.startsWith('UNKNOWN_') || code.startsWith('FORBIDDEN_') || code.startsWith('TEXT_') || code.endsWith('_LOCKED') || code.endsWith('_REQUIRED') || code.endsWith('_BLOCKED') || code.endsWith('_DELETED')) return 400;
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

export async function createApp(config: AppConfig, store: ProjectStore, requests: CodexRequestStore): Promise<FastifyInstance> {
  await ensureWebRoot(config.webRoot);
  await store.initialize();
  await requests.initialize();
  const app: FastifyInstance = Fastify({ logger: { level: 'info' }, bodyLimit: 28 * 1024 * 1024 });

  app.setErrorHandler((error: Error, _request: FastifyRequest, reply: FastifyReply): void => {
    reply.status(statusCode(error)).send(errorBody(error));
  });

  app.get('/api/status', async (): Promise<object> => {
    const allRequests: CodexRequest[] = await requests.list(null);
    const metrics = codexRequestMetrics(allRequests);
    const failed: CodexRequest[] = allRequests.filter((item: CodexRequest): boolean => item.status === 'failed');
    return { provider: 'codex-app', ...metrics,
      recentFailures: failed.slice(-5).reverse().map((item: CodexRequest): object => ({ id: item.id, kind: item.kind, projectId: item.projectId, targetId: item.targetId, error: item.error })),
      generationInstruction: 'Codex 앱에서 $storyboard-workbench 대기 요청 처리를 실행하세요.', aiVoiceDisclosure: `가이드 음성은 macOS ${config.codex.speechVoice} 합성 음성입니다.` };
  });
  app.get('/api/projects', async (): Promise<object> => ({ projects: await store.list() }));
  app.get('/api/projects/:projectId', async (request: FastifyRequest): Promise<object> => {
    const { projectId } = ProjectParamsSchema.parse(request.params);
    return { project: await store.read(projectId) };
  });
  app.get('/api/projects/:projectId/mapping-review', async (request: FastifyRequest): Promise<object> => {
    const { projectId } = ProjectParamsSchema.parse(request.params);
    const project: Project = await store.read(projectId);
    return { issues: mappingReviewIssues(project) };
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
  app.patch('/api/projects/:projectId/text-mappings/:decisionId', async (request: FastifyRequest): Promise<object> => {
    const params = z.strictObject({ projectId: IdSchema, decisionId: IdSchema }).parse(request.params);
    const body = TextMappingBodySchema.parse(request.body);
    return { project: await store.update(params.projectId, body.expectedRevision, (project: Project): Project => updateTextMappingDecision(project, params.decisionId, body.decision), []) };
  });
  app.patch('/api/projects/:projectId/shots/:shotId/source-links', async (request: FastifyRequest): Promise<object> => {
    const { projectId, shotId } = ShotParamsSchema.parse(request.params);
    const body = SourceLinksBodySchema.parse(request.body);
    return { project: await store.update(projectId, body.expectedRevision, (project: Project): Project => updateShotSourceLinks(project, shotId, body.mapping), []) };
  });
  app.post('/api/projects/:projectId/shots/:shotId/source-links/move', async (request: FastifyRequest): Promise<object> => {
    const { projectId, shotId } = ShotParamsSchema.parse(request.params);
    const body = MoveSourceLinkBodySchema.parse(request.body);
    return { project: await store.update(projectId, body.expectedRevision, (project: Project): Project => moveShotSourceLink(project, shotId, body.move), []) };
  });
  app.patch('/api/projects/:projectId/frames/:frameId', async (request: FastifyRequest): Promise<object> => {
    const { projectId, frameId } = FrameParamsSchema.parse(request.params);
    const body = FrameBodySchema.parse(request.body);
    return { project: await store.update(projectId, body.expectedRevision, (project: Project): Project => updateStoryboardFrame(project, frameId, body.frame), []) };
  });
  app.post('/api/projects/:projectId/shots/:shotId/frames', async (request: FastifyRequest, reply: FastifyReply): Promise<object> => {
    const { projectId, shotId } = ShotParamsSchema.parse(request.params);
    const body = CreateFrameBodySchema.parse(request.body);
    const frameId: string = `${randomUUID()}:frame`;
    const project: Project = await store.update(projectId, body.expectedRevision, (current: Project): Project => addStoryboardFrame(current, shotId, frameId, body.frame), []);
    reply.status(201);
    return { project };
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
    reply.status(202);
    return requestResponse(await queueRequest('proposal', params.projectId, params.segmentId, body.expectedRevision, store, requests));
  });
  app.post('/api/projects/:projectId/frames/:frameId/generate', async (request: FastifyRequest, reply: FastifyReply): Promise<object> => {
    const { projectId, frameId } = FrameParamsSchema.parse(request.params);
    const body = RevisionSchema.parse(request.body);
    reply.status(202);
    return requestResponse(await queueRequest('image', projectId, frameId, body.expectedRevision, store, requests));
  });
  app.post('/api/projects/:projectId/audio/:cueId/generate', async (request: FastifyRequest, reply: FastifyReply): Promise<object> => {
    const { projectId, cueId } = CueParamsSchema.parse(request.params);
    const body = RevisionSchema.parse(request.body);
    reply.status(202);
    return requestResponse(await queueRequest('speech', projectId, cueId, body.expectedRevision, store, requests));
  });
  app.patch('/api/projects/:projectId/audio/:cueId', async (request: FastifyRequest): Promise<object> => {
    const { projectId, cueId } = CueParamsSchema.parse(request.params);
    const body = AudioCueBodySchema.parse(request.body);
    return { project: await store.update(projectId, body.expectedRevision, (project: Project): Project => updateAudioCueTiming(project, cueId, body.timing), []) };
  });
  app.patch('/api/projects/:projectId/text/:cueId', async (request: FastifyRequest): Promise<object> => {
    const { projectId, cueId } = CueParamsSchema.parse(request.params);
    const body = TextCueBodySchema.parse(request.body);
    return { project: await store.update(projectId, body.expectedRevision, (project: Project): Project => updateTextCueTiming(project, cueId, body.timing), []) };
  });
  app.post('/api/projects/:projectId/text/:cueId/authority', async (request: FastifyRequest): Promise<object> => {
    const { projectId, cueId } = CueParamsSchema.parse(request.params);
    const body = TextCueAuthorityBodySchema.parse(request.body);
    return { project: await store.update(projectId, body.expectedRevision, (project: Project): Project => resolveTextCueAuthority(project, cueId, body.resolution), []) };
  });
  app.delete('/api/projects/:projectId/text/:cueId', async (request: FastifyRequest): Promise<object> => {
    const { projectId, cueId } = CueParamsSchema.parse(request.params);
    const body = RevisionSchema.parse(request.body);
    return { project: await store.update(projectId, body.expectedRevision, (project: Project): Project => deleteReviewTextCue(project, cueId), []) };
  });
  app.get('/api/codex/requests/:requestId', async (request: FastifyRequest): Promise<object> => {
    const { requestId } = CodexRequestParamsSchema.parse(request.params);
    return requestResponse(await requests.read(requestId));
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

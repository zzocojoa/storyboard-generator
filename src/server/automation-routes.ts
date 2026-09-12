import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { AutomationSettingsSchema } from '../automation/run-schema.js';
import type { AutomationSettings } from '../automation/run-schema.js';
import { recommendedStoryboardDensity } from '../automation/density.js';
import type { AutomationService } from '../automation/service.js';
import { contractError } from '../domain/errors.js';
import { SpeechRetakeInputSchema } from '../automation/speech-retake-schema.js';
import { IdSchema } from '../domain/schema.js';
import { ReferenceRetakeInputSchema } from '../automation/reference-retake-schema.js';

const ProjectParams = z.strictObject({ projectId: IdSchema });
const RunParams = ProjectParams.extend({ id: z.uuid() });
const StartBody = z.strictObject({ expectedRevision: z.number().int().nonnegative(), segmentIds: z.array(IdSchema).min(1).max(8192), settings: AutomationSettingsSchema });

/** 원본 제작 값과 분리한 실행 한도 추천이다. 시작 요청은 화면에서 확인한 모든 값을 명시한다. */
export function recommendedAutomationSettings(voiceName: string): AutomationSettings {
  return { model: null, voice: { name: voiceName, rateWordsPerMinute: 180 }, speakerVoices: [], voicePlanning: 'automatic', audioProduction: 'instructions-only', density: recommendedStoryboardDensity(), textLayoutPlanning: 'automatic', audioMixPlanning: 'automatic', productionBatchSize: 4, maxModelCorrections: 2,
    maxFramesPerSegment: 64, maxAttemptsPerJob: 2, maxImageAttempts: 1024, maxJobs: 4096, maxStagedBytes: 1024 * 1024 * 1024, maxActiveMs: 12 * 60 * 60 * 1000 };
}
function localOrigin(request: FastifyRequest): void {
  if (request.headers.origin !== undefined && request.headers.origin !== `http://${request.headers.host}`) throw contractError('FORBIDDEN_AUTOMATION_ORIGIN', '현재 CUTROOM 화면에서 자동 제작을 시작하거나 제어하세요.', []);
}
function requireService(service: AutomationService | null): AutomationService {
  if (service === null) throw contractError('AUTOMATION_SETUP_REQUIRED', '서버의 automation 설정에 Codex App·로컬 음성 실행 파일과 실행 저장 폴더를 지정하세요.', []);
  return service;
}
export function registerAutomationRoutes(app: FastifyInstance, service: AutomationService | null, voiceName: string): void {
  app.get('/api/automation/speech-voices', async (): Promise<object> => ({ voices: await requireService(service).speechVoices() }));
  app.post('/api/projects/:projectId/automation/storage', { bodyLimit: 4096 }, async (request): Promise<object> => {
    localOrigin(request); const { projectId } = ProjectParams.parse(request.params);
    const { maxStagedBytes } = z.strictObject({ maxStagedBytes: z.number().int().min(1).max(1073741824) }).parse(request.body);
    return requireService(service).inspectStorage(projectId, maxStagedBytes);
  });
  app.get('/api/projects/:projectId/automation', async (request): Promise<object> => {
    const { projectId } = ProjectParams.parse(request.params);
    return { configured: service !== null, recommendedSettings: service === null ? null : recommendedAutomationSettings(voiceName), runs: service === null ? [] : await service.list(projectId) };
  });
  app.post('/api/projects/:projectId/automation', { bodyLimit: 1024 * 1024 }, async (request, reply): Promise<object> => {
    localOrigin(request); const { projectId } = ProjectParams.parse(request.params); const body = StartBody.parse(request.body);
    const run = await requireService(service).start(projectId, body.expectedRevision, body.segmentIds, body.settings);
    reply.status(202); return { run };
  });
  app.post('/api/projects/:projectId/automation/speech-retakes', { bodyLimit: 65536 }, async (request, reply): Promise<object> => {
    localOrigin(request); const { projectId } = ProjectParams.parse(request.params);
    const body = z.strictObject({ expectedRevision: z.number().int().nonnegative(), input: SpeechRetakeInputSchema, settings: AutomationSettingsSchema }).parse(request.body);
    const run = await requireService(service).startSpeechRetake(projectId, body.expectedRevision, body.input, body.settings);
    reply.status(202); return { run };
  });
  app.post('/api/projects/:projectId/automation/reference-retakes', { bodyLimit: 65536 }, async (request, reply): Promise<object> => {
    localOrigin(request); const { projectId } = ProjectParams.parse(request.params);
    const body = z.strictObject({ expectedRevision: z.number().int().nonnegative(), input: ReferenceRetakeInputSchema, settings: AutomationSettingsSchema }).parse(request.body);
    const run = await requireService(service).startReferenceRetake(projectId, body.expectedRevision, body.input, body.settings);
    reply.status(202); return { run };
  });
  app.get('/api/projects/:projectId/automation/:id', async (request): Promise<object> => {
    const { projectId, id } = RunParams.parse(request.params); return { run: await requireService(service).read(projectId, id) };
  });
  app.post('/api/projects/:projectId/automation/:id/pause', async (request): Promise<object> => {
    localOrigin(request); const { projectId, id } = RunParams.parse(request.params); z.strictObject({}).parse(request.body);
    return { run: await requireService(service).pause(projectId, id) };
  });
  app.post('/api/projects/:projectId/automation/:id/resume', async (request, reply): Promise<object> => {
    localOrigin(request); const { projectId, id } = RunParams.parse(request.params); z.strictObject({}).parse(request.body);
    const run = await requireService(service).resume(projectId, id); reply.status(202); return { run };
  });
  app.post('/api/projects/:projectId/automation/:id/cancel', async (request): Promise<object> => {
    localOrigin(request); const { projectId, id } = RunParams.parse(request.params); z.strictObject({}).parse(request.body);
    return { run: await requireService(service).cancel(projectId, id) };
  });
}

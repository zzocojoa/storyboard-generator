import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { contractError } from '../domain/errors.js';
import { DocumentReviewInputSchema } from '../documents/review-context.js';
import { ProductionFieldsSchema } from '../documents/review-model.js';
import type { DocumentReviewService } from '../documents/review-service.js';

function requireReviewService(service: DocumentReviewService | null): DocumentReviewService {
  if (service === null) throw contractError('DOCUMENT_REVIEW_SETUP_REQUIRED', '서버의 documentReview 설정에 설치된 Codex App 실행 파일과 검토 저장 경로를 지정하세요.', []);
  return service;
}

function requireLocalOrigin(request: FastifyRequest): void {
  const origin: string | undefined = request.headers.origin;
  if (origin !== undefined && origin !== `http://${request.headers.host}`) throw contractError('FORBIDDEN_DOCUMENT_REVIEW_ORIGIN', '문서 검토는 현재 CUTROOM 화면에서 실행하세요.', []);
}

export function registerDocumentReviewRoutes(app: FastifyInstance, service: DocumentReviewService | null): void {
  app.get('/api/document-reviews/status', async (): Promise<object> => ({ configured: service !== null, activeRequestId: service?.activeRequestId() ?? null }));
  app.get('/api/document-presets', async (): Promise<object> => ({ presets: service === null ? [] : await service.presets() }));
  app.post('/api/document-presets', async (request): Promise<object> => {
    requireLocalOrigin(request);
    const body = z.strictObject({ name: z.string(), fields: ProductionFieldsSchema }).parse(request.body);
    return { preset: await requireReviewService(service).savePreset(body.name, body.fields) };
  });
  app.post('/api/document-reviews', { bodyLimit: 4 * 1024 * 1024 }, async (request, reply): Promise<object> => {
    requireLocalOrigin(request);
    const review = await requireReviewService(service).start(DocumentReviewInputSchema.parse(request.body));
    reply.status(202); return { review };
  });
  app.post('/api/document-reviews/:id/start', { bodyLimit: 4 * 1024 * 1024 }, async (request, reply): Promise<object> => {
    requireLocalOrigin(request);
    const { id } = z.strictObject({ id: z.uuid() }).parse(request.params);
    const review = await requireReviewService(service).startIdentified(id, DocumentReviewInputSchema.parse(request.body));
    reply.status(202); return { review };
  });
  app.get('/api/document-reviews/:id', async (request): Promise<object> => {
    const { id } = z.strictObject({ id: z.uuid() }).parse(request.params);
    return { review: await requireReviewService(service).read(id) };
  });
  app.post('/api/document-reviews/:id/cancel', async (request): Promise<object> => {
    requireLocalOrigin(request);
    const { id } = z.strictObject({ id: z.uuid() }).parse(request.params);
    return { review: await requireReviewService(service).cancel(id) };
  });
  app.post('/api/document-reviews/:id/validate', { bodyLimit: 4 * 1024 * 1024 }, async (request): Promise<object> => {
    requireLocalOrigin(request);
    const { id } = z.strictObject({ id: z.uuid() }).parse(request.params);
    return { review: await requireReviewService(service).validate(id, DocumentReviewInputSchema.parse(request.body)) };
  });
}

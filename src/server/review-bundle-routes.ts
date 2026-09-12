import type { TextFontSource } from '../rendering/text-font-source.js';
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import type { BuildManifest } from '../build.js';
import { contractError } from '../domain/errors.js';
import { IdSchema, HashSchema } from '../domain/schema.js';
import { createReviewDelivery, previewReviewDelivery, REVIEW_WEB_MEDIA_MAX_BYTES } from '../exporters/review-delivery.js';
import { ReviewBundleInputSchema, ReviewDeliveryAttemptSchema, ReviewDeliveryCredentialSchema } from '../exporters/review-delivery-schema.js';
import { verifyReviewDelivery } from '../exporters/review-delivery-recovery.js';
import type { ReviewBundlePreview, ReviewBundleResult } from '../exporters/review-delivery-schema.js';

const ParamsSchema = z.strictObject({ projectId: IdSchema });
const CreateBodySchema = z.strictObject({ input: ReviewBundleInputSchema, basisSha256: HashSchema, credential: ReviewDeliveryCredentialSchema.optional() });

function requireOrigin(request: FastifyRequest): void {
  if (request.headers['sec-fetch-site'] === 'cross-site' || request.headers.origin !== undefined && request.headers.origin !== `http://${request.headers.host}`) {
    throw contractError('FORBIDDEN_REVIEW_DELIVERY_ORIGIN', '검토 패키지 생성은 현재 CUTROOM 화면에서 실행하세요.', []);
  }
}

/** 패키지 I/O는 서버당 하나만 실행하며 HTTP 종료까지 응답을 기다리고 자동 재시도하지 않는다. */
export function registerReviewBundleRoutes(app: FastifyInstance, dataRoot: string, fontPath: TextFontSource, build: BuildManifest): void {
  let activeProjectId: string | null = null;
  const acquire = (projectId: string): void => {
    if (activeProjectId !== null) throw contractError('REVIEW_DELIVERY_BUSY', `다른 패키지를 확인·생성하고 있습니다. projectId=${activeProjectId}. 완료 후 다시 실행하세요.`, []);
    activeProjectId = projectId;
  };
  app.get('/api/review-bundles/status', async (): Promise<{ activeProjectId: string | null; maxMediaBytes: number }> => ({ activeProjectId, maxMediaBytes: REVIEW_WEB_MEDIA_MAX_BYTES }));
  app.post('/api/projects/:projectId/review-bundles/preview', { bodyLimit: 256 * 1024 }, async (request: FastifyRequest, reply: FastifyReply): Promise<ReviewBundlePreview> => {
    requireOrigin(request); const { projectId } = ParamsSchema.parse(request.params); const input = ReviewBundleInputSchema.parse(request.body);
    acquire(projectId);
    try { reply.header('Cache-Control', 'no-store'); return await previewReviewDelivery(dataRoot, projectId, input, fontPath, build); }
    finally { activeProjectId = null; }
  });
  app.post('/api/projects/:projectId/review-bundles', { bodyLimit: 256 * 1024 }, async (request: FastifyRequest, reply: FastifyReply): Promise<ReviewBundleResult> => {
    requireOrigin(request); const { projectId } = ParamsSchema.parse(request.params); const { input, basisSha256, credential } = CreateBodySchema.parse(request.body);
    acquire(projectId);
    try { const result = await createReviewDelivery(dataRoot, projectId, input, basisSha256, fontPath, build, credential ?? null); reply.status(201).header('Cache-Control', 'no-store'); return result; }
    finally { activeProjectId = null; }
  });
  app.post('/api/projects/:projectId/review-bundles/verify', { bodyLimit: 256 * 1024 }, async (request: FastifyRequest, reply: FastifyReply): Promise<ReviewBundleResult> => {
    requireOrigin(request); const { projectId } = ParamsSchema.parse(request.params); const attempt = ReviewDeliveryAttemptSchema.parse(request.body);
    acquire(projectId);
    try { reply.header('Cache-Control', 'no-store'); return await verifyReviewDelivery(projectId, attempt); }
    finally { activeProjectId = null; }
  });
}

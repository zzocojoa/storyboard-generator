import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { IdSchema, MillisecondsSchema } from '../domain/schema.js';
import type { ProducerVisualOutput, ProjectStore } from './store.js';

const Params = z.strictObject({ projectId: IdSchema });
const Query = z.strictObject({
  atMs: z.string().regex(/^\d+$/u).transform(Number).pipe(MillisecondsSchema),
  revision: z.string().regex(/^\d+$/u).transform(Number).pipe(z.number().int().nonnegative()),
});

/** 제작자 검토 경로는 안전 출력 URL과 분리하고 미승인 상태를 응답에 명시한다. */
export function registerProducerReviewRoutes(app: FastifyInstance, store: ProjectStore): void {
  const routes: readonly { path: string; read: (projectId: string, revision: number, atMs: number) => Promise<ProducerVisualOutput> }[] = [
    { path: 'visual', read: (id, revision, atMs) => store.producerVisual(id, revision, atMs) },
    { path: 'transition', read: (id, revision, atMs) => store.producerTransition(id, revision, atMs) },
  ];
  for (const route of routes) app.get(`/api/projects/:projectId/review/${route.path}`, async (request, reply): Promise<Buffer> => {
    const { projectId } = Params.parse(request.params); const query = Query.parse(request.query);
    const output: ProducerVisualOutput = await route.read(projectId, query.revision, query.atMs);
    reply.header('Content-Type', output.mimeType).header('Cache-Control', 'no-store')
      .header('X-Cutroom-Preview', 'producer-review').header('X-Cutroom-Revision', output.revision)
      .header('X-Cutroom-Visual-Review', output.decision.visualReview ?? 'none');
    return output.content;
  });
}

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AudioMixInputSchema, updateAudioMix } from '../domain/audio-mix.js';
import { IdSchema } from '../domain/schema.js';
import type { ProjectStore } from './store.js';

/** 한 음원의 명시적인 음량 설정만 기존 revision 트랜잭션으로 저장한다. */
export function registerAudioMixRoutes(app: FastifyInstance, store: ProjectStore): void {
  app.patch('/api/projects/:projectId/audio/:cueId/mix', async (request): Promise<object> => {
    const { projectId, cueId } = z.strictObject({ projectId: IdSchema, cueId: IdSchema }).parse(request.params);
    const body = z.strictObject({ expectedRevision: z.number().int().nonnegative(), mix: AudioMixInputSchema }).parse(request.body);
    return { project: await store.update(projectId, body.expectedRevision, (current) => updateAudioMix(current, cueId, body.mix), []) };
  });
}

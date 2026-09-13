import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AudioInstructionInputSchema, confirmAudioInstruction, updateAudioInstruction } from '../domain/audio-instructions.js';
import { IdSchema } from '../domain/schema.js';
import type { ProjectStore } from './store.js';

export function registerAudioInstructionRoutes(app: FastifyInstance, store: ProjectStore): void {
  const params = z.strictObject({ projectId: IdSchema, instructionId: IdSchema });
  app.patch('/api/projects/:projectId/audio-instructions/:instructionId', async (request): Promise<object> => {
    const { projectId, instructionId } = params.parse(request.params);
    const body = z.strictObject({ expectedRevision: z.number().int().nonnegative(), decision: AudioInstructionInputSchema.omit({ instructionId: true }) }).parse(request.body);
    return { project: await store.update(projectId, body.expectedRevision, (current) => updateAudioInstruction(current, { ...body.decision, instructionId }, randomUUID()), []) };
  });
  app.post('/api/projects/:projectId/audio-instructions/:instructionId/confirm', async (request): Promise<object> => {
    const { projectId, instructionId } = params.parse(request.params);
    const body = z.strictObject({ expectedRevision: z.number().int().nonnegative() }).parse(request.body);
    return { project: await store.update(projectId, body.expectedRevision, (current) => confirmAudioInstruction(current, instructionId), []) };
  });
}

import type { FastifyInstance } from 'fastify';
import { contractError } from '../domain/errors.js';
import type { Project } from '../domain/schema.js';
import { importPackage } from '../importers/import-package.js';
import { readPackage } from '../io/package.js';
import { createIndependentStoryboard } from '../proposal/independent-storyboard.js';
import { IndependentStoryboardInputSchema } from '../domain/storyboard-creation.js';
import type { ProjectStore } from './store.js';

export function registerIndependentStoryboardRoutes(app: FastifyInstance, store: ProjectStore): void {
  app.post('/api/projects/import-independent', async (request, reply): Promise<{ project: Project }> => {
    const input = IndependentStoryboardInputSchema.parse(request.body);
    const project: Project = createIndependentStoryboard(importPackage(await readPackage(input.handoffPath)), input);
    try {
      const created: Project = await store.create(project);
      reply.status(201);
      return { project: created };
    } catch (error: unknown) {
      if (!(error instanceof Error) || !('code' in error) || error.code !== 'PROJECT_ALREADY_EXISTS') throw error;
      // 응답을 놓친 동일 생성 요청만 재사용하며 이후 편집된 현재본은 보존한다.
      const existing: Project = await store.read(project.projectId);
      if (existing.storyboardIdentity?.creationFingerprint !== project.storyboardIdentity?.creationFingerprint) {
        throw contractError('STORYBOARD_CREATION_CONFLICT', '같은 생성 요청의 입력이 달라졌습니다. 새 콘티 생성으로 다시 시작하세요.', []);
      }
      return { project: existing };
    }
  });
}

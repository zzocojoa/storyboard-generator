import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { createProjectBackup, previewProjectBackup } from '../backup/service.js';
import { readProjectBackup } from '../backup/snapshot.js';
import { BackupSelectionSchema } from '../backup/schema.js';
import type { BackupResult } from '../backup/schema.js';
import { contractError } from '../domain/errors.js';
import { HashSchema, IdSchema } from '../domain/schema.js';

const InputSchema = z.strictObject({ expectedRevision: z.number().int().nonnegative(), selection: BackupSelectionSchema });
const CreateSchema = InputSchema.extend({ basisSha256: HashSchema });
const ParamsSchema = z.strictObject({ projectId: IdSchema });

function requireOrigin(request: FastifyRequest): void {
  if (request.headers['sec-fetch-site'] === 'cross-site' || request.headers.origin !== undefined && request.headers.origin !== `http://${request.headers.host}`) {
    throw contractError('FORBIDDEN_BACKUP_ORIGIN', '백업 작업은 현재 CUTROOM 화면에서 실행하세요.', []);
  }
}

/** 큰 파일 보관·검증은 서버당 하나씩 수행한다. 외부 문서·모델·Project 쓰기를 호출하지 않는다. */
export function registerProjectBackupRoutes(app: FastifyInstance, dataRoot: string): void {
  let active: boolean = false;
  const acquire = (): void => { if (active) throw contractError('BACKUP_BUSY', '다른 백업을 처리하고 있습니다. 완료 후 다시 실행하세요.', []); active = true; };
  app.post('/api/projects/:projectId/backups/preview', { bodyLimit: 16384 }, async (request, reply) => {
    requireOrigin(request); const { projectId } = ParamsSchema.parse(request.params); const input = InputSchema.parse(request.body); acquire();
    try { reply.header('Cache-Control', 'no-store'); return await previewProjectBackup(dataRoot, projectId, input.expectedRevision, input.selection); }
    finally { active = false; }
  });
  app.post('/api/projects/:projectId/backups', { bodyLimit: 16384 }, async (request, reply) => {
    requireOrigin(request); const { projectId } = ParamsSchema.parse(request.params); const input = CreateSchema.parse(request.body); acquire();
    try { const result = await createProjectBackup(dataRoot, projectId, input.expectedRevision, input.selection, input.basisSha256); reply.code(201).header('Cache-Control', 'no-store'); return result; }
    finally { active = false; }
  });
  app.post('/api/projects/:projectId/backups/verify', { bodyLimit: 16384 }, async (request, reply): Promise<BackupResult> => {
    requireOrigin(request); const { projectId } = ParamsSchema.parse(request.params); const { path } = z.strictObject({ path: z.string().min(1).max(4096) }).parse(request.body); acquire();
    try {
      const snapshot = await readProjectBackup(path);
      if (snapshot.manifest.projectId !== projectId) throw contractError('BACKUP_PROJECT_MISMATCH', '선택한 콘티의 백업이 아닙니다. 해당 콘티를 선택한 뒤 검증하세요.', []);
      reply.header('Cache-Control', 'no-store'); return { outputPath: path, manifest: snapshot.manifest, manifestSha256: snapshot.manifestSha256 };
    } finally { active = false; }
  });
}

import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { contractError } from '../domain/errors.js';
import { HashSchema, IdSchema } from '../domain/schema.js';
import type { PackagePayload, Project } from '../domain/schema.js';
import { applySourceUpdate, sourceImpact } from '../domain/source-update.js';
import type { SourceImpactReport } from '../domain/source-update.js';
import { importPackage } from '../importers/import-package.js';
import { sha256Text } from '../importers/integrity.js';
import { readPackage } from '../io/package.js';
import { stableJsonStringify } from '../io/stable-json.js';
import { createSourceOutline } from '../proposal/outline.js';
import type { ProjectStore } from './store.js';

const ParamsSchema = z.strictObject({ projectId: IdSchema });
const SourceUpdateInputSchema = z.strictObject({ handoffPath: z.string().min(1), proposedTextHoldMs: z.number().int().positive(), expectedRevision: z.number().int().nonnegative() });
const ReviewedSourceInputSchema = SourceUpdateInputSchema.extend({ basisSha256: HashSchema });
type SourceUpdateInput = z.infer<typeof SourceUpdateInputSchema>;
type Replacement = { payload: PackagePayload; project: Project };

async function readReplacement(input: SourceUpdateInput): Promise<Replacement> {
  const payload: PackagePayload = await readPackage(input.handoffPath);
  return { payload, project: createSourceOutline(importPackage(payload), { proposedTextHoldMs: input.proposedTextHoldMs }) };
}

function reviewFingerprint(projectId: string, input: SourceUpdateInput, payload: PackagePayload): string {
  return sha256Text(stableJsonStringify({ projectId, input, payload }));
}

async function inspectReplacement(store: ProjectStore, projectId: string, input: SourceUpdateInput): Promise<{ impact: SourceImpactReport; basisSha256: string }> {
  const current: Project = await store.read(projectId);
  if (current.revision !== input.expectedRevision) throw contractError('REVISION_CONFLICT', `${projectId}: expected=${input.expectedRevision}, actual=${current.revision}`, []);
  const replacement: Replacement = await readReplacement(input);
  return { impact: sourceImpact(current, replacement.project), basisSha256: reviewFingerprint(projectId, input, replacement.payload) };
}

async function applyReplacement(store: ProjectStore, projectId: string, input: SourceUpdateInput, incoming: Project): Promise<Project> {
  const prefix: string = `source-update:${randomUUID()}`;
  return store.update(projectId, input.expectedRevision, (current: Project): Project => applySourceUpdate(current, incoming, prefix), []);
}

/** 기존 명시적 교체 API와 웹의 검토 기준 결속 API를 구별한다. 원본·설정이 달라지면 검토를 다시 요구한다. */
export function registerSourceUpdateRoutes(app: FastifyInstance, store: ProjectStore): void {
  app.post('/api/projects/:projectId/source-impact', async (request: FastifyRequest): Promise<object> => {
    const { projectId } = ParamsSchema.parse(request.params);
    const inspected = await inspectReplacement(store, projectId, SourceUpdateInputSchema.parse(request.body));
    return { impact: inspected.impact };
  });
  app.post('/api/projects/:projectId/source-update', async (request: FastifyRequest): Promise<object> => {
    const { projectId } = ParamsSchema.parse(request.params); await store.assertMutable(projectId);
    const input: SourceUpdateInput = SourceUpdateInputSchema.parse(request.body);
    const replacement: Replacement = await readReplacement(input);
    return { project: await applyReplacement(store, projectId, input, replacement.project) };
  });
  app.post('/api/projects/:projectId/source-update/preview', async (request: FastifyRequest): Promise<object> => {
    const { projectId } = ParamsSchema.parse(request.params);
    return inspectReplacement(store, projectId, SourceUpdateInputSchema.parse(request.body));
  });
  app.post('/api/projects/:projectId/source-update/apply', async (request: FastifyRequest): Promise<object> => {
    const { projectId } = ParamsSchema.parse(request.params); await store.assertMutable(projectId);
    const { basisSha256, ...input } = ReviewedSourceInputSchema.parse(request.body);
    const replacement: Replacement = await readReplacement(input);
    if (basisSha256 !== reviewFingerprint(projectId, input, replacement.payload)) {
      throw contractError('SOURCE_REVIEW_STALE', `${projectId}: 확인한 원본·경로·설정·버전과 다릅니다. 변경 영향을 다시 확인하세요.`, []);
    }
    return { project: await applyReplacement(store, projectId, input, replacement.project) };
  });
}

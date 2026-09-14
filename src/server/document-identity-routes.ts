import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { contractError } from '../domain/errors.js';
import { HashSchema } from '../domain/schema.js';
import { sha256Text } from '../importers/integrity.js';
import { readDocumentSources } from '../documents/io.js';
import { readDocumentText } from '../documents/read-file.js';
import { inspectDocuments } from '../documents/compile.js';
import { verifyIdentityEvidence } from '../documents/identity.js';
import { IdentityEvidenceSchema, IDENTITY_FILE_MAX_BYTES } from '../documents/identity-schema.js';
import type { IdentityEvidence, IdentityPreview } from '../documents/identity-schema.js';
import type { SavedIdentityPreview } from '../documents/identity-schema.js';
import type { DocumentReviewService } from '../documents/review-service.js';
import { DocumentBindingsSchema } from '../documents/schema.js';

const IdentityRequestSchema = z.strictObject({ directory: z.string().min(1), sourceFingerprint: HashSchema, bindings: DocumentBindingsSchema,
  charactersPath: z.string().min(1), footprintPath: z.string().min(1) });
const IdentityBasisSchema = IdentityRequestSchema.pick({ directory: true, sourceFingerprint: true, bindings: true });

function requireIdentityOrigin(request: FastifyRequest): void {
  if (request.headers.origin !== undefined && request.headers.origin !== `http://${request.headers.host}`) {
    throw contractError('FORBIDDEN_DOCUMENT_IDENTITY_ORIGIN', '인물 근거 검증은 현재 CUTROOM 화면에서 실행하세요.', []);
  }
}

async function inspectIdentityFiles(input: z.infer<typeof IdentityRequestSchema>): Promise<IdentityPreview> {
  const sources = await readDocumentSources(input.directory);
  const preview = inspectDocuments(sources, input.bindings).preview;
  if (preview.sourceFingerprint !== input.sourceFingerprint) throw contractError('INVALID_IDENTITY_BASIS', '원본 문서가 변경됐습니다. 문서 확인부터 다시 진행하세요.', []);
  const [characters, footprint] = await Promise.all([readDocumentText(input.charactersPath, IDENTITY_FILE_MAX_BYTES), readDocumentText(input.footprintPath, IDENTITY_FILE_MAX_BYTES)]);
  const evidence: IdentityEvidence = { format: 'production-characters-v1', projectId: preview.projectId, sourceFingerprint: preview.sourceFingerprint,
    characters: { sha256: sha256Text(characters), content: characters }, footprint: { sha256: sha256Text(footprint), content: footprint } };
  return { evidence, matches: verifyIdentityEvidence(sources, input.bindings, evidence) };
}

export function registerDocumentIdentityRoutes(app: FastifyInstance, reviews: DocumentReviewService | null): void {
  app.post('/api/document-identities/saved/preview', async (request): Promise<{ saved: SavedIdentityPreview | null }> => {
    requireIdentityOrigin(request);
    const input = IdentityBasisSchema.parse(request.body);
    return { saved: reviews === null ? null : await reviews.findSavedIdentity(input) };
  });
  app.post('/api/document-identities/saved/validate', async (request): Promise<SavedIdentityPreview> => {
    requireIdentityOrigin(request);
    const { reviewId, ...input } = IdentityBasisSchema.extend({ reviewId: z.uuid() }).parse(request.body);
    if (reviews === null) throw contractError('DOCUMENT_REVIEW_SETUP_REQUIRED', '이 서버에는 저장된 문서 검토가 없습니다. 보충 파일을 지정하세요.', []);
    return reviews.validateSavedIdentity(reviewId, input);
  });
  app.post('/api/document-identities/preview', async (request): Promise<IdentityPreview> => {
    requireIdentityOrigin(request);
    return inspectIdentityFiles(IdentityRequestSchema.parse(request.body));
  });
  app.post('/api/document-identities/validate', { bodyLimit: 4 * 1024 * 1024 }, async (request): Promise<IdentityPreview> => {
    requireIdentityOrigin(request);
    const body = IdentityRequestSchema.extend({ evidence: IdentityEvidenceSchema }).parse(request.body);
    const current: IdentityPreview = await inspectIdentityFiles(body);
    if (JSON.stringify(current.evidence) !== JSON.stringify(body.evidence)) throw contractError('INVALID_IDENTITY_CHANGED', '보충 자료가 검토 이후 변경됐습니다. 근거 확인부터 다시 진행하세요.', []);
    return current;
  });
}

import { z } from 'zod';
import { APPLY_INTENT_VERSION } from './storage-contract.js';

const hash = z.string().regex(/^[a-f0-9]{64}$/u);
/** Request Journal에 함께 게시하며 완료 후에도 결과 재시도와 감사의 결속 근거로 보존한다. */
export const ApplyIntentSchema = z.strictObject({
  version: z.literal(APPLY_INTENT_VERSION), operationId: z.uuid(), requestId: z.uuid(), logicalKey: hash,
  projectId: z.string().min(1), kind: z.enum(['proposal', 'image', 'speech']), targetId: z.string().min(1),
  basisHash: hash, generationBuildSha256: hash, resultSha256: hash, generationRecordSha256: hash,
  resultProjectSha256: hash, startRevision: z.number().int().nonnegative(),
  owner: z.strictObject({ transactionId: z.uuid(), host: z.string().min(1), pid: z.number().int().positive() }),
  createdAt: z.iso.datetime(),
});
export type ApplyIntent = z.infer<typeof ApplyIntentSchema>;

export const ApplyStatusSchema = z.strictObject({
  requestId: z.uuid(), projectId: z.string(), requestStatus: z.enum(['pending', 'applying', 'completed', 'failed', 'superseded']),
  state: z.enum(['pending', 'applying', 'committed-awaiting-request-settlement', 'completed', 'failed', 'superseded', 'recovery-required', 'evidence-conflict']),
  committedRevision: z.number().int().nonnegative().nullable(), code: z.string().nullable(),
});
export type ApplyStatus = z.infer<typeof ApplyStatusSchema>;

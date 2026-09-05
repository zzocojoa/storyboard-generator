import { z } from 'zod';
import type { SegmentProposal } from '../proposal/model.js';

export const CodexRequestKindSchema = z.enum(['proposal', 'image', 'speech']);
export const CodexRequestStatusSchema = z.enum(['pending', 'completed', 'failed']);
export const CodexRequestSchema = z.strictObject({
  id: z.uuid(), kind: CodexRequestKindSchema, projectId: z.string().min(1), targetId: z.string().min(1),
  basisHash: z.string().regex(/^[a-f0-9]{64}$/u), status: CodexRequestStatusSchema,
  createdAt: z.iso.datetime(), updatedAt: z.iso.datetime(), resultRevision: z.number().int().nonnegative().nullable(),
  error: z.strictObject({ code: z.string().min(1), message: z.string().min(1) }).nullable(),
});

export type CodexRequestKind = z.infer<typeof CodexRequestKindSchema>;
export type CodexRequestStatus = z.infer<typeof CodexRequestStatusSchema>;
export type CodexRequest = z.infer<typeof CodexRequestSchema>;

export type GeneratedImage = {
  bytes: Buffer; provider: 'codex-app'; prompt: string; model: string; requestId: string;
  mimeType: 'image/png'; referenceHashes: string[];
};
export type GeneratedSpeech = {
  bytes: Buffer; provider: 'codex-app'; prompt: string; model: string; requestId: string; mimeType: 'audio/wav';
};
export type ProposedSegment = {
  proposal: SegmentProposal; provider: 'codex-app'; prompt: string; model: string; requestId: string;
};

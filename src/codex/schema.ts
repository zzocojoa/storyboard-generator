import type { GeneratorBuildProvenance } from '../domain/schema.js';
import type { SegmentProposal } from '../proposal/model.js';
export { CodexRequestSchema, CodexRequestKindSchema, CodexRequestStatusSchema } from './request-schema.js';
export type { CodexRequest, CodexRequestKind, CodexRequestStatus } from './request-schema.js';

export type GeneratedImage = {
  generatorBuild: GeneratorBuildProvenance; bytes: Buffer; provider: 'codex-app'; prompt: string; model: string; requestId: string;
  mimeType: 'image/png'; referenceHashes: string[];
};
export type GeneratedSpeech = {
  generatorBuild: GeneratorBuildProvenance; bytes: Buffer; provider: 'codex-app'; prompt: string; model: string; requestId: string; mimeType: 'audio/wav';
};
export type ProposedSegment = {
  generatorBuild: GeneratorBuildProvenance; proposal: SegmentProposal; provider: 'codex-app'; prompt: string; model: string; requestId: string;
};

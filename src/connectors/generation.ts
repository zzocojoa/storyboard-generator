import type { ImageContext, SegmentContext } from '../proposal/context.js';
import type { SegmentProposal } from '../proposal/model.js';

export type GeneratedImage = {
  bytes: Buffer; prompt: string; model: string; requestId: string | null; mimeType: 'image/png'; referenceHashes: string[];
};
export type GeneratedSpeech = {
  bytes: Buffer; prompt: string; model: string; requestId: string | null; mimeType: 'audio/wav';
};
export type ProposedSegment = {
  proposal: SegmentProposal; prompt: string; model: string; requestId: string | null;
};
export type ImageReference = { id: string; bytes: Buffer; mimeType: string; sha256: string };

export interface GenerationConnector {
  propose(context: SegmentContext): Promise<ProposedSegment>;
  image(context: ImageContext, references: readonly ImageReference[]): Promise<GeneratedImage>;
  speech(text: string): Promise<GeneratedSpeech>;
}

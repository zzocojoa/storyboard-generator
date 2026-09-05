import { contractError } from '../domain/errors.js';
import type { AudioCue, Project, Segment, SourceUnit } from '../domain/schema.js';
import { sha256Text } from '../importers/integrity.js';
import { buildFrameImageContext, buildSegmentContext } from '../proposal/context.js';
import type { ImageContext, SegmentContext } from '../proposal/context.js';
import type { ProjectStore } from '../server/store.js';
import type { CodexRequest, CodexRequestKind } from './schema.js';

export type SpeechContext = {
  projectId: string; cue: Pick<AudioCue, 'id' | 'kind' | 'startMs' | 'endMs'>;
  unit: Pick<SourceUnit, 'id' | 'text' | 'speakerId'>; segment: Pick<Segment, 'id' | 'endMs'>;
};
export type CodexReference = { id: string; path: string; mimeType: string; sha256: string };
export type ProposalWork = { kind: 'proposal'; request: CodexRequest; prompt: string; context: SegmentContext };
export type ImageWork = { kind: 'image'; request: CodexRequest; prompt: string; context: ImageContext; references: CodexReference[] };
export type SpeechWork = { kind: 'speech'; request: CodexRequest; prompt: string; context: SpeechContext };
export type CodexWork = ProposalWork | ImageWork | SpeechWork;

function requireSpeechContext(project: Project, cueId: string): SpeechContext {
  const cue: AudioCue | undefined = project.audioCues.find((candidate: AudioCue): boolean => candidate.id === cueId);
  if (cue === undefined) throw contractError('AUDIO_CUE_NOT_FOUND', `오디오 큐를 찾을 수 없습니다: ${cueId}`, []);
  if (!['dialogue', 'voiceover', 'panel'].includes(cue.kind)) throw contractError('SPEECH_CUE_REQUIRED', `${cueId}: 대사·내레이션·패널 발화만 가이드 음성으로 만들 수 있습니다.`, []);
  const unit: SourceUnit | undefined = project.dataset.units.find((candidate: SourceUnit): boolean => candidate.id === cue.unitId);
  if (unit === undefined) throw contractError('SOURCE_UNIT_NOT_FOUND', `오디오 큐의 원문을 찾을 수 없습니다: ${cue.unitId}`, []);
  const segment: Segment | undefined = project.dataset.segments.find((candidate: Segment): boolean => candidate.id === unit.segmentId);
  if (segment === undefined) throw contractError('SEGMENT_NOT_FOUND', `원문의 구간을 찾을 수 없습니다: ${unit.segmentId}`, []);
  return { projectId: project.projectId, cue: { id: cue.id, kind: cue.kind, startMs: cue.startMs, endMs: cue.endMs },
    unit: { id: unit.id, text: unit.text, speakerId: unit.speakerId }, segment: { id: segment.id, endMs: segment.endMs } };
}

function contextFor(project: Project, kind: CodexRequestKind, targetId: string): SegmentContext | ImageContext | SpeechContext {
  if (kind === 'proposal') return buildSegmentContext(project, targetId);
  if (kind === 'image') return buildFrameImageContext(project, targetId);
  return requireSpeechContext(project, targetId);
}

export function codexRequestBasis(project: Project, kind: CodexRequestKind, targetId: string): string {
  return sha256Text(JSON.stringify(contextFor(project, kind, targetId)));
}

function proposalPrompt(context: SegmentContext): string {
  return `현재 구간의 원문과 제작 지시만 사용해 촬영 가능한 컷 제안을 작성하세요. sourceUnitIds로 모든 원문 단위를 빠짐없이 한 번 이상 연결하고 원문을 바꾸지 마세요. 미래 정보나 다른 구간의 내용을 넣지 마세요. 결과는 SegmentProposal 스키마에 맞는 JSON이어야 합니다.\n\n${JSON.stringify(context, null, 2)}`;
}

function imagePrompt(context: ImageContext): string {
  return `영상 콘티용 단일 프레임을 만드세요. 프로젝트 화면비 ${context.profile.aspectWidth}:${context.profile.aspectHeight}와 시각 스타일 ${context.profile.visualStyle ?? '미정'}을 따르세요. 컷의 행동·구도·인물 상태·연속성을 정확히 표현하세요. 이미지 안에 글자, 자막, 말풍선, 워터마크를 넣지 마세요. 화면 글자는 별도 트랙에서 합성합니다. 허용된 정보만 시각화하세요.\n\n${JSON.stringify(context, null, 2)}`;
}

function speechPrompt(context: SpeechContext): string {
  return `한국어 영상 제작용 가이드 음성입니다. 다음 원문을 바꾸거나 덧붙이지 말고 또렷하고 자연스럽게 읽으세요.\n\n${context.unit.text}`;
}

export async function buildCodexWork(request: CodexRequest, project: Project, store: ProjectStore): Promise<CodexWork> {
  const actualHash: string = codexRequestBasis(project, request.kind, request.targetId);
  if (actualHash !== request.basisHash) throw contractError('CODEX_REQUEST_STALE', `${request.id}: 요청 이후 대상 내용이 바뀌었습니다. 새 생성 요청을 만드세요.`, []);
  if (request.kind === 'proposal') {
    const context: SegmentContext = buildSegmentContext(project, request.targetId);
    return { kind: 'proposal', request, context, prompt: proposalPrompt(context) };
  }
  if (request.kind === 'image') {
    const context: ImageContext = buildFrameImageContext(project, request.targetId);
    const references: CodexReference[] = await Promise.all(context.visualReferences.map(async (reference): Promise<CodexReference> => {
      const asset = await store.asset(project.projectId, reference.id);
      return { id: reference.id, path: await store.assetPath(project.projectId, reference.id), mimeType: asset.mimeType, sha256: reference.sha256 };
    }));
    return { kind: 'image', request, context, references, prompt: imagePrompt(context) };
  }
  const context: SpeechContext = requireSpeechContext(project, request.targetId);
  return { kind: 'speech', request, context, prompt: speechPrompt(context) };
}

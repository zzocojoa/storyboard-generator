import { attachAudioAsset } from './audio-asset.js';
import { assertNoErrors, contractError } from './errors.js';
import { inspectImageBytes, wavDurationMs } from './media-inspection.js';
import type { Asset, AudioCue, GenerationRecord, Project, StoryboardFrame } from './schema.js';
import { ProjectSchema } from './schema.js';
import { validateProject } from './validation.js';
import { sha256Text } from '../importers/integrity.js';
import type { GeneratedImage, GeneratedSpeech, ProposedSegment } from '../codex/schema.js';
import { applySegmentProposal } from '../proposal/model.js';

export { wavDurationMs };

export type GeneratedMutation = { project: Project; relativePath: string | null; content: Buffer | null };
export type ReferenceAssetInput = {
  id: string;
  kind: 'character' | 'location' | 'prop';
  subjectId: string | null;
  description: string;
  mimeType: 'image/png' | 'image/jpeg' | 'image/webp';
  bytes: Buffer;
};

function finalize(before: Project, input: Project): Project {
  const project: Project = ProjectSchema.parse(input);
  assertNoErrors(validateProject(project, before.dataset), 'INVALID_GENERATION_RESULT');
  return project;
}

function requireUniqueGenerationId(project: Project, generationId: string): void {
  if (project.generationRecords.some((record: GenerationRecord): boolean => record.id === generationId)) {
    throw contractError('DUPLICATE_GENERATION_ID', `생성 작업 ID가 이미 존재합니다: ${generationId}`, []);
  }
}

function generationRecord(
  id: string,
  result: { provider: string; prompt: string; model: string; requestId: string | null },
  resultAssetIds: readonly string[],
  shotIds: readonly string[],
  referenceHashes: readonly string[],
  createdAt: string,
): GenerationRecord {
  return {
    id, provider: result.provider, model: result.model, modelVersion: null, requestId: result.requestId,
    prompt: result.prompt, templateVersion: '1.0.0', seed: null, referenceHashes: [...referenceHashes],
    resultAssetIds: [...resultAssetIds], shotIds: [...shotIds], createdAt,
  };
}

export function applyGeneratedProposal(
  project: Project, segmentId: string, generationId: string, createdAt: string, result: ProposedSegment,
): GeneratedMutation {
  requireUniqueGenerationId(project, generationId);
  const proposed: Project = applySegmentProposal(project, segmentId, result.proposal, generationId);
  const shotIds: string[] = proposed.shots.filter((shot): boolean => shot.segmentId === segmentId).map((shot): string => shot.id);
  const record: GenerationRecord = generationRecord(generationId, result, [], shotIds, [], createdAt);
  return { project: finalize(project, { ...proposed, generationRecords: [...proposed.generationRecords, record] }), relativePath: null, content: null };
}

export async function applyGeneratedImage(
  project: Project, frameId: string, generationId: string, createdAt: string, result: GeneratedImage,
): Promise<GeneratedMutation> {
  requireUniqueGenerationId(project, generationId);
  const frame: StoryboardFrame | undefined = project.frames.find((candidate: StoryboardFrame): boolean => candidate.id === frameId);
  if (frame === undefined) throw contractError('FRAME_NOT_FOUND', `프레임을 찾을 수 없습니다: ${frameId}`, []);
  const shot = project.shots.find((candidate): boolean => candidate.id === frame.shotId);
  if (shot === undefined) throw contractError('SHOT_NOT_FOUND', `프레임의 컷을 찾을 수 없습니다: ${frame.shotId}`, []);
  if (shot.lockedFields.includes('frames')) throw contractError('SHOT_FIELD_LOCKED', `${shot.id}: frames 필드를 먼저 잠금 해제하세요.`, []);
  const inspected = await inspectImageBytes(result.bytes, result.mimeType);
  const assetId: string = `${generationId}:image`;
  if (project.assets.some((asset: Asset): boolean => asset.id === assetId)) throw contractError('DUPLICATE_ASSET_ID', `자산 ID가 이미 존재합니다: ${assetId}`, []);
  const prior: Asset | undefined = frame.imageAssetId === null ? undefined : project.assets.find((asset: Asset): boolean => asset.id === frame.imageAssetId);
  const extension: string = inspected.mimeType === 'image/png' ? 'png' : inspected.mimeType === 'image/jpeg' ? 'jpg' : 'webp';
  const relativePath: string = `assets/${sha256Text(assetId)}.${extension}`;
  const asset: Asset = { id: assetId, kind: 'image', subjectId: frame.id, path: relativePath, mimeType: inspected.mimeType,
    sha256: inspected.sha256, description: `${frame.description} · ${inspected.width}×${inspected.height}`, durationMs: null, version: (prior?.version ?? 0) + 1 };
  const record: GenerationRecord = generationRecord(generationId, result, [assetId], [shot.id], result.referenceHashes, createdAt);
  const next: Project = { ...project, assets: [...project.assets, asset],
    frames: project.frames.map((candidate: StoryboardFrame): StoryboardFrame => candidate.id === frameId ? { ...candidate, imageAssetId: assetId, visualReview: 'pending' } : candidate),
    generationRecords: [...project.generationRecords, record] };
  return { project: finalize(project, next), relativePath, content: result.bytes };
}

export function applyGeneratedSpeech(
  project: Project, cueId: string, generationId: string, createdAt: string, result: GeneratedSpeech,
): GeneratedMutation {
  requireUniqueGenerationId(project, generationId);
  const cue: AudioCue | undefined = project.audioCues.find((candidate: AudioCue): boolean => candidate.id === cueId);
  if (cue === undefined) throw contractError('AUDIO_CUE_NOT_FOUND', `오디오 큐를 찾을 수 없습니다: ${cueId}`, []);
  if (!['dialogue', 'voiceover', 'panel'].includes(cue.kind)) throw contractError('SPEECH_CUE_REQUIRED', `${cueId}: 대사·내레이션·패널 발화만 가이드 음성으로 만들 수 있습니다.`, []);
  const attached = attachAudioAsset(project, cueId, `${generationId}:audio`, {
    originalFileName: `${generationId}.wav`, declaredMimeType: result.mimeType, bytes: result.bytes,
  });
  const unit = project.dataset.units.find((candidate): boolean => candidate.id === cue.unitId);
  if (unit === undefined) throw contractError('SOURCE_UNIT_NOT_FOUND', `오디오 큐의 원문을 찾을 수 없습니다: ${cue.unitId}`, []);
  const shotIds: string[] = project.shots.filter((shot): boolean => shot.sourceLinks.some((link): boolean => link.unitId === unit.id)).map((shot): string => shot.id);
  const record: GenerationRecord = generationRecord(generationId, result, [`${generationId}:audio`], shotIds, [], createdAt);
  return { ...attached, project: finalize(project, { ...attached.project, generationRecords: [...attached.project.generationRecords, record] }) };
}

export async function addReferenceAsset(project: Project, input: ReferenceAssetInput): Promise<GeneratedMutation> {
  if (project.assets.some((asset: Asset): boolean => asset.id === input.id)) throw contractError('DUPLICATE_ASSET_ID', `자산 ID가 이미 존재합니다: ${input.id}`, []);
  const inspected = await inspectImageBytes(input.bytes, input.mimeType);
  const validSubject: boolean = input.kind === 'character' ? input.subjectId !== null && project.dataset.people.some((person): boolean => person.id === input.subjectId)
    : input.kind === 'location' ? input.subjectId !== null && project.dataset.locations.some((location): boolean => location.id === input.subjectId) : true;
  if (!validSubject) throw contractError('INVALID_REFERENCE_SUBJECT', `${input.kind}: 연결 대상을 프로젝트에서 찾을 수 없습니다. subjectId=${input.subjectId ?? 'null'}`, []);
  const extension: string = inspected.mimeType === 'image/png' ? 'png' : inspected.mimeType === 'image/jpeg' ? 'jpg' : 'webp';
  const relativePath: string = `assets/${sha256Text(input.id)}.${extension}`;
  const version: number = Math.max(0, ...project.assets.filter((asset: Asset): boolean => asset.kind === input.kind && asset.subjectId === input.subjectId).map((asset: Asset): number => asset.version)) + 1;
  const asset: Asset = { id: input.id, kind: input.kind, subjectId: input.subjectId, path: relativePath, mimeType: inspected.mimeType,
    sha256: inspected.sha256, description: `${input.description} · ${inspected.width}×${inspected.height}`, durationMs: null, version };
  const affectedShotIds: Set<string> = new Set<string>(project.shots.filter((shot): boolean =>
    (input.kind === 'character' && input.subjectId !== null && shot.presence.some((presence): boolean => presence.personId === input.subjectId))
    || (input.kind === 'location' && input.subjectId !== null && shot.visualLocationId === input.subjectId),
  ).map((shot): string => shot.id));
  return { project: finalize(project, { ...project, assets: [...project.assets, asset],
    shots: project.shots.map((shot): typeof shot => affectedShotIds.has(shot.id) ? { ...shot, approvalStatus: 'proposed' } : shot),
    frames: project.frames.map((frame: StoryboardFrame): StoryboardFrame => affectedShotIds.has(frame.shotId) ? { ...frame, visualReview: 'pending' } : frame) }), relativePath, content: input.bytes };
}

import { storyboardAudioIssues } from '../domain/audio-storyboard.js';
import { audioInstructions } from '../domain/audio-instructions.js';
import { audioCueSource } from '../domain/audio-source.js';
import type { TextTypography } from '../domain/text-typography.js';
import type { TextFontSource } from '../rendering/text-font-source.js';
import { audioMixValues } from '../domain/audio-mix.js';
import sharp from 'sharp';
import { renderStoryboardPdf } from './pdf-renderer.js';
import { initialOutputOptions, outputSelectionLabel, selectedOutputFrames } from './output-options.js';
import type { PdfFormat, StoryboardOutputOptions } from './output-options.js';
import { reviewTextOutput } from '../domain/output-policy.js';
import type { OutputPolicy } from '../domain/output-policy.js';
import { assertFinalReadiness, reviewFinalReadiness } from '../domain/final-readiness.js';
import type { AssetIntegrityStatuses } from '../domain/final-readiness.js';
import { reviewShotVisualTimeline } from '../domain/visual-output.js';
import { contractError } from '../domain/errors.js';
import { frameOutputPlaceholderText, reviewFrameOutput } from '../domain/frame-output.js';
import type { FrameOutputDecision } from '../domain/frame-output.js';
import { effectiveInformationGate } from '../domain/mapping.js';
import type { EffectiveInformationGate } from '../domain/mapping.js';
import { reviewTextPlaybackWithPolicy } from '../domain/playback.js';
import { withProjectTextReadiness } from '../rendering/project-text.js';
import type { TextLayoutInput } from '../rendering/text-layout.js';
import type { TextLayoutPreset } from '../domain/text-layout-settings.js';
import type { AudioCue, Issue, Project, Shot, StoryboardFrame, TextCue } from '../domain/schema.js';
import { formatAbsoluteProjectTimecode, frameDisplayAbsoluteMs, frameEvaluationAbsoluteMs } from '../domain/time.js';

export type AssetLoader = (assetId: string) => Promise<Buffer>;
export type PdfTrackEntry = { id: string; label: string; timeText: string; body: string; statusText: string };

export type PdfFramePageItem = {
  image: Buffer | null; renderMode: FrameOutputDecision['renderMode'];
  shotId: string; frameId: string; timeText: string; cameraText: string; action: string; frameText: string;
  sourceText: string; gateText: string; outputText: string; placeholderText: string; description: string;
  textEntries: PdfTrackEntry[]; audioEntries: PdfTrackEntry[];
  overlayInputs: TextLayoutInput[];
};
export type PdfProjection = { title: string; outputLabel: string; aspectWidth: number; aspectHeight: number; revision: number; textLayout: TextLayoutPreset; textTypography?: TextTypography; items: PdfFramePageItem[]; format?: PdfFormat; selectionLabel?: string };
type PdfImageLoader = (assetId: string) => Promise<Buffer | null>;

function trackTimeText(project: Project, startMs: number, endMs: number): string {
  return `${formatAbsoluteProjectTimecode(startMs, project.handoff.timebase)} - ${formatAbsoluteProjectTimecode(endMs, project.handoff.timebase)} (${startMs}..${endMs}ms)`;
}

export function textTrackEntry(project: Project, cue: TextCue, policy: OutputPolicy): PdfTrackEntry {
  const output = reviewTextOutput(project, cue.id, policy);
  return { id: cue.id, label: cue.kind.toUpperCase(), timeText: trackTimeText(project, cue.startMs, cue.endMs),
    body: output.allowed ? cue.text : '[OUTPUT BLOCKED]',
    statusText: output.allowed ? output.label : output.issues.map((value): string => value.code).join(', ') };
}

export function audioTrackEntry(project: Project, cue: AudioCue): PdfTrackEntry {
  const issues: Issue[] = storyboardAudioIssues(project, cue);
  const allowed: boolean = issues.length === 0;
  const unit = audioCueSource(project, cue);
  if (allowed && unit === null) throw contractError('AUDIO_SOURCE_CONTEXT_MISSING', `${cue.id}: PDF 음향 원문 ${cue.instructionId ?? cue.unitId}를 찾을 수 없습니다.`, []);
  const mix = audioMixValues(cue);
  return { id: cue.id, label: cue.kind.toUpperCase(), timeText: `${trackTimeText(project, cue.startMs, cue.endMs)} · ${cue.timingRelation} · ${mix.volumeDb}dB · FADE ${mix.fadeInMs}/${mix.fadeOutMs}ms`,
    body: allowed && unit !== null ? unit.text : '[OUTPUT BLOCKED]',
    statusText: allowed ? cue.timingStatus === 'measured' ? 'MEASURED · GUIDE AUDIO' : 'STORYBOARD TIMING · AUDIO OPTIONAL' : issues.map((value): string => value.code).join(', ') };
}

function assetErrorCode(error: unknown): string | null {
  if (!(error instanceof Error) || !('code' in error) || typeof error.code !== 'string') return null;
  return error.code.startsWith('ASSET_') || error.code.startsWith('STORED_ASSET_') || error.code.startsWith('STORED_AUDIO_')
    ? error.code : null;
}

/** PDF의 흰 배경에서 합성한 불투명 PNG로 비동기 alpha 삽입의 객체 순서 변화를 제거한다. */
async function pdfRaster(bytes: Buffer): Promise<Buffer> {
  return sharp(bytes).flatten({ background: '#ffffff' }).removeAlpha().toColourspace('srgb')
    .png({ compressionLevel: 9, adaptiveFiltering: false, progressive: false, palette: false }).toBuffer();
}

async function pageItems(project: Project, loadImage: PdfImageLoader, policy: OutputPolicy, options: StoryboardOutputOptions): Promise<PdfFramePageItem[]> {
  const orderedFrames: StoryboardFrame[] = selectedOutputFrames(project, options);
  return Promise.all(orderedFrames.map(async (frame: StoryboardFrame): Promise<PdfFramePageItem> => {
    const shot: Shot | undefined = project.shots.find((candidate: Shot): boolean => candidate.id === frame.shotId);
    if (shot === undefined) throw contractError('SHOT_NOT_FOUND', `${frame.id}: PDF 출력용 Shot을 찾을 수 없습니다.`, []);
    const frameDecision: FrameOutputDecision = reviewFrameOutput(project, frame.id, 'pdf-export');
    const frameIssues: Issue[] = [...frameDecision.issues, ...reviewShotVisualTimeline(project, shot, 'pdf-export')];
    const sourceText: string = frameIssues.length > 0 ? '[OUTPUT BLOCKED]' : shot.sourceLinks.map((link): string => `[${link.usage}/${link.status}/${link.temporalAnchor.kind}:${link.temporalAnchor.basis}] ${project.dataset.units.find((unit): boolean => unit.id === link.unitId)?.text ?? link.unitId}`).join(' / ');
    const gates: EffectiveInformationGate[] = project.dataset.informationRules.filter((rule): boolean => rule.segmentId === shot.segmentId)
      .map((rule): EffectiveInformationGate => effectiveInformationGate(project, rule.id));
    const gateText: string = gates.map((gate: EffectiveInformationGate): string => `${gate.id} B${gate.baseNotBeforeMs}→E${gate.effectiveNotBeforeMs} ${gate.evidenceType}${gate.reviewRequired ? ' REVIEW' : ''}`).join(' / ');
    const audioIssues: Issue[] = project.audioCues.filter((cue): boolean => cue.startMs < shot.endMs && cue.endMs > shot.startMs)
      .flatMap((cue): Issue[] => storyboardAudioIssues(project, cue));
    const textIssues: Issue[] = project.textCues.filter((cue: TextCue): boolean => cue.startMs < shot.endMs && cue.endMs > shot.startMs)
      .flatMap((cue: TextCue): Issue[] => reviewTextOutput(project, cue.id, policy).issues);
    let image: Buffer | null = null;
    let integrityCode: string | null = null;
    if (frameIssues.length === 0 && frameDecision.renderBitmap && frameDecision.imageAssetId !== null) {
      try {
        image = await loadImage(frameDecision.imageAssetId);
      } catch (error: unknown) {
        integrityCode = assetErrorCode(error);
        if (integrityCode === null || policy.maturity === 'final') throw error;
      }
    }
    const codes: string[] = [...new Set([...frameIssues, ...textIssues, ...audioIssues].map((value: Issue): string => value.code))];
    if (integrityCode !== null) codes.push(integrityCode);
    const unconfirmed: boolean = project.textCues.some((cue: TextCue): boolean => cue.startMs < shot.endMs && cue.endMs > shot.startMs && cue.timingStatus === 'proposed');
    const outputText: string = codes.length === 0 ? policy.maturity === 'final' ? 'FINAL · OUTPUT SAFE' : unconfirmed ? 'DRAFT · TIMING UNCONFIRMED' : 'DRAFT' : `DRAFT · OUTPUT INTERLOCK REVIEW REQUIRED · ${codes.join(', ')}`;
    const placeholderText: string = integrityCode === null ? frameOutputPlaceholderText({ ...frameDecision, issues: frameIssues }, frame.description)
      : `Frame ID: ${frame.id}\nAsset ID: ${frameDecision.imageAssetId ?? 'NONE'}\nIssue: ${integrityCode}`;
    return { image, renderMode: integrityCode !== null || frameIssues.length > 0 || (frameDecision.imageAssetId !== null && image === null) ? 'blocked' : frameDecision.renderMode,
      shotId: shot.id, frameId: frame.id, timeText: `${formatAbsoluteProjectTimecode(shot.startMs, project.handoff.timebase)} – ${formatAbsoluteProjectTimecode(shot.endMs, project.handoff.timebase)}`,
      cameraText: `${shot.visualMode.toUpperCase()} · ${shot.camera.size} · ${shot.camera.angle} · ${shot.camera.move}\n${shot.transitionOut.kind.toUpperCase()} ${shot.transitionOut.durationMs}ms`,
      action: shot.action, frameText: `${frame.id} · ${frame.role.toUpperCase()} · ${frame.visualReview.toUpperCase()} · DISPLAY ${frameDisplayAbsoluteMs(shot, frame)} · EVAL ${frameEvaluationAbsoluteMs(shot, frame)}`,
      sourceText, gateText, outputText, placeholderText, description: frame.description,
      textEntries: project.textCues.filter((cue): boolean => cue.startMs < shot.endMs && cue.endMs > shot.startMs).map((cue): PdfTrackEntry => textTrackEntry(project, cue, policy)),
      overlayInputs: reviewTextPlaybackWithPolicy(project, frameEvaluationAbsoluteMs(shot, frame), policy).playable.map(({ id, kind, text, presentation }): TextLayoutInput => ({ id, kind, text, ...(presentation === undefined ? {} : { presentation }) })),
      audioEntries: [...project.audioCues.filter((cue): boolean => cue.startMs < shot.endMs && cue.endMs > shot.startMs).map((cue): PdfTrackEntry => audioTrackEntry(project, cue)),
        ...audioInstructions(project).filter((instruction): boolean => instruction.segmentId === shot.segmentId).map((instruction): PdfTrackEntry => ({
          id: instruction.id, label: `${instruction.kind.toUpperCase()} DIRECTION`, timeText: `SEGMENT ${instruction.segmentId}`, body: instruction.text,
          statusText: (project.audioInstructionDecisions ?? []).find((decision): boolean => decision.instructionId === instruction.id)?.reviewStatus === 'confirmed' ? 'REVIEWED DIRECTION' : 'DIRECTION · REVIEW REQUIRED',
        }))] };
  }));
}

/** 현재 컷 순서와 프레임을 A4 가로형 제작 콘티로 렌더링한다. */
export async function exportProjectPdf(project: Project, fontPath: TextFontSource, loadAsset: AssetLoader): Promise<Buffer> {
  return exportProjectPdfForPolicy(project, fontPath, loadAsset, { maturity: 'draft', channel: 'pdf-export' }, {});
}

export async function exportProjectPdfForPolicy(project: Project, fontPath: TextFontSource, loadAsset: AssetLoader, policy: OutputPolicy, integrity: AssetIntegrityStatuses): Promise<Buffer> {
  return exportProjectPdfAt(project, fontPath, loadAsset, policy, integrity, new Date().toISOString());
}

/** 검증은 원본에서 끝내고 렌더러에는 출력용 자료만 전달한다. */
export async function createPdfProjection(project: Project, loadAsset: AssetLoader, policy: OutputPolicy, integrity: AssetIntegrityStatuses): Promise<PdfProjection> {
  return createSelectedPdfProjection(project, loadAsset, policy, integrity, initialOutputOptions());
}

export async function createSelectedPdfProjection(project: Project, loadAsset: AssetLoader, policy: OutputPolicy, integrity: AssetIntegrityStatuses, options: StoryboardOutputOptions): Promise<PdfProjection> {
  if (policy.maturity === 'final') assertFinalReadiness(reviewFinalReadiness(project, integrity));
  const items: PdfFramePageItem[] = await pageItems(project, async (id: string): Promise<Buffer> => pdfRaster(await loadAsset(id)), policy, options);
  return { title: project.title, outputLabel: policy.exportLabel ?? policy.maturity.toUpperCase(), aspectWidth: project.profile.aspectWidth, aspectHeight: project.profile.aspectHeight, revision: project.revision, textLayout: project.textLayout, ...(project.textTypography === undefined ? {} : { textTypography: project.textTypography }), items, format: options.pdf, selectionLabel: outputSelectionLabel(project, options) };
}

/** 외부 검토는 원본의 안전 판정만 사용하고 bitmap을 로드하지 않는다. */
export async function createPdfTextProjection(project: Project, policy: OutputPolicy, integrity: AssetIntegrityStatuses): Promise<PdfProjection> {
  return createSelectedPdfTextProjection(project, policy, integrity, initialOutputOptions());
}

export async function createSelectedPdfTextProjection(project: Project, policy: OutputPolicy, integrity: AssetIntegrityStatuses, options: StoryboardOutputOptions): Promise<PdfProjection> {
  if (policy.maturity === 'final') assertFinalReadiness(reviewFinalReadiness(project, integrity));
  const items: PdfFramePageItem[] = await pageItems(project, async (): Promise<null> => null, policy, options);
  return { title: project.title, outputLabel: policy.exportLabel ?? policy.maturity.toUpperCase(), aspectWidth: project.profile.aspectWidth, aspectHeight: project.profile.aspectHeight, revision: project.revision, textLayout: project.textLayout, ...(project.textTypography === undefined ? {} : { textTypography: project.textTypography }), format: options.pdf, selectionLabel: outputSelectionLabel(project, options),
    items: items.map((item: PdfFramePageItem): PdfFramePageItem => ({ ...item, overlayInputs: [], placeholderText: 'EXTERNAL REDACTED · IMAGE PLACEHOLDER' })) };
}

export async function exportProjectPdfAt(project: Project, fontPath: TextFontSource, loadAsset: AssetLoader, policy: OutputPolicy, integrity: AssetIntegrityStatuses, createdAt: string): Promise<Buffer> {
  if (policy.maturity === 'final') assertFinalReadiness(await withProjectTextReadiness(project, reviewFinalReadiness(project, integrity), fontPath));
  return renderPdfProjection(await createPdfProjection(project, loadAsset, policy, integrity), fontPath, createdAt);
}

/** 비식별화된 출력 자료를 Project로 재검증하거나 저장하지 않고 렌더링한다. */
export async function renderPdfProjection(projection: PdfProjection, fontPath: TextFontSource, createdAt: string): Promise<Buffer> {
  return renderStoryboardPdf(projection, fontPath, createdAt);
}

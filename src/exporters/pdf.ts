import PDFDocument from 'pdfkit';
import { reviewIssuesForTextCue } from '../domain/emission.js';
import { contractError } from '../domain/errors.js';
import { frameOutputPlaceholderText, reviewFrameOutput } from '../domain/frame-output.js';
import type { FrameOutputDecision } from '../domain/frame-output.js';
import { effectiveInformationGate } from '../domain/mapping.js';
import type { EffectiveInformationGate } from '../domain/mapping.js';
import { reviewAudioPlaybackAt } from '../domain/playback.js';
import type { BlockedCue } from '../domain/playback.js';
import type { Issue, Project, Shot, StoryboardFrame, TextCue } from '../domain/schema.js';
import { formatMilliseconds, frameDisplayAbsoluteMs, frameEvaluationAbsoluteMs } from '../domain/time.js';

export type AssetLoader = (assetId: string) => Promise<Buffer>;

type FramePageItem = {
  frame: StoryboardFrame; shot: Shot; image: Buffer | null; sourceText: string; gateText: string; outputText: string; placeholderText: string;
};
type FrameRect = { x: number; y: number; width: number; height: number };

function assetErrorCode(error: unknown): string | null {
  if (!(error instanceof Error) || !('code' in error) || typeof error.code !== 'string') return null;
  return error.code.startsWith('ASSET_') ? error.code : null;
}

async function pageItems(project: Project, loadAsset: AssetLoader): Promise<FramePageItem[]> {
  const orderedFrames: StoryboardFrame[] = project.shots.flatMap((shot: Shot): StoryboardFrame[] => project.frames
    .filter((frame: StoryboardFrame): boolean => frame.shotId === shot.id)
    .sort((left: StoryboardFrame, right: StoryboardFrame): number => left.offsetMs - right.offsetMs));
  return Promise.all(orderedFrames.map(async (frame: StoryboardFrame): Promise<FramePageItem> => {
    const shot: Shot | undefined = project.shots.find((candidate: Shot): boolean => candidate.id === frame.shotId);
    if (shot === undefined) throw contractError('SHOT_NOT_FOUND', `${frame.id}: PDF 출력용 Shot을 찾을 수 없습니다.`, []);
    const frameDecision: FrameOutputDecision = reviewFrameOutput(project, frame.id, 'pdf-export');
    const frameIssues: Issue[] = frameDecision.issues;
    const sourceText: string = frameIssues.length > 0 ? '[OUTPUT BLOCKED]' : shot.sourceLinks.map((link): string => `[${link.usage}/${link.status}/${link.temporalAnchor.kind}:${link.temporalAnchor.basis}] ${project.dataset.units.find((unit): boolean => unit.id === link.unitId)?.text ?? link.unitId}`).join(' / ');
    const gates: EffectiveInformationGate[] = project.dataset.informationRules.filter((rule): boolean => rule.segmentId === shot.segmentId)
      .map((rule): EffectiveInformationGate => effectiveInformationGate(project, rule.id));
    const gateText: string = gates.map((gate: EffectiveInformationGate): string => `${gate.id} B${gate.baseNotBeforeMs}→E${gate.effectiveNotBeforeMs} ${gate.evidenceType}${gate.reviewRequired ? ' REVIEW' : ''}`).join(' / ');
    const audioBlocked: BlockedCue[] = project.audioCues.filter((cue): boolean => cue.startMs < shot.endMs && cue.endMs > shot.startMs)
      .flatMap((cue): BlockedCue[] => reviewAudioPlaybackAt(project, cue.startMs).blocked.filter((entry: BlockedCue): boolean => entry.cueId === cue.id));
    const textIssues: Issue[] = project.textCues.filter((cue: TextCue): boolean => cue.startMs < shot.endMs && cue.endMs > shot.startMs)
      .flatMap((cue: TextCue): Issue[] => reviewIssuesForTextCue(project, cue.id));
    let image: Buffer | null = null;
    let integrityCode: string | null = null;
    if (frameDecision.renderBitmap && frameDecision.imageAssetId !== null) {
      try {
        image = await loadAsset(frameDecision.imageAssetId);
      } catch (error: unknown) {
        integrityCode = assetErrorCode(error);
        if (integrityCode === null) throw error;
      }
    }
    const codes: string[] = [...new Set([...frameIssues, ...textIssues, ...audioBlocked.flatMap((entry: BlockedCue): Issue[] => entry.issues)].map((value: Issue): string => value.code))];
    if (integrityCode !== null) codes.push(integrityCode);
    const outputText: string = codes.length === 0 ? 'OUTPUT SAFE' : `DRAFT · OUTPUT INTERLOCK REVIEW REQUIRED · ${codes.join(', ')}`;
    const placeholderText: string = integrityCode === null ? frameOutputPlaceholderText(frameDecision, frame.description)
      : `Frame ID: ${frame.id}\nAsset ID: ${frameDecision.imageAssetId ?? 'NONE'}\nIssue: ${integrityCode}`;
    return { frame, shot, image,
      sourceText, gateText, outputText, placeholderText };
  }));
}

function addHeader(document: PDFKit.PDFDocument, project: Project, page: number, totalPages: number): void {
  document.fillColor('#101820').fontSize(17).text(project.title, 32, 24, { width: 610, lineBreak: false });
  document.fillColor('#59636d').fontSize(8).text(`STORYBOARD  ·  ${project.profile.aspectWidth}:${project.profile.aspectHeight}  ·  REV ${project.revision}`, 32, 48, { width: 610, lineBreak: false });
  document.fillColor('#101820').fontSize(9).text(`${page} / ${totalPages}`, 760, 31, { width: 50, align: 'right', lineBreak: false });
  document.moveTo(32, 64).lineTo(810, 64).lineWidth(0.8).strokeColor('#c8cdd2').stroke();
}

function drawPlaceholder(document: PDFKit.PDFDocument, x: number, y: number, width: number, height: number, description: string): void {
  document.rect(x, y, width, height).fill('#e7e2d9');
  document.moveTo(x, y).lineTo(x + width, y + height).moveTo(x + width, y).lineTo(x, y + height).lineWidth(0.5).strokeColor('#c3bbae').stroke();
  document.fillColor('#6a6257').fontSize(9).text(description || '이미지 생성 전', x + 16, y + height / 2 - 12, { width: width - 32, align: 'center', height: 30, ellipsis: true });
}

function frameRect(x: number, y: number, aspectWidth: number, aspectHeight: number): FrameRect {
  const availableWidth: number = 210;
  const availableHeight: number = 150;
  const ratio: number = aspectWidth / aspectHeight;
  const width: number = ratio >= availableWidth / availableHeight ? availableWidth : availableHeight * ratio;
  const height: number = ratio >= availableWidth / availableHeight ? availableWidth / ratio : availableHeight;
  return { x: x + 8 + (availableWidth - width) / 2, y: y + 8 + (availableHeight - height) / 2, width, height };
}

function drawCard(document: PDFKit.PDFDocument, item: FramePageItem, index: number, aspectWidth: number, aspectHeight: number): void {
  const column: number = index % 2;
  const row: number = Math.floor(index / 2);
  const x: number = 32 + column * 397;
  const y: number = 78 + row * 246;
  const width: number = 381;
  const frame: FrameRect = frameRect(x, y, aspectWidth, aspectHeight);
  document.roundedRect(x, y, width, 230, 5).lineWidth(0.8).strokeColor('#b6bcc2').stroke();
  if (item.image === null) drawPlaceholder(document, frame.x, frame.y, frame.width, frame.height, item.placeholderText);
  else document.image(item.image, frame.x, frame.y, { fit: [frame.width, frame.height], align: 'center', valign: 'center' });
  const time: string = `${formatMilliseconds(item.shot.startMs)} – ${formatMilliseconds(item.shot.endMs)}`;
  document.fillColor('#d34b2e').fontSize(8).text(time, x + 228, y + 10, { width: 143 });
  document.fillColor('#101820').fontSize(10).text(item.shot.id, x + 228, y + 28, { width: 143, height: 27, ellipsis: true });
  document.fillColor('#59636d').fontSize(8).text(`${item.shot.camera.size} · ${item.shot.camera.angle} · ${item.shot.camera.move}\n${item.shot.transitionOut.kind.toUpperCase()} ${item.shot.transitionOut.durationMs}ms`, x + 228, y + 59, { width: 143, height: 31, ellipsis: true });
  document.fillColor('#101820').fontSize(8.5).text(item.shot.action, x + 228, y + 95, { width: 143, height: 61, ellipsis: true });
  document.moveTo(x + 8, y + 166).lineTo(x + width - 8, y + 166).lineWidth(0.5).strokeColor('#d8dce0').stroke();
  document.fillColor('#59636d').fontSize(7).text('SOURCE', x + 8, y + 174, { width: 50 });
  document.fillColor('#101820').fontSize(7.5).text(item.sourceText, x + 58, y + 173, { width: width - 74, height: 16, ellipsis: true });
  document.fillColor('#59636d').fontSize(7).text('GATE', x + 8, y + 194, { width: 50 });
  document.fillColor('#101820').fontSize(7).text(item.gateText || '—', x + 58, y + 193, { width: width - 74, height: 13, ellipsis: true });
  document.fillColor('#59636d').fontSize(7).text(`FRAME ${item.frame.role.toUpperCase()} · ${item.frame.visualReview.toUpperCase()} · DISPLAY ${frameDisplayAbsoluteMs(item.shot, item.frame)} · EVAL ${frameEvaluationAbsoluteMs(item.shot, item.frame)}`, x + 8, y + 208, { width: width - 16, lineBreak: false });
  document.fillColor(item.outputText === 'OUTPUT SAFE' ? '#2f6b4f' : '#a33a2a').fontSize(6.5).text(item.outputText, x + 8, y + 218, { width: width - 16, lineBreak: false, ellipsis: true });
}

/** 현재 컷 순서와 프레임을 A4 가로형 제작 콘티로 렌더링한다. */
export async function exportProjectPdf(project: Project, fontPath: string, loadAsset: AssetLoader): Promise<Buffer> {
  const items: FramePageItem[] = await pageItems(project, loadAsset);
  const totalPages: number = Math.max(1, Math.ceil(items.length / 4));
  const document = new PDFDocument({ size: 'A4', layout: 'landscape', margin: 0, autoFirstPage: false, info: { Title: `${project.title} Storyboard`, Author: 'Storyboard Generator' } });
  document.registerFont('Korean', fontPath);
  document.font('Korean');
  const chunks: Buffer[] = [];
  const complete = new Promise<Buffer>((resolve, reject): void => {
    document.on('data', (chunk: Buffer): void => { chunks.push(chunk); });
    document.on('end', (): void => { resolve(Buffer.concat(chunks)); });
    document.on('error', (error: Error): void => { reject(error); });
  });
  for (let pageIndex: number = 0; pageIndex < totalPages; pageIndex += 1) {
    document.addPage();
    addHeader(document, project, pageIndex + 1, totalPages);
    items.slice(pageIndex * 4, pageIndex * 4 + 4).forEach((item: FramePageItem, index: number): void => {
      drawCard(document, item, index, project.profile.aspectWidth, project.profile.aspectHeight);
    });
  }
  document.end();
  return complete;
}

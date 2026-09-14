import { textPresentationColors } from '../domain/text-presentation.js';
import { readSelectedTextFont, textFontEnvironment } from '../rendering/text-font-source.js';
import type { TextFontSource } from '../rendering/text-font-source.js';
import PDFDocument from 'pdfkit';
import type { PdfFramePageItem, PdfProjection, PdfTrackEntry } from './pdf.js';
import { initialOutputOptions, PdfFormatSchema } from './output-options.js';
import type { PdfFormat } from './output-options.js';
import { contractError } from '../domain/errors.js';
import { layoutStoryboardText } from '../rendering/text-layout.js';
import { readTextFont, vectorTextLayout } from '../rendering/text-font.js';
import type { TextFont, TextVectorLayout } from '../rendering/text-font.js';

type PdfCursor = {
  document: PDFKit.PDFDocument; x: number; y: number; width: number; limitY: number;
  afterColumnY: number | null; frameNumber: number; frameCount: number; continuationLabel: string;
};
type TextStyle = { size: number; leading: number; color: string };
const margin: number = 32;
const bodyStyle: TextStyle = { size: 9.5, leading: 15, color: '#202623' };
const headingStyle: TextStyle = { size: 8, leading: 14, color: '#aa4125' };

function startPage(document: PDFKit.PDFDocument, frameNumber: number, frameCount: number): PdfCursor {
  document.addPage();
  document.fontSize(8).fillColor('#4a554d').text('CUTROOM / STORYBOARD', margin, 25, { lineBreak: false });
  document.text(`FRAME ${frameNumber} / ${frameCount}`, document.page.width - 160, 25, { lineBreak: false });
  document.strokeColor('#ccd0c8').lineWidth(0.6).moveTo(margin, 45).lineTo(document.page.width - margin, 45).stroke();
  return { document, x: margin, y: 60, width: document.page.width - margin * 2,
    limitY: document.page.height - 45, afterColumnY: null, frameNumber, frameCount, continuationLabel: '' };
}

function availableRegion(cursor: PdfCursor, height: number): PdfCursor {
  if (cursor.y + height <= cursor.limitY) return cursor;
  if (cursor.afterColumnY !== null) return availableRegion({ ...cursor, x: margin, y: cursor.afterColumnY,
    width: cursor.document.page.width - margin * 2, limitY: cursor.document.page.height - 45, afterColumnY: null }, height);
  const next: PdfCursor = startPage(cursor.document, cursor.frameNumber, cursor.frameCount);
  if (cursor.continuationLabel.length === 0) return next;
  next.document.fontSize(headingStyle.size).fillColor(headingStyle.color)
    .text(`${cursor.continuationLabel} / 계속`, next.x, next.y, { lineBreak: false });
  return { ...next, y: next.y + headingStyle.leading, continuationLabel: cursor.continuationLabel };
}

/** 공백과 글자를 삭제하지 않고, 긴 단어도 실제 글꼴 폭 안에서 나눈다. */
function fittedLine(document: PDFKit.PDFDocument, paragraph: string, width: number): string {
  if (document.widthOfString(paragraph) <= width) return paragraph;
  const segments: string[] = Array.from(new Intl.Segmenter('ko', { granularity: 'grapheme' }).segment(paragraph), (part): string => part.segment);
  let low: number = 1; let high: number = segments.length;
  while (low < high) {
    const middle: number = Math.ceil((low + high) / 2);
    if (document.widthOfString(segments.slice(0, middle).join('')) <= width) low = middle;
    else high = middle - 1;
  }
  const fitted: string = segments.slice(0, low).join('');
  const boundary: number = fitted.search(/\s+\S*$/u);
  return boundary > 0 ? fitted.slice(0, boundary + 1) : fitted;
}

function textFlow(input: PdfCursor, value: string, style: TextStyle): PdfCursor {
  let cursor: PdfCursor = input;
  for (const paragraph of value.split(/\r\n|\r|\n/u)) {
    let remainder: string = paragraph;
    do {
      cursor = availableRegion(cursor, style.leading);
      cursor.document.fontSize(style.size).fillColor(style.color);
      const line: string = fittedLine(cursor.document, remainder, cursor.width);
      cursor.document.text(line, cursor.x, cursor.y, { lineBreak: false });
      cursor = { ...cursor, y: cursor.y + style.leading };
      remainder = remainder.slice(line.length);
    } while (remainder.length > 0);
  }
  return cursor;
}

function section(input: PdfCursor, label: string, value: string): PdfCursor {
  const cursor: PdfCursor = availableRegion({ ...input, continuationLabel: '' }, headingStyle.leading + bodyStyle.leading);
  const heading: PdfCursor = textFlow(cursor, label, headingStyle);
  const body: PdfCursor = textFlow({ ...heading, continuationLabel: label }, value.length > 0 ? value : '-', bodyStyle);
  return { ...body, y: body.y + 9 };
}

function drawOverlay(document: PDFKit.PDFDocument, layout: TextVectorLayout, x: number, y: number, width: number): void {
  const scale: number = width / layout.width;
  document.save().translate(x, y).scale(scale);
  for (const box of layout.boxes) {
    document.rect(box.x, box.y, box.width, box.height).fill(textPresentationColors(box.background).background);
    for (const glyph of box.paths) if (glyph.path.length > 0) document.save().translate(glyph.x, glyph.y).scale(glyph.scale, -glyph.scale).path(glyph.path).fill(textPresentationColors(box.background).foreground).restore();
  }
  document.restore();
}

function imageRegion(input: PdfCursor, item: PdfFramePageItem, projection: PdfProjection, overlay: TextVectorLayout): PdfCursor {
  const cursor: PdfCursor = availableRegion(input, 210);
  const boxWidth: number = Math.min(330, cursor.width * 0.5); const boxHeight: number = 190;
  const scale: number = Math.min(boxWidth / projection.aspectWidth, boxHeight / projection.aspectHeight);
  const width: number = projection.aspectWidth * scale; const height: number = projection.aspectHeight * scale;
  const x: number = margin + (boxWidth - width) / 2; const y: number = cursor.y + (boxHeight - height) / 2;
  const document: PDFKit.PDFDocument = cursor.document;
  document.rect(margin, cursor.y, boxWidth, boxHeight).fill('#eef0e9');
  document.rect(x, y, width, height).fill(item.renderMode === 'black' ? '#000000' : '#dfe4d8');
  if (item.image !== null) document.image(item.image, x, y, { fit: [width, height], align: 'center', valign: 'center' });
  else if (item.renderMode !== 'black') document.fontSize(8).fillColor('#4a554d').text('IMAGE / REVIEW REQUIRED', margin + 15, cursor.y + 90, { lineBreak: false });
  drawOverlay(document, overlay, x, y, width);
  document.rect(margin, cursor.y, boxWidth, boxHeight).strokeColor('#ccd0c8').lineWidth(0.5).stroke();
  return { ...cursor, x: margin + boxWidth + 22, width: cursor.width - boxWidth - 22,
    limitY: cursor.y + boxHeight, afterColumnY: cursor.y + boxHeight + 18 };
}

function finishImageRegion(cursor: PdfCursor): PdfCursor {
  if (cursor.afterColumnY === null) return cursor;
  return { ...cursor, x: margin, y: cursor.afterColumnY, width: cursor.document.page.width - margin * 2,
    limitY: cursor.document.page.height - 45, afterColumnY: null };
}

function trackSections(input: PdfCursor, label: string, entries: readonly PdfTrackEntry[]): PdfCursor {
  return entries.reduce((cursor: PdfCursor, entry: PdfTrackEntry, index: number): PdfCursor => section(cursor,
    `${label} ${index + 1} / ${entries.length}`, `${entry.id} · ${entry.label}\n${entry.timeText}\n${entry.body}\n${entry.statusText}`), input);
}

function renderFrame(document: PDFKit.PDFDocument, projection: PdfProjection, item: PdfFramePageItem, index: number, font: TextFont): void {
  const format: PdfFormat = projection.format ?? initialOutputOptions().pdf;
  const overlay: TextVectorLayout = vectorTextLayout(layoutStoryboardText(item.overlayInputs, projection.aspectWidth, projection.aspectHeight, projection.textLayout, font.metrics), font);
  let cursor: PdfCursor = startPage(document, index + 1, projection.items.length);
  cursor = textFlow(cursor, projection.title, { size: 16, leading: 23, color: '#202623' });
  cursor = textFlow(cursor, `${projection.outputLabel} · REV ${projection.revision} · ${projection.aspectWidth}:${projection.aspectHeight}`, headingStyle);
  if (projection.selectionLabel !== undefined) cursor = textFlow(cursor, projection.selectionLabel, headingStyle);
  cursor = imageRegion({ ...cursor, y: cursor.y + 8 }, item, projection, overlay);
  cursor = section(cursor, '컷 / 시간', `${item.shotId}\n${item.timeText}`);
  if (format.sections.includes('direction')) cursor = section(cursor, '카메라 / 전환', item.cameraText);
  cursor = section(cursor, '프레임', item.frameText);
  cursor = finishImageRegion(cursor);
  if (format.sections.includes('direction')) cursor = section(cursor, '행동 / 연출', item.action);
  if (overlay.problems.length > 0) cursor = section(cursor, '글자 조판 검토', overlay.problems.map((problem): string => `${problem.code}: ${problem.message}`).join('\n'));
  if (format.sections.includes('direction')) cursor = section(cursor, '프레임 설명', item.description);
  if (item.image === null && item.renderMode !== 'black') cursor = section(cursor, '그림 검토', item.placeholderText);
  if (format.sections.includes('sources')) cursor = section(cursor, '원문 연결', item.sourceText);
  if (format.sections.includes('text')) cursor = trackSections(cursor, '화면 글자', item.textEntries);
  if (format.sections.includes('audio')) cursor = trackSections(cursor, '음성 / 음향', item.audioEntries);
  if (format.sections.includes('sources') && item.gateText.length > 0) cursor = section(cursor, '정보 공개 기준', item.gateText);
  section(cursor, '출력 검토', item.outputText);
}

/** 그림 목록은 비교용 요약이다. 전체 연출 본문을 잘라 담는 대신 상세 출력과 목적을 명시적으로 구분한다. */
function renderBoard(document: PDFKit.PDFDocument, projection: PdfProjection, font: TextFont, count: 2 | 4 | 6): void {
  let cover: PdfCursor = startPage(document, 0, projection.items.length);
  cover = textFlow(cover, projection.title, { size: 18, leading: 26, color: '#202623' });
  cover = section(cover, '그림 비교용 목록', `${projection.outputLabel} · REV ${projection.revision}\n${projection.selectionLabel ?? '전체 프레임'}\n페이지당 최대 ${count}개 · 원본 화면비 유지`);
  section(cover, '출력 범위', '그림·프레임 번호·시간과 검토 상태를 담은 비교용 요약입니다. 전체 행동·대사·자막·음향 지시는 상세 PDF 또는 제작용 CSV로 확인하세요.');
  for (let start: number = 0; start < projection.items.length; start += count) {
    const cursor: PdfCursor = startPage(document, start + 1, projection.items.length);
    const columns: number = count === 6 && document.page.width > document.page.height ? 3 : count === 2 && document.page.width < document.page.height ? 1 : 2;
    const rows: number = Math.ceil(count / columns); const gap: number = 16;
    const cellWidth: number = (cursor.width - gap * (columns - 1)) / columns;
    const cellHeight: number = (cursor.limitY - cursor.y - gap * (rows - 1)) / rows;
    for (const [offset, item] of projection.items.slice(start, start + count).entries()) {
      const x: number = margin + (offset % columns) * (cellWidth + gap);
      const y: number = cursor.y + Math.floor(offset / columns) * (cellHeight + gap);
      const imageHeight: number = cellHeight - 74;
      const scale: number = Math.min(cellWidth / projection.aspectWidth, imageHeight / projection.aspectHeight);
      const width: number = projection.aspectWidth * scale; const height: number = projection.aspectHeight * scale;
      const imageX: number = x + (cellWidth - width) / 2; const imageY: number = y + (imageHeight - height) / 2;
      document.rect(x, y, cellWidth, imageHeight).fill('#eef0e9');
      document.rect(imageX, imageY, width, height).fill(item.renderMode === 'black' ? '#000000' : '#dfe4d8');
      if (item.image !== null) document.image(item.image, imageX, imageY, { fit: [width, height], align: 'center', valign: 'center' });
      else if (item.renderMode !== 'black') document.fontSize(8).fillColor('#4a554d').text('IMAGE / REVIEW REQUIRED', x + 12, y + imageHeight / 2, { lineBreak: false });
      const overlay: TextVectorLayout = vectorTextLayout(layoutStoryboardText(item.overlayInputs, projection.aspectWidth, projection.aspectHeight, projection.textLayout, font.metrics), font);
      drawOverlay(document, overlay, imageX, imageY, width);
      const status: string = item.renderMode === 'blocked' || item.outputText.includes('REVIEW REQUIRED') || overlay.problems.length > 0 ? '출력 검토 필요' : item.outputText;
      const lines: string[] = [`FRAME ${start + offset + 1} · ${status}`, item.timeText, item.frameId];
      let textY: number = y + imageHeight + 6;
      for (const value of lines) {
        let remainder: string = value;
        do {
          document.fontSize(8).fillColor('#202623');
          const line: string = fittedLine(document, remainder, cellWidth - 4);
          if (textY + 11 > y + cellHeight) throw contractError('PDF_BOARD_CAPTION_TOO_LONG', `${item.frameId}: 그림 목록의 식별자·시간이 칸을 넘습니다. 페이지당 그림 수를 줄이거나 상세 PDF를 선택하세요.`, []);
          document.text(line, x + 2, textY, { lineBreak: false }); textY += 11; remainder = remainder.slice(line.length);
        } while (remainder.length > 0);
      }
    }
  }
}

function pageNumbers(document: PDFKit.PDFDocument): void {
  const range: { start: number; count: number } = document.bufferedPageRange();
  for (let index: number = range.start; index < range.start + range.count; index += 1) {
    document.switchToPage(index);
    document.fontSize(8).fillColor('#4a554d').text(`${index + 1} / ${range.count}`, margin, document.page.height - 27, { lineBreak: false });
  }
}

/** 긴 본문은 다음 영역·페이지로 이어 쓰며 비트맵의 원래 비율과 결정적 객체 순서를 유지한다. */
export async function renderStoryboardPdf(projection: PdfProjection, fontPath: TextFontSource, createdAt: string): Promise<Buffer> {
  const bodyFont: TextFont = await readTextFont(textFontEnvironment(fontPath).defaultPath);
  const font: TextFont = await readSelectedTextFont(projection.textTypography, fontPath);
  const format: PdfFormat = PdfFormatSchema.parse(projection.format ?? initialOutputOptions().pdf);
  const document: PDFKit.PDFDocument = new PDFDocument({ size: format.pageSize, layout: format.orientation, margin,
    autoFirstPage: false, bufferPages: true, info: { Title: projection.title, Creator: 'CUTROOM', Keywords: `text-layout:${projection.textLayout.version}; font-sha256:${font.sha256}${projection.textTypography === undefined ? '' : `; text-language:${projection.textTypography.language}; body-font-sha256:${bodyFont.sha256}`}`,
      CreationDate: new Date(createdAt), ModDate: new Date(createdAt) } });
  const chunks: Buffer[] = [];
  const result: Promise<Buffer> = new Promise((resolve, reject): void => {
    document.on('data', (chunk: Buffer): void => { chunks.push(chunk); });
    document.on('end', (): void => { resolve(Buffer.concat(chunks)); });
    document.on('error', reject);
  });
  document.font(bodyFont.bytes);
  if (format.layout.kind === 'board') renderBoard(document, projection, font, format.layout.framesPerPage);
  else {
    projection.items.forEach((item: PdfFramePageItem, index: number): void => renderFrame(document, projection, item, index, font));
    if (projection.items.length === 0) textFlow(startPage(document, 0, 0), projection.title, bodyStyle);
  }
  pageNumbers(document);
  document.end();
  return result;
}

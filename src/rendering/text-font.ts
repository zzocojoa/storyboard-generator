import { textPresentationColors } from '../domain/text-presentation.js';
import { open } from 'node:fs/promises';
import { create } from 'fontkit';
import type { Font, GlyphRun } from 'fontkit';
import { contractError } from '../domain/errors.js';
import { sha256Bytes } from '../importers/integrity.js';
import type { TextLayout, TextLayoutBox, TextMetrics } from './text-layout.js';

export type TextFont = { font: Font; bytes: Buffer; sha256: string; metrics: TextMetrics };
export type TextGlyphPath = { path: string; x: number; y: number; scale: number };
export type TextVectorBox = Omit<TextLayoutBox, 'lines'> & { paths: TextGlyphPath[] };
export type TextVectorLayout = Omit<TextLayout, 'boxes'> & { boxes: TextVectorBox[]; fontSha256: string };

/** 원문의 탭은 보존하고 표시할 때만 네 칸 공백으로 조판한다. */
function shapingText(text: string): string { return text.replace(/\t/gu, '    '); }

export async function readTextFont(fontPath: string): Promise<TextFont> {
  const handle = await open(fontPath, 'r').catch((error: unknown) => {
    if (error instanceof Error && 'code' in error && ['ENOENT', 'ENOTDIR', 'EACCES'].includes(String(error.code))) {
      throw contractError('TEXT_FONT_FILE_UNAVAILABLE', `${fontPath}: 글꼴 파일을 읽을 수 없습니다. 파일과 읽기 권한을 확인하세요. cause=${error.message}`, []);
    }
    throw error;
  });
  const bytes: Buffer = await (async (): Promise<Buffer> => {
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size === 0 || stat.size > 32 * 1024 * 1024) throw contractError('TEXT_FONT_FILE_INVALID', `${fontPath}: 글꼴은 32 MiB 이하의 비어 있지 않은 일반 파일이어야 합니다. bytes=${stat.size}`, []);
      const value: Buffer = Buffer.alloc(stat.size);
      let offset: number = 0;
      while (offset < value.length) {
        const read = await handle.read(value, offset, value.length - offset, offset);
        if (read.bytesRead === 0) throw contractError('TEXT_FONT_FILE_CHANGED', `${fontPath}: 읽는 중 글꼴 파일 길이가 변경됐습니다. 같은 파일로 다시 확인하세요.`, []);
        offset += read.bytesRead;
      }
      if ((await handle.stat()).size !== value.length) throw contractError('TEXT_FONT_FILE_CHANGED', `${fontPath}: 읽는 중 글꼴 파일 길이가 변경됐습니다. 같은 파일로 다시 확인하세요.`, []);
      return value;
    } finally { await handle.close(); }
  })();
  const font = (() => {
    try { return create(bytes); }
    catch (error: unknown) { throw contractError('TEXT_FONT_FILE_INVALID', `${fontPath}: 지원하는 단일 글꼴 파일인지 확인하세요. cause=${error instanceof Error ? error.message : String(error)}`, []); }
  })();
  if (!('layout' in font)) throw contractError('TEXT_FONT_COLLECTION_UNSUPPORTED', '글자 조판에는 단일 TTF/OTF 글꼴을 지정하세요.', []);
  return { font, bytes, sha256: sha256Bytes(bytes), metrics: {
    measure: (text: string, size: number): number => font.layout(shapingText(text)).advanceWidth / font.unitsPerEm * size,
    supports: (text: string): boolean => [...text].every((character: string): boolean => /\s/u.test(character) || font.hasGlyphForCodePoint(character.codePointAt(0) as number)),
    ascentRatio: font.ascent / font.unitsPerEm,
  } };
}

/** 브라우저와 PDF가 같은 Glyph 경로·좌표를 사용하므로 시스템 대체 글꼴에 의존하지 않는다. */
export function vectorTextLayout(layout: TextLayout, font: TextFont): TextVectorLayout {
  return { ...layout, fontSha256: font.sha256, boxes: layout.boxes.map((box): TextVectorBox => {
    const scale: number = box.fontSize / font.font.unitsPerEm;
    const paths: TextGlyphPath[] = box.lines.flatMap((line): TextGlyphPath[] => {
      const run: GlyphRun = font.font.layout(shapingText(line.text)); let x: number = line.x; let y: number = line.baselineY;
      return run.glyphs.map((glyph, index: number): TextGlyphPath => {
        const position = run.positions[index];
        if (position === undefined) throw contractError('TEXT_FONT_POSITION_MISSING', `${box.cueId}: 글꼴의 Glyph 위치가 누락됐습니다.`, []);
        const path: TextGlyphPath = { path: glyph.path.toSVG(), x: x + position.xOffset * scale, y: y - position.yOffset * scale, scale };
        x += position.xAdvance * scale; y -= position.yAdvance * scale;
        return path;
      }).filter((glyph): boolean => glyph.path.length > 0);
    });
    const { lines: _lines, ...fields } = box;
    return { ...fields, paths };
  }) };
}

export function textLayoutSvg(layout: TextVectorLayout): string {
  const boxes: string[] = layout.boxes.map((box): string => `<rect x="${box.x}" y="${box.y}" width="${box.width}" height="${box.height}" fill="${textPresentationColors(box.background).background}"/>${box.paths.map((glyph): string =>
    `<path d="${glyph.path}" transform="matrix(${glyph.scale} 0 0 ${-glyph.scale} ${glyph.x} ${glyph.y})" fill="${textPresentationColors(box.background).foreground}"/>`).join('')}`);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${layout.width} ${layout.height}" width="${layout.width}" height="${layout.height}">${boxes.join('')}</svg>`;
}

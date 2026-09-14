/** 설치한 fontkit 2.0.4의 공개 글꼴·GlyphRun API 중 조판에 사용하는 계약이다. */
declare module 'fontkit' {
  export type Glyph = { id: number; path: { toSVG(): string } };
  export type GlyphPosition = { xAdvance: number; yAdvance: number; xOffset: number; yOffset: number };
  export type GlyphRun = { glyphs: Glyph[]; positions: GlyphPosition[]; advanceWidth: number };
  export type Font = { unitsPerEm: number; ascent: number; descent: number; postscriptName: string;
    hasGlyphForCodePoint(codePoint: number): boolean; layout(value: string): GlyphRun };
  export type FontCollection = { fonts: Font[] };
  export function create(buffer: Buffer): Font | FontCollection;
}

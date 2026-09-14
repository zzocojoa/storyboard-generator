import { TextPresentationSchema } from '../domain/text-presentation.js';
import type { TextCue } from '../domain/schema.js';
import { TextLayoutPresetSchema } from '../domain/text-layout-settings.js';
import type { TextLayoutPreset } from '../domain/text-layout-settings.js';

export type TextLayoutInput = Pick<TextCue, 'id' | 'text' | 'kind' | 'presentation'>;
export type TextLayoutProblem = { code: 'TEXT_LAYOUT_OVERFLOW' | 'TEXT_LAYOUT_COLLISION' | 'TEXT_FONT_GLYPH_MISSING'; cueId: string; message: string };
export type TextLine = { text: string; x: number; baselineY: number };
export type TextLayoutBox = { cueId: string; kind: TextCue['kind']; x: number; y: number; width: number; height: number; fontSize: number; layer: number; background: 'dark' | 'light'; lines: TextLine[] };
export type TextLayout = { width: number; height: number; preset: TextLayoutPreset; boxes: TextLayoutBox[]; problems: TextLayoutProblem[] };
export type TextMetrics = { measure: (text: string, size: number) => number; supports: (text: string) => boolean; ascentRatio: number; language?: string };

function wrappedLines(text: string, width: number, size: number, metrics: TextMetrics): string[] {
  const lines: string[] = [];
  for (const paragraph of text.split(/\r\n|\r|\n/u)) {
    let current: string = '';
    for (const { segment } of new Intl.Segmenter(metrics.language ?? 'und', { granularity: 'grapheme' }).segment(paragraph)) {
      if (current.length > 0 && metrics.measure(current + segment, size) > width) {
        const boundary: number = current.search(/\s+\S*$/u);
        if (boundary > 0) { lines.push(current.slice(0, boundary + 1)); current = current.slice(boundary + 1); }
        else { lines.push(current); current = ''; }
        if (current.length > 0 && metrics.measure(current + segment, size) > width) { lines.push(current); current = ''; }
      }
      current += segment;
    }
    lines.push(current);
  }
  return lines;
}

function overlaps(left: TextLayoutBox, right: TextLayoutBox): boolean {
  return left.x < right.x + right.width && right.x < left.x + left.width && left.y < right.y + right.height && right.y < left.y + left.height;
}

/** 본문과 시각을 바꾸지 않으며, 보이지 않을 글자를 성공한 배치로 내보내지 않는다. */
export function layoutStoryboardText(inputs: readonly TextLayoutInput[], aspectWidth: number, aspectHeight: number, preset: TextLayoutPreset, metrics: TextMetrics): TextLayout {
  TextLayoutPresetSchema.parse(preset);
  const scale: number = 1000 / Math.max(aspectWidth, aspectHeight);
  const width: number = aspectWidth * scale; const height: number = aspectHeight * scale;
  const shortEdge: number = Math.min(width, height);
  const padding: number = shortEdge * preset.padding; const gap: number = shortEdge * preset.gap;
  const problems: TextLayoutProblem[] = [];
  const prepared: TextLayoutBox[] = inputs.map((input): TextLayoutBox => {
    const custom = input.presentation === undefined ? undefined : TextPresentationSchema.parse(input.presentation);
    const boxWidth: number = width * (custom?.width ?? 1 - preset.safeMargin * 2);
    const fontSize: number = shortEdge * (custom?.fontSize ?? preset.fontSize);
    const x: number = width * (custom?.x ?? preset.safeMargin);
    const alignment = custom?.alignment ?? 'center';
    const lines: string[] = wrappedLines(input.text, boxWidth - padding * 2, fontSize, metrics);
    const height: number = lines.length * fontSize * preset.lineHeight + padding * 2;
    if (!metrics.supports(input.text)) problems.push({ code: 'TEXT_FONT_GLYPH_MISSING', cueId: input.id, message: `${input.id}: 선택 글꼴에 없는 글자가 있습니다. 지원하는 글꼴을 지정하세요.` });
    if (lines.length > preset.maxLines || lines.some((line): boolean => metrics.measure(line, fontSize) > boxWidth - padding * 2)) problems.push({
      code: 'TEXT_LAYOUT_OVERFLOW', cueId: input.id, message: `${input.id}: ${lines.length}줄이 필요합니다. 글자 크기·영역·최대 줄 수를 검토하세요. 원문은 줄이지 않았습니다.` });
    return { cueId: input.id, kind: input.kind, x, y: 0, width: boxWidth, height, fontSize, layer: custom?.layer ?? 0, background: custom?.background ?? 'dark',
      lines: lines.map((text: string, index: number): TextLine => ({ text,
        x: alignment === 'left' ? x + padding : alignment === 'right' ? x + boxWidth - padding - metrics.measure(text, fontSize) : x + (boxWidth - metrics.measure(text, fontSize)) / 2,
        baselineY: padding + fontSize * metrics.ascentRatio + index * fontSize * preset.lineHeight })) };
  });
  const grouped: TextLayoutBox[] = (['top', 'center', 'bottom'] as const).flatMap((position): TextLayoutBox[] => {
    const group: TextLayoutBox[] = prepared.filter((box): boolean => inputs.find((input): boolean => input.id === box.cueId)?.presentation === undefined && preset.positions[box.kind] === position);
    const groupHeight: number = group.reduce((sum: number, box): number => sum + box.height, 0) + Math.max(0, group.length - 1) * gap;
    let nextY: number = position === 'top' ? height * preset.safeMargin : position === 'center' ? (height - groupHeight) / 2 : height * (1 - preset.safeMargin) - groupHeight;
    return group.map((box): TextLayoutBox => {
      const y: number = nextY; nextY += box.height + gap;
      return { ...box, y, lines: box.lines.map((line): TextLine => ({ ...line, baselineY: line.baselineY + y })) };
    });
  });
  const customBoxes: TextLayoutBox[] = prepared.flatMap((box): TextLayoutBox[] => {
    const custom = inputs.find((input): boolean => input.id === box.cueId)?.presentation;
    if (custom === undefined) return [];
    const y: number = custom.y * height - (custom.verticalAnchor === 'top' ? 0 : custom.verticalAnchor === 'center' ? box.height / 2 : box.height);
    return [{ ...box, y, lines: box.lines.map((line): TextLine => ({ ...line, baselineY: line.baselineY + y })) }];
  });
  const placed: TextLayoutBox[] = [...grouped, ...customBoxes].sort((left, right): number => left.layer - right.layer);
  for (const box of placed) {
    if (box.x < width * preset.safeMargin - 0.001 || box.x + box.width > width * (1 - preset.safeMargin) + 0.001 || box.y < height * preset.safeMargin - 0.001 || box.y + box.height > height * (1 - preset.safeMargin) + 0.001) problems.push({ code: 'TEXT_LAYOUT_OVERFLOW', cueId: box.cueId, message: `${box.cueId}: 글자 영역이 화면의 안전 여백을 벗어납니다.` });
    const collisions: TextLayoutBox[] = placed.filter((other): boolean => other.cueId !== box.cueId && overlaps(box, other));
    if (collisions.length > 0) problems.push({ code: 'TEXT_LAYOUT_COLLISION', cueId: box.cueId, message: `${box.cueId}: ${collisions.map((other): string => other.cueId).join(', ')}의 글자 영역과 겹칩니다. 배치를 검토하세요.` });
  }
  const blocked: Set<string> = new Set(problems.map((problem): string => problem.cueId));
  return { width, height, preset: { ...preset }, boxes: placed.filter((box): boolean => !blocked.has(box.cueId)), problems };
}

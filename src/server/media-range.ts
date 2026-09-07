import { contractError } from '../domain/errors.js';

export type MediaByteRange = { start: number; end: number };

/** 검증된 Media 바이트에 대해 단일 HTTP Range만 해석하고 범위 밖 요청을 거부한다. */
export function mediaByteRange(header: string, size: number): MediaByteRange {
  const match: RegExpMatchArray | null = /^bytes=(\d*)-(\d*)$/.exec(header);
  const startText: string = match?.[1] ?? ''; const endText: string = match?.[2] ?? '';
  const start: number = startText === '' ? Math.max(0, size - Number(endText)) : Number(startText);
  const end: number = startText === '' || endText === '' ? size - 1 : Math.min(size - 1, Number(endText));
  if (match === null || startText === '' && (endText === '' || Number(endText) === 0)
    || !Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start >= size || end < start) {
    throw contractError('INVALID_MEDIA_RANGE', `지원하는 단일 바이트 범위를 지정하세요. range=${header}, size=${size}`, []);
  }
  return { start, end };
}

import type { TextTypography } from '../src/domain/text-typography.js';
import { readTextFont } from '../src/rendering/text-font.js';
import { TEST_TEXT_FONT_PATH } from './helpers.js';

export const TEST_LATIN_FONT_PATH: string = 'node_modules/@fontsource/ibm-plex-mono/files/ibm-plex-mono-latin-400-normal.woff2';

export async function testTextTypography(): Promise<TextTypography> {
  const font = await readTextFont(TEST_TEXT_FONT_PATH);
  return { version: '1.0.0', language: 'und', fontId: 'default', fontSha256: font.sha256 };
}

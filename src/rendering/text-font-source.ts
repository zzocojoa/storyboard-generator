import { contractError } from '../domain/errors.js';
import { TextFontRegistrationsSchema, TextTypographySchema } from '../domain/text-typography.js';
import type { TextFontChoice, TextFontRegistration, TextTypography, TextFontCatalog } from '../domain/text-typography.js';
import { readTextFont } from './text-font.js';
import type { TextFont } from './text-font.js';

export type TextFontEnvironment = { defaultPath: string; registrations: readonly TextFontRegistration[] };
/** 기존 CLI의 단일 경로는 추가 등록이 없는 동일한 글꼴 환경이다. */
export type TextFontSource = string | TextFontEnvironment;

export function textFontEnvironment(source: TextFontSource): TextFontEnvironment {
  const environment: TextFontEnvironment = typeof source === 'string' ? { defaultPath: source, registrations: [] } : source;
  return { defaultPath: environment.defaultPath, registrations: TextFontRegistrationsSchema.parse(environment.registrations) };
}

export function isTextFontAvailabilityError(error: unknown): error is Error & { code: string } {
  return error instanceof Error && 'code' in error && typeof error.code === 'string' && [
    'TEXT_FONT_NOT_REGISTERED', 'TEXT_FONT_HASH_MISMATCH', 'TEXT_FONT_FILE_UNAVAILABLE', 'TEXT_FONT_FILE_INVALID',
    'TEXT_FONT_FILE_CHANGED', 'TEXT_FONT_COLLECTION_UNSUPPORTED',
  ].includes(error.code);
}

function selectedFontPath(id: string, source: TextFontSource): string {
  const environment: TextFontEnvironment = textFontEnvironment(source);
  if (id === 'default') return environment.defaultPath;
  const font: TextFontRegistration | undefined = environment.registrations.find((candidate): boolean => candidate.id === id);
  if (font === undefined) throw contractError('TEXT_FONT_NOT_REGISTERED', `${id}: 이 콘티의 글꼴이 실행 환경에 없습니다. 같은 ID의 원래 글꼴을 등록하거나 제작 설정에서 다른 글꼴을 선택하세요.`, []);
  return font.path;
}

/** 저장된 글꼴 ID와 실제 바이트를 대조하며 사라지거나 바뀐 글꼴을 대체하지 않는다. */
export async function readSelectedTextFont(selection: TextTypography | undefined, source: TextFontSource): Promise<TextFont> {
  if (selection === undefined) return readTextFont(textFontEnvironment(source).defaultPath);
  const selected: TextTypography = TextTypographySchema.parse(selection);
  const font: TextFont = await readTextFont(selectedFontPath(selected.fontId, source));
  if (font.sha256 !== selected.fontSha256) throw contractError('TEXT_FONT_HASH_MISMATCH', `${selected.fontId}: 저장된 글꼴과 현재 파일이 다릅니다. expected=${selected.fontSha256}, actual=${font.sha256}. 원래 파일을 복원하거나 새 글꼴을 확인해 저장하세요.`, []);
  return { ...font, metrics: { ...font.metrics, language: selected.language } };
}

/** 선택 화면에는 실제 글꼴의 이름·해시만 제공하고 서버 파일 경로는 노출하지 않는다. */
export async function readTextFontCatalog(source: TextFontSource): Promise<TextFontCatalog> {
  const environment: TextFontEnvironment = textFontEnvironment(source);
  const registrations: readonly TextFontRegistration[] = [{ id: 'default', label: '기본 글꼴', path: environment.defaultPath }, ...environment.registrations];
  const fonts: TextFontChoice[] = []; const unavailable: TextFontCatalog['unavailable'] = [];
  for (const registration of registrations) {
    try {
      const font: TextFont = await readTextFont(registration.path);
      fonts.push({ id: registration.id, label: registration.label, postscriptName: font.font.postscriptName, sha256: font.sha256 });
    } catch (error: unknown) {
      if (!isTextFontAvailabilityError(error)) throw error;
      unavailable.push({ id: registration.id, label: registration.label, code: error.code,
        message: `${registration.id}: 등록한 글꼴을 읽을 수 없습니다 (${error.code}). 서버 설정의 글꼴 파일과 읽기 권한을 확인하세요.` });
    }
  }
  return { fonts, unavailable };
}

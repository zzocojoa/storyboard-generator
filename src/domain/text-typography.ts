import { z } from 'zod';

export const TextLanguageSchema = z.string().trim().min(2).max(80).refine((value: string): boolean => {
  try { return new Intl.Locale(value).toString() === value; }
  catch (error: unknown) { if (error instanceof RangeError) return false; throw error; }
}, 'ko, en, ja, zh-Hans처럼 올바른 언어 태그를 입력하세요.');

export const TextTypographySchema = z.strictObject({
  version: z.literal('1.0.0'), language: TextLanguageSchema,
  fontId: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/u),
  fontSha256: z.string().regex(/^[a-f0-9]{64}$/u),
});
export type TextTypography = z.infer<typeof TextTypographySchema>;

export const TextFontRegistrationSchema = z.strictObject({
  id: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/u).refine((value: string): boolean => value !== 'default', 'default는 기본 글꼴 ID입니다.'),
  label: z.string().trim().min(1).max(200), path: z.string().min(1),
});
export const TextFontRegistrationsSchema = z.array(TextFontRegistrationSchema).max(32).refine(
  (values): boolean => new Set(values.map((value): string => value.id)).size === values.length, '글꼴 ID는 중복될 수 없습니다.');
export type TextFontRegistration = z.infer<typeof TextFontRegistrationSchema>;

export const TextFontChoiceSchema = z.strictObject({
  id: z.string(), label: z.string(), postscriptName: z.string(), sha256: z.string().regex(/^[a-f0-9]{64}$/u),
});
export const TextFontCatalogSchema = z.strictObject({ fonts: z.array(TextFontChoiceSchema).max(33),
  unavailable: z.array(z.strictObject({ id: z.string(), label: z.string(), code: z.string(), message: z.string() })).max(33) });
export type TextFontChoice = z.infer<typeof TextFontChoiceSchema>;
export type TextFontCatalog = z.infer<typeof TextFontCatalogSchema>;

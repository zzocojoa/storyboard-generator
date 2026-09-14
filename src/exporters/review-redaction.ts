import { BuildManifestSchema } from '../build-schema.js';
import type { BuildManifest } from '../build-schema.js';
import { contractError } from '../domain/errors.js';
import { sha256Text } from '../importers/integrity.js';
import { stableJsonStringify } from '../io/stable-json.js';
import type { JsonValue } from '../io/stable-json.js';
import type { PdfFramePageItem, PdfProjection, PdfTrackEntry } from './pdf.js';
import type { ReviewContentPolicy } from './review-delivery-schema.js';

export type ReviewProfile = 'internal' | 'external';
export type RedactionCategory = 'source-content' | 'generation-prompt' | 'absolute-path' | 'email' | 'phone' | 'resident-id' | 'explicit-pii';
export type RedactionEntry = { fieldPath: string; category: RedactionCategory; sha256: string; count: number };
export type RedactionPattern = { category: RedactionCategory; source: string; flags: string };
export type RedactedText = { value: string; entries: RedactionEntry[] };
export type RedactedJson = { value: JsonValue; entries: RedactionEntry[] };
export type RedactionManifest = { profile: ReviewProfile; policyVersion: '1.0.0'; label: string; configuredPatternHashes: string[];
  categories: Record<string, number>; entries: RedactionEntry[]; externalImagePolicy: 'placeholder' | 'not-applicable'; embeddedImageRedaction: 'not-performed' };

export function reviewProfile(value: unknown): ReviewProfile {
  if (value === undefined || value === 'internal') return 'internal';
  if (value === 'external') return 'external';
  throw contractError('REVIEW_REDACTION_PROFILE_INVALID', '--profile은 internal 또는 external이어야 합니다.', []);
}
export function reviewRedactionPatterns(explicit: readonly string[]): RedactionPattern[] {
  const patterns: RedactionPattern[] = [
    { category: 'email', source: String.raw`\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b`, flags: 'giu' },
    { category: 'phone', source: String.raw`(?<![\w])(?:\+?\d{1,3}[- .]?)?\(?\d{2,4}\)?[- .]\d{3,4}[- .]\d{4}(?!\d)|(?<![\w])(?:01[016789]\d{7,8}|02\d{7,8})(?!\d)`, flags: 'gu' },
    { category: 'resident-id', source: String.raw`\b\d{6}[- ]?[1-8]\d{6}\b`, flags: 'gu' },
    { category: 'absolute-path', source: String.raw`(?<![\w:#/])(?:[A-Za-z]:[\\/]|/(?!/))[^\s"'<>|,;\]}]+`, flags: 'gu' },
  ];
  for (const [index, source] of explicit.entries()) {
    try {
      const pattern: RegExp = new RegExp(source, 'gu');
      if (source.length === 0 || pattern.test('')) throw new SyntaxError('empty match');
      patterns.push({ category: 'explicit-pii', source, flags: 'gu' });
    } catch (error: unknown) {
      if (!(error instanceof SyntaxError)) throw error;
      throw contractError('REVIEW_REDACTION_PATTERN_INVALID', `개인정보 패턴 ${index + 1}의 정규식 문법과 빈 문자열 일치 여부를 확인하세요.`, []);
    }
  }
  return patterns;
}
function replacement(raw: string, category: RedactionCategory): string { return `[REDACTED:${category}:${sha256Text(raw).slice(0, 16)}]`; }

/** 원문 대신 범주·Hash만 기록하며 동일 규칙을 JSON, CSV, PDF 출력 자료에 적용한다. */
export function redactReviewText(input: string, fieldPath: string, patterns: readonly RedactionPattern[]): RedactedText {
  const entries: RedactionEntry[] = []; let value: string = input;
  for (const pattern of patterns) value = value.replace(new RegExp(pattern.source, pattern.flags), (raw: string): string => {
    entries.push({ fieldPath, category: pattern.category, sha256: sha256Text(raw), count: 1 }); return replacement(raw, pattern.category);
  });
  return { value, entries };
}
function wholeField(input: string, fieldPath: string, category: RedactionCategory): RedactedJson {
  return { value: replacement(input, category), entries: [{ fieldPath, category, sha256: sha256Text(input), count: 1 }] };
}
function pointerPart(value: string): string { return value.replaceAll('~', '~0').replaceAll('/', '~1'); }

export function redactReviewJson(input: unknown, fieldPath: string, patterns: readonly RedactionPattern[]): RedactedJson {
  return projectReviewJson(input, fieldPath, patterns, { sourceContent: false, generationPrompts: false });
}

/** 내부 전달물에서도 사용자가 제외한 전문·프롬프트는 범주와 원본 해시만 보존한다. */
export function selectReviewJsonContent(input: unknown, fieldPath: string, contents: ReviewContentPolicy): RedactedJson {
  return projectReviewJson(input, fieldPath, [], contents);
}

function projectReviewJson(input: unknown, fieldPath: string, patterns: readonly RedactionPattern[], contents: ReviewContentPolicy): RedactedJson {
  if (typeof input === 'string') {
    if (!contents.generationPrompts && fieldPath.endsWith('/prompt')) return wholeField(input, fieldPath, 'generation-prompt');
    if (!contents.sourceContent && fieldPath.includes('/sources/') && fieldPath.endsWith('/content')) return wholeField(input, fieldPath, 'source-content');
    return redactReviewText(input, fieldPath, patterns);
  }
  if (input === null || typeof input === 'boolean' || typeof input === 'number' && Number.isFinite(input)) return { value: input, entries: [] };
  if (Array.isArray(input)) {
    const results: RedactedJson[] = input.map((value: unknown, index: number): RedactedJson => projectReviewJson(value, `${fieldPath}/${index}`, patterns, contents));
    return { value: results.map((result: RedactedJson): JsonValue => result.value), entries: results.flatMap((result: RedactedJson): RedactionEntry[] => result.entries) };
  }
  if (typeof input === 'object' && Object.getPrototypeOf(input) === Object.prototype) {
    const entries: RedactionEntry[] = []; const pairs: [string, JsonValue][] = [];
    for (const [key, value] of Object.entries(input).sort(([a], [b]): number => a < b ? -1 : a > b ? 1 : 0)) {
      const redactedKey: RedactedText = redactReviewText(key, `${fieldPath}/key:${sha256Text(key)}`, patterns);
      const result: RedactedJson = projectReviewJson(value, `${fieldPath}/${pointerPart(redactedKey.value)}`, patterns, contents);
      pairs.push([redactedKey.value, result.value]); entries.push(...redactedKey.entries, ...result.entries);
    }
    if (new Set(pairs.map(([key]): string => key)).size !== pairs.length) throw contractError('REVIEW_REDACTION_KEY_COLLISION', '비식별화한 출력 필드 이름이 중복됩니다.', []);
    return { value: Object.fromEntries(pairs), entries };
  }
  throw contractError('REVIEW_REDACTION_VALUE_INVALID', '검토 Projection에는 JSON 값만 사용할 수 있습니다.', []);
}
function redactCsvCell(input: string, fieldPath: string, patterns: readonly RedactionPattern[]): RedactedText {
  let structured: unknown;
  try { structured = JSON.parse(input) as unknown; }
  catch (error: unknown) { if (!(error instanceof SyntaxError)) throw error; return redactReviewText(input, fieldPath, patterns); }
  if (structured === null || typeof structured !== 'object') return redactReviewText(input, fieldPath, patterns);
  const redacted: RedactedJson = redactReviewJson(structured, fieldPath, patterns);
  return { value: stableJsonStringify(redacted.value).trimEnd(), entries: redacted.entries };
}
export function redactCsvProjection(rows: readonly string[][], patterns: readonly RedactionPattern[]): { rows: string[][]; entries: RedactionEntry[] } {
  const entries: RedactionEntry[] = [];
  const result: string[][] = rows.map((row: string[], rowIndex: number): string[] => row.map((cell: string, columnIndex: number): string => {
    const redacted: RedactedText = redactCsvCell(cell, `/shots.csv/${rowIndex}/${columnIndex}`, patterns); entries.push(...redacted.entries); return redacted.value;
  }));
  return { rows: result, entries };
}
export function redactPdfProjection(input: PdfProjection, patterns: readonly RedactionPattern[]): { projection: PdfProjection; entries: RedactionEntry[] } {
  const entries: RedactionEntry[] = [];
  const text = (value: string, field: string): string => { const result: RedactedText = redactReviewText(value, `/storyboard.pdf/${field}`, patterns); entries.push(...result.entries); return result.value; };
  const track = (entry: PdfTrackEntry, field: string): PdfTrackEntry => ({ id: text(entry.id, `${field}/id`),
    label: text(entry.label, `${field}/label`), timeText: text(entry.timeText, `${field}/timeText`),
    body: text(entry.body, `${field}/body`), statusText: text(entry.statusText, `${field}/statusText`) });
  const items: PdfFramePageItem[] = input.items.map((item: PdfFramePageItem, index: number): PdfFramePageItem => ({ ...item, image: null, overlayInputs: [],
    shotId: text(item.shotId, `${index}/shotId`), frameId: text(item.frameId, `${index}/frameId`), timeText: text(item.timeText, `${index}/timeText`), cameraText: text(item.cameraText, `${index}/cameraText`),
    action: text(item.action, `${index}/action`), frameText: text(item.frameText, `${index}/frameText`), sourceText: text(item.sourceText, `${index}/sourceText`),
    gateText: text(item.gateText, `${index}/gateText`), outputText: text(item.outputText, `${index}/outputText`), placeholderText: text(item.placeholderText, `${index}/placeholderText`),
    description: text(item.description, `${index}/description`),
    textEntries: item.textEntries.map((entry: PdfTrackEntry, trackIndex: number): PdfTrackEntry => track(entry, `${index}/textEntries/${trackIndex}`)),
    audioEntries: item.audioEntries.map((entry: PdfTrackEntry, trackIndex: number): PdfTrackEntry => track(entry, `${index}/audioEntries/${trackIndex}`)) }));
  const { textTypography: _textTypography, ...visibleProjection } = input;
  return { projection: { ...visibleProjection, title: text(input.title, 'title'), outputLabel: text(input.outputLabel, 'outputLabel'),
    ...(input.selectionLabel === undefined ? {} : { selectionLabel: text(input.selectionLabel, 'selectionLabel') }), items }, entries };
}
export function redactionManifest(profile: ReviewProfile, label: string, explicit: readonly string[], entries: readonly RedactionEntry[]): RedactionManifest {
  const categories: Record<string, number> = {};
  for (const entry of entries) categories[entry.category] = (categories[entry.category] ?? 0) + entry.count;
  return { profile, label, policyVersion: '1.0.0', configuredPatternHashes: explicit.map(sha256Text), categories, entries: [...entries],
    externalImagePolicy: profile === 'external' ? 'placeholder' : 'not-applicable', embeddedImageRedaction: 'not-performed' };
}

export function redactReviewBuild(build: BuildManifest, fieldPath: string, patterns: readonly RedactionPattern[]): { build: BuildManifest; entries: RedactionEntry[] } {
  const result: RedactedJson = redactReviewJson(build, fieldPath, patterns);
  const parsed = BuildManifestSchema.safeParse(result.value);
  if (!parsed.success) throw contractError('REVIEW_REDACTION_PATTERN_INVALID', '지정 개인정보 패턴이 Build 식별 Hash·시각 계약과 충돌합니다. 패턴 범위를 구체화하세요.', []);
  return { build: parsed.data, entries: result.entries };
}

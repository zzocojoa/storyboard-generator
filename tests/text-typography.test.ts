import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { reviewFinalReadiness } from '../src/domain/final-readiness.js';
import { TextTypographySchema, TextFontRegistrationsSchema } from '../src/domain/text-typography.js';
import type { TextTypography } from '../src/domain/text-typography.js';
import { createPdfProjection, renderPdfProjection } from '../src/exporters/pdf.js';
import { redactPdfProjection, reviewRedactionPatterns } from '../src/exporters/review-redaction.js';
import { parseProject, parseProjectSnapshotEvidence } from '../src/io/project.js';
import { stableJsonStringify } from '../src/io/stable-json.js';
import { sha256Text } from '../src/importers/integrity.js';
import { withProjectTextReadiness } from '../src/rendering/project-text.js';
import { readSelectedTextFont, readTextFontCatalog } from '../src/rendering/text-font-source.js';
import type { TextFontEnvironment } from '../src/rendering/text-font-source.js';
import { layoutStoryboardText } from '../src/rendering/text-layout.js';
import { vectorTextLayout } from '../src/rendering/text-font.js';
import { issueDestination } from '../web/src/workspace-navigation.js';
import { TEST_TEXT_FONT_PATH } from './helpers.js';
import { finalFixture } from './readiness-fixtures.js';
import { TEST_LATIN_FONT_PATH, testTextTypography } from './typography-helpers.js';

it('text_typography_uses_registered_font_bytes_and_language_without_substitution', async (): Promise<void> => {
  const environment: TextFontEnvironment = { defaultPath: TEST_TEXT_FONT_PATH, registrations: [{ id: 'mono', label: 'Latin mono', path: TEST_LATIN_FONT_PATH }] };
  const catalog = await readTextFontCatalog(environment);
  expect(catalog.unavailable).toEqual([]); expect(catalog.fonts.map((font): string => font.id)).toEqual(['default', 'mono']);
  const choice = catalog.fonts[1]!;
  const selected: TextTypography = { version: '1.0.0', language: 'en', fontId: choice.id, fontSha256: choice.sha256 };
  const font = await readSelectedTextFont(selected, environment); const original = await readSelectedTextFont(undefined, environment);
  expect(font.metrics.language).toBe('en'); expect(font.sha256).not.toBe(original.sha256);
  const fixture = await finalFixture(); const input = [{ id: 'english', kind: 'overlay' as const, text: 'Water the plant.' }];
  const selectedVector = vectorTextLayout(layoutStoryboardText(input, 16, 9, fixture.project.textLayout, font.metrics), font);
  const defaultVector = vectorTextLayout(layoutStoryboardText(input, 16, 9, fixture.project.textLayout, original.metrics), original);
  expect(selectedVector.problems).toEqual([]); expect(selectedVector.boxes[0]!.paths).not.toEqual(defaultVector.boxes[0]!.paths);
  expect(font.metrics.supports('물을 주세요')).toBe(false);
  await expect(readSelectedTextFont({ ...selected, fontId: 'missing' }, environment)).rejects.toMatchObject({ code: 'TEXT_FONT_NOT_REGISTERED' });
  await expect(readSelectedTextFont({ ...selected, fontSha256: '0'.repeat(64) }, environment)).rejects.toMatchObject({ code: 'TEXT_FONT_HASH_MISMATCH' });
  expect(TextTypographySchema.safeParse({ ...selected, language: 'not_a_locale' }).success).toBe(false);
  expect(TextFontRegistrationsSchema.safeParse([{ id: 'default', label: 'override', path: TEST_LATIN_FONT_PATH }]).success).toBe(false);
  expect(TextFontRegistrationsSchema.safeParse([...environment.registrations, ...environment.registrations]).success).toBe(false);
});

it('text_typography_missing_and_changed_fonts_block_final_but_keep_project_repairable', async (): Promise<void> => {
  const root: string = await mkdtemp(join(tmpdir(), 'cutroom-typography-'));
  try {
    const path: string = join(root, 'selected.ttf'); await writeFile(path, await readFile(TEST_TEXT_FONT_PATH));
    const environment: TextFontEnvironment = { defaultPath: TEST_TEXT_FONT_PATH, registrations: [{ id: 'selected', label: 'Selected', path }, { id: 'absent', label: 'Absent', path: join(root, 'absent.ttf') }] };
    const catalog = await readTextFontCatalog(environment); const selection = { ...await testTextTypography(), fontId: 'selected', language: 'ko' };
    expect(catalog.fonts).toHaveLength(2); expect(catalog.unavailable[0]).toMatchObject({ id: 'absent', code: 'TEXT_FONT_FILE_UNAVAILABLE' });
    expect(JSON.stringify(catalog)).not.toContain(root);
    const fixture = await finalFixture(); const project = { ...fixture.project, textTypography: selection };
    const readiness = reviewFinalReadiness(project, fixture.integrity);
    expect((await withProjectTextReadiness(project, readiness, environment)).finalReady).toBe(true);
    await writeFile(path, await readFile(TEST_LATIN_FONT_PATH));
    const mismatch = await withProjectTextReadiness(project, readiness, environment);
    expect(mismatch.finalReady).toBe(false); expect(mismatch.issues).toContainEqual(expect.objectContaining({ code: 'TEXT_FONT_HASH_MISMATCH', field: 'textTypography' }));
    expect(issueDestination(project, mismatch.issues.find((issue): boolean => issue.code === 'TEXT_FONT_HASH_MISMATCH')!)).toMatchObject({ settingsSection: 'text-typography' });
    await rm(path);
    expect((await withProjectTextReadiness(project, readiness, environment)).issues).toContainEqual(expect.objectContaining({ code: 'TEXT_FONT_FILE_UNAVAILABLE' }));
    await writeFile(path, 'not a font');
    expect((await readTextFontCatalog(environment)).unavailable).toContainEqual(expect.objectContaining({ id: 'selected', code: 'TEXT_FONT_FILE_INVALID' }));
    expect(project.textCues).toEqual(fixture.project.textCues); expect(project.frames).toEqual(fixture.project.frames);
  } finally { await rm(root, { recursive: true, force: true }); }
});

it('text_typography_pdf_keeps_selected_overlay_font_and_redacts_selection_externally', async (): Promise<void> => {
  const fixture = await finalFixture(); const selected: TextTypography = { ...await testTextTypography(), language: 'ko' };
  const project = { ...fixture.project, textTypography: selected };
  const projection = await createPdfProjection(project, async (id): Promise<Buffer> => fixture.media.get(id)!, { maturity: 'draft', channel: 'pdf-export' }, fixture.integrity);
  expect(projection.textTypography).toEqual(selected);
  const pdf = await renderPdfProjection(projection, TEST_TEXT_FONT_PATH, '2026-09-12T00:00:00.000Z');
  const loading = getDocument({ data: new Uint8Array(pdf), useSystemFonts: false });
  const document = await loading.promise;
  try {
    const metadata = await document.getMetadata();
    expect(JSON.stringify(metadata.info)).toContain(`text-language:ko`);
    expect(JSON.stringify(metadata.info)).toContain(selected.fontSha256);
  } finally { await loading.destroy(); }
  const external = redactPdfProjection(projection, reviewRedactionPatterns([])).projection;
  expect(external).not.toHaveProperty('textTypography'); expect(external.items.every((item): boolean => item.overlayInputs.length === 0)).toBe(true);
});

it('text_typography_migration_preserves_117_source_and_rejects_unknown_legacy_selection', async (): Promise<void> => {
  const fixture = await finalFixture(); const legacy = { ...fixture.project, schemaVersion: '1.17.0' };
  const bytes: string = stableJsonStringify(legacy); const evidence = parseProjectSnapshotEvidence(legacy);
  expect(evidence.project).toEqual({ ...legacy, schemaVersion: '1.23.0' }); expect(evidence.project).not.toHaveProperty('textTypography');
  expect(evidence.projectionHashes).toContain(sha256Text(bytes)); expect(stableJsonStringify(legacy)).toBe(bytes);
  expect(() => parseProject({ ...legacy, textTypography: { unknown: 'preserve me' } })).toThrowError(expect.objectContaining({ code: 'UNSUPPORTED_LEGACY_TEXT_TYPOGRAPHY' }));
});

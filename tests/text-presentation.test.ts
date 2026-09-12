import { expect, it } from 'vitest';
import { currentTextPresentations } from '../src/automation/text-cue-schema.js';
import { compileTextPresentations } from '../src/automation/text-cue-plan.js';
import { reconcileTextCues } from '../src/domain/mapping.js';
import type { TextCue } from '../src/domain/schema.js';
import { applySourceUpdate } from '../src/domain/source-update.js';
import { initialTextPresentation, updateTextPresentation, resetTextPresentation } from '../src/domain/text-presentation.js';
import type { TextPresentation } from '../src/domain/text-presentation.js';
import { createPdfProjection, renderPdfProjection } from '../src/exporters/pdf.js';
import { importPackage } from '../src/importers/import-package.js';
import { parseProject } from '../src/io/project.js';
import { createSourceOutline } from '../src/proposal/outline.js';
import { projectTextLayoutAt } from '../src/rendering/project-text.js';
import { layoutStoryboardText } from '../src/rendering/text-layout.js';
import { readTextFont, textLayoutSvg, vectorTextLayout } from '../src/rendering/text-font.js';
import { TEST_TEXT_FONT_PATH, nativeData, nativePackage, withNativeData } from './helpers.js';
import { finalFixture, readinessOutline } from './readiness-fixtures.js';

it('text_presentation_places_real_glyphs_with_alignment_palette_and_stable_layers', async (): Promise<void> => {
  const project = await readinessOutline(); const font = await readTextFont(TEST_TEXT_FONT_PATH);
  const presentation: TextPresentation = { ...initialTextPresentation(project.textLayout, 'overlay'), mode: 'manual', x: 0.1, y: 0.2, width: 0.35, alignment: 'left', layer: 2, background: 'light' };
  const input = [{ id: 'left', kind: 'overlay' as const, text: '왼쪽 문구', presentation },
    { id: 'right', kind: 'overlay' as const, text: '오른쪽 문구', presentation: { ...presentation, x: 0.55, layer: 1, alignment: 'right' as const, background: 'dark' as const } }];
  const original: string = JSON.stringify(input);
  for (const [width, height] of [[16, 9], [9, 16]]) {
    const result = layoutStoryboardText(input, width!, height!, project.textLayout, font.metrics);
    expect(result.problems).toEqual([]); expect(result.boxes.map((box): string => box.cueId)).toEqual(['right', 'left']);
    expect(result.boxes[1]!.x / result.width).toBeCloseTo(0.1); expect(result.boxes[1]!.y / result.height).toBeCloseTo(0.2);
    expect(result.boxes[0]!.lines.map((line): string => line.text).join('')).toBe('오른쪽 문구');
    const svg: string = textLayoutSvg(vectorTextLayout(result, font)); expect(svg).toContain('fill="#ffffff"'); expect(svg).toContain('fill="#172019"'); expect(svg).toContain('<path');
  }
  expect(JSON.stringify(input)).toBe(original);
  const collision = layoutStoryboardText(input.map((cue) => ({ ...cue, presentation: { ...cue.presentation, x: 0.1 } })), 16, 9, project.textLayout, font.metrics);
  expect(collision.problems.filter((problem): boolean => problem.code === 'TEXT_LAYOUT_COLLISION')).toHaveLength(2); expect(collision.boxes).toEqual([]);
  const overflow = layoutStoryboardText([{ ...input[0]!, presentation: { ...presentation, x: 0.9 } }], 16, 9, project.textLayout, font.metrics);
  expect(overflow.problems).toContainEqual(expect.objectContaining({ code: 'TEXT_LAYOUT_OVERFLOW' })); expect(overflow.boxes).toEqual([]);
});

it('text_presentation_manual_edits_and_automatic_plans_preserve_originals_and_protection', async (): Promise<void> => {
  const source = await readinessOutline(); const cue = source.textCues[0]!;
  const value = { ...initialTextPresentation(source.textLayout, cue.kind), x: 0.12, width: 0.7 };
  const manual = updateTextPresentation(source, cue.id, value); const { presentation, ...unchanged } = manual.textCues[0]!;
  expect(presentation?.mode).toBe('manual'); expect(unchanged).toEqual(cue); expect(manual.frames).toEqual(source.frames); expect(source.textCues[0]).not.toHaveProperty('presentation');
  const rows = currentTextPresentations(manual); expect(compileTextPresentations(manual, rows)).toEqual(manual.textCues);
  expect(() => compileTextPresentations(manual, rows.map((row) => ({ ...row, presentation: null })))).toThrowError(expect.objectContaining({ code: 'AUTOMATION_TEXT_CUE_PRESENTATION_INVALID' }));
  expect(() => compileTextPresentations(manual, rows.slice(1))).toThrowError(expect.objectContaining({ code: 'AUTOMATION_TEXT_CUE_PRESENTATION_INVALID' }));
  expect(() => compileTextPresentations(manual, [...rows.slice(1), rows[1]!])).toThrowError(expect.objectContaining({ code: 'AUTOMATION_TEXT_CUE_PRESENTATION_INVALID' }));
  const automatic = compileTextPresentations(source, currentTextPresentations(source).map((row) => row.cueId === cue.id ? { ...row, presentation: { ...value, mode: 'automatic' as const } } : row));
  expect(automatic[0]!.presentation?.mode).toBe('automatic'); expect(automatic.map(({ presentation: _value, ...rest }): Omit<TextCue, 'presentation'> => rest)).toEqual(source.textCues);
  const approved = { ...source, shots: source.shots.map((shot) => ({ ...shot, approvalStatus: 'approved' as const })) };
  expect(() => compileTextPresentations(approved, currentTextPresentations({ ...source, textCues: automatic }))).toThrowError(expect.objectContaining({ code: 'AUTOMATION_TEXT_CUE_PRESENTATION_INVALID' }));
  expect(resetTextPresentation(manual, cue.id).textCues).toEqual(source.textCues);
});

it('text_presentation_survives_mapping_reconciliation_and_explicit_source_update', async (): Promise<void> => {
  const payload = await nativePackage(); const data = nativeData(payload); const source = createSourceOutline(importPackage(payload), { proposedTextHoldMs: 2000 });
  const cue = source.textCues[0]!; const edited = updateTextPresentation(source, cue.id, initialTextPresentation(source.textLayout, cue.kind));
  expect(reconcileTextCues(edited, edited.textMappingDecisions, 2000).find((item): boolean => item.id === cue.id)?.presentation).toEqual(edited.textCues[0]!.presentation);
  const unit = data.units.find((item): boolean => item.segmentId === cue.segmentId && item.kind === 'ACTION'); expect(unit).toBeDefined();
  const changed = { ...data, units: data.units.map((item) => item.id === unit!.id ? { ...item, text: `${item.text} 손의 위치를 유지한다.` } : item) };
  const incoming = createSourceOutline(importPackage(withNativeData(payload, changed)), { proposedTextHoldMs: 2000 });
  const updated = applySourceUpdate(edited, incoming, 'presentation-update');
  const replacement = updated.textCues.find((item): boolean => item.placementId === cue.placementId && item.authority === cue.authority);
  expect(replacement?.id).not.toBe(cue.id); expect(replacement?.presentation).toEqual(edited.textCues[0]!.presentation);
  expect(replacement?.text).toBe(cue.text); expect(edited.dataset).toEqual(source.dataset);
});

it('text_presentation_pdf_and_monitor_share_individual_layout_and_legacy_values_are_not_invented', async (): Promise<void> => {
  const fixture = await finalFixture(); const cue = fixture.project.textCues[0]!; const font = await readTextFont(TEST_TEXT_FONT_PATH);
  const project = updateTextPresentation(fixture.project, cue.id, { ...initialTextPresentation(fixture.project.textLayout, cue.kind), x: 0.2, width: 0.6, y: 0.4, background: 'light', alignment: 'right', layer: 3 });
  const projection = await createPdfProjection(project, async (id): Promise<Buffer> => fixture.media.get(id)!, { maturity: 'draft', channel: 'pdf-export' }, fixture.integrity);
  expect(projection.items[0]!.overlayInputs[0]!.presentation).toEqual(project.textCues[0]!.presentation);
  expect(layoutStoryboardText(projection.items[0]!.overlayInputs, project.profile.aspectWidth, project.profile.aspectHeight, project.textLayout, font.metrics)).toEqual(projectTextLayoutAt(project, cue.startMs, 'draft', font));
  const pdf = await renderPdfProjection(projection, TEST_TEXT_FONT_PATH, '2026-09-12T00:00:00.000Z'); expect(pdf.subarray(0, 4).toString()).toBe('%PDF');
  const legacy = { ...fixture.project, schemaVersion: '1.18.0' }; const original: string = JSON.stringify(legacy);
  expect(parseProject(legacy)).toEqual({ ...legacy, schemaVersion: '1.21.0' }); expect(JSON.stringify(legacy)).toBe(original);
  expect(() => parseProject({ ...legacy, textCues: project.textCues })).toThrowError(expect.objectContaining({ code: 'UNSUPPORTED_LEGACY_TEXT_PRESENTATION' }));
});

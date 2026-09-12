import { resolve } from 'node:path';
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { reviewFinalReadiness } from '../src/domain/final-readiness.js';
import type { Project } from '../src/domain/schema.js';
import { storyboardTextPreset } from '../src/domain/text-layout-settings.js';
import { createPdfProjection, exportProjectPdfForPolicy, renderPdfProjection } from '../src/exporters/pdf.js';
import { redactPdfProjection, reviewRedactionPatterns } from '../src/exporters/review-redaction.js';
import { parseProject, parseProjectSnapshotEvidence } from '../src/io/project.js';
import { sha256Text } from '../src/importers/integrity.js';
import { stableJsonStringify } from '../src/io/stable-json.js';
import { layoutStoryboardText } from '../src/rendering/text-layout.js';
import { projectTextLayoutAt, textLayoutTimelineIssues, withTextLayoutReadiness } from '../src/rendering/project-text.js';
import { readTextFont, textLayoutSvg, vectorTextLayout } from '../src/rendering/text-font.js';
import { legacyTextProject } from './legacy-text-helpers.js';
import { finalFixture } from './readiness-fixtures.js';

const fontPath: string = resolve('assets/fonts/NanumGothic-Regular.ttf');

describe('실제 글꼴의 공통 글자 배치', (): void => {
  it('text_layout_preserves_korean_and_long_tokens_and_separates_roles', async (): Promise<void> => {
    const font = await readTextFont(fontPath); const preset = { ...storyboardTextPreset(), fontSize: 0.03, maxLines: 12 };
    const text: string = '긴 한글과 공백을 모두 보존합니다. '.repeat(4) + '문자가계속이어지는단어'.repeat(4);
    const inputs = [{ id: 'notice', kind: 'overlay' as const, text }, { id: 'prop', kind: 'prop-text' as const, text: '메모의 원문' }, { id: 'subtitle', kind: 'dialogue-subtitle' as const, text: '화자가 말하는 내용' }];
    const tabbed = layoutStoryboardText([{ id: 'tab', kind: 'overlay', text: '흙\t확인' }], 16, 9, preset, font.metrics);
    const spaced = layoutStoryboardText([{ id: 'tab', kind: 'overlay', text: '흙    확인' }], 16, 9, preset, font.metrics);
    expect(tabbed.boxes[0]!.lines[0]!.text).toBe('흙\t확인');
    expect(vectorTextLayout(tabbed, font)).toEqual(vectorTextLayout(spaced, font));
    for (const [width, height] of [[16, 9], [9, 16]]) {
      const layout = layoutStoryboardText(inputs, width!, height!, preset, font.metrics);
      expect(layout.problems).toEqual([]); expect(layout.boxes).toHaveLength(3);
      expect(layout.boxes[0]!.lines.map((line): string => line.text).join('')).toBe(text);
      expect(layout.boxes[0]!.y + layout.boxes[0]!.height).toBeLessThan(layout.boxes[1]!.y);
      expect(layout.boxes[1]!.y + layout.boxes[1]!.height).toBeLessThan(layout.boxes[2]!.y);
      const vector = vectorTextLayout(layout, font); const svg: string = textLayoutSvg(vector);
      expect(svg).not.toContain('<text'); expect(svg).toContain('<path'); expect(vector.fontSha256).toBe(font.sha256);
      const image = await sharp(Buffer.from(svg)).png().toBuffer({ resolveWithObject: true });
      expect(image.info.width / image.info.height).toBeCloseTo(width! / height!, 2);
    }
  });

  it('text_layout_reports_collisions_overflow_and_unsupported_glyphs_without_truncation', async (): Promise<void> => {
    const font = await readTextFont(fontPath); const text: string = '화면에서 읽어야 하는 긴 문구입니다. '.repeat(4);
    const inputs = (['overlay', 'prop-text', 'dialogue-subtitle'] as const).map((kind) => ({ id: kind, kind, text }));
    const crowded = layoutStoryboardText(inputs, 16, 9, { ...storyboardTextPreset(), fontSize: 0.1, maxLines: 12 }, font.metrics);
    expect(crowded.problems.some((problem): boolean => problem.code === 'TEXT_LAYOUT_COLLISION')).toBe(true);
    const overflow = layoutStoryboardText(inputs, 9, 16, { ...storyboardTextPreset(), maxLines: 1 }, font.metrics);
    expect(overflow.problems.some((problem): boolean => problem.code === 'TEXT_LAYOUT_OVERFLOW')).toBe(true); expect(overflow.boxes).toEqual([]);
    const unsupported = layoutStoryboardText([{ id: 'missing', kind: 'overlay', text: '\u{10ffff}' }], 16, 9, storyboardTextPreset(), font.metrics);
    expect(unsupported.problems.map((problem): string => problem.code)).toContain('TEXT_FONT_GLYPH_MISSING'); expect(unsupported.boxes).toEqual([]);
    expect(inputs.every((input): boolean => input.text === text)).toBe(true);
  });

  it('text_layout_detects_a_problem_between_frames_and_blocks_final_pdf', async (): Promise<void> => {
    const fixture = await finalFixture(); const unit = fixture.project.dataset.units.find((value): boolean => value.id === '안내-1')!;
    const project: Project = { ...fixture.project, textLayout: { ...storyboardTextPreset(), fontSize: 0.1, maxLines: 2 }, textCues: [...fixture.project.textCues,
      { id: 'between-frames', segmentId: unit.segmentId, unitId: unit.id, placementId: null, mappingDecisionId: null, authority: 'source-unit', text: unit.text,
        kind: 'dialogue-subtitle', timingStatus: 'confirmed', startMs: 6000, endMs: 9000 }] };
    expect(parseProject(project)).toEqual(project); expect(reviewFinalReadiness(project, fixture.integrity).finalReady).toBe(true);
    const font = await readTextFont(fontPath);
    for (const time of [0, 5000, 13500]) expect(projectTextLayoutAt(project, time, 'final', font).problems).toEqual([]);
    expect(textLayoutTimelineIssues(project, font)).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'TEXT_LAYOUT_OVERFLOW', entityId: 'between-frames' })]));
    expect(withTextLayoutReadiness(project, reviewFinalReadiness(project, fixture.integrity), font).finalReady).toBe(false);
    await expect(exportProjectPdfForPolicy(project, fontPath, async (id): Promise<Buffer> => fixture.media.get(id)!, { maturity: 'final', channel: 'pdf-export' }, fixture.integrity)).rejects.toMatchObject({ code: 'FINAL_OUTPUT_NOT_READY' });
  });

  it('text_layout_pdf_uses_only_current_allowed_text_and_redacts_overlay_inputs', async (): Promise<void> => {
    const fixture = await finalFixture(); const font = await readTextFont(fontPath);
    const projection = await createPdfProjection(fixture.project, async (id): Promise<Buffer> => fixture.media.get(id)!, { maturity: 'draft', channel: 'pdf-export' }, fixture.integrity);
    expect(projection.textLayout).toEqual(fixture.project.textLayout);
    expect(projection.items[0]!.overlayInputs.map((input): string => input.text)).toEqual([fixture.project.textCues[0]!.text]);
    expect(projection.items[1]!.overlayInputs).toEqual([]);
    expect(layoutStoryboardText(projection.items[0]!.overlayInputs, projection.aspectWidth, projection.aspectHeight, projection.textLayout, font.metrics))
      .toEqual(projectTextLayoutAt(fixture.project, 0, 'draft', font));
    const createdAt: string = '2026-09-11T00:00:00.000Z';
    expect(await renderPdfProjection(projection, fontPath, createdAt)).toEqual(await renderPdfProjection(projection, fontPath, createdAt));
    const external = redactPdfProjection(projection, reviewRedactionPatterns([])).projection;
    expect(external.items.every((item): boolean => item.overlayInputs.length === 0 && item.image === null)).toBe(true);
    const proposed: Project = { ...fixture.project, textCues: fixture.project.textCues.map((cue) => ({ ...cue, timingStatus: 'proposed' })) };
    expect(projectTextLayoutAt(proposed, 0, 'final', font).boxes).toEqual([]);
    expect(projectTextLayoutAt(proposed, 0, 'draft', font).boxes).toHaveLength(1);
  });

  it('text_layout_migration_keeps_legacy_hashes_and_all_original_fields', async (): Promise<void> => {
    const fixture = await finalFixture(); const legacy = { ...legacyTextProject(fixture.project), schemaVersion: '1.12.0' };
    const original: string = stableJsonStringify(legacy); const evidence = parseProjectSnapshotEvidence(legacy);
    expect(evidence.projectionHashes).toContain(sha256Text(original)); expect(stableJsonStringify(legacy)).toBe(original);
    expect(evidence.project).toEqual({ ...legacy, schemaVersion: '1.23.0', textLayout: storyboardTextPreset(), textReadability: fixture.project.textReadability, textLayoutControl: { version: '1.0.0', mode: 'manual', plannedInputHash: null } });
    expect(parseProject(evidence.project)).toEqual(evidence.project);
    expect(() => parseProject({ ...legacy, textLayout: { unknown: '이전 값을 버리면 안 됨' } })).toThrowError(expect.objectContaining({ code: 'UNSUPPORTED_LEGACY_TEXT_LAYOUT' }));
  });
});

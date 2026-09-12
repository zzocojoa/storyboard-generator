import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { compileDocuments, inspectDocuments } from '../src/documents/compile.js';
import { readDocumentSources, writeDocumentPackage } from '../src/documents/io.js';
import { buildDocumentPackage } from '../src/documents/package.js';
import type { DocumentManifest } from '../src/documents/supporting.js';
import type { DocumentKey } from '../src/documents/schema.js';
import { reviewFinalReadiness } from '../src/domain/final-readiness.js';
import { reconcileTextCues } from '../src/domain/mapping.js';
import { validateDataset, validateProject } from '../src/domain/validation.js';
import { importPackage } from '../src/importers/import-package.js';
import { readPackage } from '../src/io/package.js';
import { parseProject } from '../src/io/project.js';
import { buildSegmentContext } from '../src/proposal/context.js';
import { createSourceOutline } from '../src/proposal/outline.js';
import { documentTestSettings, PRODUCTION_DOCUMENT_BINDINGS } from './document-helpers.js';
import { syntheticSectionSources, withSectionChanges } from './document-section-helpers.js';

const roots: string[] = [];
const bindings = { people: [], scenes: [], units: [] };
afterEach(async (): Promise<void> => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

describe('구간 제목형 여덟 문서', (): void => {
  it('section_documents_roundtrip_preserves_all_units_and_explicit_identity_evidence', async (): Promise<void> => {
    const sources = await readDocumentSources('tests/fixtures/section-documents');
    const preview = inspectDocuments(sources, bindings).preview;
    expect(preview.counts).toEqual({ scenes: 12, segments: 24, units: 208, narration: 6, panel: 24 });
    expect(Object.fromEntries(preview.people.map((choice) => [choice.key, choice.selected]))).toEqual({ 민아: 'CHAR-01', 준: 'CHAR-03', 다솜: 'CHAR-02', 보라: 'CHAR-05', 태오: 'CHAR-04', 수인: 'CHAR-06', 하늘: 'PANEL-01', 여울: 'PANEL-02' });
    expect([...preview.people, ...preview.scenes, ...preview.units].every((choice): boolean => choice.selected !== null)).toBe(true);
    expect(preview.people.every((choice): boolean => choice.sourceRefs.some((ref): boolean => ref.fileId === 'document-shooting'))).toBe(true);
    const root = await mkdtemp(join(tmpdir(), 'section-documents-')); roots.push(root);
    const result = await writeDocumentPackage('tests/fixtures/section-documents', documentTestSettings(sources, bindings), join(root, 'package'));
    const payload = await readPackage(result.handoffPath);
    const project = createSourceOutline(importPackage(payload), { proposedTextHoldMs: 1800 });
    expect(project.dataset.units.map((unit) => [unit.kind, unit.delivery, unit.text])).toEqual(inspectDocuments(sources, bindings).broadcast.units.map((unit) => [unit.kind, unit.delivery, unit.text]));
    expect(project.dataset.segments.at(-1)?.endMs).toBe(1500000);
    expect(project.shots).toHaveLength(24);
    expect(project.dataset.segments.every((segment): boolean => segment.timingStatus === 'proposed')).toBe(true);
    expect(parseProject(project)).toEqual(project);
    expect(validateProject(project, project.dataset).filter((issue): boolean => issue.severity === 'error')).toEqual([]);
    for (const file of Object.values(sources)) expect(await readFile(join(root, 'package', file.path), 'utf8')).toBe(file.content);
  });

  it('section_documents_keep_subtitle_times_unconfirmed_and_inner_monologue_spoken_once', async (): Promise<void> => {
    const original = await readDocumentSources('tests/fixtures/section-documents');
    const finalHeader: string = '## SEG-024 24:25–25:00 · PANEL_REACTION · SCN-12';
    expect(original.edit.content).toContain(finalHeader);
    const finalNote: string = '정리한 도구 목록을 마지막 패널 구간에서 확인한다.';
    const sources = withSectionChanges(original, { edit: original.edit.content.replace(finalHeader, `${finalHeader}\n\n${finalNote}`) });
    const project = createSourceOutline(importPackage(buildDocumentPackage(sources, documentTestSettings(sources, bindings))), { proposedTextHoldMs: 1800 });
    expect(project.dataset.textPlacements).toEqual([]);
    expect(project.textCues).toHaveLength(155);
    expect(validateProject({ ...project, textCues: project.textCues.slice(1) }, project.dataset).some((issue): boolean => issue.code === 'SUBTITLE_PLAN_COVERAGE')).toBe(true);
    expect(project.textCues.every((cue): boolean => cue.authority === 'source-unit' && cue.timingStatus === 'proposed' && cue.endMs - cue.startMs === 1800)).toBe(true);
    expect(project.dataset.units.filter((unit): boolean => unit.subtitleSourceRefs !== undefined)).toHaveLength(155);
    const written = project.dataset.units.filter((unit): boolean => unit.kind === 'CHAT' || unit.kind === 'NOTE');
    expect(written.length).toBeGreaterThan(0);
    expect(project.audioCues.some((cue): boolean => written.some((unit): boolean => unit.id === cue.unitId))).toBe(false);
    const inner = project.dataset.units.filter((unit): boolean => unit.delivery === 'inner-monologue');
    expect(inner).toHaveLength(2);
    for (const unit of inner) {
      expect(project.audioCues.filter((cue): boolean => cue.unitId === unit.id).map((cue): string => cue.kind)).toEqual(['voiceover']);
      expect(buildSegmentContext(project, unit.segmentId).sourceUnits.find((candidate): boolean => candidate.id === unit.id)?.delivery).toBe('inner-monologue');
    }
    const changed = { ...project, textCues: project.textCues.map((cue, index) => index === 0 ? { ...cue, startMs: 500, endMs: 2200, timingStatus: 'confirmed' as const } : cue) };
    expect(reconcileTextCues(changed, changed.textMappingDecisions, 1800)[0]).toEqual(changed.textCues[0]);
    expect(reviewFinalReadiness(project, {}).issues.some((issue): boolean => issue.code === 'TEXT_TIMING_CONFIRMATION_REQUIRED')).toBe(true);
    expect(project.dataset.instructions.filter((instruction): boolean => instruction.segmentId === 'SEG-024').some((instruction): boolean => instruction.text.includes(finalNote))).toBe(true);
    expect(project.dataset.instructions.filter((instruction): boolean => instruction.segmentId === 'SEG-001').some((instruction): boolean => instruction.text.includes(finalNote))).toBe(false);
  });

  it('section_documents_support_independent_short_story_without_narration_or_panels', async (): Promise<void> => {
    const sources = await syntheticSectionSources();
    const preview = inspectDocuments(sources, bindings).preview;
    expect(preview.counts).toEqual({ scenes: 2, segments: 2, units: 4, narration: 0, panel: 0 });
    const project = createSourceOutline(importPackage(buildDocumentPackage(sources, documentTestSettings(sources, bindings))), { proposedTextHoldMs: 1000 });
    expect(project.projectId).toBe('plant-doc-demo'); expect(project.textCues).toHaveLength(2);
    expect(project.dataset.segments.map((segment) => [segment.id, segment.mode, segment.endMs])).toEqual([['opening', 'DEMO', 8000], ['finish', 'DEMO', 20000]]);
    const manifest = JSON.parse(sources.manifest.content) as DocumentManifest;
    const silent = withSectionChanges(sources, {
      shooting: sources.shooting.content.replace('CAST:host ', 'CAST:host,observer '),
      broadcast: sources.broadcast.content.replace('| 민아 |', '| 관찰자 | 말없이 지켜본다 | 동료 |\n| 민아 |'),
      reenactment: sources.reenactment.content.replace('| 민아 |', '| 관찰자 | 말없이 지켜본다 | 동료 |\n| 민아 |'),
      manifest: JSON.stringify({ ...manifest, scenes: manifest.scenes.map((scene, index) => index === 0 ? { ...scene, cast_ids: [...scene.cast_ids, 'observer'] } : scene) }),
    });
    expect(inspectDocuments(silent, bindings).preview.people.find((person): boolean => person.key === '관찰자')?.selected).toBeNull();
    expect(() => compileDocuments(silent, bindings)).toThrow(/연결/u);
    expect(compileDocuments(silent, { ...bindings, people: [{ key: '관찰자', targetId: 'observer' }] }).dataset.people).toHaveLength(3);
    const legacy = await readDocumentSources('tests/fixtures/production/09_PRODUCTION');
    expect(compileDocuments(legacy, PRODUCTION_DOCUMENT_BINDINGS).dataset.segments).toHaveLength(32);
  });

  it('section_documents_reject_conflicting_identity_timeline_markers_and_subtitles', async (): Promise<void> => {
    const sources = await readDocumentSources('tests/fixtures/section-documents');
    const cases: { key: DocumentKey; before: string; after: string }[] = [
      { key: 'edit', before: 'garden-steps-demo ·', after: 'garden-steps-demo-other ·' },
      { key: 'edit', before: '02:00–03:00', after: '02:01–03:00' },
      { key: 'shooting', before: 'DURATION:120', after: 'DURATION:121' },
      { key: 'shooting', before: '<!-- END_SEGMENT:SEG-001 -->', after: '<!-- END_SEGMENT:missing -->' },
      { key: 'shooting', before: '<!-- UNIT:UNIT-01-002 -->', after: '<!-- UNIT:UNIT-01-001 -->' },
      { key: 'shooting', before: '[MESSAGE] CHAR-01:', after: '[MESSAGE] CHAR-02:' },
      { key: 'shooting', before: '[INNER_MONOLOGUE]', after: '[UNSUPPORTED]' },
      { key: 'shooting', before: '## SCN-01 ·', after: '## SCN-02 ·' },
      { key: 'narration', before: '00:03:00–00:03:15', after: '00:03:01–00:03:15' },
      { key: 'narration', before: '화자 민아(CHAR-01)', after: '화자 민아(CHAR-02)' },
      { key: 'panel', before: '[PANEL-01] “저는', after: '[PANEL-02] “저는' },
      { key: 'subtitles', before: 'SUBTITLE_SOURCE:UNIT-01-003', after: 'SUBTITLE_SOURCE:UNIT-01-005' },
      { key: 'subtitles', before: '> 본 이야기는 창작입니다.', after: '> 바뀐 원문입니다.' },
      { key: 'subtitles', before: '## SEG-001 ·', after: '## unknown ·' },
      { key: 'subtitles', before: '· 독백**', after: '· 대사**' },
    ];
    for (const testCase of cases) {
      expect(sources[testCase.key].content).toContain(testCase.before);
      const changed = withSectionChanges(sources, { [testCase.key]: sources[testCase.key].content.replace(testCase.before, testCase.after) });
      expect(() => inspectDocuments(changed, bindings), `${testCase.key}: ${testCase.before}`).toThrow();
    }
    expect(() => inspectDocuments(sources, { ...bindings, people: [{ key: '민아', targetId: 'CHAR-02' }] })).toThrow();
    const dataset = compileDocuments(sources, bindings).dataset;
    const invalid = { ...dataset, units: dataset.units.map((unit, index) => index === 0 ? { ...unit, delivery: 'inner-monologue' as const } : unit) };
    expect(validateDataset(invalid, Object.values(sources)).some((issue): boolean => issue.code === 'INVALID_UNIT_DELIVERY')).toBe(true);
  });
});

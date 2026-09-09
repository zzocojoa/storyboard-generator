import { execFile } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, readdir, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { compileDocuments, inspectDocuments } from '../src/documents/compile.js';
import { readDocumentSources, writeDocumentPackage } from '../src/documents/io.js';
import { buildDocumentPackage } from '../src/documents/package.js';
import type { DocumentSources, DocumentKey } from '../src/documents/schema.js';
import type { Project, SourceUnit } from '../src/domain/schema.js';
import { importPackage } from '../src/importers/import-package.js';
import { sha256Text } from '../src/importers/integrity.js';
import { importEdit, readEditTimeline } from '../src/importers/production-views.js';
import { readPackage } from '../src/io/package.js';
import { parseProject } from '../src/io/project.js';
import { createSourceOutline } from '../src/proposal/outline.js';
import { documentTestSettings, PRODUCTION_DOCUMENT_BINDINGS, SYNTHETIC_DOCUMENT_BINDINGS } from './document-helpers.js';

const roots: string[] = [];
const runFile = promisify(execFile);

async function isolated(directory: string): Promise<{ root: string; input: string }> {
  const root: string = await mkdtemp(join(tmpdir(), 'document-handoff-'));
  roots.push(root);
  const input: string = join(root, 'input');
  await cp(directory, input, { recursive: true });
  return { root, input };
}
function changed(sources: DocumentSources, key: DocumentKey, content: string): DocumentSources {
  return { ...sources, [key]: { ...sources[key], content, sha256: sha256Text(content) } };
}

afterEach(async (): Promise<void> => { await Promise.all(roots.splice(0).map(async (root: string): Promise<void> => { await rm(root, { recursive: true, force: true }); })); });

describe('제작 문서 handoff', (): void => {
  it('documents_eight_files_preserve_full_sources_timeline_and_reopen', async (): Promise<void> => {
    const { root, input } = await isolated('tests/fixtures/production/09_PRODUCTION');
    expect(await readdir(input)).toHaveLength(8);
    const sources: DocumentSources = await readDocumentSources(input);
    const before: string = JSON.stringify(sources);
    const settings = documentTestSettings(sources, PRODUCTION_DOCUMENT_BINDINGS);
    const result = await writeDocumentPackage(input, settings, join(root, 'package'));
    const payload = await readPackage(result.handoffPath);
    expect(payload.handoff.adapter).toBe('production-documents-v1');
    expect(payload.handoff.timebase).toEqual(settings.timebase);
    expect(payload.handoff.profile).toEqual(settings.profile);
    expect(payload.files).toHaveLength(9);
    expect(await readdir(root)).toEqual(['input', 'package']);
    for (const source of Object.values(sources)) expect(payload.files.find((file): boolean => file.path === source.path)?.content).toBe(source.content);
    const project: Project = createSourceOutline(importPackage(payload), { proposedTextHoldMs: 2000 });
    expect(project.dataset.scenes).toHaveLength(12);
    expect(project.dataset.segments).toHaveLength(32);
    expect(project.dataset.units).toHaveLength(95);
    expect(project.dataset.segments.at(-1)?.endMs).toBe(1500000);
    expect(project.dataset.textPlacements).toHaveLength(25);
    expect(project.dataset.textPlacements.every((placement): boolean => placement.endMs === null)).toBe(true);
    expect(project.importIssues.filter((entry): boolean => entry.code === 'SCREEN_TEXT_MAPPING_REVIEW')).toHaveLength(5);
    expect(project.dataset.instructions.some((entry): boolean => entry.text.includes('3초 이상'))).toBe(true);
    expect(project.dataset.instructions.some((entry): boolean => entry.text.includes('2초 무음'))).toBe(true);
    // 기존 구조화 원본은 비교 기준으로만 읽는다. 위 변환은 상위 파일이 없는 폴더에서 이미 완료했다.
    const oracle: Project = importPackage(await readPackage('tests/fixtures/production/storyboard_handoff.json'));
    const projection = (unit: SourceUnit): object => ({ segmentId: unit.segmentId, kind: unit.kind, text: unit.text, speakerId: unit.speakerId });
    expect(project.dataset.units.map(projection)).toEqual(oracle.dataset.units.map(projection));
    expect(project.dataset.units.every((unit: SourceUnit): boolean => unit.sourceRefs.some((ref): boolean => ref.fileId === 'document-broadcast' && ref.locator.startsWith('line:')))).toBe(true);
    expect(parseProject(JSON.parse(JSON.stringify(project)))).toEqual(project);
    expect(JSON.stringify(await readDocumentSources(input))).toBe(before);
  });

  it('documents_do_not_assign_character_ids_by_roster_order', async (): Promise<void> => {
    const sources = await readDocumentSources('tests/fixtures/production/09_PRODUCTION');
    const preview = inspectDocuments(sources, { people: [], scenes: [], units: [] }).preview;
    expect(preview.people.filter((choice): boolean => choice.selected === null).map((choice): string => choice.key)).toEqual(['백기철', '윤서진', '강태균', '박도현', '오민주']);
    expect(preview.people.find((choice): boolean => choice.key === '한가람')?.selected).toBe('PANEL-01');
    expect(() => buildDocumentPackage(sources, documentTestSettings(sources, { people: [], scenes: [], units: [] }))).toThrowError(expect.objectContaining({ code: 'DOCUMENT_MAPPING_REQUIRED' }));
  });

  it('documents_independent_project_without_optional_content_is_supported', async (): Promise<void> => {
    const { root, input } = await isolated('tests/fixtures/documents');
    const sources = await readDocumentSources(input);
    const preview = inspectDocuments(sources, { people: [], scenes: [], units: [] }).preview;
    expect(preview.scenes.every((choice): boolean => choice.selected === null)).toBe(true);
    const result = await writeDocumentPackage(input, documentTestSettings(sources, SYNTHETIC_DOCUMENT_BINDINGS), join(root, 'package'));
    const project = createSourceOutline(importPackage(await readPackage(result.handoffPath)), { proposedTextHoldMs: 1500 });
    expect(project.projectId).toBe('plant-doc-demo');
    expect(project.dataset.segments.map((segment): string => segment.mode)).toEqual(['DEMO', 'DEMO']);
    expect(project.dataset.units.map((unit): string => unit.segmentId)).toEqual(['opening', 'opening', 'finish', 'finish']);
    expect(project.dataset.units.some((unit): boolean => unit.kind === 'PANEL' || unit.kind === 'NARRATION')).toBe(false);
    expect(project.dataset.textPlacements).toEqual([]);
    expect(project.dataset.segments.at(-1)?.endMs).toBe(20000);
    expect(parseProject(project)).toEqual(project);
  });

  it('documents_missing_settings_never_receive_test_defaults', async (): Promise<void> => {
    const sources = await readDocumentSources('tests/fixtures/documents');
    const settings = documentTestSettings(sources, SYNTHETIC_DOCUMENT_BINDINGS);
    expect(() => buildDocumentPackage(sources, { ...settings, timebase: undefined })).toThrow();
    expect(() => buildDocumentPackage(sources, { ...settings, profile: undefined })).toThrow();
  });

  it('documents_reject_unknown_duplicate_and_conflicting_bindings', async (): Promise<void> => {
    const sources = await readDocumentSources('tests/fixtures/documents');
    const base = documentTestSettings(sources, SYNTHETIC_DOCUMENT_BINDINGS);
    for (const people of [
      [...base.bindings.people, { key: '없는 사람', targetId: 'host' }],
      [...base.bindings.people, { key: '민아', targetId: 'host' }],
      [{ key: '민아', targetId: 'host' }, { key: '준', targetId: 'host' }],
      [{ key: '민아', targetId: 'unlisted' }, { key: '준', targetId: 'helper' }],
    ]) expect(() => buildDocumentPackage(sources, { ...base, bindings: { ...base.bindings, people } })).toThrow();
  });

  it('documents_changed_review_rejects_before_output_creation', async (): Promise<void> => {
    const { root, input } = await isolated('tests/fixtures/documents');
    const sources = await readDocumentSources(input);
    const settings = documentTestSettings(sources, SYNTHETIC_DOCUMENT_BINDINGS);
    await writeFile(join(input, 'narration.md'), `${sources.narration.content}\n변경된 제작 메모\n`);
    await expect(writeDocumentPackage(input, settings, join(root, 'output'))).rejects.toMatchObject({ code: 'INVALID_DOCUMENT_FINGERPRINT' });
    expect(await readdir(root)).toEqual(['input']);
  });

  it('documents_preserve_existing_output_and_forbid_source_output', async (): Promise<void> => {
    const { root, input } = await isolated('tests/fixtures/documents');
    const sources = await readDocumentSources(input);
    const settings = documentTestSettings(sources, SYNTHETIC_DOCUMENT_BINDINGS);
    const target: string = join(root, 'output'); await mkdir(target); await writeFile(join(target, 'keep'), 'preserve');
    await expect(writeDocumentPackage(input, settings, target)).rejects.toMatchObject({ code: 'DOCUMENT_OUTPUT_EXISTS' });
    expect(await readFile(join(target, 'keep'), 'utf8')).toBe('preserve');
    await expect(writeDocumentPackage(input, settings, join(input, 'output'))).rejects.toMatchObject({ code: 'UNSAFE_DOCUMENT_OUTPUT' });
    await symlink(target, join(root, 'link'));
    await expect(writeDocumentPackage(input, settings, join(root, 'link'))).rejects.toMatchObject({ code: 'DOCUMENT_OUTPUT_EXISTS' });
  });

  it('documents_reject_missing_symlink_utf8_and_oversized_sources', async (): Promise<void> => {
    const { root, input } = await isolated('tests/fixtures/documents');
    const path: string = join(input, 'narration.md');
    await unlink(path); await expect(readDocumentSources(input)).rejects.toThrow();
    await writeFile(join(root, 'outside.md'), 'outside'); await symlink(join(root, 'outside.md'), path);
    await expect(readDocumentSources(input)).rejects.toMatchObject({ code: 'INVALID_DOCUMENT_FILE' });
    await unlink(path); await writeFile(path, Buffer.from([0xff, 0xfe]));
    await expect(readDocumentSources(input)).rejects.toMatchObject({ code: 'INVALID_UTF8' });
    await writeFile(path, Buffer.alloc(4 * 1024 * 1024 + 1));
    await expect(readDocumentSources(input)).rejects.toMatchObject({ code: 'INVALID_DOCUMENT_FILE' });
  });

  it('documents_reject_modified_utterance_and_unknown_document_version', async (): Promise<void> => {
    const sources = await readDocumentSources('tests/fixtures/documents');
    const altered = changed(sources, 'reenactment', sources.reenactment.content.replace('흙이 말랐으면 물을 주세요.', '매일 물을 주세요.'));
    expect(() => compileDocuments(altered, SYNTHETIC_DOCUMENT_BINDINGS)).toThrowError(expect.objectContaining({ code: 'INVALID_DOCUMENT_UNIT_CONFLICT' }));
    const version = changed(sources, 'manifest', sources.manifest.content.replace('1.1.0', '2.0.0'));
    expect(() => compileDocuments(version, SYNTHETIC_DOCUMENT_BINDINGS)).toThrow();
  });

  it('documents_reject_manifest_hash_and_timeline_conflicts', async (): Promise<void> => {
    const sources = await readDocumentSources('tests/fixtures/documents');
    expect(() => compileDocuments(changed(sources, 'broadcast', `${sources.broadcast.content}\n`), SYNTHETIC_DOCUMENT_BINDINGS)).toThrowError(expect.objectContaining({ code: 'INVALID_DOCUMENT_HASH' }));
    expect(() => compileDocuments(changed(sources, 'shooting', sources.shooting.content.replace('00:08–00:20', '00:09–00:20')), SYNTHETIC_DOCUMENT_BINDINGS)).toThrowError(expect.objectContaining({ code: 'INVALID_DOCUMENT_TIMELINE' }));
    expect(() => compileDocuments(changed(sources, 'edit', `${sources.edit.content}\n${sources.edit.content.split('\n')[4]}\n`), SYNTHETIC_DOCUMENT_BINDINGS)).toThrowError(expect.objectContaining({ code: 'DUPLICATE_EDIT_CUE' }));
  });

  it('documents_package_detects_modified_authority_and_reimport_hash', async (): Promise<void> => {
    const sources = await readDocumentSources('tests/fixtures/documents');
    const payload = buildDocumentPackage(sources, documentTestSettings(sources, SYNTHETIC_DOCUMENT_BINDINGS));
    expect(() => importPackage({ ...payload, handoff: { ...payload.handoff, authority: payload.handoff.authority.map((entry) => entry.field === 'timeline' ? { ...entry, fileIds: ['document-manifest'] } : entry) } })).toThrowError(expect.objectContaining({ code: 'INVALID_DOCUMENT_CONTRACT' }));
    expect(() => importPackage({ ...payload, files: payload.files.map((file) => ({ ...file, content: `${file.content} ` })) })).toThrow();
  });

  it('documents_repeated_dialogue_preserves_occurrences_and_distinct_evidence', async (): Promise<void> => {
    const original = await readDocumentSources('tests/fixtures/documents');
    let sources = changed(original, 'broadcast', original.broadcast.content.replace('**민아**\n흙이 말랐으면 물을 주세요.', '**민아**\n흙이 말랐으면 물을 주세요.\n\n**민아**\n흙이 말랐으면 물을 주세요.'));
    sources = changed(sources, 'reenactment', original.reenactment.content.replace('민아: 흙이 말랐으면 물을 주세요.', '민아: 흙이 말랐으면 물을 주세요.\n\n민아: 흙이 말랐으면 물을 주세요.'));
    sources = changed(sources, 'manifest', original.manifest.content.replace(original.broadcast.sha256, sources.broadcast.sha256));
    const dataset = compileDocuments(sources, SYNTHETIC_DOCUMENT_BINDINGS).dataset;
    const repeated = dataset.units.filter((unit): boolean => unit.speakerId === 'host');
    expect(repeated).toHaveLength(2);
    expect(new Set(repeated.map((unit): string | undefined => unit.sourceRefs.find((ref): boolean => ref.fileId === 'document-reenactment')?.locator)).size).toBe(2);
  });

  it('documents_narration_only_story_keeps_visual_actions_and_explicit_segment_links', async (): Promise<void> => {
    const original = await readDocumentSources('tests/fixtures/documents');
    let sources = changed(original, 'broadcast', original.broadcast.content.replace('**민아**', '**민아(내레이션)**').replace('**준**', '**준(내레이션)**'));
    sources = changed(sources, 'reenactment', original.reenactment.content.replace('\n민아:', '\n[내레이션] 민아:').replace('\n준:', '\n[내레이션] 준:'));
    sources = changed(sources, 'edit', original.edit.content.replaceAll('| DEMO |', '| NARRATION |'));
    sources = changed(sources, 'narration', '# plant-doc-demo 내레이션\n\n- `opening` / 민아: 흙이 말랐으면 물을 주세요.\n- `finish` / 준: 받침에 고인 물은 비워 주세요.\n');
    sources = changed(sources, 'manifest', original.manifest.content.replace(original.broadcast.sha256, sources.broadcast.sha256));
    const bindings = { ...SYNTHETIC_DOCUMENT_BINDINGS, scenes: [] };
    const preview = inspectDocuments(sources, bindings).preview;
    expect(preview.scenes.map((choice): string | null => choice.selected)).toEqual(['garden', 'sink']);
    const dataset = compileDocuments(sources, bindings).dataset;
    expect(dataset.units.map((unit): string => unit.kind)).toEqual(['ACTION', 'NARRATION', 'ACTION', 'NARRATION']);
  });

  it('documents_multiple_visual_segments_require_explicit_unit_mapping', async (): Promise<void> => {
    const original = await readDocumentSources('tests/fixtures/documents');
    let sources = changed(original, 'edit', original.edit.content.replace('| `opening` | 00:00–00:08 | DEMO | `garden` | 흙을 만지는 동작을 보여 준다. |', '| `opening` | 00:00–00:04 | DEMO | `garden` | 흙을 만지는 동작을 보여 준다. |\n| `closeup` | 00:04–00:08 | DEMO | `garden` | 손을 가까이 보여 준다. |'));
    sources = changed(sources, 'shooting', original.shooting.content.replace('- `opening` 00:00–00:08 / `garden` / 손과 흙을 근접 촬영한다.', '- `opening` 00:00–00:04 / `garden` / 손과 흙을 근접 촬영한다.\n- `closeup` 00:04–00:08 / `garden` / 손을 보여 준다.'));
    const preview = inspectDocuments(sources, SYNTHETIC_DOCUMENT_BINDINGS).preview;
    const unresolved = preview.units.filter((choice): boolean => choice.selected === null);
    expect(unresolved).toHaveLength(2);
    expect(() => compileDocuments(sources, SYNTHETIC_DOCUMENT_BINDINGS)).toThrowError(expect.objectContaining({ code: 'DOCUMENT_MAPPING_REQUIRED' }));
    const bindings = { ...SYNTHETIC_DOCUMENT_BINDINGS, units: unresolved.map((choice, index: number) => ({ key: choice.key, targetId: index === 0 ? 'opening' : 'closeup' })) };
    expect(compileDocuments(sources, bindings).dataset.units.map((unit): string => unit.segmentId)).toEqual(['opening', 'closeup', 'finish', 'finish']);
  });

  it('documents_reject_unrecognized_rows_instead_of_dropping_them', async (): Promise<void> => {
    const sources = await readDocumentSources('tests/fixtures/documents');
    for (const [key, line] of [['edit', '| opening | 00:00–00:08 | DEMO | garden | malformed |'], ['narration', '- opening / 민아: 누락된 발화'], ['subtitles', '- 잘못된 자막 큐'], ['shooting', '- malformed cue']] as const) {
      expect(() => compileDocuments(changed(sources, key, `${sources[key].content}\n${line}\n`), SYNTHETIC_DOCUMENT_BINDINGS)).toThrow();
    }
  });

  it('documents_shared_edit_parser_preserves_legacy_conflict_evidence', async (): Promise<void> => {
    const sources = await readDocumentSources('tests/fixtures/documents');
    const timeline = readEditTimeline(sources.edit);
    const result = importEdit(sources.edit, timeline.map((row) => ({ ...row.segment, startMs: row.segment.startMs + 1 })));
    expect(result.issues.map((entry): string | null => entry.actual)).toEqual(sources.edit.content.split('\n').filter((line: string): boolean => line.startsWith('| `')));
  });

  it('documents_cli_generates_importable_handoff_from_eight_files', async (): Promise<void> => {
    const { root, input } = await isolated('tests/fixtures/documents');
    const sources = await readDocumentSources(input);
    const settingsPath: string = join(root, 'settings.json');
    await writeFile(settingsPath, JSON.stringify(documentTestSettings(sources, SYNTHETIC_DOCUMENT_BINDINGS)));
    const preview = await runFile(process.execPath, ['--import', 'tsx', 'src/cli.ts', 'documents-preview', '--input', input], { cwd: resolve('.') });
    expect(JSON.parse(preview.stdout).counts).toMatchObject({ scenes: 2, units: 4 });
    const result = await runFile(process.execPath, ['--import', 'tsx', 'src/cli.ts', 'documents-package', '--input', input, '--settings', settingsPath, '--output', join(root, 'package')], { cwd: resolve('.') });
    expect(importPackage(await readPackage(JSON.parse(result.stdout).handoffPath)).projectId).toBe('plant-doc-demo');
  });
});

import { currentTextPresentations } from '../src/automation/text-cue-schema.js';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { z } from 'zod';
import { automaticHash } from '../src/automation/application-evidence.js';
import { nextAutomaticWork } from '../src/automation/job-graph.js';
import { planAutomaticTextLayout, textLayoutPlanningHash } from '../src/automation/plan-text-layout.js';
import { textPresetReview } from '../src/automation/text-preset-review.js';
import type { TextLayoutPlanOptions, TextLayoutPlanServices } from '../src/automation/plan-text-layout.js';
import { createAutomationRun } from '../src/automation/run-state.js';
import { AutomationSettingsSchema } from '../src/automation/run-schema.js';
import type { StructuredGenerationEngine, StructuredGenerationResult } from '../src/codex/structured-engine.js';
import type { Project } from '../src/domain/schema.js';
import { initialTextPresentation, updateTextPresentation } from '../src/domain/text-presentation.js';
import { textLayoutControl } from '../src/domain/text-layout-control.js';
import { storyboardTextPreset } from '../src/domain/text-layout-settings.js';
import type { TextLayoutPreset } from '../src/domain/text-layout-settings.js';
import { parseProject, parseProjectSnapshotEvidence } from '../src/io/project.js';
import { stableJsonStringify } from '../src/io/stable-json.js';
import { sha256Text } from '../src/importers/integrity.js';
import { recommendedAutomationSettings } from '../src/server/automation-routes.js';
import { ProjectStore } from '../src/server/store.js';
import { automaticPlanProject, automaticPlanProvenance } from './automatic-plan-helpers.js';
import { initial } from './automatic-executor-helpers.js';
import { crowdedTextProject } from './automatic-text-helpers.js';
import { TEST_LATIN_FONT_PATH, testTextTypography } from './typography-helpers.js';
import { readTextFontCatalog } from '../src/rendering/text-font-source.js';
import { TEST_TEXT_FONT_PATH } from './helpers.js';

function options(corrections: number): TextLayoutPlanOptions {
  const { model: _model, turnId: _turn, prompt: _prompt, ...provenance } = automaticPlanProvenance();
  return { provenance, maxCorrections: corrections };
}
function services(model: StructuredGenerationEngine): TextLayoutPlanServices {
  return { model, fontPath: TEST_TEXT_FONT_PATH, onProgress: async (): Promise<void> => {} };
}
async function output(project: Project, preset: TextLayoutPreset): Promise<StructuredGenerationResult> {
  return { model: 'layout-model', turnId: 'layout-turn', result: z.json().parse({ schemaVersion: '1.0.0', cuePresentations: currentTextPresentations(project), preset, textTypography: await testTextTypography(), reason: '문구 전체를 보존하면서 화면비에 맞게 배치합니다.' }) };
}
function unchangedContent(project: Project): object {
  const { textTypography: _typography, textLayout: _layout, textLayoutControl: _control, generationRecords: _records, ...content } = project;
  return content;
}

it('automatic_text_presentations_require_every_cue_preserve_manual_choices_and_record_current_identity', async (): Promise<void> => {
  const source = await automaticPlanProject(); const cue = source.textCues[0]!;
  const project = updateTextPresentation(source, cue.id, { ...initialTextPresentation(source.textLayout, cue.kind), y: 0.3 });
  let calls: number = 0;
  const model: StructuredGenerationEngine = { run: async (input) => {
    calls += 1;
    if (calls === 2) expect(input.prompt).toContain('실제 글자 Cue마다');
    return { model: 'cue-layout', turnId: `cue-${calls}`, result: z.json().parse({ schemaVersion: '1.0.0', preset: project.textLayout,
      textTypography: await testTextTypography(), reason: '수동 배치를 보존하고 다른 문구는 공통 프리셋을 사용합니다.',
      cuePresentations: calls === 1 ? [] : currentTextPresentations(project) }) };
  } };
  const result = await planAutomaticTextLayout(project, options(1), services(model), new AbortController().signal);
  expect(calls).toBe(2); expect(result.textCues).toEqual(project.textCues); expect(unchangedContent(result)).toEqual(unchangedContent(project));
  expect(result.textLayoutControl.plannedInputHash).toBe(textLayoutPlanningHash(result));
  expect(textPresetReview(result)).toMatchObject({ status: 'recorded', matchesCurrentPreset: true, problems: [] });
  const record = result.generationRecords.at(-1)!;
  const payload = JSON.parse(record.prompt) as { output: { cuePresentations: { cueId: string; presentation: unknown }[] } };
  const other = payload.output.cuePresentations.find((row): boolean => row.presentation === null)!;
  expect(other).toBeDefined();
  const malformed = { ...payload, output: { ...payload.output, cuePresentations: payload.output.cuePresentations.map((row) => row === other ? { ...row, cueId: 'unrelated-cue' } : row) } };
  expect(textPresetReview({ ...result, generationRecords: result.generationRecords.map((entry) => entry.id === record.id ? { ...entry, prompt: JSON.stringify(malformed) } : entry) })).toMatchObject({ matchesCurrentPreset: false });
});

it('automatic_text_typography_selects_real_font_after_glyph_feedback_and_preserves_manual_selection', async (): Promise<void> => {
  const project = await automaticPlanProject();
  const environment = { defaultPath: TEST_TEXT_FONT_PATH, registrations: [{ id: 'mono', label: 'Latin mono', path: TEST_LATIN_FONT_PATH }] };
  const catalog = await readTextFontCatalog(environment); const mono = catalog.fonts[1]!;
  const selected = { ...await testTextTypography(), language: 'ko' }; let calls: number = 0;
  const model: StructuredGenerationEngine = { run: async (input) => {
    calls += 1;
    expect(input.prompt).toContain('unsupportedCueIds');
    if (calls === 2) expect(input.prompt).toContain('TEXT_FONT_GLYPH_MISSING');
    return { model: 'font-planner', turnId: `font-${calls}`, result: z.json().parse({ schemaVersion: '1.0.0', cuePresentations: currentTextPresentations(project), preset: project.textLayout,
      textTypography: calls === 1 ? { ...selected, fontId: mono.id, fontSha256: mono.sha256 } : selected, reason: '실제 한글 지원 글꼴을 선택합니다.' }) };
  } };
  const result = await planAutomaticTextLayout(project, options(1), { ...services(model), fontPath: environment }, new AbortController().signal);
  expect(calls).toBe(2); expect(result.textTypography).toEqual(selected); expect(result.textLayoutControl.plannedInputHash).toBe(textLayoutPlanningHash(result));
  expect(unchangedContent(result)).toEqual(unchangedContent(project)); expect(textPresetReview(result)).toMatchObject({ status: 'recorded', matchesCurrentPreset: true, problems: [] });
  expect(textPresetReview({ ...result, textTypography: { ...selected, language: 'en' } })).toMatchObject({ matchesCurrentPreset: false });
  const preserved = { ...project, textTypography: selected }; calls = 0;
  const invalid: StructuredGenerationEngine = { run: async () => { calls += 1; return { model: 'font-planner', turnId: 'change', result: z.json().parse({ schemaVersion: '1.0.0', cuePresentations: currentTextPresentations(project), preset: project.textLayout,
    textTypography: { ...selected, fontId: mono.id, fontSha256: mono.sha256 }, reason: '기존 선택 변경 시도' }) }; } };
  await expect(planAutomaticTextLayout(preserved, options(1), { ...services(invalid), fontPath: environment }, new AbortController().signal)).rejects.toMatchObject({ code: 'AUTOMATION_PROTECTED_TEXT_TYPOGRAPHY' });
  expect(calls).toBe(2); expect(preserved.textTypography).toEqual(selected);
});

it('automatic_text_typography_rejects_invented_font_ids_and_hashes_with_bounded_correction', async (): Promise<void> => {
  const project = await automaticPlanProject(); let calls: number = 0;
  const model: StructuredGenerationEngine = { run: async () => { calls += 1; return { model: 'invalid-font', turnId: 'invalid', result: z.json().parse({ schemaVersion: '1.0.0', cuePresentations: currentTextPresentations(project), preset: project.textLayout,
    textTypography: { version: '1.0.0', language: 'ko', fontId: 'invented', fontSha256: '0'.repeat(64) }, reason: '목록에 없는 글꼴' }) }; } };
  await expect(planAutomaticTextLayout(project, options(1), services(model), new AbortController().signal)).rejects.toMatchObject({ code: 'AUTOMATION_TEXT_TYPOGRAPHY_INVALID' });
  expect(calls).toBe(2); expect(project).not.toHaveProperty('textTypography');
});

it('automatic_text_preset_plans_with_real_glyph_feedback_and_preserves_all_content_and_approvals', async (): Promise<void> => {
  const initial = await crowdedTextProject();
  const project: Project = { ...initial, textLayout: { ...initial.textLayout, maxLines: 1 } };
  const before: string = stableJsonStringify(project); let calls: number = 0; const prompts: string[] = [];
  const result = await planAutomaticTextLayout(project, options(1), services({ run: async (input) => {
    prompts.push(input.prompt); calls += 1;
    return output(project, calls === 1 ? project.textLayout : { ...storyboardTextPreset(), maxLines: 12 });
  } }), new AbortController().signal);
  expect(calls).toBe(2); expect(prompts[1]).toContain('TEXT_LAYOUT_OVERFLOW'); expect(prompts[0]).toContain('fontSha256');
  expect(result.textLayout.fontSize).toBe(0.042); expect(result.textLayoutControl).toEqual({ version: '1.0.0', mode: 'automatic', plannedInputHash: textLayoutPlanningHash(result) });
  expect(unchangedContent(result)).toEqual(unchangedContent(project)); expect(stableJsonStringify(project)).toBe(before);
  expect(result.generationRecords.slice(0, -1)).toEqual(project.generationRecords);
  expect(JSON.parse(result.generationRecords.at(-1)!.prompt)).toMatchObject({ turnId: 'layout-turn', problems: [] });
  expect(textPresetReview(result)).toMatchObject({ status: 'recorded', matchesCurrentPreset: true, problems: [] });
  expect(textPresetReview({ ...result, textLayout: { ...result.textLayout, fontSize: 0.05 } })).toMatchObject({ status: 'recorded', matchesCurrentPreset: false });
  expect(textPresetReview({ ...result, generationRecords: [{ ...result.generationRecords.at(-1)!, prompt: 'invalid-json' }] })).toMatchObject({ status: 'invalid' });
});

it('automatic_text_preset_preserves_manual_and_approved_layout_and_bounds_invalid_model_corrections', async (): Promise<void> => {
  const source = await automaticPlanProject(); const manual: Project = { ...source, textLayoutControl: textLayoutControl('manual') };
  let calls: number = 0;
  const engine: StructuredGenerationEngine = { run: async () => { calls += 1; return output(source, { ...source.textLayout, fontSize: 0.08 }); } };
  await expect(planAutomaticTextLayout(manual, options(1), services(engine), new AbortController().signal)).rejects.toMatchObject({ code: 'AUTOMATION_MANUAL_TEXT_LAYOUT' });
  expect(calls).toBe(0);
  const protectedProject: Project = { ...source, shots: source.shots.map((shot) => ({ ...shot, approvalStatus: 'approved' })) };
  await expect(planAutomaticTextLayout(protectedProject, options(1), services(engine), new AbortController().signal)).rejects.toMatchObject({ code: 'AUTOMATION_PROTECTED_TEXT_LAYOUT' });
  expect(calls).toBe(2);
  const kept = await planAutomaticTextLayout(protectedProject, options(0), services({ run: async () => output(source, source.textLayout) }), new AbortController().signal);
  expect(unchangedContent(kept)).toEqual(unchangedContent(protectedProject)); expect(kept.textLayout).toEqual(source.textLayout);
  await expect(planAutomaticTextLayout(kept, options(0), services(engine), new AbortController().signal)).rejects.toMatchObject({ code: 'AUTOMATION_DUPLICATE_GENERATION' });
});

it('automatic_text_preset_keeps_residual_problems_and_rejects_cancelled_or_changed_font_results', async (): Promise<void> => {
  const source = await crowdedTextProject(); const project: Project = { ...source, textLayout: { ...source.textLayout, maxLines: 1 } };
  const result = await planAutomaticTextLayout(project, options(0), services({ run: async () => output(project, project.textLayout) }), new AbortController().signal);
  expect(JSON.parse(result.generationRecords.at(-1)!.prompt).problems).not.toHaveLength(0);
  const cancelled = new AbortController(); let calls: number = 0;
  await expect(planAutomaticTextLayout(project, options(0), { ...services({ run: async () => { calls += 1; return output(project, project.textLayout); } }),
    onProgress: async (): Promise<void> => { cancelled.abort(); } }, cancelled.signal)).rejects.toMatchObject({ code: 'AUTOMATION_CANCELLED' });
  expect(calls).toBe(0);
  const root: string = await mkdtemp(join(tmpdir(), 'text-preset-font-'));
  try {
    const fontPath: string = join(root, 'font.ttf'); const original: Buffer = await readFile(TEST_TEXT_FONT_PATH); await writeFile(fontPath, original);
    await expect(planAutomaticTextLayout(project, options(0), { ...services({ run: async () => { await writeFile(fontPath, Buffer.concat([original, Buffer.from([0])])); return output(project, project.textLayout); } }), fontPath },
      new AbortController().signal)).rejects.toMatchObject({ code: 'TEXT_FONT_HASH_MISMATCH' });
  } finally { await rm(root, { recursive: true, force: true }); }
});

it('automatic_text_preset_job_is_explicit_single_project_scope_and_skips_legacy_manual_or_completed_plans', async (): Promise<void> => {
  const project = await automaticPlanProject(); const event = initial(project); const run = createAutomationRun({ ...event, settings: recommendedAutomationSettings('Yuna') });
  expect(nextAutomaticWork(run, project)).toMatchObject({ kind: 'register', jobs: [{ task: { kind: 'text-layout' } }] });
  expect(nextAutomaticWork(createAutomationRun(event), project)).not.toMatchObject({ jobs: [{ task: { kind: 'text-layout' } }] });
  for (const control of [textLayoutControl('manual'), { ...textLayoutControl('automatic'), plannedInputHash: textLayoutPlanningHash(project) }]) {
    const current: Project = { ...project, textLayoutControl: control };
    expect(nextAutomaticWork({ ...run, projectHash: automaticHash(current) }, current)).not.toMatchObject({ jobs: [{ task: { kind: 'text-layout' } }] });
  }
  expect(AutomationSettingsSchema.safeParse({ ...run.settings, textLayoutPlanning: 'unknown' }).success).toBe(false);
  expect(AutomationSettingsSchema.parse(event.settings)).toEqual(event.settings);
});

it('automatic_text_preset_legacy_migration_keeps_file_hashes_and_treats_unknown_ownership_as_manual', async (): Promise<void> => {
  const project = await automaticPlanProject(); const { textLayoutControl: _control, ...fields } = project;
  const legacy = { ...fields, schemaVersion: '1.14.0' }; const bytes: string = stableJsonStringify(legacy);
  const evidence = parseProjectSnapshotEvidence(legacy);
  expect(evidence.project.textLayoutControl).toEqual(textLayoutControl('manual')); expect(evidence.project.textLayout).toEqual(project.textLayout);
  expect(evidence.projectionHashes).toContain(automaticHash(legacy)); expect(stableJsonStringify(legacy)).toBe(bytes);
  expect(() => parseProject({ ...legacy, textLayoutControl: { mode: 'automatic' } })).toThrowError(expect.objectContaining({ code: 'UNSUPPORTED_LEGACY_TEXT_LAYOUT_CONTROL' }));
  const root: string = await mkdtemp(join(tmpdir(), 'text-preset-legacy-'));
  const store = new ProjectStore(root);
  try {
    await store.create(project); const directory: string = join(root, sha256Text(project.projectId));
    const path: string = join(directory, 'project.json'); const versionPath: string = join(directory, 'versions', '000000.json');
    await writeFile(path, bytes); await writeFile(versionPath, bytes);
    expect(evidence.project.schemaVersion).toBe('1.22.0');
    expect((await store.read(project.projectId)).textLayoutControl.mode).toBe('manual');
    expect(await readFile(path, 'utf8')).toBe(bytes); expect(await readFile(versionPath, 'utf8')).toBe(bytes);
    await store.update(project.projectId, 0, (current) => ({ ...current, title: '이전 콘티에서 이어 편집' }), []);
    expect(await readFile(versionPath, 'utf8')).toBe(bytes);
    expect(JSON.parse(await readFile(path, 'utf8'))).toMatchObject({ schemaVersion: '1.22.0', revision: 1, textLayoutControl: { mode: 'manual' } });
  } finally { await store.close(); await rm(root, { recursive: true, force: true }); }
});

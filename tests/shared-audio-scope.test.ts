import { expect, it } from 'vitest';
import { z } from 'zod';
import { automaticAudioInstructionTargets } from '../src/automation/audio-instruction-targets.js';
import { compileAudioInstructionPlan, planAutomaticAudioInstructions } from '../src/automation/plan-audio-instructions.js';
import type { AutomaticAudioInstructionPlan } from '../src/automation/plan-audio-instructions.js';
import { confirmAudioInstruction, updateAudioInstruction } from '../src/domain/audio-instructions.js';
import { storyboardAudioIssues } from '../src/domain/audio-storyboard.js';
import { audioInstructionContentIssues, audioInstructionSourceText } from '../src/domain/audio-instruction-evidence.js';
import { reviewAudioPlaybackAt } from '../src/domain/playback.js';
import type { Project, SharedAudioScope, SourceRef } from '../src/domain/schema.js';
import { sharedAudioInstructions } from '../src/domain/shared-audio-scope.js';
import { applySourceUpdate } from '../src/domain/source-update.js';
import { migrateProjectInput } from '../src/io/project.js';
import { audioInstructionFixture } from './audio-instruction-helpers.js';
import { automaticPlanProvenance } from './automatic-plan-helpers.js';
import { createPdfTextProjection } from '../src/exporters/pdf.js';
import { redactPdfProjection, reviewRedactionPatterns } from '../src/exporters/review-redaction.js';

async function sharedProject(): Promise<Project> {
  const project: Project = await audioInstructionFixture();
  const other = project.dataset.segments.find((segment): boolean => segment.id !== 'demonstration')!;
  const refs: SourceRef[] = [{ fileId: project.sources[0]!.id, locator: 'line:40', originalId: null }];
  const ambient = project.dataset.instructions.find((instruction): boolean => instruction.id === 'ambient-instruction')!;
  return { ...project, dataset: { ...project.dataset, instructions: [
    ...project.dataset.instructions.map((instruction) => instruction.id === ambient.id ? { ...instruction, sourceRefs: refs } : instruction),
    { ...ambient, id: 'shared-ambient-other', segmentId: other.id, sourceRefs: refs },
  ] } };
}

it('shared_audio_instruction_rejects_independent_segment_sound_without_a_common_scope', async (): Promise<void> => {
  const project = await sharedProject();
  const instruction = project.dataset.instructions.find((value): boolean => value.id === 'shared-ambient-other')!;
  const plan: AutomaticAudioInstructionPlan = { schemaVersion: '1.0.0', segmentId: instruction.segmentId,
    summary: '같은 물소리를 앞 구간에도 독립적으로 추가하는 잘못된 제안', decisions: [{
      instructionId: instruction.id, resolution: 'required', cueIds: [], informationIds: [], sourceEvidence: [], reason: '공통 지시를 현재 구간의 소리로 오해했다.',
    }] };
  const before: string = JSON.stringify(project);
  expect(() => compileAudioInstructionPlan(project, instruction.segmentId, plan, automaticPlanProvenance())).toThrowError(expect.objectContaining({ code: 'AUTOMATION_AUDIO_INSTRUCTION_SHARED_SCOPE' }));
  expect(JSON.stringify(project)).toBe(before);
});

function sharedScope(project: Project): SharedAudioScope {
  return { version: '1.0.0', instructionIds: ['ambient-instruction', 'shared-ambient-other'], requiredSegmentIds: ['demonstration'],
    sourceEvidence: [{ unitId: '동작', quote: project.dataset.units.find((unit): boolean => unit.id === '동작')!.text }], reason: '물주기 행동은 demonstration에 있다. 앞선 안내에 같은 물소리를 새로 추가하지 않는다.' };
}

function scopedPlan(project: Project, segmentId: string): AutomaticAudioInstructionPlan {
  return { schemaVersion: '1.0.0', segmentId, summary: '공통 원문을 실제 물주기 구간에 한 번 연결한다.',
    decisions: automaticAudioInstructionTargets(project, segmentId).map((instruction) => ({
      instructionId: instruction.id, resolution: instruction.id === 'ambient-instruction' ? 'required' : 'none',
      cueIds: instruction.id === 'ambient-instruction' ? [project.audioCues.find((cue): boolean => cue.unitId === '효과음')!.id] : [],
      informationIds: instruction.id === 'ambient-instruction' ? ['reveal:동작'] : [], sourceEvidence: [],
      sharedScope: instruction.kind === 'ambience' ? sharedScope(project) : null, reason: instruction.id === 'ambient-instruction' ? '기존 물소리와 동작의 정보 공개를 연결한다.' : '이 구간에 추가 트랙이 없다.',
    })) };
}

it('shared_audio_model_receives_other_segments_and_reuses_one_scoped_sound_without_early_information', async (): Promise<void> => {
  const project = await sharedProject(); const other = project.dataset.instructions.find((value): boolean => value.id === 'shared-ambient-other')!;
  let calls: number = 0;
  const next = await planAutomaticAudioInstructions(project, other.segmentId, { maxCorrections: 1, provenance: automaticPlanProvenance() }, {
    model: { run: async (input) => {
      expect(input.prompt).toContain('sharedInstructions'); expect(input.prompt).toContain(project.dataset.units.find((unit): boolean => unit.id === '동작')!.text);
      expect(input.prompt).toContain('demonstration'); expect(input.prompt).toContain('같은 파일/행');
      calls += 1; const plan = scopedPlan(project, other.segmentId);
      const output = { ...plan, decisions: plan.decisions.map((decision) => ({ ...decision, occurrences: [] })) };
      return { model: 'scope-test', turnId: `scope-${calls}`, result: z.json().parse(calls === 1 ? { ...output, decisions: output.decisions.map((decision) => ({ ...decision, sharedScope: null })) } : output) };
    } }, onProgress: async (): Promise<void> => {},
  }, new AbortController().signal);
  expect(calls).toBe(2); expect(next.audioCues).toEqual(project.audioCues); expect(next.dataset).toEqual(project.dataset);
  expect(next.audioInstructionDecisions![0]).toMatchObject({ resolution: 'none', informationIds: [], cueIds: [], reviewStatus: 'proposed', sharedScope: sharedScope(project) });
  const final = compileAudioInstructionPlan(next, 'demonstration', scopedPlan(next, 'demonstration'), { ...automaticPlanProvenance(), generationId: 'second-plan' });
  expect(final.audioCues).toEqual(project.audioCues); expect(final.shots).toEqual(project.shots); expect(final.frames).toEqual(project.frames);
  expect(final.generationRecords.slice(0, -1)).toEqual(next.generationRecords);
  expect(final.audioInstructionDecisions!.filter((decision): boolean => decision.resolution === 'required')).toHaveLength(1);
  expect(automaticAudioInstructionTargets(final, other.segmentId)).toEqual([]); expect(automaticAudioInstructionTargets(final, 'demonstration')).toEqual([]);
});

it('shared_audio_scope_rejects_foreign_invented_conflicting_or_unbound_allocations', async (): Promise<void> => {
  const project = await sharedProject(); const plan = scopedPlan(project, 'demonstration'); const first = plan.decisions.find((decision): boolean => decision.instructionId === 'ambient-instruction')!;
  const scope = sharedScope(project);
  const spoken = project.dataset.units.find((unit): boolean => unit.kind === 'NARRATION')!;
  const variants = [
    { ...first, sharedScope: { ...scope, instructionIds: ['ambient-instruction', 'unknown'] } },
    { ...first, sharedScope: { ...scope, requiredSegmentIds: ['foreign'] } },
    { ...first, sharedScope: { ...scope, requiredSegmentIds: [] } },
    { ...first, sharedScope: { ...scope, sourceEvidence: [{ unitId: '동작', quote: '폭발음이 들린다.' }] } },
    { ...first, sharedScope: { ...scope, sourceEvidence: [{ unitId: spoken.id, quote: spoken.text }] } },
    { ...first, informationIds: [] },
  ];
  for (const changed of variants) expect(() => compileAudioInstructionPlan(project, 'demonstration', { ...plan, decisions: plan.decisions.map((decision) => decision.instructionId === first.instructionId ? changed : decision) }, automaticPlanProvenance())).toThrow();
  const other = project.dataset.instructions.find((value): boolean => value.id === 'shared-ambient-other')!;
  const earlier = compileAudioInstructionPlan(project, other.segmentId, scopedPlan(project, other.segmentId), automaticPlanProvenance());
  const contradiction = { ...first, sharedScope: { ...scope, requiredSegmentIds: ['demonstration', other.segmentId] } };
  expect(() => compileAudioInstructionPlan(earlier, 'demonstration', { ...plan, decisions: plan.decisions.map((decision) => decision.instructionId === first.instructionId ? contradiction : decision) }, { ...automaticPlanProvenance(), generationId: 'conflict' })).toThrowError(expect.objectContaining({ code: 'AUTOMATION_AUDIO_INSTRUCTION_SHARED_SCOPE' }));
});

it('legacy_shared_audio_is_reviewed_without_erasing_media_manual_choices_or_generation_history', async (): Promise<void> => {
  const project = await sharedProject();
  const generated = compileAudioInstructionPlan(project, 'demonstration', scopedPlan(project, 'demonstration'), automaticPlanProvenance());
  const legacy: Project = { ...generated, audioInstructionDecisions: generated.audioInstructionDecisions!.map(({ sharedScope: _scope, ...decision }) => decision) };
  const sound = legacy.audioCues.find((cue): boolean => cue.unitId === '효과음')!;
  expect(storyboardAudioIssues(legacy, sound)).toContainEqual(expect.objectContaining({ code: 'AUDIO_INSTRUCTION_SHARED_SCOPE_REVIEW_REQUIRED' }));
  expect(reviewAudioPlaybackAt(legacy, sound.startMs).blocked.find((entry): boolean => entry.cueId === sound.id)!.issues).toContainEqual(expect.objectContaining({ code: 'AUDIO_INSTRUCTION_SHARED_SCOPE_REVIEW_REQUIRED' }));
  expect(() => confirmAudioInstruction(legacy, 'ambient-instruction')).toThrow();
  expect(automaticAudioInstructionTargets(legacy, 'demonstration').map((instruction): string => instruction.id)).toEqual(['ambient-instruction']);
  const plan = scopedPlan(legacy, 'demonstration');
  const repaired = compileAudioInstructionPlan(legacy, 'demonstration', plan, { ...automaticPlanProvenance(), generationId: 'repair' });
  expect(repaired.audioCues).toEqual(legacy.audioCues); expect(repaired.generationRecords.slice(0, -1)).toEqual(legacy.generationRecords);
  const media: Project = { ...legacy, audioCues: legacy.audioCues.map((cue) => cue.id === sound.id ? { ...cue, assetId: 'existing-media' } : cue) };
  expect(automaticAudioInstructionTargets(media, 'demonstration')).toEqual([]);
  const manual = updateAudioInstruction(legacy, { instructionId: 'ambient-instruction', resolution: 'required', cueIds: [sound.id], informationIds: ['reveal:동작'], reason: '제작자가 현재 구간의 물소리를 직접 지정했다.' }, 'unused');
  expect(automaticAudioInstructionTargets(manual, 'demonstration')).toEqual([]);
  expect(confirmAudioInstruction(manual, 'ambient-instruction').audioInstructionDecisions!.find((decision): boolean => decision.instructionId === 'ambient-instruction')!.reviewStatus).toBe('confirmed');
});

it('shared_audio_grouping_requires_exact_provenance_and_migration_never_fabricates_scope', async (): Promise<void> => {
  const project = await sharedProject(); const ambient = project.dataset.instructions.find((instruction): boolean => instruction.id === 'ambient-instruction')!;
  const separate: Project = { ...project, dataset: { ...project.dataset, instructions: project.dataset.instructions.map((instruction) => instruction.id === 'shared-ambient-other' ? { ...instruction, sourceRefs: [{ ...instruction.sourceRefs[0]!, locator: 'line:41' }] } : instruction) } };
  expect(sharedAudioInstructions(separate, ambient)).toEqual([ambient]);
  const old = { ...project, schemaVersion: '1.21.0' }; const bytes: string = JSON.stringify(old);
  expect(migrateProjectInput(old)).toEqual({ ...old, schemaVersion: '1.23.0' }); expect(JSON.stringify(old)).toBe(bytes);
  const generated = compileAudioInstructionPlan(project, 'demonstration', scopedPlan(project, 'demonstration'), automaticPlanProvenance());
  expect(() => migrateProjectInput({ ...generated, schemaVersion: '1.21.0' })).toThrowError(expect.objectContaining({ code: 'UNSUPPORTED_LEGACY_SHARED_AUDIO_SCOPE' }));
});

it('shared_audio_source_update_invalidates_cross_segment_scope_and_preserves_local_choices_and_history', async (): Promise<void> => {
  const source = await sharedProject();
  const generated = compileAudioInstructionPlan(source, 'demonstration', scopedPlan(source, 'demonstration'), automaticPlanProvenance());
  const current = confirmAudioInstruction(generated, 'ambient-instruction');
  const other = source.dataset.instructions.find((value): boolean => value.id === 'shared-ambient-other')!;
  const incoming: Project = { ...source, dataset: { ...source.dataset, units: source.dataset.units.map((unit) => unit.segmentId === other.segmentId ? { ...unit, text: `${unit.text} 변경된 검증 원문.` } : unit) } };
  const next = applySourceUpdate(current, incoming, 'scope-update');
  const decision = next.audioInstructionDecisions!.find((value): boolean => value.instructionId === 'ambient-instruction')!;
  expect(decision).toMatchObject({ ...current.audioInstructionDecisions!.find((value): boolean => value.instructionId === 'ambient-instruction')!, sharedScope: null, reviewStatus: 'proposed' });
  expect(next.audioCues.filter((cue): boolean => decision.cueIds.includes(cue.id))).toEqual(current.audioCues.filter((cue): boolean => decision.cueIds.includes(cue.id)));
  expect(next.generationRecords).toEqual(current.generationRecords); expect(next.assets).toEqual(current.assets);
  expect(automaticAudioInstructionTargets(next, 'demonstration').map((instruction): string => instruction.id)).toEqual(['ambient-instruction']);
  expect(storyboardAudioIssues(next, next.audioCues.find((cue): boolean => cue.id === decision.cueIds[0])!)).toContainEqual(expect.objectContaining({ code: 'AUDIO_INSTRUCTION_SHARED_SCOPE_REVIEW_REQUIRED' }));
  const instruction = next.dataset.instructions.find((value): boolean => value.id === decision.instructionId)!;
  const stale = { ...decision, sharedScope: { ...sharedScope(source), instructionIds: ['removed-source', 'ambient-instruction'] } };
  expect(audioInstructionContentIssues(next, instruction, stale)).toContainEqual(expect.objectContaining({ code: 'AUDIO_INSTRUCTION_SHARED_SCOPE_INVALID', severity: 'conflict' }));
});

it('shared_audio_manual_scope_is_respected_and_local_source_text_does_not_repeat_other_segment_events', async (): Promise<void> => {
  const source = await sharedProject(); const other = source.dataset.instructions.find((value): boolean => value.id === 'shared-ambient-other')!;
  const manual = updateAudioInstruction(source, { instructionId: other.id, resolution: 'required', cueIds: [], informationIds: [], reason: '제작자가 이 구간에 지속 물소리를 별도로 선택했다.' }, 'manual-water');
  const before = JSON.stringify(manual);
  expect(() => compileAudioInstructionPlan(manual, 'demonstration', scopedPlan(manual, 'demonstration'), automaticPlanProvenance())).toThrow();
  expect(JSON.stringify(manual)).toBe(before);
  const plan = scopedPlan(manual, 'demonstration');
  const agreed = compileAudioInstructionPlan(manual, 'demonstration', { ...plan, decisions: plan.decisions.map((decision) => decision.sharedScope === null ? decision : {
    ...decision, sharedScope: { ...sharedScope(source), requiredSegmentIds: ['demonstration', other.segmentId] },
  }) }, automaticPlanProvenance());
  expect(agreed.audioInstructionDecisions!.find((decision): boolean => decision.instructionId === other.id)).toEqual(manual.audioInstructionDecisions![0]);
  expect(agreed.audioCues).toEqual(manual.audioCues);
  const local = agreed.audioInstructionDecisions!.find((decision): boolean => decision.instructionId === 'ambient-instruction')!;
  expect(audioInstructionSourceText(local.sourceSnapshot, local)).toBe(source.dataset.units.find((unit): boolean => unit.id === '동작')!.text);
  expect(local.sourceSnapshot.text).toBe('물 흐르는 소리');
});

it('pdf_shared_audio_directions_distinguish_applied_and_excluded_segments_with_originals_and_review_state', async (): Promise<void> => {
  const project = await sharedProject();
  const other = project.dataset.instructions.find((value): boolean => value.id === 'shared-ambient-other')!;
  const excluded = compileAudioInstructionPlan(project, other.segmentId, scopedPlan(project, other.segmentId), automaticPlanProvenance());
  const generated = compileAudioInstructionPlan(excluded, 'demonstration', scopedPlan(excluded, 'demonstration'), { ...automaticPlanProvenance(), generationId: 'pdf-scope' });
  const before: string = JSON.stringify(generated);
  const projection = await createPdfTextProjection(generated, { maturity: 'draft', channel: 'pdf-export' }, {});
  const entries = projection.items.flatMap((item) => item.audioEntries);
  const applied = entries.find((entry): boolean => entry.id === 'ambient-instruction')!;
  const omitted = entries.find((entry): boolean => entry.id === other.id)!;
  expect(applied.body).toBe('물 흐르는 소리'); expect(omitted.body).toBe(other.text);
  expect(applied.label).toContain('음향 배치'); expect(omitted.label).toContain('추가 음향 배치 없음');
  expect(applied.statusText).toContain('현재 구간: 음향 배치');
  expect(omitted.statusText).toContain('현재 구간: 추가 음향 배치 없음');
  for (const entry of [applied, omitted]) {
    expect(entry.statusText).toContain('공통 지시 적용 구간: demonstration');
    expect(entry.statusText).toContain(sharedScope(project).reason);
    expect(entry.statusText).toContain('DIRECTION · REVIEW REQUIRED');
    expect(entry.statusText).not.toContain('REVIEWED DIRECTION');
  }
  expect(JSON.stringify(generated)).toBe(before);
  const confirmed = confirmAudioInstruction(generated, 'ambient-instruction');
  const reviewed = await createPdfTextProjection(confirmed, { maturity: 'draft', channel: 'pdf-export' }, {});
  expect(reviewed.items.flatMap((item) => item.audioEntries).find((entry): boolean => entry.id === applied.id)!.statusText).toContain('REVIEWED DIRECTION');
});

it('pdf_shared_audio_directions_never_present_missing_stale_or_invalid_scope_as_reviewed', async (): Promise<void> => {
  const project = await sharedProject();
  const generated = compileAudioInstructionPlan(project, 'demonstration', scopedPlan(project, 'demonstration'), automaticPlanProvenance());
  const confirmed = confirmAudioInstruction(generated, 'ambient-instruction');
  const variants: Project[] = [project,
    { ...confirmed, audioInstructionDecisions: confirmed.audioInstructionDecisions!.map(({ sharedScope: _scope, ...decision }) => decision) },
    { ...confirmed, audioInstructionDecisions: confirmed.audioInstructionDecisions!.map((decision) => decision.instructionId !== 'ambient-instruction' ? decision : {
      ...decision, sharedScope: { ...sharedScope(project), requiredSegmentIds: [] },
    }) },
    { ...confirmed, dataset: { ...confirmed.dataset, instructions: confirmed.dataset.instructions.map((instruction) => instruction.id === 'ambient-instruction' ? { ...instruction, text: '변경된 현재 원문' } : instruction) } },
  ];
  for (const variant of variants) {
    const before: string = JSON.stringify(variant);
    const projection = await createPdfTextProjection(variant, { maturity: 'draft', channel: 'pdf-export' }, {});
    const entry = projection.items.flatMap((item) => item.audioEntries).find((value): boolean => value.id === 'ambient-instruction')!;
    expect(entry.statusText).toContain('DIRECTION · REVIEW REQUIRED');
    expect(entry.statusText).not.toContain('REVIEWED DIRECTION');
    expect(entry.statusText).not.toContain('현재 구간: 음향 배치');
    expect(entry.body).toBe(variant.dataset.instructions.find((value): boolean => value.id === entry.id)!.text);
    expect(JSON.stringify(variant)).toBe(before);
  }
});

it('pdf_shared_audio_scope_reasons_use_external_redaction_without_modifying_saved_evidence', async (): Promise<void> => {
  const project = await sharedProject(); const plan = scopedPlan(project, 'demonstration');
  const generated = compileAudioInstructionPlan(project, 'demonstration', { ...plan, decisions: plan.decisions.map((decision) => ({
    ...decision, reason: '문의 scope@example.com', sharedScope: decision.sharedScope === null ? null : { ...sharedScope(project), reason: '구간 검토 /Users/private/source.txt' },
  })) }, automaticPlanProvenance());
  const before: string = JSON.stringify(generated);
  const projection = await createPdfTextProjection(generated, { maturity: 'draft', channel: 'pdf-export' }, {});
  const redacted = redactPdfProjection(projection, reviewRedactionPatterns([]));
  const entry = redacted.projection.items.flatMap((item) => item.audioEntries).find((value): boolean => value.id === 'ambient-instruction')!;
  expect(entry.statusText).toContain('현재 구간: 음향 배치');
  expect(entry.statusText).not.toContain('scope@example.com'); expect(entry.statusText).not.toContain('/Users/private/source.txt');
  expect(redacted.entries).toContainEqual(expect.objectContaining({ category: 'email', fieldPath: expect.stringContaining('/statusText') }));
  expect(redacted.entries).toContainEqual(expect.objectContaining({ category: 'absolute-path', fieldPath: expect.stringContaining('/statusText') }));
  expect(JSON.stringify(generated)).toBe(before);
});

import { expect, it } from 'vitest';
import { automaticAudioInstructionTargets } from '../src/automation/audio-instruction-targets.js';
import { recommendedStoryboardDensity } from '../src/automation/density.js';
import { nextAutomaticWork } from '../src/automation/job-graph.js';
import { createSourceRepairBasis } from '../src/automation/repair-basis.js';
import { compileSourceRepair } from '../src/automation/repair-compiler.js';
import { createAutomationRun } from '../src/automation/run-state.js';
import { compileAudioInstructionPlan } from '../src/automation/plan-audio-instructions.js';
import { confirmAudioInstruction, updateAudioInstruction } from '../src/domain/audio-instructions.js';
import { audioOccurrenceReviewIssues } from '../src/domain/audio-occurrences.js';
import { audioCueSource } from '../src/domain/audio-source.js';
import { storyboardAudioIssues } from '../src/domain/audio-storyboard.js';
import type { Project } from '../src/domain/schema.js';
import { applySourceUpdate } from '../src/domain/source-update.js';
import { createPdfTextProjection } from '../src/exporters/pdf.js';
import { migrateProjectInput, parseProject } from '../src/io/project.js';
import { occurrencePlan, occurrenceProject } from './audio-occurrence-helpers.js';
import { audioInstructionFixture } from './audio-instruction-helpers.js';
import { automaticPlanProvenance } from './automatic-plan-helpers.js';
import { initial } from './automatic-executor-helpers.js';

it('audio_occurrences_create_independent_sources_and_timing_without_late_information_on_early_sound', async (): Promise<void> => {
  const source = await occurrenceProject(); const before: string = JSON.stringify(source);
  const generated = compileAudioInstructionPlan(source, 'demonstration', occurrencePlan(), automaticPlanProvenance());
  expect(parseProject(generated)).toEqual(generated); expect(JSON.stringify(source)).toBe(before);
  const decision = generated.audioInstructionDecisions!.find((value): boolean => value.instructionId === 'ambient-instruction')!;
  expect(decision.cueIds).toHaveLength(2); expect(decision.reviewStatus).toBe('proposed');
  const early = generated.audioCues.find((cue): boolean => cue.id === decision.cueIds[0])!;
  const late = generated.audioCues.find((cue): boolean => cue.id === decision.cueIds[1])!;
  expect(audioCueSource(generated, early)).toMatchObject({ text: '물이 흙에 닿는 소리', unitId: '동작', informationIds: ['reveal:동작'] });
  expect(audioCueSource(generated, late)).toMatchObject({ text: '컵을 내려놓는 소리', unitId: '효과음', informationIds: ['reveal:효과음'] });
  expect(generated.audioCues.filter((cue): boolean => !decision.cueIds.includes(cue.id))).toEqual(source.audioCues);
  const planned: Project = { ...generated, shots: generated.shots.map((shot) => shot.segmentId !== 'demonstration' ? shot : { ...shot,
    sourceLinks: shot.sourceLinks.map((link) => ({ ...link, status: 'confirmed' as const,
      temporalAnchor: { kind: 'shot-offset' as const, startOffsetMs: link.unitId === '안내-1' ? 0 : link.unitId === '동작' ? 1000 : 6000,
        endOffsetMs: link.unitId === '안내-1' ? 1000 : link.unitId === '동작' ? 2500 : 8500, basis: 'proposal' as const, status: 'confirmed' as const } })),
  }), audioCues: generated.audioCues.map((cue) => cue.id === early.id ? { ...cue, startMs: 6000, endMs: 6500 } : cue.id === late.id ? { ...cue, startMs: 11000, endMs: 11500 } : cue) };
  expect(storyboardAudioIssues(planned, planned.audioCues.find((cue): boolean => cue.id === early.id)!)).toEqual([]);
  expect(storyboardAudioIssues(planned, planned.audioCues.find((cue): boolean => cue.id === late.id)!)).toEqual([]);
  expect(storyboardAudioIssues(planned, { ...late, startMs: 6000, endMs: 6500 })).toContainEqual(expect.objectContaining({ code: 'EARLY_INFORMATION_EMISSION' }));
  expect(storyboardAudioIssues(planned, { ...early, startMs: 11000, endMs: 11500 })).toContainEqual(expect.objectContaining({ code: 'STORYBOARD_AUDIO_TIMING_REQUIRED' }));
  const projection = await createPdfTextProjection(planned, { maturity: 'draft', channel: 'pdf-export' }, {});
  const entries = projection.items.flatMap((item) => item.audioEntries);
  expect(entries.find((entry): boolean => entry.id === early.id)).toMatchObject({ body: '물이 흙에 닿는 소리', timeText: expect.stringContaining('(6000..6500ms)') });
  expect(entries.find((entry): boolean => entry.id === late.id)).toMatchObject({ body: '컵을 내려놓는 소리', timeText: expect.stringContaining('(11000..11500ms)') });
  expect(planned.assets).toEqual(source.assets); expect(planned.generationRecords).toEqual(generated.generationRecords);
});

it('audio_occurrences_reject_missing_foreign_spoken_duplicate_or_unbound_sources_atomically', async (): Promise<void> => {
  const project = await occurrenceProject(); const plan = occurrencePlan(); const first = plan.decisions[0]!; const occurrences = first.occurrences!;
  const variants = [
    { ...first, occurrences: [occurrences[0]!] },
    { ...first, occurrences: [{ ...occurrences[0]!, source: { kind: 'unit' as const, unitId: '안내-1', quote: '물을 주기 전에' } }, occurrences[1]!] },
    { ...first, occurrences: [{ ...occurrences[0]!, source: { kind: 'unit' as const, unitId: 'missing', quote: '없는 소리' } }, occurrences[1]!] },
    { ...first, occurrences: [{ ...occurrences[0]!, informationIds: [] }, occurrences[1]!] },
    { ...first, occurrences: [{ ...occurrences[0]!, source: { kind: 'instruction' as const, quote: '폭발음' } }, occurrences[1]!] },
    { ...first, cueIds: ['missing'], occurrences: [{ ...occurrences[0]!, cueId: 'missing' }, occurrences[1]!] },
  ];
  const before: string = JSON.stringify(project);
  for (const decision of variants) expect(() => compileAudioInstructionPlan(project, 'demonstration', { ...plan, decisions: [decision, plan.decisions[1]!] }, automaticPlanProvenance())).toThrow();
  expect(JSON.stringify(project)).toBe(before);
  const generated = compileAudioInstructionPlan(project, 'demonstration', plan, automaticPlanProvenance());
  const saved = generated.audioInstructionDecisions![0]!;
  expect(() => updateAudioInstruction(generated, { ...first, cueIds: [saved.cueIds[0]!, saved.cueIds[0]!],
    occurrences: saved.occurrences!.map((value) => ({ ...value, cueId: saved.cueIds[0]! })) }, 'duplicate')).toThrowError(expect.objectContaining({ code: 'INVALID_AUDIO_INSTRUCTION' }));
});

it('audio_occurrences_reuse_one_existing_effect_for_corresponding_action_and_sound_evidence_without_duplicates', async (): Promise<void> => {
  const project = await audioInstructionFixture(); const effect = project.audioCues.find((cue): boolean => cue.unitId === '효과음')!;
  const action = project.dataset.units.find((unit): boolean => unit.id === '동작')!; const sound = project.dataset.units.find((unit): boolean => unit.id === '효과음')!;
  const next = compileAudioInstructionPlan(project, 'demonstration', { ...occurrencePlan(), decisions: [
    { instructionId: 'ambient-instruction', resolution: 'required', cueIds: [effect.id], informationIds: [...action.informationIds, ...sound.informationIds],
      sourceEvidence: [{ unitId: action.id, quote: action.text }, { unitId: sound.id, quote: sound.text }], reason: '동작과 효과음의 물소리는 같은 발생이다.',
      occurrences: [{ cueId: effect.id, source: { kind: 'unit', unitId: sound.id, quote: sound.text }, supportingUnitIds: [action.id],
        informationIds: [...action.informationIds, ...sound.informationIds], reason: '기존 물소리를 재사용한다.' }] },
    occurrencePlan().decisions[1]!,
  ] }, automaticPlanProvenance());
  expect(next.audioCues).toEqual(project.audioCues);
  expect(next.audioInstructionDecisions![0]!.cueIds).toEqual([effect.id]);
  expect(audioCueSource(next, effect)).toMatchObject({ text: sound.text, informationIds: expect.arrayContaining([...action.informationIds, ...sound.informationIds]) });
  const decision = next.audioInstructionDecisions![0]!;
  expect(() => updateAudioInstruction(next, { instructionId: decision.instructionId, resolution: 'required', cueIds: decision.cueIds,
    informationIds: sound.informationIds, sourceEvidence: decision.sourceEvidence, reason: '근거 정보 누락',
    occurrences: decision.occurrences!.map((value) => ({ ...value, informationIds: sound.informationIds })) }, 'unused')).toThrow();
});

it('audio_occurrences_are_automatically_timed_in_existing_cuts_without_audio_files_or_changing_confirmed_source_ranges', async (): Promise<void> => {
  const generated = compileAudioInstructionPlan(await occurrenceProject(), 'demonstration', occurrencePlan(), automaticPlanProvenance());
  const project: Project = { ...generated, shots: generated.shots.map((shot) => shot.segmentId !== 'demonstration' ? shot : { ...shot, proposalOrigin: 'manual',
    sourceLinks: shot.sourceLinks.map((link) => ({ ...link, status: 'confirmed' as const, temporalAnchor: { kind: 'shot-offset' as const, basis: 'manual' as const, status: 'confirmed' as const,
      startOffsetMs: link.unitId === '효과음' ? 6000 : 0, endOffsetMs: link.unitId === '안내-1' ? 1000 : link.unitId === '동작' ? 6000 : 8500 } })),
  }) };
  const decision = project.audioInstructionDecisions![0]!; const basis = createSourceRepairBasis(project, 'demonstration');
  expect(basis.targets).toEqual([]); expect(basis.soundCueIds).toEqual(decision.cueIds);
  const event = initial(project); const run = createAutomationRun({ ...event, settings: { ...event.settings, density: recommendedStoryboardDensity(), textLayoutPlanning: 'preserve', audioMixPlanning: 'preserve', speakerVoices: [], audioProduction: 'instructions-only' } });
  expect(nextAutomaticWork(run, project)).toMatchObject({ kind: 'register', jobs: [{ task: { kind: 'repair', segmentId: 'demonstration' } }] });
  const plan = { schemaVersion: '1.2.0' as const, segmentId: 'demonstration', summary: '이미 정한 컷과 원문 구간 안에서 물소리와 컵 소리를 별도로 배치한다.', links: [],
    audioTimings: [...basis.speechCueIds.map((id) => ({ cueId: id, startMs: 5000, endMs: 6000, timingRelation: 'within-segment' as const, reason: '기존 안내 범위' })),
      ...basis.soundCueIds.map((id, index) => ({ cueId: id, startMs: index === 0 ? 6000 : 11000, endMs: index === 0 ? 6500 : 11500, timingRelation: 'within-segment' as const, reason: '발생별 원문 Anchor 안의 제안' }))] };
  const provenance = { ...automaticPlanProvenance(), generationId: 'occurrence-timing' };
  const candidate = compileSourceRepair(project, basis, plan, [], [], provenance, 32);
  for (const key of ['shots', 'frames', 'dataset', 'sources', 'assets', 'audioInstructionDecisions'] as const) expect(candidate.project[key]).toEqual(project[key]);
  expect(candidate.writes).toEqual([]); expect(candidate.project.generationRecords.slice(0, -1)).toEqual(project.generationRecords);
  for (const id of decision.cueIds) expect(storyboardAudioIssues(candidate.project, candidate.project.audioCues.find((cue): boolean => cue.id === id)!)).toEqual([]);
  expect(() => compileSourceRepair(project, basis, { ...plan, audioTimings: plan.audioTimings.slice(0, -1) }, [], [], provenance, 32)).toThrowError(expect.objectContaining({ code: 'AUTOMATION_REPAIR_AUDIO_SCOPE' }));
  expect(() => compileSourceRepair(project, basis, { ...plan, audioTimings: plan.audioTimings.map((timing) => timing.cueId === decision.cueIds[1] ? { ...timing, startMs: 6000, endMs: 6500 } : timing) }, [], [], provenance, 32)).toThrowError(expect.objectContaining({ code: 'AUTOMATION_REPAIR_INVALID' }));
});

it('legacy_combined_audio_occurrences_remain_reviewable_and_only_unprotected_unmeasured_plans_are_repaired', async (): Promise<void> => {
  const project = await occurrenceProject(); const plan = occurrencePlan();
  const generated = compileAudioInstructionPlan(project, 'demonstration', plan, automaticPlanProvenance());
  const early = generated.audioInstructionDecisions![0]!.cueIds[0]!;
  const legacy: Project = { ...generated, audioInstructionDecisions: generated.audioInstructionDecisions!.map(({ occurrences: _occurrences, ...decision }) => decision.instructionId === 'ambient-instruction' ? { ...decision, cueIds: [early] } : decision),
    audioCues: generated.audioCues.filter((cue): boolean => cue.instructionId !== 'ambient-instruction' || cue.id === early) };
  expect(parseProject(legacy)).toEqual(legacy);
  expect(automaticAudioInstructionTargets(legacy, 'demonstration').map((instruction): string => instruction.id)).toEqual(['ambient-instruction']);
  const instruction = legacy.dataset.instructions.find((value): boolean => value.id === 'ambient-instruction')!;
  expect(audioOccurrenceReviewIssues(legacy, instruction, legacy.audioInstructionDecisions![0]!)).toHaveLength(1);
  expect(() => confirmAudioInstruction(legacy, instruction.id)).toThrow();
  const repaired = compileAudioInstructionPlan(legacy, 'demonstration', { ...plan, decisions: [plan.decisions[0]!] }, { ...automaticPlanProvenance(), generationId: 'occurrence-repair' });
  expect(repaired.audioCues.some((cue): boolean => cue.id === early)).toBe(false);
  expect(repaired.generationRecords.slice(0, -1)).toEqual(legacy.generationRecords);
  const media: Project = { ...legacy, audioCues: legacy.audioCues.map((cue) => cue.id === early ? { ...cue, assetId: 'preserved-file' } : cue) };
  expect(automaticAudioInstructionTargets(media, 'demonstration')).toEqual([]);
  const protectedMedia: Project = { ...generated, audioCues: generated.audioCues.map((cue) => cue.id === early ? { ...cue, assetId: 'preserved-file' } : cue) };
  const saved = generated.audioInstructionDecisions![0]!;
  expect(() => updateAudioInstruction(protectedMedia, { ...plan.decisions[0]!, cueIds: saved.cueIds,
    occurrences: saved.occurrences!.map((value, index) => index === 0 ? { ...value, source: { ...value.source, quote: '흙에 닿는 소리' } } : value) }, 'unused')).toThrowError(expect.objectContaining({ code: 'AUDIO_INSTRUCTION_AUDIO_IN_USE' }));
  const confirmed = confirmAudioInstruction(generated, instruction.id);
  expect(automaticAudioInstructionTargets(confirmed, 'demonstration')).toEqual([]);
  expect(() => updateAudioInstruction(generated, { instructionId: instruction.id, resolution: 'none', cueIds: [], informationIds: [], reason: '발생 연결을 조용히 버리면 안 된다.' }, 'unused')).toThrow();
});

it('audio_occurrence_migration_and_source_update_preserve_old_bytes_and_invalidate_changed_sources', async (): Promise<void> => {
  const source = await occurrenceProject(); const legacy = { ...source, schemaVersion: '1.22.0' }; const bytes: string = JSON.stringify(legacy);
  expect(migrateProjectInput(legacy)).toEqual(source); expect(JSON.stringify(legacy)).toBe(bytes);
  const generated = compileAudioInstructionPlan(source, 'demonstration', occurrencePlan(), automaticPlanProvenance());
  expect(() => migrateProjectInput({ ...generated, schemaVersion: '1.22.0' })).toThrowError(expect.objectContaining({ code: 'UNSUPPORTED_LEGACY_AUDIO_OCCURRENCES' }));
  expect(applySourceUpdate(generated, source, 'unchanged').audioInstructionDecisions).toEqual(generated.audioInstructionDecisions);
  const incoming: Project = { ...source, dataset: { ...source.dataset, units: source.dataset.units.map((unit) => unit.id === '동작' ? { ...unit, text: '새 소리 원문' } : unit) } };
  const next = applySourceUpdate(generated, incoming, 'changed');
  expect(next.audioInstructionDecisions).toEqual([]); expect(next.audioCues.some((cue): boolean => cue.instructionId === 'ambient-instruction')).toBe(false);
  expect(next.assets).toEqual(generated.assets); expect(next.generationRecords).toEqual(generated.generationRecords);
});

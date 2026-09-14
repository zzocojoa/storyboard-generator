import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { z } from 'zod';
import { automaticAudioInstructionTargets } from '../src/automation/audio-instruction-targets.js';
import { compileAudioInstructionPlan, planAutomaticAudioInstructions } from '../src/automation/plan-audio-instructions.js';
import type { AutomaticAudioInstructionPlan } from '../src/automation/plan-audio-instructions.js';
import { confirmAudioInstruction } from '../src/domain/audio-instructions.js';
import { storyboardAudioIssues } from '../src/domain/audio-storyboard.js';
import { audioCueSource } from '../src/domain/audio-source.js';
import type { Project } from '../src/domain/schema.js';
import { parseProject } from '../src/io/project.js';
import { audioPlaceholderFixture } from './audio-instruction-helpers.js';
import { automaticPlanProvenance } from './automatic-plan-helpers.js';


function proposed(): AutomaticAudioInstructionPlan {
  return { schemaVersion: '1.0.0', segmentId: 'demonstration', summary: '지문에 적힌 문 두드림을 음향 지시로 연결한다.', decisions: [
    { instructionId: 'ambient-instruction', resolution: 'required', cueIds: [], informationIds: ['reveal:동작'],
      sourceEvidence: [{ unitId: '동작', quote: '문을 두드리는 소리가 들린다.' }], sharedScope: null, occurrences: [{ cueId: null, supportingUnitIds: [], source: { kind: 'unit', unitId: '동작', quote: '문을 두드리는 소리가 들린다.' }, informationIds: ['reveal:동작'], reason: '원문 소리 발생' }], reason: '빈 환경 음향 칸을 무음으로 단정하지 않고 지문의 실제 소리를 인용한다.' },
    { instructionId: 'music-instruction', resolution: 'none', cueIds: [], informationIds: [], sourceEvidence: [], sharedScope: null, occurrences: [], reason: '배경 음악 없음이 명시됐다.' },
  ] };
}

it('audio_instruction_placeholder_requires_exact_audible_source_evidence_and_corrects_the_model', async (): Promise<void> => {
  const project = await audioPlaceholderFixture(); const before = structuredClone(project); let calls: number = 0;
  const invalid = { ...proposed(), decisions: proposed().decisions.map((decision) => ({ ...decision, sourceEvidence: [] })) };
  expect(() => compileAudioInstructionPlan(project, 'demonstration', invalid, automaticPlanProvenance())).toThrowError(expect.objectContaining({ code: 'INVALID_AUDIO_INSTRUCTION' }));
  const result = await planAutomaticAudioInstructions(project, 'demonstration', { maxCorrections: 1, provenance: automaticPlanProvenance() }, {
    model: { run: async (input) => {
      expect(input.outputSchema).toMatchObject({ properties: { decisions: { items: {
        additionalProperties: false, required: expect.arrayContaining(['instructionId', 'resolution', 'cueIds', 'informationIds', 'reason', 'sourceEvidence', 'sharedScope', 'occurrences']),
        properties: { sourceEvidence: { items: { additionalProperties: false, required: ['unitId', 'quote'] } },
          occurrences: { items: { additionalProperties: false, required: expect.arrayContaining(['cueId', 'source', 'informationIds', 'supportingUnitIds', 'reason']),
            properties: { source: { anyOf: [
              { additionalProperties: false, properties: { kind: { const: 'unit' } }, required: ['kind', 'unitId', 'quote'] },
              { additionalProperties: false, properties: { kind: { const: 'instruction' } }, required: ['kind', 'quote'] },
            ] } },
          } } },
      } } } });
      expect(JSON.stringify(input.outputSchema)).not.toContain('"oneOf"');
      calls += 1; return { model: 'fixture', turnId: `turn-${calls}`, result: z.json().parse(calls === 1 ? invalid : proposed()) };
    } },
    onProgress: async (): Promise<void> => {},
  }, new AbortController().signal);
  expect(calls).toBe(2); expect(project).toEqual(before); expect(result.dataset).toEqual(project.dataset); expect(result.assets).toEqual([]);
  const cue = result.audioCues.find((value): boolean => value.instructionId === 'ambient-instruction')!;
  const source = audioCueSource(result, cue)!;
  expect(source.text).toBe('문을 두드리는 소리가 들린다.'); expect(source.informationIds).toContain('reveal:동작');
  expect(source.sourceRefs).toEqual(expect.arrayContaining(project.dataset.units.find((unit): boolean => unit.id === '동작')!.sourceRefs));
  expect(result.audioInstructionDecisions!.every((decision): boolean => decision.reviewStatus === 'proposed')).toBe(true);
});

it('audio_instruction_evidence_rejects_invented_foreign_spoken_duplicate_or_unbound_quotes', async (): Promise<void> => {
  const project = await audioPlaceholderFixture(); const decision = proposed().decisions[0]!;
  const variants = [
    { ...decision, sourceEvidence: [{ unitId: '동작', quote: '경보가 세 번 울린다.' }] },
    { ...decision, sourceEvidence: [{ unitId: 'missing', quote: '문을 두드리는 소리가 들린다.' }] },
    { ...decision, sourceEvidence: [{ unitId: '안내-1', quote: project.dataset.units.find((unit): boolean => unit.id === '안내-1')!.text }] },
    { ...decision, sourceEvidence: [...decision.sourceEvidence!, ...decision.sourceEvidence!] },
    { ...decision, informationIds: [] },
    { ...decision, resolution: 'none' as const },
  ];
  for (const changed of variants) expect(() => compileAudioInstructionPlan(project, 'demonstration', { ...proposed(), decisions: [changed, proposed().decisions[1]!] }, automaticPlanProvenance())).toThrow();
  const foreign: Project = { ...project, dataset: { ...project.dataset, units: project.dataset.units.map((unit) => unit.id === '동작' ? { ...unit, segmentId: 'another-segment' } : unit) } };
  expect(() => compileAudioInstructionPlan(foreign, 'demonstration', proposed(), automaticPlanProvenance())).toThrow();
});

it('legacy_empty_automatic_sound_is_preserved_blocked_and_replanned_without_replacing_real_media_or_manual_choices', async (): Promise<void> => {
  const initial = await audioPlaceholderFixture();
  const generated = compileAudioInstructionPlan(initial, 'demonstration', proposed(), automaticPlanProvenance());
  const legacy = { ...generated, schemaVersion: '1.20.0', audioInstructionDecisions: generated.audioInstructionDecisions!.map(({ sourceEvidence: _evidence, sharedScope: _scope, occurrences: _occurrences, ...decision }) => decision) };
  const bytes: string = JSON.stringify(legacy); const project = parseProject(legacy);
  expect(JSON.stringify(legacy)).toBe(bytes); expect(project.schemaVersion).toBe('1.24.0');
  const cue = project.audioCues.find((value): boolean => value.instructionId === 'ambient-instruction')!;
  expect(storyboardAudioIssues(project, cue)).toContainEqual(expect.objectContaining({ code: 'AUDIO_INSTRUCTION_CONTENT_REQUIRED' }));
  expect(() => confirmAudioInstruction(project, 'ambient-instruction')).toThrow();
  expect(automaticAudioInstructionTargets(project, 'demonstration').map((value): string => value.id)).toEqual(['ambient-instruction']);
  const corrected = compileAudioInstructionPlan(project, 'demonstration', { ...proposed(), decisions: [{ ...proposed().decisions[0]!, cueIds: [cue.id], occurrences: proposed().decisions[0]!.occurrences!.map((value) => ({ ...value, cueId: cue.id })) }] }, { ...automaticPlanProvenance(), generationId: randomUUID() });
  expect(corrected.audioCues).toEqual(project.audioCues); expect(corrected.generationRecords.slice(0, -1)).toEqual(project.generationRecords);
  expect(audioCueSource(corrected, cue)?.text).toBe('문을 두드리는 소리가 들린다.');
  expect(automaticAudioInstructionTargets(corrected, 'demonstration')).toEqual([]);
  const manual: Project = { ...project, audioInstructionDecisions: project.audioInstructionDecisions!.map((decision) => ({ ...decision, origin: 'manual', generationId: null })) };
  expect(automaticAudioInstructionTargets(manual, 'demonstration')).toEqual([]);
  const attached: Project = { ...project, audioCues: project.audioCues.map((value) => value.id === cue.id ? { ...value, assetId: 'existing-media' } : value) };
  expect(automaticAudioInstructionTargets(attached, 'demonstration')).toEqual([]);
  expect(() => parseProject({ ...legacy, audioInstructionDecisions: generated.audioInstructionDecisions })).toThrowError(expect.objectContaining({ code: 'UNSUPPORTED_LEGACY_AUDIO_EVIDENCE' }));
});

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { describe, expect, it, vi } from 'vitest';
import { assertAutomaticFrameBasis, automaticFrameContinuityReference, automaticFramePrompt, compileAutomaticFrame, createAutomaticFrameBasis, generateAutomaticFrame } from '../src/automation/frame-image.js';
import type { AutomaticFrameCandidate } from '../src/automation/frame-image.js';
import { verifiedImageReferences } from '../src/automation/image-references.js';
import { createSegmentPlanBasis } from '../src/automation/plan-basis.js';
import { compileAutomaticSegmentPlan } from '../src/automation/plan-compiler.js';
import type { AutomaticPlanProvenance } from '../src/automation/plan-compiler.js';
import type { PlannedAssetWrite } from '../src/automation/plan-audio.js';
import { compileAutomaticProductionPlan } from '../src/automation/production-compiler.js';
import { createProductionPlanBasis } from '../src/automation/production-basis.js';
import type { ImageGenerationInput, ImageGenerationResult } from '../src/codex/image-engine.js';
import { prepareImageReferences } from '../src/codex/image-reference-presentation.js';
import { addReferenceAsset } from '../src/domain/media.js';
import { inspectImageBytes } from '../src/domain/media-inspection.js';
import type { Project } from '../src/domain/schema.js';
import { importPackage } from '../src/importers/import-package.js';
import { createSourceOutline } from '../src/proposal/outline.js';
import { ProjectStore } from '../src/server/store.js';
import { automaticPlanProject, automaticPlanProvenance, demonstrationPlan, existingPlanAudio, stagedPlanSpeech } from './automatic-plan-helpers.js';
import { nativeData, nativePackage, withNativeData } from './helpers.js';

async function png(project: Project): Promise<Buffer> {
  return sharp({ create: { width: project.profile.aspectWidth * 10, height: project.profile.aspectHeight * 10, channels: 3, background: '#8a967f' } }).png().toBuffer();
}

async function readyFrame(source: Project): Promise<{ project: Project; writes: PlannedAssetWrite[]; referenceBytes: Buffer; frameId: string }> {
  const referenceBytes = await png(source);
  const reference = await addReferenceAsset({ ...source, profile: { ...source.profile, medium: 'ai', visualStyle: '흑백 연필 콘티' } }, { id: 'bench-reference', kind: 'location', subjectId: 'workbench', description: '흰 벽과 나무 작업대', mimeType: 'image/png', bytes: referenceBytes });
  const plan = demonstrationPlan(reference.project);
  if (source.dataset.units.some((unit): boolean => unit.id === 'late-action')) plan.shots[0]!.sourceLinks.push({ unitId: 'late-action', usage: 'primary-visual', startOffsetMs: 4000, endOffsetMs: 8500, reason: '뒤에서 공개하는 검증 지문' });
  const candidate = compileAutomaticSegmentPlan(reference.project, createSegmentPlanBasis(reference.project, 'demonstration', ['shot-2']), plan, [stagedPlanSpeech(reference.project)], [], automaticPlanProvenance(), 64);
  const frameId = candidate.project.frames.find((frame): boolean => frame.shotId === 'automatic-plan-test:shot:0')!.id;
  return { project: candidate.project, writes: [{ relativePath: reference.relativePath!, content: reference.content! }, ...candidate.writes], referenceBytes, frameId };
}

async function image(project: Project): Promise<ImageGenerationResult> {
  const bytes = await png(project);
  return { bytes, model: 'test-image-model', turnId: 'actual-image-turn', itemId: 'actual-image-item', revisedPrompt: null, inspection: await inspectImageBytes(bytes, 'image/png') };
}

function options(id: string): Omit<AutomaticPlanProvenance, 'model' | 'turnId' | 'prompt'> {
  const { model: _model, turnId: _turn, prompt: _prompt, ...rest } = automaticPlanProvenance();
  return { ...rest, generationId: id };
}

function withKeyFrames(project: Project, firstId: string, offsets: readonly number[]): Project {
  const first = project.frames.find((frame): boolean => frame.id === firstId)!;
  return { ...project, frames: [...project.frames, ...offsets.map((offsetMs) => ({ ...first, id: `key-${offsetMs}`, role: 'key' as const, offsetMs, description: `같은 구도에서 ${offsetMs}ms의 물주기 동작.` }))] };
}

async function generatedFrame(project: Project, frameId: string, generationId: string, result: ImageGenerationResult): Promise<AutomaticFrameCandidate> {
  const basis = createAutomaticFrameBasis(project, frameId);
  return compileAutomaticFrame(project, basis, result, { ...automaticPlanProvenance(), generationId, model: result.model, turnId: result.turnId, prompt: automaticFramePrompt(project, basis) });
}

describe('프레임 자동 그림', (): void => {
  it('automatic_frame_continuity_passes_previous_verified_bytes_first_without_changing_human_review_or_history', async (): Promise<void> => {
    const ready = await readyFrame(await automaticPlanProject());
    const initial = withKeyFrames(ready.project, ready.frameId, [1000]);
    const firstBytes = await sharp({ create: { width: initial.profile.aspectWidth * 10, height: initial.profile.aspectHeight * 10, channels: 3, background: '#e5ab30' } }).png().toBuffer();
    const firstResult: ImageGenerationResult = { ...await image(initial), bytes: firstBytes, inspection: await inspectImageBytes(firstBytes, 'image/png') };
    const first = await generatedFrame(initial, ready.frameId, 'previous', firstResult);
    const project: Project = { ...first.project, frames: first.project.frames.map((frame) => frame.id === ready.frameId ? { ...frame, visualReview: 'accepted' } : frame) };
    const before = structuredClone(project); const basis = createAutomaticFrameBasis(project, 'key-1000');
    expect(basis.referenceAssetIds).toEqual(['previous:image', 'bench-reference']);
    expect(automaticFrameContinuityReference(project, 'key-1000')).toMatchObject({ kind: 'previous-frame', frameId: ready.frameId, assetId: 'previous:image', atMs: 5000, generationRecordId: 'previous' });
    const nextResult = await image(project);
    const run = vi.fn(async (input: ImageGenerationInput): Promise<ImageGenerationResult> => {
      expect(input.references.map((reference) => reference.bytes)).toEqual([firstBytes, ready.referenceBytes]);
      expect(input.references[0]?.label).toContain('같은 컷의 바로 앞 그림');
      expect(input.prompt).toContain('구도·인물 크기·가구와 소품 위치를 유지');
      expect(input.prompt).toContain('참조 보드');
      return nextResult;
    });
    const candidate = await generateAutomaticFrame(project, basis, [{ assetId: 'bench-reference', bytes: ready.referenceBytes }, { assetId: 'previous:image', bytes: firstBytes }], options('next'), { run }, new AbortController().signal);
    expect(run).toHaveBeenCalledTimes(1); expect(project).toEqual(before);
    expect(candidate.project.assets.slice(0, project.assets.length)).toEqual(project.assets);
    expect(candidate.project.generationRecords.slice(0, project.generationRecords.length)).toEqual(project.generationRecords);
    expect(candidate.project.frames.find((frame): boolean => frame.id === ready.frameId)).toEqual(project.frames.find((frame): boolean => frame.id === ready.frameId));
    expect(candidate.project.frames.find((frame): boolean => frame.id === 'key-1000')).toMatchObject({ imageAssetId: 'next:image', visualReview: 'pending' });
    expect(candidate.project.generationRecords.at(-1)?.referenceHashes).toContain(firstResult.inspection.sha256);
    expect(candidate.project.dataset).toEqual(initial.dataset);
    await expect(generateAutomaticFrame(project, basis, [{ assetId: 'bench-reference', bytes: ready.referenceBytes }, { assetId: 'previous:image', bytes: ready.referenceBytes }], options('substituted'), { run }, new AbortController().signal)).rejects.toMatchObject({ code: 'AUTOMATION_REFERENCE_HASH' });
    await expect(generateAutomaticFrame(project, basis, [{ assetId: 'bench-reference', bytes: ready.referenceBytes }], options('missing-previous'), { run }, new AbortController().signal)).rejects.toMatchObject({ code: 'AUTOMATION_REFERENCE_INPUT' });
    await expect(verifiedImageReferences(project, ['previous:image'], [{ assetId: 'previous:image', bytes: firstBytes }], (asset): string => asset.id)).rejects.toMatchObject({ code: 'ASSET_REFERENCE_NOT_FOUND' });
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('automatic_frame_continuity_never_skips_a_missing_rejected_or_changed_immediate_predecessor', async (): Promise<void> => {
    const ready = await readyFrame(await automaticPlanProject()); const initial = withKeyFrames(ready.project, ready.frameId, [1000, 2000]);
    const project = (await generatedFrame(initial, ready.frameId, 'first', await image(initial))).project;
    expect(automaticFrameContinuityReference(project, ready.frameId)).toEqual({ kind: 'none', frameId: null, reason: 'first-frame' });
    expect(automaticFrameContinuityReference(project, 'key-2000')).toEqual({ kind: 'none', frameId: 'key-1000', reason: 'not-generated' });
    const rejected: Project = { ...project, frames: project.frames.map((frame) => frame.id === ready.frameId ? { ...frame, visualReview: 'rejected' } : frame) };
    expect(automaticFrameContinuityReference(rejected, 'key-1000')).toMatchObject({ kind: 'none', reason: 'rejected' });
    const changedCamera: Project = { ...project, shots: project.shots.map((shot) => shot.id === 'automatic-plan-test:shot:0' ? { ...shot, camera: { ...shot.camera, size: 'WS' } } : shot) };
    const changedDescription: Project = { ...project, frames: project.frames.map((frame) => frame.id === ready.frameId ? { ...frame, description: '수정한 현재 물주기 구도' } : frame) };
    const changedSource: Project = { ...project, dataset: { ...project.dataset, units: project.dataset.units.map((unit) => unit.id === '동작' ? { ...unit, text: '물뿌리개를 옆에 내려놓는다.' } : unit) } };
    const changedReference = (await addReferenceAsset(project, { id: 'bench-reference-v2', kind: 'location', subjectId: 'workbench', description: '수정한 작업대', mimeType: 'image/png', bytes: ready.referenceBytes })).project;
    for (const changed of [changedCamera, changedDescription, changedSource, changedReference]) expect(automaticFrameContinuityReference(changed, 'key-1000')).toMatchObject({ kind: 'none', reason: 'changed-input' });
    const foreign: Project = { ...project, frames: project.frames.filter((frame): boolean => frame.id !== ready.frameId), shots: [...project.shots, { ...project.shots.find((shot): boolean => shot.id === 'automatic-plan-test:shot:0')!, id: 'different-shot' }] };
    foreign.frames.push({ ...project.frames.find((frame): boolean => frame.id === ready.frameId)!, shotId: 'different-shot' });
    expect(automaticFrameContinuityReference(foreign, 'key-1000')).toEqual({ kind: 'none', frameId: null, reason: 'first-frame' });
  });

  it('automatic_frame_continuity_invalidates_transitive_image_dependencies_after_an_earlier_retake', async (): Promise<void> => {
    const ready = await readyFrame(await automaticPlanProject()); const initial = withKeyFrames(ready.project, ready.frameId, [1000, 2000, 3000]);
    const result = await image(initial); let project: Project = initial;
    for (const [frameId, generationId] of [[ready.frameId, 'chain-first'], ['key-1000', 'chain-second'], ['key-2000', 'chain-third']] as const) project = (await generatedFrame(project, frameId, generationId, result)).project;
    expect(automaticFrameContinuityReference(project, 'key-3000')).toMatchObject({ kind: 'previous-frame', assetId: 'chain-third:image' });
    const before = structuredClone(project); const basis = createAutomaticFrameBasis(project, 'key-3000');
    const retaken = (await generatedFrame(project, ready.frameId, 'chain-first-retake', result)).project;
    expect(retaken.frames.find((frame): boolean => frame.id === 'key-2000')).toEqual(project.frames.find((frame): boolean => frame.id === 'key-2000'));
    expect(automaticFrameContinuityReference(retaken, 'key-3000')).toMatchObject({ kind: 'none', reason: 'changed-input' });
    expect(() => assertAutomaticFrameBasis(retaken, basis)).toThrow(expect.objectContaining({ code: 'AUTOMATION_STALE_PLAN' }));
    const inserted: Project = { ...project, frames: [...project.frames, { ...project.frames.find((frame): boolean => frame.id === ready.frameId)!, id: 'new-in-between', role: 'key', offsetMs: 500 }] };
    expect(automaticFrameContinuityReference(inserted, 'key-3000')).toMatchObject({ kind: 'none', reason: 'changed-input' });
    expect(project).toEqual(before); expect(retaken.generationRecords.slice(0, project.generationRecords.length)).toEqual(project.generationRecords);
  });

  it('automatic_frame_continuity_accepts_legacy_actual_inputs_but_rejects_unverifiable_or_corrupt_records', async (): Promise<void> => {
    const ready = await readyFrame(await automaticPlanProject()); const initial = withKeyFrames(ready.project, ready.frameId, [1000]);
    const current = (await generatedFrame(initial, ready.frameId, 'legacy-image', await image(initial))).project;
    const envelope = JSON.parse(current.generationRecords.at(-1)!.prompt) as { input: string };
    const separator: number = envelope.input.indexOf('\n');
    const { continuityReference: _reference, ...oldInput } = JSON.parse(envelope.input.slice(separator + 1)) as Record<string, unknown>;
    const legacy: Project = { ...current, generationRecords: current.generationRecords.map((record) => record.id === 'legacy-image' ? { ...record, templateVersion: 'automatic-frame-image-1.0.0', prompt: JSON.stringify({ ...JSON.parse(record.prompt) as object, input: `기존 그림 생성 지시\n${JSON.stringify(oldInput)}` }) } : record) };
    const before = structuredClone(legacy);
    expect(automaticFrameContinuityReference(legacy, 'key-1000')).toMatchObject({ kind: 'previous-frame', assetId: 'legacy-image:image' });
    const unverified: Project = { ...legacy, generationRecords: legacy.generationRecords.filter((record): boolean => record.id !== 'legacy-image') };
    expect(automaticFrameContinuityReference(unverified, 'key-1000')).toMatchObject({ kind: 'none', reason: 'unverifiable-generation' });
    for (const prompt of ['broken-json', '{}', JSON.stringify({ ...JSON.parse(legacy.generationRecords.at(-1)!.prompt) as object, input: 'no-line-break' })]) {
      const broken: Project = { ...legacy, generationRecords: legacy.generationRecords.map((record) => record.id === 'legacy-image' ? { ...record, prompt } : record) };
      expect(() => automaticFrameContinuityReference(broken, 'key-1000')).toThrow(expect.objectContaining({ code: 'AUTOMATION_FRAME_CONTINUITY_PROVENANCE' }));
    }
    expect(legacy).toEqual(before);
  });

  it('automatic_frame_continuity_excludes_previous_images_when_their_visual_sources_are_no_longer_active', async (): Promise<void> => {
    const payload = await nativePackage(); const data = nativeData(payload); const action = data.units.find((unit): boolean => unit.id === '동작')!;
    const source = createSourceOutline(importPackage(withNativeData(payload, { ...data, units: [...data.units, { ...action, id: 'late-action', order: 20, text: '다음 화면의 빈 작업대.' }] })), { proposedTextHoldMs: 2000 });
    const ready = await readyFrame(source);
    const project: Project = { ...ready.project, shots: ready.project.shots.map((shot) => shot.id === 'automatic-plan-test:shot:0' ? { ...shot, sourceLinks: shot.sourceLinks.map((link) => link.unitId === '동작' ? { ...link, temporalAnchor: { kind: 'shot-offset' as const, startOffsetMs: 0, endOffsetMs: 4000, basis: 'proposal' as const, status: 'confirmed' as const } } : link) } : shot) };
    const generated = (await generatedFrame(project, ready.frameId, 'earlier-action', await image(project))).project;
    expect(automaticFrameContinuityReference(generated, 'automatic-plan-test:shot:0:reveal:4000')).toMatchObject({ kind: 'none', reason: 'different-active-sources' });
    expect(createAutomaticFrameBasis(generated, 'automatic-plan-test:shot:0:reveal:4000').referenceAssetIds).toEqual(['bench-reference']);
  });


  it('automatic_frame_continuity_counts_the_previous_bitmap_in_reference_limits_without_dropping_originals', async (): Promise<void> => {
    const ready = await readyFrame(await automaticPlanProject()); let project: Project = withKeyFrames(ready.project, ready.frameId, [1000]);
    const props: string[] = [];
    for (let index: number = 0; index < 19; index += 1) {
      const id: string = `limit-prop-${index}`; props.push(id);
      project = (await addReferenceAsset(project, { id, kind: 'prop', subjectId: id, description: `검증 소품 ${index}`, mimeType: 'image/png', bytes: ready.referenceBytes })).project;
    }
    project = { ...project, shots: project.shots.map((shot) => shot.id === 'automatic-plan-test:shot:0' ? { ...shot, propIds: props } : shot) };
    const basis = createAutomaticFrameBasis(project, ready.frameId); expect(basis.referenceAssetIds).toHaveLength(20);
    const generated = await image(project);
    const first = await generateAutomaticFrame(project, basis, basis.referenceAssetIds.map((assetId) => ({ assetId, bytes: ready.referenceBytes })), options('limit-first'), { run: async (input, signal): Promise<ImageGenerationResult> => ({ ...generated, referencePresentation: (await prepareImageReferences(input.references, signal)).presentation }) }, new AbortController().signal);
    const before = structuredClone(first.project);
    expect(() => createAutomaticFrameBasis(first.project, 'key-1000')).toThrow(expect.objectContaining({ code: 'CODEX_IMAGE_REFERENCES_LIMIT' }));
    expect(first.project).toEqual(before); expect(first.project.shots.find((shot): boolean => shot.id === 'automatic-plan-test:shot:0')?.propIds).toEqual(props);
  });

  it('automatic_frame_continuity_uses_end_frame_evaluation_and_never_selects_a_later_bitmap', async (): Promise<void> => {
    const ready = await readyFrame(await automaticPlanProject()); const keyed = withKeyFrames(ready.project, ready.frameId, [8000]);
    const first = keyed.frames.find((frame): boolean => frame.id === ready.frameId)!;
    const initial: Project = { ...keyed, frames: [...keyed.frames, { ...first, id: 'end-frame', role: 'end', offsetMs: 8500 }] };
    const result = await image(initial);
    const early = (await generatedFrame(initial, ready.frameId, 'end-first', result)).project;
    const later = (await generatedFrame(early, 'key-8000', 'end-key', result)).project;
    expect(automaticFrameContinuityReference(later, 'end-frame')).toMatchObject({ kind: 'previous-frame', frameId: 'key-8000', atMs: 13000 });
    const end = (await generatedFrame(later, 'end-frame', 'end-generated', result)).project;
    expect(automaticFramePrompt(end, createAutomaticFrameBasis(end, 'end-frame'))).toContain('"evaluationAbsoluteMs": 13499');
    expect(automaticFrameContinuityReference(end, 'key-8000')).toMatchObject({ kind: 'previous-frame', frameId: ready.frameId });
    expect(automaticFrameContinuityReference(end, ready.frameId)).toMatchObject({ kind: 'none', reason: 'first-frame' });
  });

  it('automatic_frame_preserves_eight_reference_assets_and_records_the_complete_board_mapping', async (): Promise<void> => {
    const ready = await readyFrame(await automaticPlanProject()); let project: Project = ready.project;
    const extraIds: string[] = [];
    for (let index: number = 0; index < 7; index += 1) {
      const id: string = `prop-reference-${index}`; extraIds.push(id);
      project = (await addReferenceAsset(project, { id, kind: 'prop', subjectId: `prop-${index}`, description: `검증 소품 ${index}`, mimeType: 'image/png', bytes: ready.referenceBytes })).project;
    }
    project = { ...project, shots: project.shots.map((shot) => shot.id === 'automatic-plan-test:shot:0' ? { ...shot, propIds: extraIds } : shot) };
    const before = structuredClone(project); const basis = createAutomaticFrameBasis(project, ready.frameId);
    expect(basis.referenceAssetIds).toHaveLength(8); const generated = await image(project);
    const loaded = basis.referenceAssetIds.map((assetId) => ({ assetId, bytes: ready.referenceBytes }));
    const candidate = await generateAutomaticFrame(project, basis, loaded, options('eight-reference-frame'), { run: async (input, signal): Promise<ImageGenerationResult> => {
      expect(input.references).toHaveLength(8);
      return { ...generated, referencePresentation: (await prepareImageReferences(input.references, signal)).presentation };
    } }, new AbortController().signal);
    expect(project).toEqual(before); expect(candidate.project.assets.slice(0, project.assets.length)).toEqual(project.assets);
    expect(candidate.project.generationRecords.at(-1)?.referenceHashes).toHaveLength(2);
    const prompt = JSON.parse(candidate.project.generationRecords.at(-1)!.prompt) as { referencePresentation: { sources: { sha256: string }[]; attachments: object[] } };
    expect(prompt.referencePresentation.sources).toHaveLength(8); expect(prompt.referencePresentation.attachments).toHaveLength(4);
    expect(candidate.project.frames.find((frame): boolean => frame.id === ready.frameId)?.visualReview).toBe('pending');
    await expect(generateAutomaticFrame(project, basis, loaded, options('missing-presentation'), { run: async (): Promise<ImageGenerationResult> => generated }, new AbortController().signal)).rejects.toMatchObject({ code: 'AUTOMATION_REFERENCE_PRESENTATION_REQUIRED' });
  });
  it('automatic_frame_uses_current_sources_without_whole_shot_future_state_or_voice_only_speakers', async (): Promise<void> => {
    const ready = await readyFrame(await automaticPlanProject());
    const project: Project = { ...ready.project, shots: ready.project.shots.map((shot) => shot.id === 'automatic-plan-test:shot:0' ? {
      ...shot, action: '미래 전체 지문 표식', continuityAfter: [{ assetId: 'bench-reference', state: '미래 종료 상태 표식' }],
      presence: [{ personId: ready.project.dataset.people[0]!.id, mode: 'VOICE_OVER' }],
    } : shot) };
    const before = structuredClone(project);
    const basis = createAutomaticFrameBasis(project, ready.frameId);
    const prompt = automaticFramePrompt(project, basis);
    expect(prompt).toContain(project.dataset.units.find((unit): boolean => unit.id === '동작')!.text);
    expect(prompt).not.toContain('미래 전체 지문 표식'); expect(prompt).not.toContain('미래 종료 상태 표식');
    expect(prompt).not.toContain(project.dataset.units.find((unit): boolean => unit.id === '안내-1')!.text);
    expect(prompt).toContain('"people": []'); expect(basis.referenceAssetIds).toEqual(['bench-reference']);
    expect(project).toEqual(before);
  });

  it('automatic_frame_generates_an_empty_description_derived_frame_from_only_active_units', async (): Promise<void> => {
    const ready = await readyFrame(await automaticPlanProject());
    const original = ready.project.frames.find((frame): boolean => frame.id === ready.frameId)!;
    const project: Project = { ...ready.project, frames: [...ready.project.frames, { ...original, id: 'derived-frame', role: 'key', offsetMs: 2000, description: '' }] };
    const result = await image(project);
    const run = vi.fn(async (input: ImageGenerationInput): Promise<ImageGenerationResult> => {
      expect(input.prompt).toContain('"description": ""');
      expect(input.prompt).toContain('"evaluationAbsoluteMs": 7000');
      expect(input.prompt).toContain(project.dataset.units.find((unit): boolean => unit.id === '동작')!.text);
      return result;
    });
    const candidate = await generateAutomaticFrame(project, createAutomaticFrameBasis(project, 'derived-frame'), [{ assetId: 'bench-reference', bytes: ready.referenceBytes }], options('derived-generation'), { run }, new AbortController().signal);
    expect(run).toHaveBeenCalledTimes(1);
    expect(candidate.project.frames.find((frame): boolean => frame.id === 'derived-frame')).toMatchObject({ imageAssetId: 'derived-generation:image', visualReview: 'pending', description: '' });
  });

  it('automatic_frame_commits_real_bytes_and_provenance_as_pending_and_preserves_previous_versions', async (): Promise<void> => {
    const root = await mkdtemp(join(tmpdir(), 'cutroom-auto-frame-'));
    const store = new ProjectStore(root);
    try {
      const source = await automaticPlanProject(); await store.create(source);
      const ready = await readyFrame(source);
      let project = await store.update(source.projectId, 0, (): Project => ready.project, ready.writes);
      for (const id of ['first-image', 'second-image']) {
        const result = await image(project); const basis = createAutomaticFrameBasis(project, ready.frameId);
        const before = structuredClone(project);
        const candidate = await compileAutomaticFrame(project, basis, result, { ...automaticPlanProvenance(), generationId: id, model: result.model, turnId: result.turnId, prompt: automaticFramePrompt(project, basis) });
        expect(project).toEqual(before); expect(candidate.project.dataset).toEqual(source.dataset);
        project = await store.update(project.projectId, project.revision, (current): Project => { assertAutomaticFrameBasis(current, basis); return candidate.project; }, candidate.writes);
        const asset = await store.asset(project.projectId, `${id}:image`);
        expect(asset.content).toEqual(result.bytes);
        expect(project.generationRecords.at(-1)).toMatchObject({ provider: 'codex-app', model: result.model, requestId: id, templateVersion: 'automatic-frame-image-1.1.0' });
        expect(project.generationRecords.at(-1)?.prompt).toContain(result.turnId);
      }
      expect(project.assets.filter((asset): boolean => asset.kind === 'image').map((asset): number => asset.version)).toEqual([1, 2]);
      expect(project.frames.find((frame): boolean => frame.id === ready.frameId)).toMatchObject({ visualReview: 'pending', imageAssetId: 'second-image:image' });
      expect(project.shots.find((shot): boolean => shot.id === 'automatic-plan-test:shot:0')?.approvalStatus).toBe('proposed');
      expect((await store.read(project.projectId)).generationRecords).toEqual(project.generationRecords);
    } finally { await store.close(); await rm(root, { recursive: true, force: true }); }
  });

  it('automatic_frame_rejects_stale_input_accepted_frames_locks_and_missing_references_before_generation', async (): Promise<void> => {
    const ready = await readyFrame(await automaticPlanProject()); const project = ready.project;
    const basis = createAutomaticFrameBasis(project, ready.frameId);
    expect((): void => assertAutomaticFrameBasis({ ...project, revision: project.revision + 1 }, basis)).toThrow(expect.objectContaining({ code: 'AUTOMATION_STALE_PLAN' }));
    for (const lockedFields of [['camera'] as const, ['frames'] as const]) expect(() => createAutomaticFrameBasis({ ...project, shots: project.shots.map((shot) => shot.id === 'automatic-plan-test:shot:0' ? { ...shot, lockedFields: [...lockedFields] } : shot) }, ready.frameId)).toThrow(expect.objectContaining({ code: 'AUTOMATION_PROTECTED_FRAME' }));
    expect(() => createAutomaticFrameBasis({ ...project, frames: project.frames.map((frame) => frame.id === ready.frameId ? { ...frame, visualReview: 'accepted' } : frame) }, ready.frameId)).toThrow(expect.objectContaining({ code: 'AUTOMATION_PROTECTED_FRAME' }));
    expect(() => createAutomaticFrameBasis({ ...project, assets: project.assets.filter((asset): boolean => asset.id !== 'bench-reference') }, ready.frameId)).toThrow(expect.objectContaining({ code: 'AUTOMATION_FRAME_REFERENCE_REQUIRED' }));
    expect(() => createAutomaticFrameBasis({ ...project, profile: { ...project.profile, visualStyle: null } }, ready.frameId)).toThrow(expect.objectContaining({ code: 'AUTOMATION_FRAME_PROFILE_REQUIRED' }));
  });

  it('automatic_frame_rejects_reference_substitution_and_cancelled_results_without_mutating_the_project', async (): Promise<void> => {
    const ready = await readyFrame(await automaticPlanProject()); const project = ready.project; const before = structuredClone(project);
    const basis = createAutomaticFrameBasis(project, ready.frameId); const result = await image(project);
    const run = vi.fn(async (): Promise<ImageGenerationResult> => result);
    await expect(generateAutomaticFrame(project, basis, [], options('missing'), { run }, new AbortController().signal)).rejects.toMatchObject({ code: 'AUTOMATION_REFERENCE_INPUT' });
    const wrong = await sharp({ create: { width: 10, height: 10, channels: 3, background: '#fff' } }).png().toBuffer();
    await expect(generateAutomaticFrame(project, basis, [{ assetId: 'bench-reference', bytes: wrong }], options('wrong'), { run }, new AbortController().signal)).rejects.toMatchObject({ code: 'AUTOMATION_REFERENCE_HASH' });
    expect(run).not.toHaveBeenCalled();
    const controller = new AbortController();
    await expect(generateAutomaticFrame(project, basis, [{ assetId: 'bench-reference', bytes: ready.referenceBytes }], options('cancelled'), { run: async (): Promise<ImageGenerationResult> => { controller.abort(); return result; } }, controller.signal)).rejects.toMatchObject({ code: 'AUTOMATION_CANCELLED' });
    expect(project).toEqual(before);
  });

  it('automatic_frame_rejects_forged_inspection_aspect_model_and_prompt_metadata', async (): Promise<void> => {
    const ready = await readyFrame(await automaticPlanProject()); const project = ready.project;
    const basis = createAutomaticFrameBasis(project, ready.frameId); const result = await image(project);
    const provenance = { ...automaticPlanProvenance(), generationId: 'new-frame', model: result.model, turnId: result.turnId, prompt: automaticFramePrompt(project, basis) };
    await expect(compileAutomaticFrame(project, basis, result, { ...provenance, model: 'claimed-model' })).rejects.toMatchObject({ code: 'AUTOMATION_FRAME_PROVENANCE' });
    await expect(compileAutomaticFrame(project, basis, result, { ...provenance, prompt: '교체한 입력' })).rejects.toMatchObject({ code: 'AUTOMATION_FRAME_PROVENANCE' });
    await expect(compileAutomaticFrame(project, basis, { ...result, inspection: { ...result.inspection, width: 1 } }, provenance)).rejects.toMatchObject({ code: 'AUTOMATION_FRAME_INSPECTION' });
    const square = await sharp({ create: { width: 40, height: 40, channels: 3, background: '#fff' } }).png().toBuffer();
    await expect(compileAutomaticFrame(project, basis, { ...result, bytes: square, inspection: await inspectImageBytes(square, 'image/png') }, provenance)).rejects.toMatchObject({ code: 'CODEX_IMAGE_ASPECT_MISMATCH' });
  });

  it('automatic_frame_does_not_send_late_source_or_late_reference_state_to_an_earlier_frame', async (): Promise<void> => {
    const payload = await nativePackage(); const data = nativeData(payload);
    const action = data.units.find((unit): boolean => unit.id === '동작')!;
    const source = createSourceOutline(importPackage(withNativeData(payload, { ...data, units: [...data.units, { ...action, id: 'late-action', order: 20, text: '뒤늦게 붉은 봉투를 꺼낸다.' }] })), { proposedTextHoldMs: 2000 });
    const ready = await readyFrame(source); const plan = demonstrationPlan(ready.project);
    plan.shots[0] = { ...plan.shots[0]!, sourceLinks: [...plan.shots[0]!.sourceLinks, { unitId: 'late-action', usage: 'primary-visual', startOffsetMs: 4000, endOffsetMs: 8500, reason: '뒷부분에 공개한다.' }] };
    let project = compileAutomaticSegmentPlan(ready.project, createSegmentPlanBasis(ready.project, 'demonstration', ['automatic-plan-test:shot:0']), plan, [], existingPlanAudio(ready.project, ready.writes), { ...automaticPlanProvenance(), generationId: 'late-plan' }, 64).project;
    const earlyId = 'late-plan:shot:0:frame:0'; const lateId = 'late-plan:shot:0:reveal:4000';
    expect(automaticFramePrompt(project, createAutomaticFrameBasis(project, earlyId))).not.toContain('붉은 봉투');
    expect(automaticFramePrompt(project, createAutomaticFrameBasis(project, lateId))).toContain('붉은 봉투');
    project = compileAutomaticProductionPlan(project, createProductionPlanBasis(project, ['demonstration']), {
      schemaVersion: '1.1.0', profile: project.profile, profileReason: '기존 설정 유지',
      resources: [{ key: 'bench', kind: 'location', subjectId: 'workbench', name: '후반 작업대', description: '후반 공개된 봉투가 놓인 작업대', reason: '후반 지문 기준', sourceRefs: project.dataset.units.find((unit): boolean => unit.id === '동작')!.sourceRefs, sourceUnitIds: ['late-action'], referenceAssetId: 'bench-reference', propContinuity: null }],
      segments: [{ segmentId: 'demonstration', resourceKeys: ['bench'], locationResourceKey: 'bench', continuityGroup: 'bench', entryState: '작업대', exitState: '작업대', reason: '작업대 기준' }],
    }, { ...automaticPlanProvenance(), generationId: 'late-resource' }).project;
    expect(() => createAutomaticFrameBasis(project, earlyId)).toThrow(expect.objectContaining({ code: 'AUTOMATION_FRAME_REFERENCE_EARLY' }));
    expect(createAutomaticFrameBasis(project, lateId).referenceAssetIds).toEqual(['bench-reference']);
  });
});

import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { z } from 'zod';
import { describe, expect, it, vi } from 'vitest';
import { planAutomaticProduction } from '../src/automation/plan-production.js';
import { createProductionPlanBasis } from '../src/automation/production-basis.js';
import { compileAutomaticProductionPlan } from '../src/automation/production-compiler.js';
import { automaticProductionContext } from '../src/automation/production-context.js';
import { assertProductionReferenceBasis, compileAutomaticReference, createProductionReferenceBasis, generateAutomaticReference } from '../src/automation/production-reference.js';
import type { AutomaticProductionPlan } from '../src/automation/production-schema.js';
import type { AutomaticPlanProvenance } from '../src/automation/plan-compiler.js';
import { createSegmentPlanBasis } from '../src/automation/plan-basis.js';
import { compileAutomaticSegmentPlan } from '../src/automation/plan-compiler.js';
import { automaticSegmentContext } from '../src/automation/plan-context.js';
import type { ImageGenerationInput, ImageGenerationResult } from '../src/codex/image-engine.js';
import { assetReferenceIssues, currentVisualReferenceAssets } from '../src/domain/asset-references.js';
import { inspectImageBytes } from '../src/domain/media-inspection.js';
import { productionLocations } from '../src/domain/production-resources.js';
import type { Project } from '../src/domain/schema.js';
import { applySourceUpdate } from '../src/domain/source-update.js';
import { sha256Text } from '../src/importers/integrity.js';
import { parseProject } from '../src/io/project.js';
import { ProjectStore } from '../src/server/store.js';
import { automaticPlanProject, automaticPlanProvenance, demonstrationPlan, stagedPlanSpeech } from './automatic-plan-helpers.js';

function productionPlan(project: Project): AutomaticProductionPlan {
  return { schemaVersion: '1.0.0', profile: { ...project.profile, medium: project.profile.medium === 'unspecified' ? 'ai' : project.profile.medium, visualStyle: project.profile.visualStyle || '밝은 흑백 연필 콘티' }, profileReason: '원문 동작을 가까이 확인할 검토용 제작 기준이다.',
    resources: [{ key: 'bench', kind: 'location', subjectId: 'workbench', name: '밝은 작업대', description: '흰 벽 앞의 밝은 나무 작업대.', reason: '원본 작업대의 시각적 제작 제안.', sourceRefs: project.dataset.locations[0]!.sourceRefs, sourceUnitIds: [], referenceAssetId: null }],
    segments: [{ segmentId: 'demonstration', resourceKeys: ['bench'], locationResourceKey: 'bench', continuityGroup: 'plant-demo', entryState: '작업대 왼쪽에서 오른쪽을 본다.', exitState: '물뿌리개를 작업대에 내려놓는다.', reason: '물주기 원문 동작을 유지한다.' }] };
}

function generationOptions(generationId: string): Omit<AutomaticPlanProvenance, 'model' | 'turnId' | 'prompt'> {
  const { model: _model, turnId: _turn, prompt: _prompt, ...provenance } = automaticPlanProvenance();
  return { ...provenance, generationId };
}

async function imageResult(project: Project): Promise<ImageGenerationResult> {
  const bytes: Buffer = await sharp({ create: { width: project.profile.aspectWidth * 10, height: project.profile.aspectHeight * 10, channels: 3, background: '#718164' } }).png().toBuffer();
  return { model: 'test-image', turnId: 'image-turn', itemId: 'image-item', revisedPrompt: null, bytes, inspection: await inspectImageBytes(bytes, 'image/png') };
}

describe('자동 제작 기준', (): void => {
  it('미정 제작 기준과 편집용 세트를 원본 변경 없이 저장하고 재열기한다', async (): Promise<void> => {
    const source = await automaticPlanProject(); const project: Project = { ...source, profile: { ...source.profile, medium: 'unspecified', visualStyle: null } };
    const before = structuredClone(project); const plan = productionPlan(project);
    plan.resources[0] = { ...plan.resources[0]!, subjectId: null, name: '시연용 스튜디오' };
    const result = compileAutomaticProductionPlan(project, createProductionPlanBasis(project, ['demonstration']), plan, automaticPlanProvenance());
    expect(project).toEqual(before); expect(result.project.dataset).toEqual(project.dataset);
    expect(result.project.profile.medium).toBe('ai'); expect(result.project.generationRecords).toHaveLength(1);
    expect(result.project.productionPlan?.segments[0]?.visualLocationId).toBe('automatic-plan-test:resource:1');
    expect(productionLocations(result.project)).toEqual(expect.arrayContaining([expect.objectContaining({ name: '시연용 스튜디오 · 제작 제안' })]));
    expect(parseProject(result.project)).toEqual(result.project);
    expect(result.project.frames.every((frame): boolean => frame.visualReview === 'pending')).toBe(true);
  });

  it('사용자 제작 설정과 기존 계획 및 생성 도중 편집을 보존한다', async (): Promise<void> => {
    const source = await automaticPlanProject(); const project: Project = { ...source, profile: { ...source.profile, medium: 'live-action', visualStyle: '사용자 수채화' } };
    const basis = createProductionPlanBasis(project, ['demonstration']); const plan = productionPlan(project); const provenance = automaticPlanProvenance();
    expect(() => compileAutomaticProductionPlan(project, basis, { ...plan, profile: { ...plan.profile, visualStyle: '변경' } }, provenance)).toThrowError(expect.objectContaining({ code: 'AUTOMATION_PRODUCTION_PROFILE' }));
    expect(() => compileAutomaticProductionPlan({ ...project, title: '편집됨' }, basis, plan, provenance)).toThrowError(expect.objectContaining({ code: 'AUTOMATION_STALE_PLAN' }));
    const result = compileAutomaticProductionPlan(project, basis, plan, provenance).project;
    expect(result.profile).toEqual(project.profile);
    expect(() => createProductionPlanBasis({ ...project, shots: project.shots.map((shot) => shot.segmentId === 'demonstration' ? { ...shot, lockedFields: ['frames'] } : shot) }, ['demonstration']))
      .toThrowError(expect.objectContaining({ code: 'AUTOMATION_PROTECTED_SHOTS' }));
    expect(() => createProductionPlanBasis(result, ['demonstration'])).toThrowError(expect.objectContaining({ code: 'AUTOMATION_EXISTING_PRODUCTION_PLAN' }));
  });

  it('automatic_production_preserves_accepted_frames_in_selected_and_unrelated_segments', async (): Promise<void> => {
    const source = await automaticPlanProject();
    const selected: Project = { ...source, frames: source.frames.map((frame) => frame.shotId === 'shot-2' ? { ...frame, visualReview: 'accepted' } : frame) };
    expect(() => createProductionPlanBasis(selected, ['demonstration'])).toThrowError(expect.objectContaining({ code: 'AUTOMATION_PROTECTED_SHOTS' }));
    const image = await imageResult(source); const frameId: string = source.frames.find((frame): boolean => frame.shotId === 'shot-1')!.id;
    const elsewhere: Project = { ...source, assets: [...source.assets, { id: 'reviewed-image', kind: 'image', subjectId: frameId,
      path: 'assets/reviewed-image.png', mimeType: image.inspection.mimeType, sha256: image.inspection.sha256, description: '승인된 기존 그림', durationMs: null, version: 1 }],
      frames: source.frames.map((frame) => frame.id === frameId ? { ...frame, imageAssetId: 'reviewed-image', visualReview: 'accepted' } : frame) };
    const before = structuredClone(elsewhere); const basis = createProductionPlanBasis(elsewhere, ['demonstration']);
    expect(() => compileAutomaticProductionPlan(elsewhere, basis, productionPlan(elsewhere), automaticPlanProvenance())).toThrowError(expect.objectContaining({ code: 'AUTOMATION_PROTECTED_PROFILE' }));
    const configured: Project = { ...elsewhere, profile: { ...elsewhere.profile, medium: 'live-action', visualStyle: '이미 정한 연필 표현' } };
    const result = compileAutomaticProductionPlan(configured, createProductionPlanBasis(configured, ['demonstration']), productionPlan(configured), automaticPlanProvenance());
    expect(result.project.frames.filter((frame): boolean => frame.shotId === 'shot-1')).toEqual(elsewhere.frames.filter((frame): boolean => frame.shotId === 'shot-1'));
    expect(elsewhere).toEqual(before);
  });

  it('거짓 출처와 인물 및 미래 상태를 제작 근거로 채택하지 않는다', async (): Promise<void> => {
    const project = await automaticPlanProject(); const plan = productionPlan(project); const basis = createProductionPlanBasis(project, ['demonstration']);
    const invalidResources = [
      { ...plan.resources[0]!, sourceRefs: [{ ...plan.resources[0]!.sourceRefs[0]!, locator: '/invented' }] },
      { ...plan.resources[0]!, kind: 'character', subjectId: 'unknown-person' },
      { ...plan.resources[0]!, sourceUnitIds: ['요약'] },
    ];
    for (const resource of invalidResources) expect(() => compileAutomaticProductionPlan(project, basis, { ...plan, resources: [resource] }, automaticPlanProvenance())).toThrow();
    expect(() => compileAutomaticProductionPlan(project, basis, { ...plan, segments: [] }, automaticPlanProvenance())).toThrow();
    expect(() => compileAutomaticProductionPlan(project, basis, { ...plan, resources: [...plan.resources, ...plan.resources] }, automaticPlanProvenance())).toThrowError(expect.objectContaining({ code: 'AUTOMATION_PRODUCTION_RESOURCE' }));
  });

  it('실제 기준 이미지와 계획 및 측정 음성을 저장 계약으로 연결한다', async (): Promise<void> => {
    const root: string = await mkdtemp(join(tmpdir(), 'automatic-production-')); const store: ProjectStore = new ProjectStore(root);
    try {
      const original = await automaticPlanProject(); await store.create(original);
      const plan = productionPlan(original); const basis = createProductionPlanBasis(original, ['demonstration']); const provenance = automaticPlanProvenance();
      const planned = await store.update(original.projectId, 0, (current): Project => compileAutomaticProductionPlan(current, basis, plan, provenance).project, []);
      const resourceId: string = planned.productionPlan!.resources[0]!.id; const referenceBasis = createProductionReferenceBasis(planned, resourceId); const image = await imageResult(planned);
      const generated = await generateAutomaticReference(planned, referenceBasis, [], generationOptions('reference-test'), { run: async (_input: ImageGenerationInput): Promise<ImageGenerationResult> => image }, new AbortController().signal);
      const withReference = await store.update(planned.projectId, 1, (current): Project => { assertProductionReferenceBasis(current, referenceBasis); return generated.project; }, generated.writes);
      expect(withReference.assets).toHaveLength(1); expect(assetReferenceIssues(withReference)).toEqual([]);
      const context = automaticSegmentContext(withReference, createSegmentPlanBasis(withReference, 'demonstration', ['shot-2']), [], [], null, 32, { fontSha256: 'a'.repeat(64), previousReview: null }, null);
      expect(context.prompt).toContain('reference-test:reference');
      const segmentBasis = createSegmentPlanBasis(withReference, 'demonstration', ['shot-2']); const segmentPlan = demonstrationPlan(withReference); const speech = [stagedPlanSpeech(withReference)];
      const cuts = compileAutomaticSegmentPlan(withReference, segmentBasis, segmentPlan, speech, [], { ...provenance, generationId: 'cuts-test' }, 32);
      const final = await store.update(withReference.projectId, 2, (current): Project => compileAutomaticSegmentPlan(current, segmentBasis, segmentPlan, speech, [], { ...provenance, generationId: 'cuts-test' }, 32).project, cuts.writes);
      expect(final.revision).toBe(3); expect(final.assets).toHaveLength(2); expect(final.generationRecords).toHaveLength(4);
      expect(final.dataset).toEqual(original.dataset); expect(final.productionPlan).toEqual(withReference.productionPlan);
      expect(final.frames.every((frame): boolean => frame.visualReview === 'pending')).toBe(true);
      expect(await readFile(join(root, sha256Text(final.projectId), generated.writes[0]!.relativePath))).toEqual(image.bytes);
      expect(parseProject(JSON.parse(await readFile(join(root, sha256Text(final.projectId), 'project.json'), 'utf8')))).toEqual(final);
    } finally { await store.close(); await rm(root, { recursive: true, force: true }); }
  });

  it('잘못된 기준 이미지와 다른 구간 참조 및 오래된 결과를 거부한다', async (): Promise<void> => {
    const source = await automaticPlanProject(); const planned = compileAutomaticProductionPlan(source, createProductionPlanBasis(source, ['demonstration']), productionPlan(source), automaticPlanProvenance()).project;
    const basis = createProductionReferenceBasis(planned, planned.productionPlan!.resources[0]!.id); const result = await imageResult(planned);
    const provenance = { ...automaticPlanProvenance(), generationId: 'ref-test', model: result.model, turnId: result.turnId };
    await expect(compileAutomaticReference(planned, basis, { ...result, inspection: { ...result.inspection, sha256: 'a'.repeat(64) } }, provenance)).rejects.toMatchObject({ code: 'AUTOMATION_REFERENCE_INSPECTION' });
    await expect(compileAutomaticReference({ ...planned, revision: 1 }, basis, result, provenance)).rejects.toMatchObject({ code: 'AUTOMATION_STALE_PLAN' });
    const model = vi.fn(async (): Promise<ImageGenerationResult> => result);
    await expect(generateAutomaticReference(planned, basis, [{ assetId: 'foreign', bytes: result.bytes }], generationOptions('ref-test'), { run: model }, new AbortController().signal)).rejects.toMatchObject({ code: 'AUTOMATION_REFERENCE_INPUT' });
    expect(model).not.toHaveBeenCalled();
    const segmentBasis = createSegmentPlanBasis(planned, 'demonstration', ['shot-2']);
    expect(() => compileAutomaticSegmentPlan(planned, segmentBasis, demonstrationPlan(planned), [stagedPlanSpeech(planned)], [], { ...provenance, generationId: 'cuts' }, 32)).toThrowError(expect.objectContaining({ code: 'AUTOMATION_PRODUCTION_REFERENCE_SCOPE' }));
  });

  it('컷 계획 출력은 현재 구간의 실제 소품·연속성 자산만 허용한다', async (): Promise<void> => {
    const source = await automaticPlanProject(); const sourcePlan = productionPlan(source);
    const plan: AutomaticProductionPlan = { ...sourcePlan,
      resources: [...sourcePlan.resources, { key: 'can', kind: 'prop', subjectId: null, name: '물뿌리개', description: '작은 초록 물뿌리개', reason: '원문의 물주기 소품', sourceRefs: source.dataset.units.find((unit): boolean => unit.id === '동작')!.sourceRefs, sourceUnitIds: ['동작'], referenceAssetId: null }],
      segments: sourcePlan.segments.map((segment) => ({ ...segment, resourceKeys: [...segment.resourceKeys, 'can'] })),
    };
    let project = compileAutomaticProductionPlan(source, createProductionPlanBasis(source, ['demonstration']), plan, automaticPlanProvenance()).project;
    const image = await imageResult(project);
    for (const resource of project.productionPlan!.resources) project = (await compileAutomaticReference(project, createProductionReferenceBasis(project, resource.id), image,
      { ...automaticPlanProvenance(), generationId: `ref-${resource.kind}`, model: image.model, turnId: image.turnId })).project;
    const basis = createSegmentPlanBasis(project, 'demonstration', ['shot-2']);
    const context = automaticSegmentContext(project, basis, [], [], null, 32, { fontSha256: 'a'.repeat(64), previousReview: null }, null);
    const schema = z.fromJSONSchema(context.outputSchema as z.core.JSONSchema.JSONSchema);
    const proposal = demonstrationPlan(project); const shot = proposal.shots[0]!;
    const valid = { ...proposal, shots: [{ ...shot, propIds: ['ref-prop:reference'], continuityBefore: [{ assetId: 'ref-location:reference', state: '밝은 작업대' }], continuityAfter: [{ assetId: 'ref-prop:reference', state: '물뿌리개를 내려놓음' }] }] };
    expect(schema.safeParse(valid).success).toBe(true);
    expect(compileAutomaticSegmentPlan(project, basis, valid, [stagedPlanSpeech(project)], [], { ...automaticPlanProvenance(), generationId: 'scoped-cuts' }, 32).project.shots.some((value): boolean => value.propIds.includes('ref-prop:reference'))).toBe(true);
    for (const id of [project.productionPlan!.resources[1]!.id, 'other-segment:reference', 'ref-location:reference']) {
      expect(schema.safeParse({ ...valid, shots: [{ ...valid.shots[0]!, propIds: [id] }] }).success).toBe(false);
    }
    for (const id of [project.productionPlan!.resources[1]!.id, 'other-segment:reference']) {
      const invalid = { ...valid, shots: [{ ...valid.shots[0]!, continuityBefore: [{ assetId: id, state: '검토' }] }] };
      expect(schema.safeParse(invalid).success).toBe(false);
      expect(() => compileAutomaticSegmentPlan(project, basis, invalid, [stagedPlanSpeech(project)], [], { ...automaticPlanProvenance(), generationId: 'invalid-cuts' }, 32))
        .toThrowError(expect.objectContaining({ code: 'AUTOMATION_PRODUCTION_REFERENCE_SCOPE', message: expect.stringContaining('ref-prop:reference') }));
    }
    expect(context.prompt).toContain(JSON.stringify({ resourceId: project.productionPlan!.resources[1]!.id, referenceAssetId: 'ref-prop:reference', kind: 'prop' }));
    const otherContext = automaticSegmentContext(project, createSegmentPlanBasis(project, 'SEG-001', ['shot-1']), [], [], null, 32, { fontSha256: 'a'.repeat(64), previousReview: null }, null);
    const otherSchema = z.fromJSONSchema(otherContext.outputSchema as z.core.JSONSchema.JSONSchema);
    expect(otherSchema.safeParse(valid).success).toBe(false);
  });

  it('기준 자산이 없는 구간은 빈 목록을 허용하고 자산 ID 생성을 거부한다', async (): Promise<void> => {
    const project = await automaticPlanProject(); const before = structuredClone(project);
    const context = automaticSegmentContext(project, createSegmentPlanBasis(project, 'demonstration', ['shot-2']), [], [], null, 32, { fontSha256: 'a'.repeat(64), previousReview: null }, null);
    const schema = z.fromJSONSchema(context.outputSchema as z.core.JSONSchema.JSONSchema);
    const proposal = demonstrationPlan(project);
    expect(schema.safeParse(proposal).success).toBe(true);
    expect(schema.safeParse({ ...proposal, shots: [{ ...proposal.shots[0]!, propIds: ['invented'] }] }).success).toBe(false);
    expect(schema.safeParse({ ...proposal, shots: [{ ...proposal.shots[0]!, continuityAfter: [{ assetId: 'invented', state: '검토' }] }] }).success).toBe(false);
    expect(project).toEqual(before);
  });

  it('늦은 구간의 최신 의상을 앞 구간에 재사용하지 않는다', async (): Promise<void> => {
    const source = await automaticPlanProject(); const plan = productionPlan(source);
    const person = source.dataset.people[0]!;
    plan.resources = ['earlier', 'later'].map((key, index) => ({ key, kind: 'character', subjectId: person.id, name: person.name, description: index === 0 ? '흰 셔츠' : '검은 코트', reason: '구간별 의상 제작 제안', sourceRefs: person.sourceRefs, sourceUnitIds: [], referenceAssetId: null }));
    plan.segments = ['SEG-001', 'demonstration'].map((segmentId, index) => ({ ...plan.segments[0]!, segmentId, resourceKeys: [index === 0 ? 'earlier' : 'later'], locationResourceKey: null }));
    let project = compileAutomaticProductionPlan(source, createProductionPlanBasis(source, ['SEG-001', 'demonstration']), plan, automaticPlanProvenance()).project;
    const image = await imageResult(project);
    for (const index of [1, 0]) {
      const resourceId = project.productionPlan!.resources[index]!.id;
      const basis = createProductionReferenceBasis(project, resourceId);
      expect(basis.referenceAssetIds).toEqual([]);
      project = (await compileAutomaticReference(project, basis, image, { ...automaticPlanProvenance(), generationId: `outfit-${index}`, model: image.model, turnId: image.turnId })).project;
    }
    const firstShot = { ...project.shots[0]!, presence: [{ personId: person.id, mode: 'VISIBLE' as const }] };
    expect(currentVisualReferenceAssets(project, firstShot).map((asset): string => asset.id)).toEqual(['outfit-0:reference']);
    const earlyBasis = createProductionReferenceBasis(project, project.productionPlan!.resources[0]!.id);
    expect(earlyBasis.referenceAssetIds).toEqual([]);
    const laterBasis = createProductionReferenceBasis(project, project.productionPlan!.resources[1]!.id);
    expect(laterBasis.referenceAssetIds).toEqual(['outfit-0:reference']);
    const withContinuity: Project = { ...project, shots: project.shots.map((shot, index) => index === 0 ? { ...firstShot,
      continuityBefore: [{ assetId: 'outfit-0:reference', state: '흰 셔츠 착용' }], continuityAfter: [{ assetId: 'outfit-0:reference', state: '흰 셔츠 착용' }] } : shot) };
    const regenerated = await compileAutomaticReference(withContinuity, createProductionReferenceBasis(withContinuity, project.productionPlan!.resources[0]!.id), image,
      { ...automaticPlanProvenance(), generationId: 'regenerated-outfit', model: image.model, turnId: image.turnId });
    expect(regenerated.project.assets.slice(0, 2)).toEqual(project.assets);
    expect(regenerated.project.generationRecords.slice(0, project.generationRecords.length)).toEqual(project.generationRecords);
    expect(regenerated.project.shots[0]?.continuityBefore).toEqual([{ assetId: 'regenerated-outfit:reference', state: '흰 셔츠 착용' }]);
    expect(currentVisualReferenceAssets(regenerated.project, regenerated.project.shots[0]!).map((asset): string => asset.id)).toEqual(['regenerated-outfit:reference']);
    expect(regenerated.project.productionPlan?.resources[1]?.referenceAssetId).toBe('outfit-1:reference');
  });

  it('같은 장소의 변형은 앞선 기본 공간 이미지와 구조 유지 지시를 함께 전달한다', async (): Promise<void> => {
    const source = await automaticPlanProject(); const plan = productionPlan(source);
    plan.resources = ['day', 'night'].map((key, index) => ({ ...plan.resources[0]!, key, description: index === 0 ? '왼쪽 창문과 나무 작업대' : '같은 작업대를 밤 조명으로 표현' }));
    plan.segments = ['SEG-001', 'demonstration'].map((segmentId, index) => ({ ...plan.segments[0]!, segmentId, resourceKeys: [index === 0 ? 'day' : 'night'], locationResourceKey: index === 0 ? 'day' : 'night' }));
    const planned = compileAutomaticProductionPlan(source, createProductionPlanBasis(source, ['SEG-001', 'demonstration']), plan, automaticPlanProvenance()).project;
    const image = await imageResult(planned); const firstId = planned.productionPlan!.resources[0]!.id;
    const current = (await compileAutomaticReference(planned, createProductionReferenceBasis(planned, firstId), image,
      { ...automaticPlanProvenance(), generationId: 'day-reference', model: image.model, turnId: image.turnId })).project;
    const before = structuredClone(current); const nextId = current.productionPlan!.resources[1]!.id;
    const basis = createProductionReferenceBasis(current, nextId);
    expect(basis.referenceAssetIds).toEqual(['day-reference:reference']);
    const engine = vi.fn(async (input: ImageGenerationInput): Promise<ImageGenerationResult> => {
      expect(input.references).toHaveLength(1); expect(input.references[0]?.bytes).toEqual(image.bytes);
      expect(input.references[0]?.label).toContain('벽·창문·출입구의 위치와 연결');
      expect(input.references[0]?.label).toContain('왼쪽 창문과 나무 작업대');
      expect(input.references[0]?.label).not.toContain('얼굴·체형');
      expect(input.prompt).toContain('밤 조명'); return image;
    });
    const result = await generateAutomaticReference(current, basis, [{ assetId: 'day-reference:reference', bytes: image.bytes }], generationOptions('night-reference'), { run: engine }, new AbortController().signal);
    expect(engine).toHaveBeenCalledOnce(); expect(current).toEqual(before);
    expect(result.project.assets.slice(0, current.assets.length)).toEqual(current.assets);
    expect(result.project.generationRecords.at(-1)?.referenceHashes).toContain(image.inspection.sha256);
    expect(JSON.parse(result.project.generationRecords.at(-1)!.prompt).basis.referenceAssetIds).toEqual(['day-reference:reference']);
    expect(result.project.frames.every((frame): boolean => frame.visualReview === 'pending')).toBe(true);
  });

  it('공간 기준은 미래 상태·다른 장소·독립 제작 세트에서 자동 차용하지 않는다', async (): Promise<void> => {
    const source = await automaticPlanProject(); const plan = productionPlan(source);
    plan.resources = ['earlier', 'later'].map((key) => ({ ...plan.resources[0]!, key }));
    plan.segments = ['SEG-001', 'demonstration'].map((segmentId, index) => ({ ...plan.segments[0]!, segmentId, resourceKeys: [index === 0 ? 'earlier' : 'later'], locationResourceKey: index === 0 ? 'earlier' : 'later' }));
    let project = compileAutomaticProductionPlan(source, createProductionPlanBasis(source, ['SEG-001', 'demonstration']), plan, automaticPlanProvenance()).project;
    const image = await imageResult(project);
    for (const index of [1, 0]) {
      const basis = createProductionReferenceBasis(project, project.productionPlan!.resources[index]!.id);
      expect(basis.referenceAssetIds).toEqual([]);
      project = (await compileAutomaticReference(project, basis, image, { ...automaticPlanProvenance(), generationId: `room-${index}`, model: image.model, turnId: image.turnId })).project;
    }
    const earlier = project.productionPlan!.resources[0]!; const later = project.productionPlan!.resources[1]!;
    for (const resources of [
      [{ ...earlier, sourceUnitIds: [source.dataset.units[0]!.id] }, later],
      [{ ...earlier, subjectId: null }, later],
      [{ ...earlier, subjectId: null }, { ...later, subjectId: null }],
      [{ ...earlier, kind: 'prop' as const, subjectId: null }, { ...later, kind: 'prop' as const, subjectId: null }],
    ]) {
      const candidate: Project = { ...project, productionPlan: { ...project.productionPlan!, resources } };
      expect(createProductionReferenceBasis(candidate, later.id).referenceAssetIds).toEqual([]);
    }
    const inactive: Project = { ...project, productionPlan: { ...project.productionPlan!, segments: project.productionPlan!.segments.slice(1) } };
    expect(createProductionReferenceBasis(inactive, later.id).referenceAssetIds).toEqual([]);
  });

  it('모델 보정 횟수와 취소를 지키며 선택 입력 스냅샷을 보존한다', async (): Promise<void> => {
    const project = await automaticPlanProject(); const basis = createProductionPlanBasis(project, ['demonstration']); const plan = productionPlan(project);
    const options = { maxCorrections: 1, provenance: generationOptions('production-planner') }; const controller = new AbortController();
    const model = vi.fn().mockResolvedValueOnce({ model: 'fixture', turnId: 'first', result: { invalid: true } }).mockResolvedValueOnce({ model: 'fixture', turnId: 'second', result: plan });
    const progress = vi.fn(async (): Promise<void> => {});
    const result = await planAutomaticProduction(project, basis, options, { model: { run: model }, onProgress: progress }, controller.signal);
    expect(model).toHaveBeenCalledTimes(2); expect(result.project.productionPlan?.segments).toHaveLength(1); expect(project.productionPlan).toBeNull();
    expect(model.mock.calls[1]?.[0].prompt).toContain('AUTOMATION_PRODUCTION_SCHEMA');
    const cancelled = new AbortController();
    await expect(planAutomaticProduction(project, basis, options, { model: { run: model }, onProgress: async (): Promise<void> => { cancelled.abort(); } }, cancelled.signal)).rejects.toMatchObject({ code: 'AUTOMATION_CANCELLED' });
    expect(model).toHaveBeenCalledTimes(2);
    expect(automaticProductionContext(project, basis, null).prompt).not.toContain('assets/');
  });

  it('이전 저장본의 원본과 자산을 보존하고 제작 계획을 임의로 복원하지 않는다', async (): Promise<void> => {
    const project = await automaticPlanProject(); const { productionPlan: _plan, textLayout: _textLayout, textReadability: _textReadability, textLayoutControl: _control, ...withoutPlan } = project;
    const legacy = { ...withoutPlan, schemaVersion: '1.10.0' }; const snapshot = structuredClone(legacy);
    expect(parseProject(legacy)).toEqual({ ...project, schemaVersion: '1.23.0', productionPlan: null, textLayoutControl: { version: '1.0.0', mode: 'manual', plannedInputHash: null } });
    expect(legacy).toEqual(snapshot);
    expect(() => parseProject({ ...legacy, productionPlan: { unknown: '보존해야 할 자료' } })).toThrowError(expect.objectContaining({ code: 'UNSUPPORTED_LEGACY_PRODUCTION_PLAN' }));
  });

  it('원본 갱신에서 기준 자원은 보존하고 변경 구간의 제작 연결만 다시 계획한다', async (): Promise<void> => {
    const original = await automaticPlanProject();
    const planned = compileAutomaticProductionPlan(original, createProductionPlanBasis(original, ['demonstration']), productionPlan(original), automaticPlanProvenance()).project;
    expect(applySourceUpdate(planned, original, 'same-source').productionPlan).toEqual(planned.productionPlan);
    const incoming: Project = { ...original, dataset: { ...original.dataset, units: original.dataset.units.map((unit) => unit.id === '동작' ? { ...unit, text: '작은 물뿌리개를 양손으로 잡고 천천히 물을 준다.' } : unit) } };
    const next = applySourceUpdate(planned, incoming, 'changed-source');
    expect(next.productionPlan?.resources).toEqual(planned.productionPlan?.resources);
    expect(next.productionPlan?.segments).toEqual([]);
    expect(next.generationRecords).toEqual(planned.generationRecords);
    expect(createProductionPlanBasis(next, ['demonstration']).segmentIds).toEqual(['demonstration']);
    expect(() => createProductionReferenceBasis(next, next.productionPlan!.resources[0]!.id)).toThrowError(expect.objectContaining({ code: 'AUTOMATION_INACTIVE_RESOURCE' }));
  });
});

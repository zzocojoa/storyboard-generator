import { describe, expect, it, vi } from 'vitest';
import { compileAutomaticProductionPlan } from '../src/automation/production-compiler.js';
import { automaticProductionContext } from '../src/automation/production-context.js';
import { createProductionPlanBasis } from '../src/automation/production-basis.js';
import { createProductionReferenceBasis, generateAutomaticReference } from '../src/automation/production-reference.js';
import { orderProductionReferences } from '../src/automation/production-reference-order.js';
import { assertReferenceRetakeIntent, createReferenceRetakeIntent } from '../src/automation/reference-retake.js';
import type { ImageGenerationInput } from '../src/codex/image-engine.js';
import { propContinuityCandidates, propContinuityIssues } from '../src/domain/prop-continuity.js';
import type { Project } from '../src/domain/schema.js';
import { sourceImpact } from '../src/domain/source-update.js';
import { parseProject } from '../src/io/project.js';
import { automaticPlanProject, automaticPlanProvenance } from './automatic-plan-helpers.js';
import { propTestImage, twoPropCandidate, twoPropPlan } from './prop-continuity-helpers.js';

describe('명시적 소품 기준 연결', (): void => {
  it('prop_continuity_plan_resolves_new_keys_and_orders_reference_dependencies', async (): Promise<void> => {
    const source = await automaticPlanProject(); const plan = twoPropPlan(source);
    plan.resources[1] = { ...plan.resources[1]!, propContinuity: { resourceKey: 'paper-0', reason: '같은 물건의 다음 화면' } };
    const basis = createProductionPlanBasis(source, ['SEG-001', 'demonstration']);
    const before = structuredClone(source);
    const current = compileAutomaticProductionPlan(source, basis, plan, automaticPlanProvenance()).project;
    const [base, target] = current.productionPlan!.resources;
    expect(target!.propContinuity).toEqual({ resourceId: base!.id, reason: '같은 물건의 다음 화면' });
    expect(orderProductionReferences(current, [target!, base!]).map((resource): string => resource.id)).toEqual([base!.id, target!.id]);
    expect(() => orderProductionReferences(current, [target!])).toThrowError(expect.objectContaining({ code: 'AUTOMATION_PROP_REFERENCE_REQUIRED' }));
    expect(() => createProductionReferenceBasis(current, target!.id)).toThrowError(expect.objectContaining({ code: 'AUTOMATION_PROP_REFERENCE_REQUIRED' }));
    expect(automaticProductionContext(source, basis, null).prompt).toContain('이름 유사성만으로 연결');
    expect(source).toEqual(before); expect(parseProject(current)).toEqual(current);
    const firstPlan = { ...plan, resources: [plan.resources[0]!], segments: [plan.segments[0]!] };
    const first = compileAutomaticProductionPlan(source, createProductionPlanBasis(source, ['SEG-001']), firstPlan, automaticPlanProvenance()).project;
    const previousId = first.productionPlan!.resources[0]!.id;
    const laterPlan = { ...plan, resources: [{ ...plan.resources[1]!, propContinuity: { resourceKey: previousId, reason: '이전 배치의 같은 물건' } }], segments: [plan.segments[1]!] };
    const later = compileAutomaticProductionPlan(first, createProductionPlanBasis(first, ['demonstration']), laterPlan, { ...automaticPlanProvenance(), generationId: 'later-batch' }).project;
    expect(later.productionPlan!.resources[1]?.propContinuity?.resourceId).toBe(previousId);
  });

  it('prop_continuity_rejects_foreign_future_cyclic_and_wrong_kind_links', async (): Promise<void> => {
    const source = await automaticPlanProject(); const plan = twoPropPlan(source);
    const basis = createProductionPlanBasis(source, ['SEG-001', 'demonstration']);
    for (const resourceKey of ['missing', 'paper-1']) {
      const invalid = { ...plan, resources: plan.resources.map((resource, index) => index === 1 ? { ...resource, propContinuity: { resourceKey, reason: '검증' } } : resource) };
      expect(() => compileAutomaticProductionPlan(source, basis, invalid, automaticPlanProvenance())).toThrowError(expect.objectContaining({ code: 'AUTOMATION_PRODUCTION_INVALID' }));
    }
    const current = (await twoPropCandidate(source)).project; const [base, target] = current.productionPlan!.resources;
    expect(propContinuityIssues(current, base!, { resourceId: target!.id, reason: '미래 연결' })).not.toEqual([]);
    const cyclic: Project = { ...current, productionPlan: { ...current.productionPlan!, resources: [{ ...base!, propContinuity: { resourceId: target!.id, reason: '순환' } }, target!] } };
    expect(propContinuityIssues(cyclic, target!, { resourceId: base!.id, reason: '순환' })[0]?.message).toContain('순환');
    expect(propContinuityIssues(current, { ...target!, kind: 'character' }, { resourceId: base!.id, reason: '다른 종류' })).not.toEqual([]);
    expect(propContinuityCandidates(current, base!)).toEqual([]);
    expect(propContinuityCandidates(current, target!).map((resource): string => resource.id)).toEqual([base!.id]);
    const sameSegment: Project = { ...current, productionPlan: { ...current.productionPlan!, resources: [{ ...base!, sourceUnitIds: ['효과음'] }, { ...target!, sourceUnitIds: ['동작'] }],
      segments: current.productionPlan!.segments.map((segment) => ({ ...segment, resourceIds: segment.segmentId === 'demonstration' ? [base!.id, target!.id] : [] })) } };
    expect(propContinuityIssues(sameSegment, sameSegment.productionPlan!.resources[1]!, { resourceId: base!.id, reason: '같은 구간의 뒤 상태' })).not.toEqual([]);
  });

  it('prop_continuity_retake_passes_verified_base_bytes_and_commits_only_with_new_image', async (): Promise<void> => {
    const prepared = await twoPropCandidate(await automaticPlanProject()); const project = prepared.project;
    const [base, target] = project.productionPlan!.resources; const before = structuredClone(project);
    const propContinuity = { resourceId: base!.id, reason: '앞에서 보여 준 같은 종이를 펼친다는 현재 원문 확인' };
    const intent = createReferenceRetakeIntent(project, { resourceId: target!.id, propContinuity });
    const basis = assertReferenceRetakeIntent(project, intent); const result = await propTestImage(project);
    expect(basis.referenceAssetIds).toEqual([base!.referenceAssetId]);
    const engine = vi.fn(async (input: ImageGenerationInput) => {
      expect(input.references).toHaveLength(1); expect(input.references[0]?.bytes).toEqual(result.bytes);
      expect(input.references[0]?.label).toContain('판형·비율·색상·재질·표 구획'); expect(input.references[0]?.label).not.toContain('얼굴·체형');
      expect(input.prompt).toContain(propContinuity.reason); return result;
    });
    const { model: _model, prompt: _prompt, turnId: _turnId, ...provenance } = automaticPlanProvenance();
    const candidate = await generateAutomaticReference(project, basis, [{ assetId: base!.referenceAssetId!, bytes: result.bytes }],
      { ...provenance, generationId: 'prop-continuity-retake' }, { run: engine }, new AbortController().signal);
    expect(engine).toHaveBeenCalledOnce(); expect(project).toEqual(before);
    expect(candidate.project.productionPlan!.resources[0]).toEqual(base);
    expect(candidate.project.productionPlan!.resources[1]?.propContinuity).toEqual(propContinuity);
    expect(candidate.project.assets.slice(0, project.assets.length)).toEqual(project.assets);
    expect(candidate.project.generationRecords.slice(0, project.generationRecords.length)).toEqual(project.generationRecords);
    expect(candidate.project.generationRecords.at(-1)?.referenceHashes).toContain(result.inspection.sha256);
    expect(candidate.project.dataset).toEqual(project.dataset); expect(candidate.project.audioCues).toEqual(project.audioCues);
    expect(candidate.project.textCues).toEqual(project.textCues); expect(candidate.project.frames.every((frame): boolean => frame.visualReview === 'pending')).toBe(true);
    expect(parseProject(candidate.project)).toEqual(candidate.project);
  });

  it('prop_continuity_retake_rechecks_selection_and_preserves_protected_shots_on_failure', async (): Promise<void> => {
    const project = (await twoPropCandidate(await automaticPlanProject())).project; const [base, target] = project.productionPlan!.resources;
    const input = { resourceId: target!.id, propContinuity: { resourceId: base!.id, reason: '같은 물건 확인' } };
    const intent = createReferenceRetakeIntent(project, input);
    expect(() => assertReferenceRetakeIntent(project, { ...intent, propContinuity: { ...input.propContinuity, reason: '변경된 근거' } })).toThrowError(expect.objectContaining({ code: 'AUTOMATION_REFERENCE_RETAKE_STALE' }));
    const protectedProject: Project = { ...project, shots: project.shots.map((shot) => shot.segmentId === 'demonstration' ? { ...shot, approvalStatus: 'approved' } : shot) };
    expect(() => createReferenceRetakeIntent(protectedProject, input)).toThrowError(expect.objectContaining({ code: 'AUTOMATION_PROTECTED_REFERENCE' }));
    const changed: Project = { ...project, productionPlan: { ...project.productionPlan!, resources: [{ ...base!, referenceAssetId: target!.referenceAssetId }, target!] } };
    expect(() => assertReferenceRetakeIntent(changed, intent)).toThrowError(expect.objectContaining({ code: 'AUTOMATION_REFERENCE_RETAKE_STALE' }));
    expect(project.productionPlan!.resources[1]).not.toHaveProperty('propContinuity');
  });

  it('prop_continuity_source_update_includes_indirect_resource_evidence', async (): Promise<void> => {
    const original = (await twoPropCandidate(await automaticPlanProject())).project;
    const [base, target] = original.productionPlan!.resources;
    const unit = original.dataset.units.find((value): boolean => value.segmentId === 'SEG-001')!;
    const project: Project = { ...original, productionPlan: { ...original.productionPlan!, resources: [{ ...base!, sourceUnitIds: [unit.id] },
      { ...target!, propContinuity: { resourceId: base!.id, reason: '앞선 원형 유지' } }] } };
    const incoming: Project = { ...project, dataset: { ...project.dataset, units: project.dataset.units.map((value) => value.id === unit.id ? { ...value, text: `${value.text} 변경` } : value) } };
    expect(sourceImpact(project, incoming).impactedSegmentIds).toEqual(expect.arrayContaining(['SEG-001', 'demonstration']));
    const segmentChanged: Project = { ...project, dataset: { ...project.dataset, segments: project.dataset.segments.map((segment) => segment.id === 'SEG-001' ? { ...segment, endMs: segment.endMs - 1 } : segment) } };
    expect(sourceImpact(project, segmentChanged).impactedSegmentIds).toEqual(expect.arrayContaining(['SEG-001', 'demonstration']));
    const lateUnit = original.dataset.units.find((value): boolean => value.segmentId === 'demonstration')!;
    const future: Project = { ...project, productionPlan: { ...project.productionPlan!, resources: [{ ...base!, sourceUnitIds: [lateUnit.id] }, target!] } };
    expect(propContinuityIssues(future, base!, { resourceId: target!.id, reason: '미래 상태' })).not.toEqual([]);
  });

  it('prop_continuity_legacy_migration_preserves_absent_links_and_rejects_fabricated_evidence', async (): Promise<void> => {
    const project = (await twoPropCandidate(await automaticPlanProject())).project;
    const legacy = { ...project, schemaVersion: '1.23.0' }; const bytes = JSON.stringify(legacy);
    expect(parseProject(legacy)).toEqual(project); expect(JSON.stringify(legacy)).toBe(bytes);
    expect(() => parseProject({ ...legacy, productionPlan: { ...legacy.productionPlan!, resources: legacy.productionPlan!.resources.map((resource) => ({ ...resource, propContinuity: { resourceId: 'invented', reason: '거짓 연결' } })) } }))
      .toThrowError(expect.objectContaining({ code: 'UNSUPPORTED_LEGACY_PROP_CONTINUITY' }));
  });
});

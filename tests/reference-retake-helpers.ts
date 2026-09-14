import sharp from 'sharp';
import { createProductionPlanBasis } from '../src/automation/production-basis.js';
import { compileAutomaticProductionPlan } from '../src/automation/production-compiler.js';
import { compileAutomaticReference, createProductionReferenceBasis } from '../src/automation/production-reference.js';
import type { AutomaticReferenceCandidate } from '../src/automation/production-reference.js';
import { inspectImageBytes } from '../src/domain/media-inspection.js';
import type { Project } from '../src/domain/schema.js';
import { automaticPlanProvenance } from './automatic-plan-helpers.js';

/** 실제 파일 검사에 사용하는 합성 기준 한 장을 한 번의 저장 후보로 준비한다. */
export async function referenceRetakeCandidate(source: Project): Promise<AutomaticReferenceCandidate> {
  const project = compileAutomaticProductionPlan(source, createProductionPlanBasis(source, ['demonstration']), {
    schemaVersion: '1.1.0', profile: { ...source.profile, medium: 'ai', visualStyle: '밝은 연필 콘티' }, profileReason: '화분 시연용 합성 제작 기준',
    resources: [{ key: 'bench', kind: 'location', subjectId: 'workbench', name: '밝은 작업대', description: '왼쪽 창문 앞의 나무 작업대', reason: '화분 시연 장소', sourceRefs: source.dataset.locations[0]!.sourceRefs, sourceUnitIds: [], referenceAssetId: null, propContinuity: null }],
    segments: [{ segmentId: 'demonstration', resourceKeys: ['bench'], locationResourceKey: 'bench', continuityGroup: 'plant', entryState: '나무 작업대', exitState: '같은 작업대', reason: '원본 장소 유지' }],
  }, automaticPlanProvenance()).project;
  const bytes = await sharp({ create: { width: project.profile.aspectWidth * 10, height: project.profile.aspectHeight * 10, channels: 3, background: '#bdc9a9' } }).png().toBuffer();
  return compileAutomaticReference(project, createProductionReferenceBasis(project, project.productionPlan!.resources[0]!.id),
    { model: 'test-image', turnId: 'first-reference', itemId: 'first-image', revisedPrompt: null, bytes, inspection: await inspectImageBytes(bytes, 'image/png') },
    { ...automaticPlanProvenance(), model: 'test-image', turnId: 'first-reference', generationId: 'first-reference' });
}

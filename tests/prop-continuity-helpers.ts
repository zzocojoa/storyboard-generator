import sharp from 'sharp';
import { compileAutomaticProductionPlan } from '../src/automation/production-compiler.js';
import { createProductionPlanBasis } from '../src/automation/production-basis.js';
import type { AutomaticProductionPlan } from '../src/automation/production-schema.js';
import { compileAutomaticReference, createProductionReferenceBasis } from '../src/automation/production-reference.js';
import type { AutomaticReferenceCandidate } from '../src/automation/production-reference.js';
import type { ImageGenerationResult } from '../src/codex/image-engine.js';
import { inspectImageBytes } from '../src/domain/media-inspection.js';
import type { Project } from '../src/domain/schema.js';
import { automaticPlanProvenance } from './automatic-plan-helpers.js';

export function twoPropPlan(source: Project): AutomaticProductionPlan {
  return { schemaVersion: '1.1.0', profile: { ...source.profile, medium: 'ai', visualStyle: '연필 콘티' }, profileReason: '구간마다 같은 소품을 보여 주는 합성 검증',
    resources: ['앞선 종이', '뒤 구간 종이'].map((name, index) => ({ key: `paper-${index}`, kind: 'prop', subjectId: null, name,
      description: index === 0 ? '가로로 긴 종이, 같은 폭의 다섯 칸' : '같은 종이를 현재 조명 아래 펼침', reason: '원문에 연결한 제작용 종이',
      sourceRefs: source.dataset.locations[0]!.sourceRefs, sourceUnitIds: [], referenceAssetId: null, propContinuity: null })),
    segments: ['SEG-001', 'demonstration'].map((segmentId, index) => ({ segmentId, resourceKeys: [`paper-${index}`], locationResourceKey: null,
      continuityGroup: 'table', entryState: '종이 놓임', exitState: '종이 유지', reason: '현재 구간의 소품 검토' })) };
}

export async function propTestImage(project: Project): Promise<ImageGenerationResult> {
  const bytes: Buffer = await sharp({ create: { width: project.profile.aspectWidth * 10, height: project.profile.aspectHeight * 10, channels: 3, background: '#c7cabf' } }).png().toBuffer();
  return { model: 'test-image', turnId: 'prop-image-turn', itemId: 'prop-image', revisedPrompt: null, bytes, inspection: await inspectImageBytes(bytes, 'image/png') };
}

/** 기존 기준 두 장과 바이트를 함께 준비하여 실제 저장·재생성 경로를 검증한다. */
export async function twoPropCandidate(source: Project): Promise<AutomaticReferenceCandidate> {
  const plan = twoPropPlan(source);
  let project = compileAutomaticProductionPlan(source, createProductionPlanBasis(source, plan.segments.map((segment): string => segment.segmentId)), plan, automaticPlanProvenance()).project;
  const image = await propTestImage(source); const writes: AutomaticReferenceCandidate['writes'] = [];
  for (const resource of project.productionPlan!.resources) {
    const candidate = await compileAutomaticReference(project, createProductionReferenceBasis(project, resource.id), image,
      { ...automaticPlanProvenance(), generationId: `${resource.id}:image`, model: image.model, turnId: image.turnId });
    project = candidate.project; writes.push(...candidate.writes);
  }
  return { project, writes, basis: createProductionReferenceBasis(project, project.productionPlan!.resources[1]!.id) };
}

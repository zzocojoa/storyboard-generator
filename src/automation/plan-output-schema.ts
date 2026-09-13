import { z } from 'zod';
import { ContinuitySchema, IdSchema } from '../domain/schema.js';
import type { Asset } from '../domain/schema.js';
import type { JsonValue } from '../io/stable-json.js';
import { AutomaticSegmentPlanSchema, AutomaticShotSchema } from './plan-schema.js';

/** 제작 자원 ID와 실제 이미지 자산 ID를 혼동하지 않도록 현재 구간의 자산만 출력 후보로 제공한다. */
export function automaticSegmentOutputSchema(references: readonly Asset[]): JsonValue {
  const propIds: string[] = references.filter((asset): boolean => asset.kind === 'prop').map((asset): string => asset.id);
  const continuityIds: string[] = references.filter((asset): boolean => ['character', 'location', 'prop'].includes(asset.kind)).map((asset): string => asset.id);
  const props = z.array(propIds.length === 0 ? IdSchema : z.enum(propIds)).max(propIds.length === 0 ? 0 : 64)
    .describe('현재 구간 referenceAssets 중 kind=prop인 실제 자산의 id. productionPlan.resourceIds는 사용할 수 없다.');
  const continuity = z.array(ContinuitySchema.extend({ assetId: continuityIds.length === 0 ? IdSchema : z.enum(continuityIds) }))
    .max(continuityIds.length === 0 ? 0 : 64)
    .describe('현재 구간 referenceAssets 중 인물·장소·소품 이미지의 실제 id와 상태. 제작 자원 ID나 인물 ID를 assetId에 넣지 않는다.');
  const shot = AutomaticShotSchema.extend({ propIds: props, continuityBefore: continuity, continuityAfter: continuity });
  return z.json().parse(z.toJSONSchema(AutomaticSegmentPlanSchema.extend({ shots: z.array(shot).min(1).max(64) })));
}

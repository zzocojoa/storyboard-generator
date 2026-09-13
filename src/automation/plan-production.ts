import { z } from 'zod';
import type { StructuredGenerationEngine, StructuredGenerationResult } from '../codex/structured-engine.js';
import { contractError } from '../domain/errors.js';
import type { Project } from '../domain/schema.js';
import { AutomaticPlanProvenanceSchema } from './plan-compiler.js';
import type { AutomaticPlanProvenance } from './plan-compiler.js';
import type { PlanCorrection } from './plan-context.js';
import { assertProductionPlanBasis } from './production-basis.js';
import { compileAutomaticProductionPlan } from './production-compiler.js';
import type { AutomaticProductionCandidate } from './production-compiler.js';
import { automaticProductionContext } from './production-context.js';
import type { ProductionPlanBasis } from './production-schema.js';

export type ProductionPlanOptions = { maxCorrections: number; provenance: Omit<AutomaticPlanProvenance, 'model' | 'turnId' | 'prompt'> };
export type ProductionPlanProgress = { phase: 'planning' | 'correction' | 'validated'; attempt: number; message: string };
export type ProductionPlanServices = { model: StructuredGenerationEngine; onProgress: (progress: ProductionPlanProgress) => Promise<void> };

function assertRunning(signal: AbortSignal): void {
  if (signal.aborted) throw contractError('AUTOMATION_CANCELLED', '제작 기준 계획이 취소되었습니다. 프로젝트는 변경하지 않았습니다.', []);
}

function productionCorrection(error: unknown, output: StructuredGenerationResult | null): PlanCorrection | null {
  if (error instanceof z.ZodError) return { code: 'AUTOMATION_PRODUCTION_SCHEMA', message: error.message, previousOutput: output?.result ?? null };
  if (!(error instanceof Error) || !('code' in error) || typeof error.code !== 'string') return null;
  if (!['AUTOMATION_PRODUCTION_PROFILE', 'AUTOMATION_PRODUCTION_SCOPE', 'AUTOMATION_PRODUCTION_RESOURCE', 'AUTOMATION_PRODUCTION_INVALID', 'CODEX_PLAN_INVALID_JSON'].includes(error.code)) return null;
  return { code: error.code, message: error.message, previousOutput: output?.result ?? null };
}

/** 원본에 결속된 제작 계획만 반환하며 취소·오래된 입력·권한 오류는 모델 보정으로 반복하지 않는다. */
export async function planAutomaticProduction(inputProject: Project, inputBasis: ProductionPlanBasis, inputOptions: ProductionPlanOptions, services: ProductionPlanServices, signal: AbortSignal): Promise<AutomaticProductionCandidate> {
  const project: Project = structuredClone(inputProject);
  const basis: ProductionPlanBasis = structuredClone(inputBasis);
  const options: ProductionPlanOptions = structuredClone(inputOptions);
  z.number().int().min(0).max(3).parse(options.maxCorrections);
  AutomaticPlanProvenanceSchema.omit({ model: true, turnId: true, prompt: true }).parse(options.provenance);
  assertProductionPlanBasis(project, basis);
  let correction: PlanCorrection | null = null;
  for (let attempt: number = 0; attempt <= options.maxCorrections; attempt += 1) {
    assertRunning(signal);
    const context = automaticProductionContext(project, basis, correction);
    await services.onProgress({ phase: 'planning', attempt, message: '제작 프로필·인물·공간·소품과 구간 연속성 계획' });
    assertRunning(signal);
    let output: StructuredGenerationResult | null = null;
    let candidate: AutomaticProductionCandidate;
    try {
      output = await services.model.run(context, signal);
      assertRunning(signal);
      candidate = compileAutomaticProductionPlan(project, basis, output.result, { ...options.provenance, model: output.model, turnId: output.turnId, prompt: context.prompt });
    } catch (error: unknown) {
      const next = productionCorrection(error, output);
      if (next === null || attempt === options.maxCorrections) throw error;
      correction = next;
      await services.onProgress({ phase: 'correction', attempt: attempt + 1, message: `${next.code}: ${next.message}` });
      continue;
    }
    await services.onProgress({ phase: 'validated', attempt, message: '제작 기준 후보 검증 완료' });
    assertRunning(signal);
    return candidate;
  }
  throw contractError('AUTOMATION_PLAN_ATTEMPTS_EXHAUSTED', '제작 기준 계획 시도 횟수를 초과했습니다.', []);
}

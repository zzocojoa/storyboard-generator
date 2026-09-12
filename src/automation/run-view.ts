import { z } from 'zod';
import { AutomationPurposeSchema, AutomationSettingsSchema, AutomationTaskSchema } from './run-schema.js';
import type { AutomationRun } from './run-schema.js';

export const AutomationViewSchema = z.strictObject({
  id: z.uuid(), projectId: z.string(), revision: z.number().int().nonnegative(),
  status: z.enum(['running', 'paused', 'cancelled', 'needs-attention', 'review-ready']),
  createdAt: z.string(), updatedAt: z.string(), settings: AutomationSettingsSchema,
  purpose: AutomationPurposeSchema.optional(),
  segmentIds: z.array(z.string()), activeMs: z.number().nonnegative(), imageAttempts: z.number().int().nonnegative(), stagedBytes: z.number().nonnegative(),
  jobs: z.array(z.strictObject({ id: z.uuid(), task: AutomationTaskSchema, attempts: z.number().int().nonnegative(),
    status: z.enum(['pending', 'running', 'prepared', 'applying', 'completed', 'failed', 'interrupted']) })),
  problem: z.strictObject({ code: z.string(), message: z.string() }).nullable(),
  workerActive: z.boolean(), progress: z.string().nullable(), serviceError: z.strictObject({ code: z.string(), message: z.string() }).nullable(),
});
export type AutomationView = z.infer<typeof AutomationViewSchema>;
export const AutomationOverviewSchema = z.strictObject({ configured: z.boolean(), recommendedSettings: AutomationSettingsSchema.nullable(), runs: z.array(AutomationViewSchema) });
export type AutomationOverview = z.infer<typeof AutomationOverviewSchema>;

export function automationView(run: AutomationRun, workerActive: boolean, progress: string | null, serviceError: AutomationView['serviceError']): AutomationView {
  return { id: run.id, projectId: run.projectId, revision: run.revision, status: run.status, createdAt: run.createdAt, updatedAt: run.updatedAt,
    ...(run.purpose === undefined ? {} : { purpose: run.purpose }),
    settings: run.settings, segmentIds: run.segmentIds, activeMs: run.activeMs, imageAttempts: run.imageAttempts, stagedBytes: run.stagedBytes,
    jobs: run.jobs.map((job) => ({ id: job.id, task: job.task, attempts: job.attempts.length, status: job.attempts.at(-1)?.status ?? 'pending' })),
    problem: run.problem, workerActive, progress, serviceError };
}

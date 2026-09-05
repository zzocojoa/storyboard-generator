import type { ContractError } from '../domain/errors.js';

export type JobKind = 'proposal' | 'image' | 'speech';
export type JobResult = { projectId: string; revision: number };
export type JobFailure = { code: string; message: string; issues: ContractError['issues'] };
export type JobRecord = {
  id: string; kind: JobKind; status: 'queued' | 'running' | 'succeeded' | 'failed';
  createdAt: string; updatedAt: string; result: JobResult | null; error: JobFailure | null;
};
export type JobQueue = {
  start(kind: JobKind, work: () => Promise<JobResult>): JobRecord;
  get(id: string): JobRecord | null;
};

function failure(error: unknown): JobFailure {
  if (!(error instanceof Error)) return { code: 'UNKNOWN_ERROR', message: String(error), issues: [] };
  const code: string = 'code' in error && typeof error.code === 'string' ? error.code : error.name;
  const issues: ContractError['issues'] = 'issues' in error && Array.isArray(error.issues) ? error.issues as ContractError['issues'] : [];
  return { code, message: error.message, issues };
}

export function createJobQueue(createId: () => string, now: () => string): JobQueue {
  const jobs: Map<string, JobRecord> = new Map<string, JobRecord>();
  return {
    start(kind: JobKind, work: () => Promise<JobResult>): JobRecord {
      const id: string = createId();
      const queued: JobRecord = { id, kind, status: 'queued', createdAt: now(), updatedAt: now(), result: null, error: null };
      jobs.set(id, queued);
      void Promise.resolve().then(async (): Promise<void> => {
        jobs.set(id, { ...queued, status: 'running', updatedAt: now() });
        try {
          const result: JobResult = await work();
          jobs.set(id, { ...queued, status: 'succeeded', updatedAt: now(), result, error: null });
        } catch (error: unknown) {
          jobs.set(id, { ...queued, status: 'failed', updatedAt: now(), result: null, error: failure(error) });
        }
      });
      return queued;
    },
    get(id: string): JobRecord | null {
      return jobs.get(id) ?? null;
    },
  };
}

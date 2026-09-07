import type { CodexRequest } from './schema.js';
import { contractError } from '../domain/errors.js';

export type CodexRequestMetrics = {
  totalRequests: number;
  completedRequests: number;
  failedRequests: number;
  pendingRequests: number;
  repeatedRequests: number;
  averageLatencyMs: number | null;
  maximumLatencyMs: number | null;
  apiCostUsd: null;
  costNote: string;
};

function requestLatency(request: CodexRequest): number {
  const latency: number = Date.parse(request.updatedAt) - Date.parse(request.createdAt);
  if (!Number.isSafeInteger(latency) || latency < 0) throw contractError('INVALID_CODEX_REQUEST_TIME', `${request.id}: 요청 종료 시각이 생성 시각보다 빠릅니다. createdAt=${request.createdAt}, updatedAt=${request.updatedAt}`, []);
  return latency;
}

/** Codex 요청 기록에서 완료 시간과 같은 대상의 반복 생성 횟수를 계산한다. */
export function codexRequestMetrics(requests: readonly CodexRequest[]): CodexRequestMetrics {
  const settled: CodexRequest[] = requests.filter((request: CodexRequest): boolean => request.status !== 'pending');
  const latencies: number[] = settled.map(requestLatency);
  const targetCounts: Map<string, number> = new Map<string, number>();
  for (const request of requests) {
    const key: string = `${request.kind}\u0000${request.projectId}\u0000${request.targetId}`;
    targetCounts.set(key, (targetCounts.get(key) ?? 0) + 1);
  }
  const repeatedRequests: number = [...targetCounts.values()].reduce((total: number, count: number): number => total + Math.max(0, count - 1), 0);
  return {
    totalRequests: requests.length,
    completedRequests: requests.filter((request: CodexRequest): boolean => request.status === 'completed').length,
    failedRequests: requests.filter((request: CodexRequest): boolean => request.status === 'failed').length,
    pendingRequests: requests.filter((request: CodexRequest): boolean => request.status === 'pending').length,
    repeatedRequests,
    averageLatencyMs: latencies.length === 0 ? null : Math.round(latencies.reduce((total: number, value: number): number => total + value, 0) / latencies.length),
    maximumLatencyMs: latencies.length === 0 ? null : Math.max(...latencies),
    apiCostUsd: null,
    costNote: 'Codex App 실행은 요청별 API 비용을 제공하지 않습니다.',
  };
}

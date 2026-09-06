import { describe, expect, it } from 'vitest';
import { codexRequestMetrics } from '../src/codex/metrics.js';
import type { CodexRequest } from '../src/codex/schema.js';

const requests: CodexRequest[] = [
  { id: '00000000-0000-4000-8000-000000000001', kind: 'image', projectId: 'project-a', targetId: 'frame-a', basisHash: '0'.repeat(64), status: 'completed', createdAt: '2026-09-06T00:00:00.000Z', updatedAt: '2026-09-06T00:00:02.000Z', resultRevision: 1, error: null },
  { id: '00000000-0000-4000-8000-000000000002', kind: 'image', projectId: 'project-a', targetId: 'frame-a', basisHash: '1'.repeat(64), status: 'failed', createdAt: '2026-09-06T00:00:03.000Z', updatedAt: '2026-09-06T00:00:07.000Z', resultRevision: null, error: { code: 'IMAGE_FAILED', message: '생성 실패' } },
  { id: '00000000-0000-4000-8000-000000000003', kind: 'speech', projectId: 'project-b', targetId: 'audio-a', basisHash: '2'.repeat(64), status: 'pending', createdAt: '2026-09-06T00:00:08.000Z', updatedAt: '2026-09-06T00:00:08.000Z', resultRevision: null, error: null },
];

describe('Codex 요청 파일럿 지표', (): void => {
  it('완료 지연과 같은 대상의 반복 생성을 프로젝트 범위에서 집계한다', (): void => {
    expect(codexRequestMetrics(requests)).toEqual({
      totalRequests: 3, completedRequests: 1, failedRequests: 1, pendingRequests: 1, repeatedRequests: 1,
      averageLatencyMs: 3000, maximumLatencyMs: 4000, apiCostUsd: null,
      costNote: 'Codex App 실행은 요청별 API 비용을 제공하지 않습니다.',
    });
  });

  it('완료된 요청이 없으면 지연을 미측정 상태로 둔다', (): void => {
    expect(codexRequestMetrics([requests[2] as CodexRequest])).toEqual(expect.objectContaining({ averageLatencyMs: null, maximumLatencyMs: null }));
  });

  it('종료 시각이 생성 시각보다 빠른 기록은 명시적으로 거부한다', (): void => {
    const invalid: CodexRequest = { ...(requests[0] as CodexRequest), updatedAt: '2026-09-05T23:59:59.000Z' };
    expect(() => codexRequestMetrics([invalid])).toThrowError(expect.objectContaining({ code: 'INVALID_CODEX_REQUEST_TIME' }));
  });
});

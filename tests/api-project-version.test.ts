import { afterEach, describe, expect, it, vi } from 'vitest';
import { ZodError } from 'zod';
import { ProjectSchema } from '../src/domain/schema.js';
import { importPackage } from '../src/importers/import-package.js';
import { createSourceOutline } from '../src/proposal/outline.js';
import { ApiError, apiErrorMessage, fetchProject, mutateProject, shouldRetryApiError } from '../web/src/api.js';
import { nativePackage } from './helpers.js';

afterEach((): void => { vi.unstubAllGlobals(); });

describe('Web project response compatibility', (): void => {
  it('old_screen_receives_actionable_version_error_without_retrying_project_read', async (): Promise<void> => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(Response.json({
      project: { schemaVersion: '99.0.0', projectId: 'version-check', revision: 12 },
    }));
    vi.stubGlobal('fetch', fetchMock);
    const error: unknown = await fetchProject('version-check').catch((value: unknown): unknown => value);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ code: 'CLIENT_PROJECT_VERSION_MISMATCH', status: 200, scope: 'service',
      category: 'internal', projectId: 'version-check', retryable: false, mutationBlocked: false });
    expect(shouldRetryApiError(error)).toBe(false);
    expect(apiErrorMessage(error)).toContain('브라우저 새로고침');
    expect(apiErrorMessage(error)).toContain('결과를 먼저 확인');
    expect(apiErrorMessage(error)).toContain(ProjectSchema.shape.schemaVersion.value);
    expect(apiErrorMessage(error)).toContain('99.0.0');
    expect(apiErrorMessage(error)).toContain('GET /api/projects/version-check');
    expect(apiErrorMessage(error)).not.toContain('입력 또는 편집 조건을 수정');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('committed_mutation_response_mismatch_does_not_resubmit_or_claim_save_failure', async (): Promise<void> => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(Response.json({
      project: { schemaVersion: '1.0.0', projectId: 'version-check', revision: 13 },
    }, { status: 201 }));
    vi.stubGlobal('fetch', fetchMock);
    const body: { expectedRevision: number; title: string } = { expectedRevision: 12, title: 'Saved title' };
    const error: unknown = await mutateProject('version-check', '/title', 'PATCH', body).catch((value: unknown): unknown => value);
    expect(error).toMatchObject({ code: 'CLIENT_PROJECT_VERSION_MISMATCH', status: 201, retryable: false });
    expect(apiErrorMessage(error)).toContain('이미 반영되었을 수');
    expect(apiErrorMessage(error)).toContain('PATCH /api/projects/version-check/title');
    expect(apiErrorMessage(error)).not.toContain('저장에 실패');
    expect(fetchMock).toHaveBeenCalledExactlyOnceWith('/api/projects/version-check/title', {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
  });

  it('matching_version_still_requires_full_project_validation_and_preserves_valid_response', async (): Promise<void> => {
    const project = createSourceOutline(importPackage(await nativePackage()), { proposedTextHoldMs: 2000 });
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ project: { ...project, shots: 'invalid' } }))
      .mockResolvedValueOnce(Response.json({ project }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(fetchProject(project.projectId)).rejects.toBeInstanceOf(ZodError);
    await expect(fetchProject(project.projectId)).resolves.toEqual(project);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

export type ImportButtonState = { disabled: boolean; label: 'IMPORTING' | '패키지 불러오기' };
export type AssetIntegrityUiIssue = { projectId: string; assetId: string; code: string; message: string };
export type RecoveryUiState = { blockedProjectIds: readonly string[]; assetIntegrityIssues: readonly AssetIntegrityUiIssue[] };
export type RecoveryUiError = {
  code: string; message: string; scope: 'request' | 'project' | 'asset' | 'service';
  projectId: string | null; resourceId: string | null; mutationBlocked: boolean;
};

export function emptyRecoveryUiState(): RecoveryUiState {
  return { blockedProjectIds: [], assetIntegrityIssues: [] };
}

export function importButtonState(working: boolean, submitting: boolean): ImportButtonState {
  const disabled: boolean = working || submitting;
  return { disabled, label: disabled ? 'IMPORTING' : '패키지 불러오기' };
}

export function reconcileBlockedProjects(state: RecoveryUiState, projectIds: readonly string[]): RecoveryUiState {
  return { ...state, blockedProjectIds: [...new Set(projectIds)].sort() };
}

export function recordRecoveryUiError(state: RecoveryUiState, error: RecoveryUiError): RecoveryUiState {
  if (error.scope === 'project' && error.mutationBlocked && error.projectId !== null) {
    return { ...state, blockedProjectIds: [...new Set([...state.blockedProjectIds, error.projectId])].sort() };
  }
  if (error.scope !== 'asset' || error.projectId === null || error.resourceId === null) return state;
  const remaining: AssetIntegrityUiIssue[] = state.assetIntegrityIssues.filter((issue: AssetIntegrityUiIssue): boolean =>
    issue.projectId !== error.projectId || issue.assetId !== error.resourceId);
  return { ...state, assetIntegrityIssues: [...remaining,
    { projectId: error.projectId, assetId: error.resourceId, code: error.code, message: error.message }] };
}

export function projectRecoveryBlocked(state: RecoveryUiState, projectId: string | null): boolean {
  return projectId !== null && state.blockedProjectIds.includes(projectId);
}

export function projectAssetIntegrityIssues(state: RecoveryUiState, projectId: string | null): readonly AssetIntegrityUiIssue[] {
  return projectId === null ? [] : state.assetIntegrityIssues.filter((issue: AssetIntegrityUiIssue): boolean => issue.projectId === projectId);
}

export function mutationControlsDisabled(working: boolean, projectId: string | null, state: RecoveryUiState): boolean {
  return working || projectRecoveryBlocked(state, projectId);
}

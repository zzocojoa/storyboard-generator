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

export function clearAssetIntegrityIssue(state: RecoveryUiState, projectId: string, assetId: string): RecoveryUiState {
  return { ...state, assetIntegrityIssues: state.assetIntegrityIssues.filter((issue: AssetIntegrityUiIssue): boolean =>
    issue.projectId !== projectId || issue.assetId !== assetId) };
}

export function reconcileAssetIntegrityIssues(
  state: RecoveryUiState, projectId: string, issues: readonly AssetIntegrityUiIssue[],
): RecoveryUiState {
  const otherProjects: AssetIntegrityUiIssue[] = state.assetIntegrityIssues.filter((issue: AssetIntegrityUiIssue): boolean => issue.projectId !== projectId);
  const byAssetId: Map<string, AssetIntegrityUiIssue> = new Map<string, AssetIntegrityUiIssue>();
  for (const issue of issues) byAssetId.set(issue.assetId, issue);
  return { ...state, assetIntegrityIssues: [...otherProjects, ...byAssetId.values()]
    .sort((left: AssetIntegrityUiIssue, right: AssetIntegrityUiIssue): number =>
      `${left.projectId}\u0000${left.assetId}`.localeCompare(`${right.projectId}\u0000${right.assetId}`)) };
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

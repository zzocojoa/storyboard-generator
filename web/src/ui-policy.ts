export type ImportButtonState = { disabled: boolean; label: 'IMPORTING' | '패키지 불러오기' };

export function importButtonState(working: boolean, submitting: boolean): ImportButtonState {
  const disabled: boolean = working || submitting;
  return { disabled, label: disabled ? 'IMPORTING' : '패키지 불러오기' };
}

export function mutationControlsDisabled(working: boolean, storageRecoveryRequired: boolean): boolean {
  return working || storageRecoveryRequired;
}

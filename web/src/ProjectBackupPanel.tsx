import { useState } from 'react';
import type { ReactElement } from 'react';
import { z } from 'zod';
import { BACKUP_MAX_BYTES, BackupSelectionSchema } from '../../src/backup/schema.js';
import type { BackupPreview, BackupResult } from '../../src/backup/schema.js';
import type { Project } from '../../src/domain/schema.js';
import { apiErrorMessage, createProjectBackup, previewProjectBackup, verifyProjectBackup } from './api.js';
import { useBrowserDraft } from './useBrowserDraft.js';

const DraftSchema = z.strictObject({ parentPath: z.string(), folderName: z.string() });
const VerificationSchema = z.strictObject({ path: z.string() });
type Preview = { value: BackupPreview; selection: string; revision: number };

export function ProjectBackupPanel(props: { project: Project }): ReactElement {
  const draft = useBrowserDraft(JSON.stringify([props.project.projectId, 'project-backup']), { parentPath: '', folderName: '' }, String(props.project.revision), DraftSchema);
  const verification = useBrowserDraft(JSON.stringify([props.project.projectId, 'project-backup-verification']), { path: '' }, '', VerificationSchema);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [result, setResult] = useState<BackupResult | null>(null);
  const [busy, setBusy] = useState<boolean>(false); const [error, setError] = useState<string>('');
  const selection: string = JSON.stringify(draft.value);
  const currentPreview: Preview | null = preview?.selection === selection && preview.revision === props.project.revision ? preview : null;
  const inspect = async (): Promise<void> => {
    setBusy(true); setError(''); setPreview(null); setResult(null);
    try {
      const input = BackupSelectionSchema.parse(draft.value);
      const value = await previewProjectBackup(props.project.projectId, props.project.revision, input);
      setPreview({ value, selection, revision: props.project.revision });
    } catch (cause: unknown) { setError(apiErrorMessage(cause)); }
    finally { setBusy(false); }
  };
  const create = async (): Promise<void> => {
    if (currentPreview === null || draft.blocked || verification.blocked) return;
    if (!verification.setValue({ path: currentPreview.value.outputPath })) return;
    setBusy(true); setError(''); setResult(null);
    try {
      setResult(await createProjectBackup(props.project.projectId, props.project.revision, BackupSelectionSchema.parse(draft.value), currentPreview.value.basisSha256));
      setPreview(null);
    } catch (cause: unknown) { setError(`${apiErrorMessage(cause)} 출력 위치가 남아 있다면 아래 ‘백업 파일 검증’으로 생성 여부를 확인하세요.`); }
    finally { setBusy(false); }
  };
  const verify = async (): Promise<void> => {
    setBusy(true); setError(''); setResult(null);
    try { setResult(await verifyProjectBackup(props.project.projectId, verification.value.path.trim())); }
    catch (cause: unknown) { setError(apiErrorMessage(cause)); }
    finally { setBusy(false); }
  };
  return <details className="draft-archive"><summary>저장된 콘티 백업</summary>
    <section aria-label="저장된 콘티 백업">
      <h3>현재본과 이전 버전·그림·음원을 함께 보관하세요</h3>
      <p>이 콘티에 저장된 원문 스냅샷과 전체 편집 이력을 그대로 보관합니다. 외부 원본 문서 폴더, 진행 중인 생성 작업, 브라우저 미저장 입력은 포함하지 않습니다.</p>
      {draft.notice}
      <fieldset disabled={busy}><legend>백업 저장 위치</legend>
        <label>백업 상위 폴더<input aria-label="백업 상위 폴더" value={draft.value.parentPath} onChange={(event): void => { draft.setValue({ ...draft.value, parentPath: event.target.value }); setResult(null); }} /></label>
        <label>새 백업 폴더 이름<input aria-label="새 백업 폴더 이름" value={draft.value.folderName} onChange={(event): void => { draft.setValue({ ...draft.value, folderName: event.target.value }); setResult(null); }} /></label>
        <p>상위 폴더는 이미 있는 위치를 선택하세요. 그 안에 새 백업 폴더를 만듭니다. 1회 최대 {BACKUP_MAX_BYTES / 1024 / 1024}MiB입니다.</p>
        <button type="button" disabled={draft.blocked} onClick={(): void => { void inspect(); }}>백업 내용 확인</button>
        {currentPreview !== null && <section aria-label="백업 내용"><p>REV {currentPreview.value.manifest.revision} · 버전 {currentPreview.value.versions}개 · 자산 {currentPreview.value.assets}개 · {(currentPreview.value.totalBytes / 1024 / 1024).toFixed(1)}MiB</p>
          <p>{currentPreview.value.outputPath}</p><button type="button" disabled={draft.blocked || verification.blocked} onClick={(): void => { void create(); }}>이 내용으로 백업</button></section>}
      </fieldset>
      {verification.notice}
      <fieldset disabled={busy}><legend>보관한 백업 검사</legend><label>검증할 백업 폴더<input aria-label="검증할 백업 폴더" value={verification.value.path} onChange={(event): void => { verification.setValue({ path: event.target.value }); setResult(null); }} /></label>
        <button type="button" disabled={verification.blocked || verification.value.path.trim() === ''} onClick={(): void => { void verify(); }}>백업 파일 검증</button></fieldset>
      {busy && <p role="status">원본과 실제 파일을 검사하고 있습니다.</p>}
      {error !== '' && <p role="alert">{error}</p>}
      {result !== null && <section aria-label="백업 검사 결과" aria-live="polite"><strong>보관한 파일과 전체 버전 목록을 확인했습니다.</strong>
        <p>{result.manifest.title} · REV {result.manifest.revision} · {result.manifest.files.length}개 파일</p><p>{result.outputPath}</p>
        <p>파일 보관은 그림·음성의 품질 검토나 Final 승인이 아닙니다. 기존 자산 오류와 검토 상태도 보존합니다.</p>
        <details><summary>복원 검증에 사용할 Manifest 해시</summary><code>{result.manifestSha256}</code></details>
      </section>}
    </section>
  </details>;
}

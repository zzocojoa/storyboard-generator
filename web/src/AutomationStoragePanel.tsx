import { useEffect, useState } from 'react';
import type { ReactElement } from 'react';
import type { AutomationDiskReport } from '../../src/automation/disk-space-schema.js';
import { apiErrorMessage, inspectAutomationStorage } from './api.js';

export function AutomationStoragePanel(props: { projectId: string; maxStagedBytes: number }): ReactElement {
  const [report, setReport] = useState<AutomationDiskReport | null>(null);
  const [error, setError] = useState<string>('');
  const [refresh, setRefresh] = useState<number>(0);
  useEffect((): (() => void) => {
    let disposed: boolean = false;
    setReport(null); setError('');
    const timer = setTimeout((): void => {
      void inspectAutomationStorage(props.projectId, props.maxStagedBytes).then((value): void => { if (!disposed) setReport(value); },
        (cause: unknown): void => { if (!disposed) setError(apiErrorMessage(cause)); });
    }, 300);
    return (): void => { disposed = true; clearTimeout(timer); };
  }, [props.projectId, props.maxStagedBytes, refresh]);
  return <section aria-label="자동 제작 저장 공간" className="automatic-storage">
    <strong>저장 공간</strong> <button type="button" onClick={(): void => { setRefresh((value): number => value + 1); }}>저장 공간 다시 확인</button>
    {report === null && error === '' && <p role="status">실제 디스크 여유 공간을 확인합니다.</p>}
    {error !== '' && <p role="alert">{error}</p>}
    {report !== null && <>
      <p role="status">{report.sufficient ? '현재 공간으로 제작을 시작할 수 있습니다.' : '공간을 확보한 뒤 이어 만드세요.'}</p>
      <ul>{report.volumes.map((volume, index): ReactElement => <li key={index}>
        사용 가능 {(Number(volume.availableBytes) / 1e9).toFixed(2)}GB · 필요 예상 {(Number(volume.requiredBytes) / 1e9).toFixed(2)}GB
        <details><summary>검사한 저장 위치</summary>{volume.paths.map((path): ReactElement => <p key={path}>{path}</p>)}</details>
      </li>)}</ul>
      <p>디스크별 예비 공간 {(Number(report.minimumFreeBytes) / 1e9).toFixed(2)}GB 포함 · 확인 {new Date(report.checkedAt).toLocaleTimeString('ko-KR')}</p>
    </>}
    <p>설정한 파일 한도와 임시·복사 공간을 기준으로 계산합니다. 실제 생성량과 다를 수 있습니다. 실행 중에도 다시 검사하며, 공간이 부족하면 저장한 결과를 보존하고 멈춥니다.</p>
  </section>;
}

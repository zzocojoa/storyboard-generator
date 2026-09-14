import { useEffect, useState } from 'react';
import type { ReactElement } from 'react';
import type { Project } from '../../src/domain/schema.js';
import { draftArchiveBasis, draftArchiveText, readProjectDraftArchive } from './browser-draft-archive.js';
import type { DraftArchive, DraftArchiveDestination, DraftArchiveEntry } from './browser-draft-archive.js';

/** 사라진 대상의 임시 내용도 열람·복사할 수 있게 하되 서버 저장이나 새로운 대상 배정을 실행하지 않는다. */
export function BrowserDraftArchive(props: { project: Project; onOpen: (destination: DraftArchiveDestination) => void }): ReactElement {
  const [snapshot, setSnapshot] = useState<DraftArchive>({ entries: [], issues: [] });
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [filter, setFilter] = useState<'all' | 'missing'>('all');
  const [query, setQuery] = useState<string>('');
  const refresh = (): void => {
    try { setSnapshot(readProjectDraftArchive(window.localStorage, props.project)); setError(null); }
    catch (failure: unknown) { setError(`임시 기록을 읽지 못했습니다. ${failure instanceof Error ? failure.message : String(failure)}`); }
  };
  useEffect((): (() => void) => {
    refresh();
    const onStorage = (event: StorageEvent): void => { if (event.key === null || event.key.startsWith('cutroom:draft:1:')) refresh(); };
    window.addEventListener('storage', onStorage);
    return (): void => { window.removeEventListener('storage', onStorage); };
  }, [props.project]);
  const copy = async (entry: DraftArchiveEntry): Promise<void> => {
    try { await navigator.clipboard.writeText(draftArchiveText(entry.record)); setNotice('작성 내용을 복사했습니다. 필요한 부분을 현재 대상의 편집기에 옮긴 뒤 저장하세요.'); }
    catch (failure: unknown) { setNotice(`복사하지 못했습니다. 작성 내용 칸에서 직접 선택해 복사하세요. ${failure instanceof Error ? failure.message : String(failure)}`); }
  };
  const download = (entry: DraftArchiveEntry): void => {
    const content: string = JSON.stringify({ artifactType: 'cutroom-browser-draft', artifactVersion: '1.0.0', projectId: props.project.projectId, record: entry.record }, null, 2);
    const url: string = URL.createObjectURL(new Blob([content], { type: 'application/json' }));
    const anchor: HTMLAnchorElement = document.createElement('a'); anchor.href = url; anchor.download = `cutroom-draft-${entry.record.id}.json`;
    document.body.append(anchor); anchor.click(); anchor.remove(); window.setTimeout((): void => { URL.revokeObjectURL(url); }, 1000);
  };
  const visible: DraftArchiveEntry[] = snapshot.entries.filter((entry): boolean => (filter === 'all' || entry.target.state !== 'present')
    && `${entry.target.label} ${entry.target.entityId ?? ''} ${entry.record.value}`.toLocaleLowerCase().includes(query.toLocaleLowerCase()));
  const missing: number = snapshot.entries.filter((entry): boolean => entry.target.state === 'missing').length;
  return <details className="draft-archive" onToggle={(event): void => { if (event.currentTarget.open) refresh(); }}>
    <summary>미저장 편집 기록</summary><section aria-label="미저장 편집 기록 보관함">
      <h3>작성하던 내용을 다시 찾으세요</h3><p>컷·프레임·음성·글자와 제작 프로필의 임시 편집을 이 브라우저에서 찾습니다. 내용 확인·복사·파일 보관은 콘티를 저장하거나 승인하지 않습니다.</p>
      <p>{snapshot.entries.length}개 기록 · 현재 대상이 없는 기록 {missing}개</p>
      <div className="draft-archive-controls"><label>표시할 기록<select aria-label="임시 기록 표시 범위" value={filter} onChange={(event): void => { setFilter(event.target.value as 'all' | 'missing'); }}><option value="all">모든 편집 기록</option><option value="missing">대상이 없거나 확인이 필요한 기록</option></select></label>
        <label>내용 찾기<input type="search" aria-label="임시 기록 검색" value={query} onChange={(event): void => { setQuery(event.target.value); }} /></label>
        <button type="button" onClick={refresh}>기록 다시 읽기</button></div>
      {error !== null && <p role="alert">{error}</p>}
      {snapshot.issues.map((issue): ReactElement => <div role="alert" key={issue.scope}><p>{issue.message}</p><code>{issue.scope}</code></div>)}
      {notice !== null && <p role="status">{notice}</p>}
      {visible.length === 0 && error === null && <p>선택한 범위에 표시할 편집 기록이 없습니다.</p>}
      {visible.map((entry): ReactElement => <details className="draft-archive-entry" key={`${entry.record.scope}:${entry.record.id}`}>
        <summary>{entry.target.label} · {entry.target.entityId ?? '프로젝트 설정'} · {entry.record.savedAt}</summary>
        <p>{entry.target.state === 'missing' ? '현재 콘티에 원래 편집 대상이 없습니다. 내용을 복사해 사용할 컷·글자를 직접 선택하세요.' : entry.target.state === 'unknown' ? '이전 편집 항목의 종류를 확인할 수 없습니다. 기록을 보관하고 내용을 검토하세요.' : '현재 대상의 편집기에서 작성 내용과 저장된 기준을 비교할 수 있습니다.'}</p>
        {entry.concurrent && <p>같은 대상에 여러 화면의 기록이 남아 있습니다. 각 내용을 확인하고 편집기에서 사용할 기록을 선택하세요.</p>}
        <label>작성 내용<textarea aria-label="보관된 작성 내용" readOnly rows={7} value={draftArchiveText(entry.record)} /></label>
        <details><summary>편집을 시작할 때의 기준</summary><pre>{draftArchiveBasis(entry.record)}</pre></details>
        <div className="draft-archive-actions"><button type="button" onClick={(): void => { void copy(entry); }}>작성 내용 복사</button>
          <button type="button" onClick={(): void => { download(entry); }}>기록 JSON 보관</button>
          {entry.target.destination !== null && <button type="button" onClick={(): void => { if (entry.target.destination !== null) props.onOpen(entry.target.destination); }}>현재 편집 대상 열기</button>}</div>
        <small>JSON은 임시 기록 보관용이며 프로젝트 가져오기 파일이 아닙니다. 그림·음성 파일은 포함하지 않습니다.</small>
      </details>)}
    </section></details>;
}

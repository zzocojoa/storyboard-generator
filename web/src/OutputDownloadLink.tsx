import { useState } from 'react';
import type { ReactElement } from 'react';
import { apiErrorMessage, responseApiError } from './api.js';

/** 다운로드 오류는 편집 화면 안에 남기고 HTML 오류 페이지를 산출물로 저장하지 않는다. */
export function OutputDownloadLink(props: { href: string; filename: string; mime: string; label: string }): ReactElement {
  const [working, setWorking] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const download = async (): Promise<void> => {
    setWorking(true); setError(null);
    try {
      const response: Response = await fetch(props.href);
      if (!response.ok) {
        if (response.headers.get('content-type')?.includes('application/json')) throw responseApiError(response, await response.json() as unknown);
        throw new Error(`다운로드 실패 HTTP ${response.status}: ${(await response.text()).slice(0, 1000)}`);
      }
      if (response.headers.get('content-type')?.split(';')[0] !== props.mime) throw new Error(`출력 형식이 다릅니다. 예상 ${props.mime}, 응답 ${response.headers.get('content-type')}. 새로고침 후 다시 시도하세요.`);
      const url: string = URL.createObjectURL(await response.blob()); const link: HTMLAnchorElement = document.createElement('a');
      link.href = url; link.download = props.filename; link.click(); window.setTimeout((): void => { URL.revokeObjectURL(url); }, 1000);
    } catch (failure: unknown) {
      if (!(failure instanceof Error)) throw failure;
      setError(apiErrorMessage(failure));
    } finally { setWorking(false); }
  };
  return <span className="output-download"><a href={props.href} aria-disabled={working} onClick={(event): void => {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault(); if (!working) void download();
  }}>{working ? '내려받는 중…' : props.label}</a>{error !== null && <span role="alert">{error}</span>}</span>;
}

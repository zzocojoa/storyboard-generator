import { useState } from 'react';
import type { ReactElement } from 'react';
import type { Project } from '../../src/domain/schema.js';
import { initialOutputOptions, outputSelectionLabel, selectedOutputShots, StoryboardOutputOptionsSchema } from '../../src/exporters/output-options.js';
import type { OutputSection, StoryboardOutputOptions } from '../../src/exporters/output-options.js';
import { OutputDownloadLink } from './OutputDownloadLink.js';
import { ReviewBundlePanel } from './ReviewBundlePanel.js';

type SavedOutput = { options: StoryboardOutputOptions; error: string | null };
function storageKey(projectId: string): string { return `cutroom:output-options:1:${projectId}`; }
function readSaved(projectId: string): SavedOutput {
  try {
    const value: string | null = localStorage.getItem(storageKey(projectId));
    return { options: value === null ? initialOutputOptions() : StoryboardOutputOptionsSchema.parse(JSON.parse(value) as unknown), error: null };
  } catch (error: unknown) {
    if (!(error instanceof Error)) throw error;
    return { options: initialOutputOptions(), error: `저장된 출력 설정을 읽지 못했습니다. 설정을 확인하고 다시 저장하세요. ${error.message}` };
  }
}

/** 출력 선호는 브라우저의 프로젝트별 영역에 명시적으로 저장하고 다운로드 요청에 같은 값을 보낸다. */
export function OutputSettings(props: { project: Project; finalReady: boolean; onPreview: (maturity: 'draft' | 'final') => void }): ReactElement {
  const [initial] = useState<SavedOutput>((): SavedOutput => readSaved(props.project.projectId));
  const [options, setOptions] = useState<StoryboardOutputOptions>(initial.options);
  const [notice, setNotice] = useState<string | null>(initial.error);
  const [loadErrorAcknowledged, setLoadErrorAcknowledged] = useState<boolean>(initial.error === null);
  if (!loadErrorAcknowledged) return <section aria-label="출력 설정"><p role="alert">{initial.error}</p><button onClick={(): void => { setLoadErrorAcknowledged(true); }}>기본 출력 구성으로 다시 설정</button></section>;
  const parsed = StoryboardOutputOptionsSchema.safeParse(options);
  let error: string | null = parsed.success ? null : parsed.error.issues.map((issue): string => issue.message).join(' ');
  let label: string = '';
  if (error === null) {
    try { selectedOutputShots(props.project, options); label = outputSelectionLabel(props.project, options); }
    catch (failure: unknown) { if (!(failure instanceof Error)) throw failure; error = failure.message; }
  }
  const href = (extension: string, maturity: 'draft' | 'final'): string => `/api/projects/${encodeURIComponent(props.project.projectId)}/export${extension}?${new URLSearchParams({ maturity, revision: String(props.project.revision), options: JSON.stringify(options) }).toString()}`;
  const link = (extension: string, mime: string, maturity: 'draft' | 'final', title: string): ReactElement => <OutputDownloadLink href={href(extension, maturity)} mime={mime}
    filename={`${options.filename}-r${props.project.revision}-${maturity}.${extension === '-options.json' ? 'output-options.json' : extension.slice(1)}`} label={title} />;
  const save = (): void => {
    try { localStorage.setItem(storageKey(props.project.projectId), JSON.stringify(StoryboardOutputOptionsSchema.parse(options))); setNotice('이 프로젝트의 출력 설정을 이 브라우저에 저장했습니다.'); }
    catch (failure: unknown) { if (!(failure instanceof Error)) throw failure; setNotice(`출력 설정을 저장하지 못했습니다. ${failure.message}`); }
  };
  const sections: readonly { id: OutputSection; label: string }[] = [{ id: 'direction', label: '연출·카메라' }, { id: 'sources', label: '원문 연결·공개 기준' }, { id: 'text', label: '화면 글자' }, { id: 'audio', label: '음성·음향' }];
  return <section className="storyboard-output-settings" aria-label="출력 설정">
    <div className="section-title"><h3>출력할 콘티 구성</h3><span>REV {props.project.revision}</span></div>
    <div className="output-setting-grid">
      <label className="field">출력 범위<select aria-label="출력 범위" value={options.scope.kind} onChange={(event): void => { setOptions({ ...options, scope: event.target.value === 'all' ? { kind: 'all' } : { kind: 'segments', segmentIds: props.project.dataset.segments.map((segment): string => segment.id) } }); }}><option value="all">전체 구간</option><option value="segments">구간 선택</option></select></label>
      <label className="field">출력 프레임<select aria-label="출력 프레임" value={options.frames} onChange={(event): void => { setOptions({ ...options, frames: event.target.value as StoryboardOutputOptions['frames'] }); }}><option value="all">모든 프레임</option><option value="representative">컷마다 대표 프레임 1개</option></select></label>
      <label className="field">PDF 용지<select aria-label="PDF 용지" value={options.pdf.pageSize} onChange={(event): void => { setOptions({ ...options, pdf: { ...options.pdf, pageSize: event.target.value as 'A4' | 'A3' } }); }}><option>A4</option><option>A3</option></select></label>
      <label className="field">PDF 방향<select aria-label="PDF 방향" value={options.pdf.orientation} onChange={(event): void => { setOptions({ ...options, pdf: { ...options.pdf, orientation: event.target.value as 'portrait' | 'landscape' } }); }}><option value="landscape">가로</option><option value="portrait">세로</option></select></label>
      <label className="field">PDF 구성<select aria-label="PDF 구성" value={options.pdf.layout.kind} onChange={(event): void => { setOptions({ ...options, pdf: { ...options.pdf, layout: event.target.value === 'detail' ? { kind: 'detail' } : { kind: 'board', framesPerPage: 4 } } }); }}><option value="detail">상세 제작 콘티</option><option value="board">그림 비교용 목록</option></select></label>
      {options.pdf.layout.kind === 'board' && <label className="field">페이지당 그림 수<select aria-label="페이지당 그림 수" value={options.pdf.layout.framesPerPage} onChange={(event): void => { setOptions({ ...options, pdf: { ...options.pdf, layout: { kind: 'board', framesPerPage: Number(event.target.value) as 2 | 4 | 6 } } }); }}><option value="2">2개</option><option value="4">4개</option><option value="6">6개</option></select></label>}
      <label className="field">CSV 구성<select aria-label="CSV 구성" value={options.csv} onChange={(event): void => { setOptions({ ...options, csv: event.target.value as 'technical' | 'readable' }); }}><option value="technical">상세 데이터 · 기존 열 구조</option><option value="readable">제작용 표 · 읽기 쉬운 본문</option></select></label>
      <label className="field">출력 파일 이름<input aria-label="출력 파일 이름" value={options.filename} maxLength={100} onChange={(event): void => { setOptions({ ...options, filename: event.target.value }); }} /><small>이름 뒤에 현재 버전·초안/최종·확장자가 붙습니다.</small></label>
    </div>
    {options.scope.kind === 'segments' && <fieldset className="output-segments"><legend>포함할 구간</legend>{props.project.dataset.segments.map((segment): ReactElement => {
      const selected: string[] = options.scope.kind === 'segments' ? options.scope.segmentIds : [];
      const scene = props.project.dataset.scenes.find((value): boolean => value.id === segment.sceneId);
      return <label key={segment.id}><input type="checkbox" checked={selected.includes(segment.id)} onChange={(event): void => { setOptions({ ...options, scope: { kind: 'segments', segmentIds: event.target.checked ? [...selected, segment.id] : selected.filter((id): boolean => id !== segment.id) } }); }} />{scene?.title ?? segment.sceneId} · {segment.mode} · {segment.id}</label>;
    })}</fieldset>}
    <fieldset className="output-sections"><legend>상세 PDF·제작용 CSV에 포함할 내용</legend>{sections.map((section): ReactElement => <label key={section.id}><input type="checkbox" checked={options.pdf.sections.includes(section.id)} onChange={(event): void => { setOptions({ ...options, pdf: { ...options.pdf, sections: event.target.checked ? [...options.pdf.sections, section.id] : options.pdf.sections.filter((id): boolean => id !== section.id) } }); }} />{section.label}</label>)}</fieldset>
    <p>{label}</p><p>대표 프레임은 첫 키 프레임을 우선하며, 없으면 시작 프레임을 사용합니다. 그림 비교용 목록은 그림·번호·시간·검토 상태를 담습니다. 상세 본문은 상세 PDF·제작용 CSV를 선택하세요.</p>
    <p>공유 출력은 허용된 그림·본문만 포함하며, 미승인 그림은 검토 표시로 대체됩니다. 구간을 선택해도 Final은 작품 전체를 검사합니다. 파일은 브라우저의 다운로드 위치에 저장됩니다.</p>
    {error !== null && <p role="alert">{error}</p>}{notice !== null && <p role="status">{notice}</p>}
    <button disabled={error !== null} onClick={save}>출력 설정 저장</button>
    <div className="export-options"><section><h3>초안 검토</h3><div><button onClick={(): void => { props.onPreview('draft'); }}>초안 재생</button>{error === null ? <>{link('.pdf', 'application/pdf', 'draft', 'DRAFT PDF')}{link('.csv', 'text/csv', 'draft', 'DRAFT CSV')}{link('-options.json', 'application/json', 'draft', '출력 선택 기록')}</> : <><button disabled>DRAFT PDF</button><button disabled>DRAFT CSV</button></>}</div></section>
      <section><h3>최종 출력</h3><p>{props.finalReady ? '현재 버전의 모든 출력 검사를 통과했습니다.' : '작품 전체의 차단 항목을 해결하면 내려받을 수 있습니다.'}</p><div><button onClick={(): void => { props.onPreview('final'); }}>최종 재생 검사</button>{props.finalReady && error === null ? <>{link('.pdf', 'application/pdf', 'final', 'FINAL PDF')}{link('.csv', 'text/csv', 'final', 'FINAL CSV')}</> : <><button disabled>FINAL PDF</button><button disabled>FINAL CSV</button></>}</div></section></div>
    <ReviewBundlePanel key={props.project.projectId} project={props.project} outputOptions={options} finalReady={props.finalReady} />
  </section>;
}

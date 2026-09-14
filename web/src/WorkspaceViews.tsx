import { OutputSettings } from './OutputSettings.js';
import { useState } from 'react';
import type { ReactElement } from 'react';
import type { FinalReadinessReport } from '../../src/domain/final-readiness.js';
import type { Project } from '../../src/domain/schema.js';
import { formatProjectDurationTimecode, formatProjectTimecode } from '../../src/domain/time.js';
import { inspectorPages, issueDestination, reviewGroups } from './workspace-navigation.js';
import type { EditDestination, InspectorPage, WorkspacePage } from './workspace-navigation.js';

export function WorkspaceNavigation(props: { page: WorkspacePage; onChange: (page: WorkspacePage) => void }): ReactElement {
  const pages: readonly { id: WorkspacePage; label: string }[] = [
    { id: 'overview', label: '제작 현황' }, { id: 'settings', label: '제작 설정' }, { id: 'editor', label: '컷 편집' }, { id: 'review', label: '검토·출력' },
  ];
  return <nav className="workspace-navigation" aria-label="콘티 작업 공간">{pages.map((page, index): ReactElement =>
    <button type="button" key={page.id} aria-current={props.page === page.id ? 'page' : undefined} onClick={(): void => { props.onChange(page.id); }}>
      <span aria-hidden="true">0{index + 1}</span>{page.label}</button>)}</nav>;
}

export function InspectorNavigation(props: { page: InspectorPage; onChange: (page: InspectorPage) => void }): ReactElement {
  return <nav className="inspector-navigation" aria-label="선택 컷 편집 항목">{inspectorPages.map((page): ReactElement =>
    <button type="button" key={page.id} aria-current={props.page === page.id ? 'page' : undefined} onClick={(): void => { props.onChange(page.id); }}>{page.label}</button>)}</nav>;
}

function ProgressRow(props: { label: string; value: number; total: number; onClick: () => void }): ReactElement {
  return <button className="progress-row" onClick={props.onClick}><span>{props.label}</span><strong>{props.value}<small> / {props.total}</small></strong>
    <progress value={props.value} max={Math.max(1, props.total)} aria-label={props.label} /><span aria-hidden="true">↗</span></button>;
}

export function ProductionOverview(props: { project: Project; report: FinalReadinessReport | null; onPage: (page: WorkspacePage) => void; onEditor: (page: InspectorPage) => void; onScene: (segmentId: string) => void }): ReactElement {
  const { project, report } = props;
  const outline: number = project.shots.filter((shot): boolean => shot.proposalOrigin === 'source-outline').length;
  const total: number = project.dataset.segments.at(-1)?.endMs ?? 0;
  const profileMissing: boolean = project.profile.medium === 'unspecified' || project.profile.visualStyle === null;
  return <section className="production-overview" aria-label="제작 현황">
    <div className="overview-lead"><div><span className="eyebrow">YOUR PRODUCTION</span><h2>이야기를, 장면으로.</h2><p>{project.dataset.scenes.length}개 장면과 {project.dataset.segments.length}개 구간을 불러왔습니다.<br />연출부터 그림·음성, 최종 검토까지 이어서 작업하세요.</p></div>
      <div className="runtime-stamp"><span>전체 러닝타임</span><strong>{formatProjectDurationTimecode(total, project.handoff.timebase)}</strong><small>{project.profile.aspectWidth}:{project.profile.aspectHeight} · {project.handoff.timebase.fpsNumerator / project.handoff.timebase.fpsDenominator} fps</small></div></div>
    <div className="overview-columns"><section className="next-action"><span className="eyebrow">NEXT UP</span><h3>{profileMissing ? '먼저, 화면의 기준을 정하세요.' : '장면의 연출을 구체화하세요.'}</h3><p>{profileMissing ? '제작 방식과 그림 스타일을 정하고 인물·장소 기준 이미지를 등록하세요. 같은 기준으로 컷을 설계할 수 있습니다.' : '원문 연결과 공개 시간을 확인하고 컷 제안을 요청하세요. 생성 결과는 검토 후 적용합니다.'}</p>
      <button className="studio-primary" onClick={(): void => { profileMissing ? props.onPage('settings') : props.onEditor('sources'); }}>{profileMissing ? '제작 설정 열기' : '원문 연결 검토'} <span aria-hidden="true">→</span></button>
      <div className="outline-note"><strong>{outline > 0 ? `원문 기반 초안 ${outline}컷` : `현재 ${project.shots.length}컷`}</strong><p>{outline > 0 ? '구간을 불러온 초기 배치입니다. 컷별 연출과 이미지 생성은 다음 작업입니다.' : '저장된 컷을 기준으로 검토합니다. 생성·확정과 최종 출력 가능 여부는 별도로 확인합니다.'}</p></div></section>
      <section className="production-progress"><div className="section-title"><h3>현재 완성도</h3><span>{report === null ? '검사 중' : report.finalReady ? '최종 출력 가능' : '작업 중'}</span></div>
        {report === null ? <p role="status">저장된 콘티와 실제 자산을 확인하고 있습니다.</p> : <>
          <ProgressRow label="컷 확정" value={report.counts.shotsApproved} total={report.counts.shotsTotal} onClick={(): void => { props.onEditor('direction'); }} />
          <ProgressRow label="그림 검토" value={report.counts.framesAccepted} total={report.counts.framesTotal} onClick={(): void => { props.onEditor('frames'); }} />
          <ProgressRow label="선택 음성 재생" value={report.counts.audioPlayable} total={report.counts.audioTotal} onClick={(): void => { props.onEditor('audio'); }} />
          <ProgressRow label="글자 시각 확정" value={report.counts.textConfirmed} total={report.counts.textTotal} onClick={(): void => { props.onEditor('text'); }} />
          <button className="text-action" onClick={(): void => { props.onPage('review'); }}>최종 출력 검사 · {report.issues.length}개 항목 확인 →</button></>}
      </section></div>
    <section className="scene-overview"><div className="section-title"><h3>장면 목록</h3><span>{project.dataset.scenes.length} SCENES</span></div>{project.dataset.scenes.map((scene, index): ReactElement => {
      const segments = project.dataset.segments.filter((segment): boolean => segment.sceneId === scene.id);
      const first = segments[0];
      return <button key={scene.id} disabled={first === undefined} onClick={(): void => { if (first !== undefined) props.onScene(first.id); }}><span className="scene-number">{String(index + 1).padStart(2, '0')}</span><strong>{scene.title}</strong><span>{segments.length}개 구간</span><time>{first === undefined ? '구간 없음' : formatProjectTimecode(first.startMs, project.handoff.timebase)}</time><span aria-hidden="true">↗</span></button>;
    })}</section>
  </section>;
}

export function GenerationGuide(props: { projectId: string }): ReactElement {
  const [copyState, setCopyState] = useState<string>('');
  const instruction: string = `$storyboard-workbench 현재 CUTROOM 프로젝트 ID ${props.projectId}의 대기 중인 요청을 처리해 주세요. 결과 검증과 반영까지 진행하고, 진행할 수 없는 요청은 원인과 다음 작업을 알려 주세요.`;
  const copy = async (): Promise<void> => {
    try { await navigator.clipboard.writeText(instruction); setCopyState('작업 문구를 복사했습니다. Codex App에 붙여 넣으세요.'); }
    catch { setCopyState('클립보드 접근에 실패했습니다. 아래 작업 문구를 직접 선택해 복사하세요.'); }
  };
  return <details className="generation-guide"><summary>Codex로 생성하는 방법</summary><p>제작 현황의 ‘자동 제작 시작’으로 기준 설정부터 컷·그림·대사·음향 지시의 검토 초안을 순서대로 만들 수 있습니다. 생성 결과를 불러온 뒤 확인하고 확정하세요.</p><p>이 화면의 개별 컷 제안·이미지·음성 버튼은 기존 요청 대기열에 등록합니다. 개별 요청을 직접 처리하려면 아래 문구를 Codex App에서 실행하세요.</p><textarea aria-label="Codex 생성 작업 문구" readOnly value={instruction} /><button type="button" onClick={(): void => { void copy(); }}>작업 문구 복사</button>{copyState !== '' && <p role="status">{copyState}</p>}<p>재생성할 그림은 ‘재생성 표시’를 누른 뒤 제작 현황에서 해당 구간의 새 자동 실행을 시작하세요. 그림·글자·컷 승인과 최종 출력 검사는 유지됩니다.</p></details>;
}

export function ProductionReview(props: { project: Project; report: FinalReadinessReport | null; onIssue: (destination: EditDestination) => void; onPreview: (maturity: 'draft' | 'final') => void }): ReactElement {
  const { project, report } = props;
  const exportBase: string = `/api/projects/${encodeURIComponent(project.projectId)}`;
  const [filter, setFilter] = useState<string>('');
  const groups = reviewGroups(report?.issues.filter((issue): boolean => `${issue.message} ${issue.code} ${issue.entityId}`.toLocaleLowerCase().includes(filter.toLocaleLowerCase())) ?? []);
  return <section className="production-review" aria-label="검토 및 내보내기"><div className="review-lead"><span className="eyebrow">REVIEW & EXPORT</span><h2>{report?.finalReady === true ? '최종 콘티를 내보낼 수 있습니다.' : '마지막까지, 빠짐없이.'}</h2><p>원문 연결, 그림, 연출, 시간, 대사·음향 지시와 글자의 상태를 확인합니다. 실제 음원은 최종 콘티의 필수 조건이 아닙니다. 검토 항목의 ‘편집하기’로 해당 위치를 바로 열 수 있습니다.</p></div>
    <OutputSettings key={project.projectId} project={project} finalReady={report?.finalReady === true} onPreview={props.onPreview} />
    <a className="project-json" href={`${exportBase}/export.json`}>편집 가능한 프로젝트 JSON 저장 ↗</a>
    <div className="review-issues"><div className="section-title"><h3>확인할 작업 <span>{report?.issues.length ?? '…'}</span></h3><label>항목 찾기<input type="search" aria-label="검토 항목 검색" placeholder="원문, 음성, 컷 ID…" value={filter} onChange={(event): void => { setFilter(event.target.value); }} /></label></div>
      {report === null && <p role="status">최종 출력 조건을 검사하고 있습니다.</p>}
      {report !== null && groups.length === 0 && <p className="empty-note">{report.finalReady ? '남아 있는 차단 항목이 없습니다.' : '검색 결과가 없습니다. 다른 문구로 찾아보세요.'}</p>}
      {groups.map((group): ReactElement => <details className="review-group" key={group.page}><summary><strong>{group.title}</strong><span>{group.issues.length}개 확인</span></summary><p>{group.description}</p>{group.issues.map((issue, index): ReactElement => {
        const destination: EditDestination | null = issueDestination(project, issue);
        return <article className="review-issue" key={`${issue.code}:${issue.entityId}:${index}`}><div><p>{issue.message}</p><details><summary>대상·근거 보기</summary><code>{issue.entityId} · {issue.code}</code><p>{issue.sourceRefs.map((ref): string => `${ref.fileId}:${ref.locator}`).join(' · ')}</p></details></div>{destination !== null && <button onClick={(): void => { props.onIssue(destination); }}>편집하기 ↗</button>}</article>;
      })}</details>)}
    </div>
    {report !== null && report.optionalAudioIssues.length > 0 && <details className="import-review"><summary>선택 음성 재생 점검 · {report.optionalAudioIssues.length}개</summary><p>음원을 재생하려는 경우에 확인하세요. 이 목록은 콘티 PDF·CSV 완료 조건에 포함되지 않습니다.</p>{report.optionalAudioIssues.map((issue, index): ReactElement => <article key={index}><p>{issue.message}</p><code>{issue.code} · {issue.entityId}</code></article>)}</details>}
    {project.importIssues.length > 0 && <details className="import-review"><summary>불러온 문서의 검토 참고사항 · {project.importIssues.length}개</summary><p>최종 출력 차단 항목과 구분한 입력 문서의 차이·주의사항입니다.</p>{project.importIssues.map((issue, index): ReactElement => <article key={index}><p>{issue.message}</p><code>{issue.code} · {issue.entityId}</code></article>)}</details>}
  </section>;
}

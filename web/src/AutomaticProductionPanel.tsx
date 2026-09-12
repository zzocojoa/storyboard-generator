import { VoiceCastingReview } from './VoiceCastingReview.js';
import { AudioPreparationSummary } from './AudioPreparationSummary.js';
import { useEffect, useState } from 'react';
import type { ReactElement } from 'react';
import { automationDensity } from '../../src/automation/run-schema.js';
import { densityDetailLabels, inspectStoryboardDensity } from '../../src/automation/density.js';
import { AutomationStartForm } from './AutomationStartForm.js';
import { AutomationStoragePanel } from './AutomationStoragePanel.js';
import type { AutomationSettings } from '../../src/automation/run-schema.js';
import type { AutomationOverview, AutomationView } from '../../src/automation/run-view.js';
import type { Project } from '../../src/domain/schema.js';
import { apiErrorMessage, cancelAutomation, fetchAutomation, pauseAutomation, resumeAutomation, startAutomation } from './api.js';

const statusLabels: Record<AutomationView['status'], string> = { running: '자동 제작 중', paused: '일시 중지', cancelled: '실행 취소됨', 'needs-attention': '확인이 필요합니다', 'review-ready': '생성 결과 검토 대기' };
const taskLabels: Record<AutomationView['jobs'][number]['task']['kind'], string> = { 'audio-instructions': '음악·환경 음향 검토', 'speech-retake': '선택 발화 재생성', 'voice-casting': '화자 음성 배정', 'audio-mix': '음량·페이드 계획', 'text-layout': '글자 배치 계획', production: '제작 기준 계획', reference: '기준 그림', segment: '컷·대사·시각 계획', repair: '기존 컷의 연결·음향 보완', image: '콘티 그림' };
export function AutomaticProductionPanel(props: { project: Project; disabled: boolean; onReview: () => Promise<void>; onRefresh: () => Promise<void>; onInspectShot: (shotId: string) => void; onInspectAudio: (segmentId: string) => void }): ReactElement {
  const [overview, setOverview] = useState<AutomationOverview | null>(null);
  const [busy, setBusy] = useState<boolean>(false);
  const [error, setError] = useState<string>('');
  const [pollError, setPollError] = useState<string>('');
  const [pollVersion, setPollVersion] = useState<number>(0);
  useEffect((): (() => void) => {
    let disposed: boolean = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const poll = async (): Promise<void> => {
      try {
        const next = await fetchAutomation(props.project.projectId);
        if (disposed) return;
        setOverview(next); setPollError('');
      } catch (cause: unknown) { if (!disposed) setPollError(apiErrorMessage(cause)); }
      finally { if (!disposed) timer = setTimeout((): void => { void poll(); }, 2500); }
    };
    void poll();
    return (): void => { disposed = true; if (timer !== null) clearTimeout(timer); };
  }, [props.project.projectId, pollVersion]);
  const current = overview?.runs.find((run): boolean => !['review-ready', 'cancelled'].includes(run.status)) ?? overview?.runs[0] ?? null;
  const active: boolean = current !== null && !['review-ready', 'cancelled'].includes(current.status);
  const runDensity = current === null ? null : automationDensity(current.settings);
  const currentScope: boolean = current !== null && props.project.revision >= current.revision && current.segmentIds.every((id): boolean => props.project.dataset.segments.some((segment): boolean => segment.id === id));
  const densityReview = runDensity === null || current === null || !currentScope ? null : inspectStoryboardDensity(props.project, current.segmentIds, runDensity);
  const perform = async (operation: () => Promise<AutomationView>): Promise<void> => {
    setBusy(true); setError('');
    try {
      const next = await operation();
      setOverview((previous): AutomationOverview | null => previous === null ? null : { ...previous, runs: [next, ...previous.runs.filter((run): boolean => run.id !== next.id)] });
      setPollVersion((value): number => value + 1);
    } catch (cause: unknown) { setError(apiErrorMessage(cause)); }
    finally { setBusy(false); }
  };
  const baseline: AutomationSettings | null = overview?.recommendedSettings === null || overview?.recommendedSettings === undefined
    ? null : { ...overview.recommendedSettings, ...overview.runs.find((run): boolean => run.purpose === undefined)?.settings };
  const completed: number = current?.jobs.filter((job): boolean => job.status === 'completed').length ?? 0;
  const running = current?.jobs.find((job): boolean => ['running', 'prepared', 'applying'].includes(job.status));
  return <section className="automatic-production" aria-label="Codex 자동 제작">
    <div className="section-title"><div><span className="eyebrow">CODEX APP</span><h3>초안 제작을 맡기세요.</h3></div><span>생성 → 결과 검토 → 선택 재생성</span></div>
    <p>비어 있는 제작 기준을 제안하고 기준 그림, 컷·대사·음향 지시·글자 배치와 콘티 그림을 순서대로 만듭니다. 가이드 음성 생성은 선택 기능입니다. 결과를 확인한 뒤 그림·글자·컷을 확정하세요.</p>
    <p>글자 겹침과 읽기 시간을 저장된 글꼴·배치·읽기 기준으로 검사하고 미확정 표시 시각을 보정합니다. 해결되지 않은 항목은 검토 화면에 남습니다.</p>
    {overview === null && pollError === '' && <p role="status">자동 제작 연결을 확인합니다.</p>}
    {overview?.configured === false && <p role="alert">서버에 자동 제작 실행 경로가 설정되지 않았습니다. automation 설정을 확인하세요.</p>}
    {pollError !== '' && <p role="alert">{pollError}</p>}{error !== '' && <p role="alert">{error}</p>}
    {overview?.configured === true && active && current !== null && <AutomationStoragePanel projectId={props.project.projectId} maxStagedBytes={Math.max(1, current.settings.maxStagedBytes - current.stagedBytes)} />}
    {current !== null && <div className="automatic-status" aria-live="polite"><strong>{statusLabels[current.status]}</strong>
      <p>{completed} / 현재 등록 {current.jobs.length}개 반영 · 저장 버전 {current.revision}{running === undefined ? '' : ` · ${taskLabels[running.task.kind]}`}</p>
      <progress aria-label="자동 제작 진행" value={completed} max={Math.max(1, current.jobs.length)} />
      <p>그림 {current.imageAttempts}회 시도 · 누적 실행 {Math.round(current.activeMs / 60000)}분 · 반영 후보 {(current.stagedBytes / 1048576).toFixed(1)}MB</p>
      {runDensity !== null && <p>표현 수준: {densityDetailLabels[runDensity.detail]} · 같은 그림 {runDensity.longHoldReviewMs / 1000}초 초과 시 검토</p>}
      {runDensity !== null && !currentScope && <p>최신 생성 결과를 불러오면 현재 컷·프레임 수와 긴 그림 표시 구간을 확인할 수 있습니다.</p>}
      {densityReview !== null && <section aria-label="콘티 표현 검토"><p>불러온 콘티 버전 {densityReview.revision} · {densityReview.shotCount}컷 · 프레임 {densityReview.frameCount}개 · 그림 대상 {densityReview.imageFrameCount}개 · 검은 화면/이전 화면 유지 {densityReview.excludedImageFrameCount}개</p>
        <p>시작 {densityReview.roles.start} · 키 {densityReview.roles.key} · 끝 {densityReview.roles.end} · 긴 그림 표시 검토 {densityReview.longHolds.length}개</p>
        {densityReview.longHolds.length > 0 && <details><summary>긴 그림 표시 구간 확인</summary><ul>{densityReview.longHolds.map((hold): ReactElement => <li key={hold.frameId}>{hold.segmentId} · {(hold.startMs / 1000).toFixed(1)}–{(hold.endMs / 1000).toFixed(1)}초 · 한 그림 {(hold.durationMs / 1000).toFixed(1)}초 <button disabled={props.disabled} onClick={(): void => { props.onInspectShot(hold.shotId); }}>이 컷 검토</button></li>)}</ul><p>긴 표시는 연출 검토 항목입니다. 의도된 유지인지 확인하며 자동으로 컷을 확정하거나 동일 그림을 추가하지 않습니다.</p></details>}
      </section>}
      {current.progress !== null && <p>{current.progress}</p>}
      {current.problem !== null && <p role="alert">{current.problem.message}<small> {current.problem.code}</small></p>}
      {current.serviceError !== null && <p role="alert">{current.serviceError.message}<small> {current.serviceError.code}</small></p>}
      {current.status === 'running' && !current.workerActive && <p>실행 Worker가 연결되지 않았습니다. 일시 중지 후 재개하여 저장 상태를 확인하세요.</p>}
      <div className="automatic-actions">
        {current.status === 'running' && <button disabled={busy} onClick={(): void => { void perform(() => pauseAutomation(props.project.projectId, current.id)); }}>일시 중지</button>}
        {['paused', 'needs-attention'].includes(current.status) && <button disabled={busy || current.workerActive} onClick={(): void => { void perform(() => resumeAutomation(props.project.projectId, current.id)); }}>이어 만들기</button>}
        {active && <button disabled={busy} onClick={(): void => { void perform(() => cancelAutomation(props.project.projectId, current.id)); }}>실행 취소 · 결과 보존</button>}
        <button disabled={busy || props.disabled} onClick={(): void => { void props.onReview(); }}>생성 결과 불러와 검토</button>
      </div>
      <details><summary>작업과 실행 설정 보기</summary><ol>{current.jobs.map((job): ReactElement => <li key={job.id}>{taskLabels[job.task.kind]} · {job.status} · {job.attempts}회</li>)}</ol><pre>{JSON.stringify(current.settings, null, 2)}</pre></details>
    </div>}
    <AudioPreparationSummary project={props.project} scope={current === null ? null : { revision: current.revision, segmentIds: current.segmentIds }}
      disabled={busy || props.disabled} onRefresh={props.onRefresh} onInspectAudio={props.onInspectAudio} />
    <VoiceCastingReview project={props.project} />
    {!active && baseline !== null && <AutomationStartForm project={props.project} baseline={baseline} busy={busy} disabled={props.disabled || pollError !== ''}
      configured={overview?.configured === true} onStart={async (segments, settings): Promise<void> => { await perform(() => startAutomation(props.project.projectId, props.project.revision, segments, settings)); }} />}

  </section>;
}

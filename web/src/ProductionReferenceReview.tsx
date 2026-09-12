import { useEffect, useState } from 'react';
import type { ReactElement } from 'react';
import { z } from 'zod';
import type { AutomationOverview, AutomationView } from '../../src/automation/run-view.js';
import type { Asset, Project } from '../../src/domain/schema.js';
import { propContinuityCandidates } from '../../src/domain/prop-continuity.js';
import { apiErrorMessage, cancelAutomation, fetchAutomation, pauseAutomation, resumeAutomation, startReferenceRetake } from './api.js';

type Props = { project: Project; disabled: boolean; visible: boolean; onRefresh: () => Promise<void> };
const ReferenceRecordSchema = z.object({ basis: z.object({ resourceId: z.string() }) });

/** 같은 원본 장소의 다른 변형을 이전 버전으로 오인하지 않고 선택 자원의 생성 이력을 읽는다. */
function resourceVersions(project: Project, resourceId: string): { assets: Asset[]; error: string } {
  try {
    const ids = new Set(project.generationRecords.filter((record): boolean => ['automatic-production-reference-1.0.0', 'automatic-production-reference-1.1.0', 'automatic-production-reference-1.2.0', 'automatic-production-reference-1.3.0'].includes(record.templateVersion))
      .filter((record): boolean => ReferenceRecordSchema.parse(JSON.parse(record.prompt)).basis.resourceId === resourceId).flatMap((record): string[] => record.resultAssetIds));
    return { assets: project.assets.filter((asset): boolean => ids.has(asset.id)), error: '' };
  } catch (cause: unknown) { return { assets: [], error: `기준 이미지 생성 이력을 확인하지 못했습니다: ${apiErrorMessage(cause)}` }; }
}

function ReferencePicture(props: { projectId: string; asset: Asset; caption: string }): ReactElement {
  const [failed, setFailed] = useState<boolean>(false);
  return <figure className="frame-review-preview">{failed ? <p role="alert">기준 이미지 파일을 읽을 수 없습니다. 자산 무결성 상태를 확인하세요.</p>
    : <img loading="lazy" src={`/api/projects/${encodeURIComponent(props.projectId)}/assets/${encodeURIComponent(props.asset.id)}`} alt={props.caption} onError={(): void => { setFailed(true); }} />}
    <figcaption>{props.caption} · v{props.asset.version}</figcaption></figure>;
}

/** 화면 조회·버전 비교는 읽기 전용이다. 버튼으로 선택한 한 기준만 별도 실행한다. */
export function ProductionReferenceReview(props: Props): ReactElement | null {
  const [resourceId, setResourceId] = useState<string>(''); const [previousId, setPreviousId] = useState<string>('');
  const [baseResourceId, setBaseResourceId] = useState<string>(''); const [continuityReason, setContinuityReason] = useState<string>('');
  const [correctionNote, setCorrectionNote] = useState<string>('');
  const [overview, setOverview] = useState<AutomationOverview | null>(null);
  const [error, setError] = useState<string>(''); const [busy, setBusy] = useState<boolean>(false);
  const [refresh, setRefresh] = useState<number>(0);
  useEffect((): (() => void) => {
    let disposed: boolean = false; let timer: ReturnType<typeof setTimeout> | null = null;
    const poll = async (): Promise<void> => {
      try { const value = await fetchAutomation(props.project.projectId); if (!disposed) setOverview(value); }
      catch (cause: unknown) { if (!disposed) setError(apiErrorMessage(cause)); }
      finally { if (!disposed && props.visible) timer = setTimeout((): void => { void poll(); }, 2500); }
    };
    if (props.visible) { setError(''); void poll(); }
    return (): void => { disposed = true; if (timer !== null) clearTimeout(timer); };
  }, [props.project.projectId, props.visible, refresh]);
  const resources = (props.project.productionPlan?.resources ?? []).filter((resource): boolean => props.project.productionPlan!.segments.some((segment): boolean => segment.resourceIds.includes(resource.id)));
  if (resources.length === 0) return null;
  const resource = resources.find((value): boolean => value.id === resourceId);
  const baseCandidates = resource === undefined ? [] : propContinuityCandidates(props.project, resource);
  const selectedBase = baseCandidates.find((value): boolean => value.id === baseResourceId);
  const baseAsset = props.project.assets.find((asset): boolean => asset.id === selectedBase?.referenceAssetId);
  const continuityIncomplete: boolean = baseResourceId !== '' && (selectedBase === undefined || continuityReason.trim() === '');
  const segments = props.project.productionPlan!.segments.filter((segment): boolean => segment.resourceIds.includes(resourceId));
  const segmentIds = new Set(segments.map((segment): string => segment.segmentId));
  const protectedShots = props.project.shots.filter((shot): boolean => segmentIds.has(shot.segmentId) && (shot.approvalStatus === 'approved' || shot.lockedFields.length > 0));
  const currentAsset = props.project.assets.find((asset): boolean => asset.id === resource?.referenceAssetId);
  const history = resourceVersions(props.project, resourceId);
  const previous = history.assets.filter((asset): boolean => asset.id !== currentAsset?.id);
  const compared = previous.find((asset): boolean => asset.id === previousId);
  const active = overview?.runs.find((run): boolean => !['review-ready', 'cancelled'].includes(run.status) || run.workerActive);
  const current = overview?.runs.find((run): boolean => run.purpose?.kind === 'reference-retake' && run.purpose.resourceId === resourceId);
  const disabled: boolean = props.disabled || busy;
  const perform = async (operation: () => Promise<AutomationView>): Promise<void> => {
    setBusy(true); setError('');
    try { await operation(); setRefresh((value): number => value + 1); }
    catch (cause: unknown) { setError(apiErrorMessage(cause)); }
    finally { setBusy(false); }
  };
  return <section className="production-reference-review" aria-label="자동 제작 기준 이미지 검토">
    <h3>기준 이미지 검토·재생성</h3><p>인물·공간·소품의 생성 결과를 비교하고, 필요한 기준 한 장의 수정 방향을 지정해 다시 만듭니다.</p>
    <label className="field">검토할 제작 기준<select aria-label="검토할 제작 기준" value={resourceId} disabled={disabled} onChange={(event): void => { setResourceId(event.target.value); setPreviousId(''); setCorrectionNote(''); setError(''); const selected = resources.find((value): boolean => value.id === event.target.value); setBaseResourceId(selected?.propContinuity?.resourceId ?? ''); setContinuityReason(selected?.propContinuity?.reason ?? ''); }}><option value="">기준 선택</option>{resources.map((value): ReactElement => <option key={value.id} value={value.id}>{value.name} · {value.kind === 'character' ? '인물' : value.kind === 'location' ? '장소' : '소품'}</option>)}</select></label>
    {error !== '' && <p role="alert">{error}</p>}
    {resource !== undefined && <>
      <p>{resource.description}</p><p>제안 근거: {resource.reason}</p><p>연결 구간: {[...segmentIds].join(', ')}</p>
      <label className="field">이번 이미지 수정 요청 (선택)<textarea aria-label="이번 이미지 수정 요청" value={correctionNote} maxLength={4000} disabled={disabled || active !== undefined}
        placeholder="예: 접힘 덮개가 없는 봉투 앞면을 보여 주세요." onChange={(event): void => { setCorrectionNote(event.target.value); }} /></label>
      <p>수정 요청과 현재 그림을 함께 전달합니다. 빈칸이면 기존 설명으로 재생성합니다. 원문·제작 설명·다른 기준은 유지됩니다.</p>
      {resource.kind === 'prop' && <fieldset disabled={disabled || active !== undefined}><legend>같은 소품의 모양 이어 쓰기</legend>
        <p>같은 물건을 다시 보여 주는 경우에만 앞선 기준을 선택하세요. 판형·색상·표 구획은 이어 쓰고, 현재 설명의 상태를 적용합니다. 새 이미지가 저장될 때 연결도 함께 반영됩니다.</p>
        <label className="field">이어 쓸 소품 기준<select aria-label="이어 쓸 소품 기준" value={baseResourceId} onChange={(event): void => { setBaseResourceId(event.target.value); }}><option value="">추가 연결 없음 · 기존 설정 유지</option>{baseCandidates.map((base): ReactElement => <option key={base.id} value={base.id}>{base.name}</option>)}</select></label>
        {baseResourceId !== '' && <label className="field">같은 소품으로 판단한 근거<textarea aria-label="같은 소품으로 판단한 근거" value={continuityReason} maxLength={4000} onChange={(event): void => { setContinuityReason(event.target.value); }} /></label>}
        {baseAsset !== undefined && <ReferencePicture key={baseAsset.id} projectId={props.project.projectId} asset={baseAsset} caption="모양을 이어 쓸 이전 소품" />}
        {continuityIncomplete && <p role="status">원문에서 같은 물건임을 확인한 근거를 입력하세요.</p>}
      </fieldset>}
      <div className="reference-comparison">{currentAsset !== undefined && <ReferencePicture key={currentAsset.id} projectId={props.project.projectId} asset={currentAsset} caption="현재 기준 이미지 · 검토용" />}
        {compared !== undefined && <ReferencePicture key={compared.id} projectId={props.project.projectId} asset={compared} caption="보존된 이전 기준 이미지" />}</div>
      {previous.length > 0 && <label className="field">이전 기준 비교<select aria-label="이전 기준 비교" value={previousId} onChange={(event): void => { setPreviousId(event.target.value); }}><option value="">비교할 버전 선택</option>{previous.map((asset): ReactElement => <option key={asset.id} value={asset.id}>v{asset.version} · {asset.description}</option>)}</select></label>}
      {history.error !== '' && <p role="alert">{history.error}</p>}
      {currentAsset === undefined && <p>아직 기준 그림이 없습니다. 제작 현황에서 자동 제작을 시작하세요.</p>}
      {protectedShots.length > 0 && <p role="alert">확정·잠금 컷 {protectedShots.length}개가 사용하는 기준입니다. 해당 컷을 검토 대기로 변경하고 잠금을 해제한 뒤 재생성하세요.</p>}
      {active !== undefined && active.id !== current?.id && <p role="status">다른 자동 실행이 남아 있습니다. 제작 현황에서 완료하거나 취소한 뒤 이 기준을 재생성하세요.</p>}
      {overview?.configured === false && <p role="alert">서버에 Codex 자동 제작 실행 설정이 필요합니다.</p>}
      <p>선택 기준만 교체하며 이전 파일을 보존합니다. 연결된 컷·그림은 검토 대기가 됩니다. 다른 기준과 기존 컷 그림은 자동 재생성하지 않습니다.</p>
      <p>최대 이미지 시도 2회 · 10분 · 새 파일 64MB. 원문 대사와 음원은 변경하지 않습니다.</p>
      <button disabled={disabled || continuityIncomplete || overview?.configured !== true || overview.recommendedSettings === null || active !== undefined || currentAsset === undefined || protectedShots.length > 0 || error !== '' || history.error !== ''}
        onClick={(): void => { if (overview?.recommendedSettings !== null && overview?.recommendedSettings !== undefined) void perform(() => startReferenceRetake(props.project.projectId, props.project.revision, { resourceId, ...(baseResourceId === '' ? {} : { propContinuity: { resourceId: baseResourceId, reason: continuityReason } }), ...(correctionNote.trim() === '' ? {} : { correctionNote: correctionNote.trim() }) }, { ...overview.recommendedSettings!, maxJobs: 1, maxAttemptsPerJob: 2, maxImageAttempts: 2, maxActiveMs: 600000, maxStagedBytes: 67108864, audioProduction: 'instructions-only' })); }}>선택 기준만 다시 생성</button>
      {current !== undefined && <div role="status"><p>{current.status === 'review-ready' ? '새 기준 생성 완료 · 결과를 불러와 이전 버전과 비교하세요.' : current.status === 'running' ? '선택 기준 이미지를 생성하고 있습니다.' : current.status === 'paused' ? '기준 생성 일시 중지' : current.status === 'cancelled' ? '기준 생성 취소됨' : '기준 생성 확인 필요'}</p>
        {current.purpose?.kind === 'reference-retake' && current.purpose.correctionNote !== undefined && <p>이 실행의 수정 요청: {current.purpose.correctionNote}</p>}
        {current.problem !== null && <p>{current.problem.code}: {current.problem.message}</p>}{current.serviceError !== null && <p>{current.serviceError.code}: {current.serviceError.message}</p>}
        {current.status === 'running' && <button disabled={disabled} onClick={(): void => { void perform(() => pauseAutomation(props.project.projectId, current.id)); }}>기준 생성 일시 중지</button>}
        {['paused', 'needs-attention'].includes(current.status) && <button disabled={disabled || current.workerActive} onClick={(): void => { void perform(() => resumeAutomation(props.project.projectId, current.id)); }}>기준 생성 이어하기</button>}
        {!['review-ready', 'cancelled'].includes(current.status) && <button disabled={disabled} onClick={(): void => { void perform(() => cancelAutomation(props.project.projectId, current.id)); }}>기준 생성 취소</button>}
        {current.status === 'review-ready' && <button disabled={disabled} onClick={(): void => { setBusy(true); void props.onRefresh().catch((cause: unknown): void => { setError(apiErrorMessage(cause)); }).finally((): void => { setBusy(false); }); }}>새 기준 결과 불러오기</button>}
      </div>}
      <button disabled={disabled} onClick={(): void => { setRefresh((value): number => value + 1); }}>기준 생성 상태 다시 확인</button>
    </>}
  </section>;
}

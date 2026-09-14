import { useEffect, useRef, useState } from 'react';
import type { ReactElement } from 'react';
import type { Project, TextCue } from '../../src/domain/schema.js';
import type { TextPresentationValues } from '../../src/domain/text-presentation.js';
import type { TextLayoutPreview } from '../../src/rendering/text-response.js';
import { reviewProducerTransitionAt, reviewProducerVisualAt } from '../../src/domain/producer-playback.js';
import { formatProjectTimecode } from '../../src/domain/time.js';
import { apiErrorMessage, previewTextPresentation } from './api.js';
import { ProducerVisualImage } from './ProducerVisualImage.js';
import { visualCompositionAt, VisualCompositionStage } from './VisualComposition.js';

/** 글자 초안을 같은 시점의 실제 그림 위에서 검토한다. 저장·승인 요청은 보내지 않는다. */
export function TextCompositionPreview(props: { project: Project; cue: TextCue; presentation: TextPresentationValues;
  initial: TextLayoutPreview; onClose: () => void }): ReactElement {
  const dialog = useRef<HTMLDialogElement>(null);
  const [atMs, setAtMs] = useState<number>(props.initial.atMs);
  const [result, setResult] = useState<{ atMs: number; value: TextLayoutPreview | null; error: string }>({ atMs: props.initial.atMs, value: props.initial, error: '' });
  useEffect((): (() => void) => {
    const element = dialog.current; element?.showModal();
    return (): void => { element?.close(); };
  }, []);
  useEffect((): (() => void) => {
    const controller = new AbortController();
    const load = async (): Promise<void> => {
      try {
        const value = await previewTextPresentation(props.project.projectId, props.cue.id, props.project.revision, props.presentation, atMs, controller.signal);
        if (value.projectId !== props.project.projectId || value.revision !== props.project.revision || value.atMs !== atMs) throw new Error('미리보기의 프로젝트·저장 버전·표시 시점이 다릅니다. 닫은 뒤 새로고침하고 다시 확인하세요.');
        if (!controller.signal.aborted) setResult({ atMs, value, error: '' });
      } catch (cause: unknown) {
        if (!controller.signal.aborted) setResult({ atMs, value: null, error: apiErrorMessage(cause) });
      }
    };
    void load();
    return (): void => { controller.abort(); };
  }, [props.project.projectId, props.project.revision, props.cue.id, props.presentation, atMs]);
  const close = (): void => { dialog.current?.close(); props.onClose(); };
  const composition = visualCompositionAt(props.project, atMs);
  const current = reviewProducerVisualAt(props.project, atMs);
  const incoming = reviewProducerTransitionAt(props.project, atMs);
  const value: TextLayoutPreview | null = result.atMs === atMs ? result.value : null;
  const error: string = result.atMs === atMs ? result.error : '';
  const issues = [...current.issues, ...(composition.incomingActive ? incoming.issues : []), ...(composition.transitionActive ? composition.transitionPolicy?.issues ?? [] : []), ...(value?.issues ?? [])];
  return <dialog ref={dialog} className="text-composition-dialog" aria-label="그림과 글자 배치 검토" onCancel={(event): void => { event.preventDefault(); close(); }}>
    <header><div><strong>그림과 글자 배치 검토</strong><p>미저장 배치 · {props.cue.id} · 미승인 그림 포함</p></div><button type="button" onClick={close}>닫기</button></header>
    <VisualCompositionStage aspectWidth={props.project.profile.aspectWidth} aspectHeight={props.project.profile.aspectHeight} composition={composition}
      current={<ProducerVisualImage projectId={props.project.projectId} revision={props.project.revision} decision={current} alt="글자 배치 검토의 현재 그림" />}
      incoming={incoming.renderMode === 'blocked' ? null : <ProducerVisualImage projectId={props.project.projectId} revision={props.project.revision} decision={incoming} alt="글자 배치 검토의 다음 그림" />}>
      {value !== null && <img className="composition-text-layer" alt="현재 시점의 미저장 글자 배치" src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(value.svg)}`} />}
    </VisualCompositionStage>
    <div className="composition-controls"><label>문구 표시 구간 내 검토 위치<input type="range" min={props.cue.startMs} max={props.cue.endMs - 1} step="1" value={atMs} onChange={(event): void => { setAtMs(Number(event.target.value)); }} /></label>
      <time aria-label="글자 배치 검토 시각">{formatProjectTimecode(atMs, props.project.handoff.timebase)}</time>
      <p>그림 속 인물·소품을 가리는지 확인하세요. 배치 저장은 이 창을 닫은 뒤 진행합니다.</p>
      {value === null && error === '' && <p role="status">선택한 시점의 글자 배치를 확인합니다.</p>}
      {error !== '' && <p role="alert">{error}</p>}
      {issues.length > 0 && <details><summary>이 시점의 검토 항목 {issues.length}개</summary>{issues.map((issue, index): ReactElement => <p key={`${issue.code}:${index}`}>{issue.entityId} · {issue.code}: {issue.message}</p>)}</details>}
    </div>
  </dialog>;
}

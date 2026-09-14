import { useEffect, useState } from 'react';
import type { ReactElement } from 'react';
import type { ProducerVisualDecision } from '../../src/domain/producer-playback.js';
import { apiErrorMessage, responseApiError } from './api.js';

function ProducerBitmap(props: { projectId: string; revision: number; decision: ProducerVisualDecision; alt: string }): ReactElement {
  const [source, setSource] = useState<string | null>(null);
  const [error, setError] = useState<string>('');
  const [path] = useState<string>(`/api/projects/${encodeURIComponent(props.projectId)}/review/${props.decision.layer === 'current' ? 'visual' : 'transition'}?atMs=${props.decision.playheadMs}&revision=${props.revision}`);
  useEffect((): (() => void) => {
    const controller: AbortController = new AbortController();
    let objectUrl: string | null = null;
    const load = async (): Promise<void> => {
      try {
        const response: Response = await fetch(path, { signal: controller.signal, cache: 'no-store' });
        if (!response.ok) throw responseApiError(response, await response.json());
        if (response.headers.get('X-Cutroom-Preview') !== 'producer-review' || response.headers.get('X-Cutroom-Revision') !== String(props.revision)) throw new Error('검토 그림의 저장 버전이 다릅니다. 결과를 다시 불러오세요.');
        const blob: Blob = await response.blob();
        if (!['image/png', 'image/jpeg', 'image/webp'].includes(blob.type)) throw new Error(`검토 그림 형식을 확인하세요: ${blob.type}`);
        if (controller.signal.aborted) return;
        objectUrl = URL.createObjectURL(blob); setSource(objectUrl);
      } catch (cause: unknown) {
        if (!controller.signal.aborted) setError(`${apiErrorMessage(cause)} · ${path}`);
      }
    };
    void load();
    return (): void => { controller.abort(); if (objectUrl !== null) URL.revokeObjectURL(objectUrl); };
  }, [path, props.revision]);
  if (error !== '') return <div className="frame-placeholder" role="alert">검토 그림을 불러오지 못했습니다.<p>{error}</p></div>;
  if (source === null) return <div className="frame-placeholder" role="status">검토 그림을 확인합니다.</div>;
  return <img src={source} alt={props.alt} onError={(): void => { setError('이미지를 표시하지 못했습니다. 저장된 파일의 형식을 확인하세요.'); }} />;
}

/** 동일 그림 구간은 재사용하고 Source·Frame·revision 변경 시 검증 요청과 Blob을 교체한다. */
export function ProducerVisualImage(props: { projectId: string; revision: number; decision: ProducerVisualDecision; alt: string }): ReactElement {
  if (props.decision.renderMode === 'blocked') return <div className="frame-placeholder"><strong>이 시점의 그림을 확인하세요.</strong><p>{props.decision.issues.map((value): string => `${value.code}: ${value.message}`).join(' · ')}</p></div>;
  const key: string = JSON.stringify([props.projectId, props.revision, props.decision.layer, props.decision.shotId,
    props.decision.frameId, props.decision.sourceFrameId, props.decision.imageAssetId, props.decision.renderMode, props.decision.activeSourceUnitIds]);
  return <ProducerBitmap key={key} {...props} />;
}

import { useEffect, useState } from 'react';
import type { ReactElement } from 'react';
import type { OutputMaturity } from '../../src/domain/output-policy.js';
import { reviewTextPlaybackWithPolicy } from '../../src/domain/playback.js';
import type { Project } from '../../src/domain/schema.js';
import { TextLayoutResponseSchema } from '../../src/rendering/text-response.js';
import type { TextLayoutResponse } from '../../src/rendering/text-response.js';
import { apiErrorMessage, responseApiError } from './api.js';

type OverlayProps = { project: Project; atMs: number; maturity: OutputMaturity; onNotice: (value: string) => void };

function TextVectorImage(props: OverlayProps & { active: boolean }): ReactElement | null {
  const [request] = useState(() => ({ projectId: props.project.projectId, revision: props.project.revision, atMs: props.atMs, maturity: props.maturity }));
  const [result, setResult] = useState<{ url: string; response: TextLayoutResponse } | null>(null);
  useEffect((): (() => void) => {
    const controller: AbortController = new AbortController(); let objectUrl: string | null = null;
    props.onNotice(props.active ? '글자 배치를 확인합니다.' : '');
    const load = async (): Promise<void> => {
      try {
        const response = await fetch(`/api/projects/${encodeURIComponent(request.projectId)}/text-layout?revision=${request.revision}&atMs=${request.atMs}&maturity=${request.maturity}`, { signal: controller.signal, cache: 'no-store' });
        const body: unknown = await response.json();
        if (!response.ok) throw responseApiError(response, body);
        const value = TextLayoutResponseSchema.parse(body);
        if (value.projectId !== request.projectId || value.revision !== request.revision || value.atMs !== request.atMs || value.maturity !== request.maturity) throw new Error('글자 배치의 저장 버전이나 시각이 다릅니다. 결과를 다시 불러오세요.');
        if (controller.signal.aborted) return;
        objectUrl = URL.createObjectURL(new Blob([value.svg], { type: 'image/svg+xml' }));
        setResult({ url: objectUrl, response: value });
        props.onNotice(value.problems.map((problem): string => `${problem.code}: ${problem.message}`).join(' · '));
      } catch (cause: unknown) {
        if (!controller.signal.aborted) props.onNotice(`글자 배치를 표시하지 못했습니다. ${apiErrorMessage(cause)}`);
      }
    };
    if (props.active) void load();
    return (): void => { controller.abort(); if (objectUrl !== null) URL.revokeObjectURL(objectUrl); };
  }, [request, props.active, props.onNotice]);
  if (result === null) return null;
  return <div className="storyboard-text-overlay" data-font-sha256={result.response.fontSha256}>
    <img src={result.url} alt="화면 글자 배치" onError={(): void => { props.onNotice('글자 그림을 표시하지 못했습니다. 새로고침 후 다시 검토하세요.'); }} />
    <span className="sr-only">{result.response.visibleTexts.map((cue): string => cue.text).join('\n')}</span>
  </div>;
}

/** 같은 활성 글자 집합은 재사용하며 시각 경계·수정·출력 정책이 바뀌면 기존 응답을 버린다. */
export function StoryboardTextOverlay(props: OverlayProps): ReactElement {
  const review = reviewTextPlaybackWithPolicy(props.project, props.atMs, { maturity: props.maturity, channel: 'program-monitor' });
  const key: string = JSON.stringify([props.project.projectId, props.project.revision, props.maturity, review.playable.map((cue) => [cue.id, cue.text, cue.kind, cue.timingStatus])]);
  return <TextVectorImage key={key} {...props} active={review.playable.length > 0} />;
}

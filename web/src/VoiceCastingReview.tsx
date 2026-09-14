import { useEffect, useState } from 'react';
import type { ReactElement } from 'react';
import type { Project } from '../../src/domain/schema.js';
import { stableJsonStringify } from '../../src/io/stable-json.js';
import { apiErrorMessage } from './api.js';

/** 브라우저에서도 현재 원문을 대조하며 저장된 제안을 새 원문의 확정값으로 표시하지 않는다. */
export function useVoiceCastingBasis(project: Project): { current: boolean | null; error: string } {
  const [current, setCurrent] = useState<boolean | null>(null); const [error, setError] = useState<string>('');
  useEffect((): (() => void) => {
    let disposed: boolean = false; setCurrent(null); setError('');
    if (project.voiceCasting !== undefined) {
      const source = new TextEncoder().encode(stableJsonStringify({ projectId: project.projectId, dataset: project.dataset }));
      void crypto.subtle.digest('SHA-256', source).then((value): void => {
        const hash: string = Array.from(new Uint8Array(value)).map((byte): string => byte.toString(16).padStart(2, '0')).join('');
        if (!disposed) setCurrent(hash === project.voiceCasting?.sourceHash);
      }, (cause: unknown): void => { if (!disposed) setError(apiErrorMessage(cause)); });
    }
    return (): void => { disposed = true; };
  }, [project.projectId, project.dataset, project.voiceCasting]);
  return { current, error };
}

/** 실행 중·일시 중지 후에도 배정 결과와 근거를 확인할 수 있다. */
export function VoiceCastingReview(props: { project: Project }): ReactElement | null {
  const basis = useVoiceCastingBasis(props.project); const casting = props.project.voiceCasting;
  if (casting === undefined) return null;
  return <section className="speaker-voices" aria-label="자동 배정한 가이드 음성">
    <h4>Codex가 배정한 가이드 음성</h4>
    <p>원문을 검토한 음성 제안입니다. 개별 지정한 음성이 우선하며 실제 생성 음원은 컷 편집의 음성 탭에서 들어볼 수 있습니다.</p>
    {basis.error !== '' ? <p role="alert">원문 확인 실패: {basis.error}</p> : basis.current === null ? <p role="status">현재 원문과 배정 근거를 확인합니다.</p>
      : basis.current ? <p>현재 원문에 맞춘 배정</p> : <p role="status">이전 원문에서 배정한 목소리입니다. 다음 자동 제작에서 미등록 발화의 배정을 다시 검토합니다.</p>}
    <ul>{casting.assignments.map((entry): ReactElement => <li key={JSON.stringify(entry.speakerId)}>
      <b>{props.project.dataset.people.find((person): boolean => person.id === entry.speakerId)?.name ?? entry.speakerId ?? '화자 미지정 발화'}</b>
      <p>{entry.voice.name} · {entry.locale} · {entry.voice.rateWordsPerMinute} 단어/분</p>
      <details><summary>배정 근거</summary><p>{entry.reason}</p><p>{entry.sourceUnitIds.join(', ')}</p></details>
    </li>)}</ul>
  </section>;
}

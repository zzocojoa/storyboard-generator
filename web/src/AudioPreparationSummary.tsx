import type { ReactElement } from 'react';
import { audioCueSource } from '../../src/domain/audio-source.js';
import type { AudioCue, Project } from '../../src/domain/schema.js';

type PreparationProps = {
  project: Project;
  scope: { revision: number; segmentIds: string[] } | null;
  disabled: boolean;
  onRefresh: () => Promise<void>;
  onInspectAudio: (segmentId: string) => void;
};

/** 자동 실행 완료와 실제 음원 준비를 구별하고 현재 구간의 편집기로 연결한다. */
export function AudioPreparationSummary(props: PreparationProps): ReactElement | null {
  if (props.scope !== null && props.project.revision < props.scope.revision) {
    return <section aria-label="음향 준비 현황"><h4>선택 음향 재생 상태</h4>
      <p>실제 소리도 듣고 싶을 때 새 생성 결과의 WAV 준비 상태를 확인하세요. 콘티 완료에는 음원이 필요하지 않습니다.</p>
      <button disabled={props.disabled} onClick={(): void => { void props.onRefresh(); }}>음향 준비 상태 불러오기</button>
    </section>;
  }
  const cues: AudioCue[] = props.project.audioCues.filter((cue): boolean => {
    if (!['sfx', 'music'].includes(cue.kind) || cue.assetId !== null && cue.timingStatus === 'measured') return false;
    const source = audioCueSource(props.project, cue);
    return props.scope === null || source === null || props.scope.segmentIds.includes(source.segmentId);
  });
  if (cues.length === 0) return null;
  return <section aria-label="음향 준비 현황"><h4>선택 음향 재생 · {cues.length}개 트랙</h4>
    <p>콘티는 음향 지시만으로 완성할 수 있습니다. 실제 소리도 듣고 싶을 때 WAV를 준비하고 가이드 음성 포함 자동 제작으로 배치하세요.</p>
    <ul>{cues.map((cue): ReactElement => {
      const source = audioCueSource(props.project, cue);
      return <li key={cue.id} aria-label={`${cue.id} 음향 준비`}>
        <b>{cue.kind === 'music' ? '배경 음악' : '효과음'} · {source?.segmentId ?? '원문 연결 확인 필요'}</b>
        <p>{source?.text ?? '트랙의 원문 연결을 검토·출력 화면에서 확인하세요.'}</p>
        <p>{cue.assetId === null ? '재생하려면 WAV 준비' : 'WAV 준비됨 · 자동 배치 필요'}</p>
        {source !== null && <button disabled={props.disabled} onClick={(): void => { props.onInspectAudio(source.segmentId); }}>이 음향 준비하기</button>}
      </li>;
    })}</ul>
    <p>음원 준비는 선택 기능입니다. 대사·음향 지시 검토와 콘티 확정은 음원 없이 진행할 수 있습니다.</p>
  </section>;
}

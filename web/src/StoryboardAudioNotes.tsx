import type { ReactElement } from 'react';
import { audioCueSource } from '../../src/domain/audio-source.js';
import { storyboardAudioIssues } from '../../src/domain/audio-storyboard.js';
import { reviewAudioPlaybackAt } from '../../src/domain/playback.js';
import type { AudioCue, Project } from '../../src/domain/schema.js';

const labels: Record<AudioCue['kind'], string> = { dialogue: '대사', voiceover: '내레이션', panel: '패널', sfx: '음향 지시', music: '음악 지시' };

/** 실제 음원과 별도로 현재 시각에 공개 가능한 콘티의 대사·음향 지시를 보여 준다. */
export function StoryboardAudioNotes(props: { project: Project; atMs: number }): ReactElement | null {
  const cues = props.project.audioCues.filter((cue): boolean => cue.startMs <= props.atMs && props.atMs < cue.endMs);
  const playback = reviewAudioPlaybackAt(props.project, props.atMs);
  if (cues.length === 0) return null;
  return <section className="monitor-audio-notes" aria-label="대사·음향 지시">
    {cues.map((cue): ReactElement => {
      const issues = storyboardAudioIssues(props.project, cue);
      const source = audioCueSource(props.project, cue);
      const speaker = props.project.dataset.people.find((person): boolean => person.id === source?.speakerId);
      return <article key={cue.id}>
        <b>{labels[cue.kind]}{speaker === undefined || issues.length > 0 ? '' : ` · ${speaker.name}`}</b>
        {issues.length === 0 && source !== null ? <p>{source.text}</p>
          : <p className="monitor-audio-review">콘티 지시 검토 필요 · {issues.map((issue): string => issue.code).join(', ')}</p>}
      </article>;
    })}
    {playback.blocked.length > 0 && <details><summary>선택 음성 재생 안내 · {playback.blocked.length}개</summary>
      <p>현재 재생할 수 없는 음원입니다. 실제 음원은 콘티 PDF·CSV의 완료 조건이 아닙니다.</p>
      {playback.blocked.map((entry): ReactElement => <p key={entry.cueId}>{entry.cueId} · {entry.issues.map((issue): string => issue.code).join(', ')}</p>)}
    </details>}
  </section>;
}

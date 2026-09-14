import type { ReactElement } from 'react';

export function IndependentStoryboardFields(props: { name: string; hold: string; onName: (value: string) => void; onHold: (value: string) => void }): ReactElement {
  return <div className="document-fields-grid">
    <label>새 콘티 이름<input aria-label="새 콘티 이름" value={props.name} maxLength={120} required
      onChange={(event): void => { props.onName(event.target.value); }} /><small>왼쪽 프로젝트 목록에 이 이름으로 추가합니다.</small></label>
    <label>초안 글자 유지 시간 (ms)<input aria-label="초안 글자 유지 시간 (ms)" type="number" min="1" step="1" value={props.hold} required
      onChange={(event): void => { props.onHold(event.target.value); }} /><small>종료 시각이 없는 글자의 임시 표시 시간입니다. 최종 출력 전에 확정합니다.</small></label>
  </div>;
}

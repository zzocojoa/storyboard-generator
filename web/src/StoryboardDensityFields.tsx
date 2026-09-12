import type { ReactElement } from 'react';
import { densityDetailLabels, StoryboardDensitySchema } from '../../src/automation/density.js';
import type { StoryboardDensity } from '../../src/automation/density.js';

export function StoryboardDensityFields(props: { value: StoryboardDensity; onChange: (value: StoryboardDensity) => void }): ReactElement {
  return <fieldset className="automatic-density"><legend>콘티 상세도</legend>
    <div className="automatic-fields"><label>컷·그림 표현 수준<select value={props.value.detail} onChange={(event): void => { props.onChange({ ...props.value, detail: StoryboardDensitySchema.shape.detail.parse(event.target.value) }); }}>
      {StoryboardDensitySchema.shape.detail.options.map((detail): ReactElement => <option key={detail} value={detail}>{densityDetailLabels[detail]}</option>)}</select></label>
      <label>같은 그림 표시 검토 기준 ms<input type="number" required min="1000" max="180000" step="1000" value={props.value.longHoldReviewMs} onChange={(event): void => { props.onChange({ ...props.value, longHoldReviewMs: Number(event.target.value) }); }} /></label></div>
    <p>원문에 맞춤은 행동·화자·정보 전환을 기준으로 계획합니다. 간략은 이어지는 동작을 묶고, 상세는 손동작·시선·상태 변화를 더 나누어 보여 줍니다. 필요한 공개 장면은 모든 수준에서 유지합니다.</p>
    <p>컷 수를 고정하지 않습니다. 같은 그림을 오래 표시하면 검토 대상으로 보여 주며 의도된 정적 장면은 유지할 수 있습니다. 이미 편집하거나 확정한 컷은 이 설정만으로 다시 나누지 않습니다.</p>
  </fieldset>;
}

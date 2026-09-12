import type { ReactElement } from 'react';
import type { AudioInstructionInput } from '../../src/domain/audio-instructions.js';
import type { Instruction, Project } from '../../src/domain/schema.js';

type Occurrence = NonNullable<AudioInstructionInput['occurrences']>[number];
type Props = { project: Project; instruction: Instruction; value: Occurrence[]; onChange: (value: Occurrence[]) => void };

/** 원문 선택과 연결을 함께 변경해 이전 소리의 트랙·정보를 새 발생에 남기지 않는다. */
function withSource(project: Project, instruction: Instruction, occurrence: Occurrence, unitId: string): Occurrence {
  const unit = project.dataset.units.find((value): boolean => value.id === unitId);
  if (unitId === '') return { ...occurrence, cueId: null, source: { kind: 'instruction', quote: instruction.text }, informationIds: [], supportingUnitIds: [] };
  if (unit === undefined) throw new Error(`${unitId}: 선택한 소리 원문이 없습니다. 현재 원문을 다시 확인하세요.`);
  return { ...occurrence, cueId: null, source: { kind: 'unit', unitId: unit.id, quote: unit.text }, informationIds: [...unit.informationIds], supportingUnitIds: [] };
}

export function AudioOccurrenceEditor(props: Props): ReactElement {
  const units = props.project.dataset.units.filter((unit): boolean => unit.segmentId === props.instruction.segmentId && ['ACTION', 'SOUND', 'MUSIC'].includes(unit.kind));
  const replace = (index: number, value: Occurrence): void => props.onChange(props.value.map((entry, position): Occurrence => index === position ? value : entry));
  return <section aria-label="발생별 음향 배치"><h5>소리별 원문과 시각</h5>
    <p>서로 다른 시점의 소리는 각각 배치합니다. 시각은 아래 같은 원문의 음성·음향 트랙에서 수정할 수 있습니다.</p>
    {props.value.map((entry, index): ReactElement => {
      const cue = props.project.audioCues.find((value): boolean => value.id === entry.cueId);
      const source = entry.source;
      const candidates = props.project.audioCues.filter((value): boolean => value.kind === (props.instruction.kind === 'music' ? 'music' : 'sfx')
        && (value.instructionId === props.instruction.id || (source.kind === 'unit' && value.instructionId === undefined && value.unitId === source.unitId))
        && !props.value.some((other, position): boolean => position !== index && other.cueId === value.id));
      return <fieldset key={index} aria-label={`소리 ${index + 1}`}><legend>소리 {index + 1}</legend>
        <label className="field">소리 원문<select value={source.kind === 'unit' ? source.unitId : ''} onChange={(event): void => replace(index, withSource(props.project, props.instruction, entry, event.target.value))}>
          <option value="">제작 음향 지시</option>{source.kind === 'unit' && !units.some((unit): boolean => unit.id === source.unitId)
            && <option value={source.unitId}>원본에서 사라진 연결 · {source.unitId}</option>}{units.map((unit): ReactElement => <option key={unit.id} value={unit.id}>{unit.id} · {unit.text}</option>)}
        </select></label>
        <label className="field">소리 인용<textarea value={source.quote} onChange={(event): void => replace(index, { ...entry, source: { ...source, quote: event.target.value } })} /></label>
        <label className="field">연결 트랙<select value={entry.cueId ?? ''} onChange={(event): void => replace(index, { ...entry, cueId: event.target.value === '' ? null : event.target.value })}>
          <option value="">새 음향 지시 트랙</option>{entry.cueId !== null && !candidates.some((value): boolean => value.id === entry.cueId)
            && <option value={entry.cueId}>다시 연결할 트랙 · {entry.cueId}</option>}{candidates.map((value): ReactElement => <option key={value.id} value={value.id}>{value.id} · {value.assetId === null ? '지시' : '음원 있음'}</option>)}
        </select></label>
        <p>{cue === undefined ? '저장 후 자동 제작에서 시각을 계획하세요.' : `${cue.startMs}–${cue.endMs} ms · ${cue.timingStatus === 'measured' ? '실측 음원' : '콘티 계획 시각'} · ${cue.assetId === null ? '음원 선택 사항' : '음원 연결됨'}`}</p>
        <details><summary>같은 소리의 보충 원문</summary><p>같은 소리가 지문과 효과음에 함께 적힌 경우에만 묶으세요. 다른 시점의 소리는 별도 발생으로 추가합니다.</p>
          {units.filter((unit): boolean => source.kind !== 'unit' || unit.id !== source.unitId).map((unit): ReactElement => <label className="check-row" key={unit.id}>
            <input type="checkbox" checked={(entry.supportingUnitIds ?? []).includes(unit.id)} onChange={(event): void => replace(index, { ...entry,
              supportingUnitIds: event.target.checked ? [...(entry.supportingUnitIds ?? []), unit.id] : (entry.supportingUnitIds ?? []).filter((id): boolean => id !== unit.id),
              informationIds: event.target.checked ? [...new Set([...entry.informationIds, ...unit.informationIds])] : entry.informationIds })} />{unit.id} · {unit.text}
          </label>)}</details>
        <details><summary>이 소리의 원문 정보</summary>{props.project.dataset.informationRules.filter((rule): boolean => rule.segmentId === props.instruction.segmentId).map((rule): ReactElement => <label className="check-row" key={rule.id}>
          <input type="checkbox" checked={entry.informationIds.includes(rule.id)} onChange={(event): void => replace(index, { ...entry, informationIds: event.target.checked ? [...entry.informationIds, rule.id] : entry.informationIds.filter((id): boolean => id !== rule.id) })} />{rule.id}
        </label>)}</details>
        <label className="field">발생 근거<textarea value={entry.reason} onChange={(event): void => replace(index, { ...entry, reason: event.target.value })} /></label>
        <button onClick={(): void => props.onChange(props.value.filter((_value, position): boolean => index !== position))}>이 발생 제거</button>
      </fieldset>;
    })}
    <button onClick={(): void => props.onChange([...props.value, { cueId: null, source: { kind: 'instruction', quote: props.instruction.text }, informationIds: [], reason: '' }])}>소리 발생 추가</button>
  </section>;
}

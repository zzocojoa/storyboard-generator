import type { ReactElement } from 'react';
import type { CandidateEvidence, DocumentBindings, DocumentPreview, MappingChoice } from '../../src/documents/schema.js';
import { DOCUMENT_FILES } from '../../src/documents/schema.js';
import { choiceValue, mappingInputId, MAPPING_GROUPS } from './document-import-state.js';
import type { FieldProblem, MappingField, ProductionFields } from './document-import-state.js';

function sourceName(fileId: string): string {
  return DOCUMENT_FILES.find((file): boolean => 'document-' + file.key === fileId)?.name ?? fileId;
}

export function FieldError(props: { id: string; problems: readonly FieldProblem[] }): ReactElement | null {
  const problem: FieldProblem | undefined = props.problems.find((entry: FieldProblem): boolean => entry.id === props.id);
  return problem === undefined ? null : <span className="document-field-error" id={props.id + '-error'}>{problem.message}</span>;
}

function MappingRow(props: { field: MappingField; title: string; choice: MappingChoice; bindings: DocumentBindings; problems: readonly FieldProblem[];
  onChange: (field: MappingField, key: string, value: string) => void }): ReactElement {
  const { field, title, choice, bindings } = props;
  const id: string = mappingInputId(field, choice.key);
  const value: string = choiceValue(choice, bindings[field]);
  const invalid: boolean = props.problems.some((problem: FieldProblem): boolean => problem.id === id);
  return <div className="document-mapping-row">
    <div><label htmlFor={id}>{choice.label}</label><details className="document-source"><summary>출처 보기</summary>
      {choice.sourceRefs.map((ref, index: number): ReactElement => <code key={index}>{sourceName(ref.fileId)} · {ref.locator}</code>)}</details></div>
    <div><select id={id} aria-label={title + ': ' + choice.key} value={value} aria-invalid={invalid} aria-describedby={invalid ? id + '-error' : undefined}
      onChange={(event): void => { props.onChange(field, choice.key, event.target.value); }}>
      <option value="">연결 선택 필요</option>
      {value !== '' && !choice.candidates.includes(value) && <option value={value}>{value} · 다시 선택 필요</option>}
      {choice.candidates.map((candidate: string): ReactElement => <option key={candidate} value={candidate}>{candidate}</option>)}
    </select><FieldError id={id} problems={props.problems} /></div>
  </div>;
}

export function DocumentMappings(props: { preview: DocumentPreview; bindings: DocumentBindings; problems: readonly FieldProblem[];
  onChange: (field: MappingField, key: string, value: string) => void; onReview: () => void }): ReactElement {
  return <section className="document-section" aria-labelledby="document-mappings-title">
    <header><span className="document-kicker">연결 검토</span><h2 id="document-mappings-title">이름과 원문을 연결하세요</h2>
      <p>문서에서 확인한 연결은 접어 두었습니다. 연결이 필요한 항목은 원본의 ID를 확인해 선택하세요.</p></header>
    {MAPPING_GROUPS.map(({ field, title }): ReactElement | null => {
      const manual: MappingChoice[] = props.preview[field].filter((choice: MappingChoice): boolean => choice.selected === null || props.bindings[field].some((entry): boolean => entry.key === choice.key));
      const automatic: MappingChoice[] = props.preview[field].filter((choice: MappingChoice): boolean => !manual.includes(choice));
      if (manual.length + automatic.length === 0) return null;
      return <section className="document-mapping-group" key={field}><h3>{title}<span>{props.preview[field].length}개</span></h3>
        {manual.length > 0 && <details className="document-candidate-evidence"><summary>{title} 후보의 문서 근거 확인</summary>
          {field === 'people' && <p>문서에 이름과 ID의 대응표가 없습니다. 아래 출연 정보를 참고하고, 확실하지 않은 연결은 원본 제작 기준에서 확인하세요.</p>}
          <dl>{props.preview.candidateEvidence.filter((entry: CandidateEvidence): boolean => entry.field === field).map((entry: CandidateEvidence): ReactElement => <div key={entry.targetId}><dt>{entry.targetId}</dt><dd>{entry.description}
            <details className="document-source"><summary>출처 보기</summary>{entry.sourceRefs.map((ref, index: number): ReactElement => <code key={index}>{sourceName(ref.fileId)} · {ref.locator}</code>)}</details></dd></div>)}</dl>
        </details>}
        {manual.map((choice: MappingChoice): ReactElement => <MappingRow key={choice.key} {...props} field={field} title={title} choice={choice} />)}
        {automatic.length > 0 && <details className="document-automatic"><summary>문서로 연결된 {title} {automatic.length}개 확인</summary>
          {automatic.map((choice: MappingChoice): ReactElement => <MappingRow key={choice.key} {...props} field={field} title={title} choice={choice} />)}</details>}
      </section>;
    })}
    <p className="document-help">장면 연결을 바꾸면 아래 버튼으로 원문 구간의 후보를 다시 확인하세요.</p>
    <button type="button" className="document-secondary" onClick={props.onReview}>연결 다시 확인</button>
  </section>;
}

export function DocumentProductionFields(props: { fields: ProductionFields; problems: readonly FieldProblem[];
  onChange: (field: keyof ProductionFields, value: string) => void }): ReactElement {
  const attributes = (field: keyof ProductionFields): { id: string; value: string; 'aria-invalid': boolean; 'aria-describedby': string | undefined } => {
    const id: string = 'document-' + field;
    const invalid: boolean = props.problems.some((entry: FieldProblem): boolean => entry.id === id);
    return { id, value: props.fields[field], 'aria-invalid': invalid, 'aria-describedby': invalid ? id + '-error' : undefined };
  };
  return <section className="document-section" aria-labelledby="document-production-title"><header><span className="document-kicker">제작 설정</span>
    <h2 id="document-production-title">이 영상의 제작 기준</h2><p>문서에 없는 설정입니다. 제작할 영상에 맞춰 직접 지정하세요.</p></header>
    <div className="document-fields-grid">
      <label htmlFor="document-fps">프레임레이트<select aria-label="프레임레이트" {...attributes('fps')} onChange={(event): void => { props.onChange('fps', event.target.value); }}>
        <option value="">프레임레이트 선택</option>{[['24/1', '24 fps'], ['25/1', '25 fps'], ['30/1', '30 fps'], ['30000/1001', '29.97 fps (30000/1001)'], ['60/1', '60 fps']].map(([value, label]): ReactElement => <option key={value} value={value}>{label}</option>)}</select><FieldError id="document-fps" problems={props.problems} /></label>
      <label htmlFor="document-sampleRate">음성 샘플레이트<select aria-label="음성 샘플레이트" {...attributes('sampleRate')} onChange={(event): void => { props.onChange('sampleRate', event.target.value); }}>
        <option value="">샘플레이트 선택</option>{[44100, 48000, 96000].map((value: number): ReactElement => <option key={value} value={value}>{value} Hz</option>)}</select><FieldError id="document-sampleRate" problems={props.problems} /></label>
      <label htmlFor="document-width">화면비 가로<input type="number" min="1" step="1" aria-label="화면비 가로" {...attributes('width')} onChange={(event): void => { props.onChange('width', event.target.value); }} /><FieldError id="document-width" problems={props.problems} /></label>
      <label htmlFor="document-height">화면비 세로<input type="number" min="1" step="1" aria-label="화면비 세로" {...attributes('height')} onChange={(event): void => { props.onChange('height', event.target.value); }} /><FieldError id="document-height" problems={props.problems} /></label>
      <label className="document-full-field" htmlFor="document-startTimecode">시작 타임코드<input aria-label="시작 타임코드" {...attributes('startTimecode')} onChange={(event): void => { props.onChange('startTimecode', event.target.value); }} /><small>HH:MM:SS:FF · 논드롭 프레임</small><FieldError id="document-startTimecode" problems={props.problems} /></label>
    </div><p className="document-help">그림 스타일과 실사·AI 제작 방식은 콘티 편집기에서 정합니다.</p>
  </section>;
}

import type { ReactElement } from 'react';
import type { ReviewAuditEntry } from '../../src/documents/review-model.js';
import type { DocumentBindings, DocumentPreview } from '../../src/documents/schema.js';
import { mappingInputId } from './document-import-state.js';
import { personConnections } from './document-identity-state.js';
import type { PersonConnection } from './document-identity-state.js';
import { REVIEW_ORIGIN_LABELS } from './DocumentReviewPanel.js';
import type { SavedIdentityControls } from './useSavedDocumentIdentity.js';

export function DocumentPersonConnections(props: { preview: DocumentPreview; bindings: DocumentBindings; entries: readonly ReviewAuditEntry[];
  working: boolean; saved: SavedIdentityControls; onFocus: (id: string) => void; onConfirm: (key: string) => void }): ReactElement {
  const connections: PersonConnection[] = personConnections(props.preview, props.bindings, props.entries);
  const completed: number = connections.filter((item: PersonConnection): boolean => item.status === 'connected').length;
  const unresolved: number = connections.filter((item: PersonConnection): boolean => item.status === 'unresolved').length;
  const verified = props.saved.result?.matches.filter((match): boolean => match.currentId === null) ?? [];
  return <section className="document-section document-person-connections" aria-labelledby="document-person-connections-title">
    <header><span className="document-kicker">최종 인물 연결</span><h2 id="document-person-connections-title" tabIndex={-1}>{connections.length === 0 ? '연결할 인물이 없습니다' : `인물 연결 ${completed}/${connections.length}명 완료`}</h2>
      <p>{connections.length === 0 ? '이번 문서에는 가져올 인물 항목이 없습니다. 인물 보충 파일 없이 제작 설정으로 진행하세요.'
        : '이름과 제작 문서의 인물 ID를 연결한 결과입니다. 아래 인물은 가져올 인물 목록에 포함되므로 연결이 필요합니다.'}</p></header>
    {props.saved.loading && unresolved > 0 && <p role="status">이 문서에서 이전에 검증한 인물 원본이 있는지 확인하고 있습니다.</p>}
    {props.saved.error !== null && <p role="alert" className="document-review-error">{props.saved.error}</p>}
    {verified.length > 0 && <div className="document-connections-next document-saved-identity"><strong>선택할 인물 ID {verified.length}개를 원본에서 확인했습니다.</strong>
      <p>이전에 검증한 인물표를 현재 8개 문서와 다시 대조했습니다. 아래 ‘선택할 ID’를 적용하면 됩니다. 보충 파일을 다시 입력할 필요가 없습니다.</p>
      <button type="button" className="document-primary" disabled={props.working} onClick={(): void => { void props.saved.apply(); }}>확인된 {verified.length}명 자동 선택</button></div>}
    {connections.length > 0 && <table><caption>현재 프로젝트의 이름과 최종 인물 ID</caption><thead><tr><th scope="col">인물</th><th scope="col">선택한 ID · 결론</th><th scope="col">다음 행동</th></tr></thead>
      <tbody>{connections.map((item: PersonConnection): ReactElement => {
        const target: string | undefined = verified.find((match): boolean => match.name === item.name)?.targetId;
        return <tr key={item.name}>
        <th scope="row">{item.name}</th><td><strong>{item.value || (target === undefined ? 'ID 결정 보류' : `선택할 ID: ${target}`)}</strong><small>{target !== undefined ? '원본으로 확인됨 · 아직 적용 전' : item.status === 'connected' ? `${REVIEW_ORIGIN_LABELS[item.origin]} · 연결 완료` : item.status === 'pending' ? `${REVIEW_ORIGIN_LABELS[item.origin]} · 제안 확인 후 연결 완료` : item.reason}</small></td>
        <td>{target !== undefined ? <span>위 ‘자동 선택’ 버튼으로 적용</span> : item.status === 'pending' ? <button type="button" className="document-secondary" disabled={props.working}
          onClick={(): void => { props.onConfirm(item.name); }}>{item.name} → {item.value} 확정</button>
          : <button type="button" className="document-secondary" disabled={props.working} onClick={(): void => { props.onFocus(mappingInputId('people', item.name)); }}>{item.name} {item.status === 'connected' ? '연결 수정' : '직접 선택'}</button>}</td>
      </tr>; })}</tbody></table>}
    {unresolved > verified.length && <div className="document-connections-next"><strong>남은 {unresolved - verified.length}명 · 아직 선택할 ID를 특정할 근거가 없습니다.</strong>
      <p>인물 원본 파일은 이름–ID 대응표, 제작 근거 파일은 그 대응표가 현재 제작 문서의 원본인지 확인하는 자료입니다. 두 파일의 경로를 지정하고 ‘근거 확인 후 자동 연결’을 누르세요. 이미 정확한 ID를 알고 있으면 위에서 직접 선택할 수 있습니다.</p>
      <p>대응 근거가 없으면 ID를 임의 배정하지 않습니다. 미연결은 연결 불필요를 뜻하지 않으며, 대사가 없다는 이유만으로 인물을 제외하지 않습니다.</p>
      <button type="button" className="document-secondary" disabled={props.working} onClick={(): void => { props.onFocus('document-identity-characters'); }}>인물 보충 파일 지정하기</button></div>}
    {connections.length > 0 && completed === connections.length && <p role="status">인물 연결이 완료되었습니다. 보충 파일을 추가할 필요 없이 남은 제작 설정을 확인한 뒤 ‘생성 내용 확인’으로 진행하세요.</p>}
  </section>;
}

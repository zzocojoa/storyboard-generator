import { useState } from 'react';
import type { ReactElement } from 'react';
import { z } from 'zod';
import { ReviewBundleInputSchema, ReviewBundleResultSchema, ReviewDeliveryAttemptSchema } from '../../src/exporters/review-delivery-schema.js';
import type { ReviewBundleInput, ReviewBundlePreview, ReviewBundleResult, ReviewDeliveryAttempt } from '../../src/exporters/review-delivery-schema.js';
import type { StoryboardOutputOptions } from '../../src/exporters/output-options.js';
import type { Project } from '../../src/domain/schema.js';
import { stableJsonStringify } from '../../src/io/stable-json.js';
import { apiErrorMessage, createReviewBundle, previewReviewBundle, verifyReviewBundle } from './api.js';
import { useBrowserDraft } from './useBrowserDraft.js';

const DeliveryDraftSchema = z.strictObject({ directory: z.string(), maturity: z.enum(['draft', 'final']), profile: z.enum(['internal', 'external']),
  includeMedia: z.boolean(), termsText: z.string(), delivery: z.strictObject({ packageName: z.string(), packageVersion: z.string(),
    purpose: z.enum(['production-review', 'production-handoff', 'archive']), recipient: z.string(),
    contents: z.strictObject({ sourceContent: z.boolean(), generationPrompts: z.boolean() }) }) });
type DeliveryDraft = z.infer<typeof DeliveryDraftSchema>;
type CheckedDelivery = { key: string; preview: ReviewBundlePreview };

/** 생성 전 포함 범위·경로를 확인하며 완료 결과는 실제 생성 당시의 값으로 표시한다. */
export function ReviewBundlePanel(props: { project: Project; outputOptions: StoryboardOutputOptions; finalReady: boolean }): ReactElement {
  const baseline: DeliveryDraft = { directory: '', maturity: 'draft', profile: 'internal', includeMedia: false, termsText: '',
    delivery: { packageName: props.outputOptions.filename, packageVersion: '01', purpose: 'production-review', recipient: '', contents: { sourceContent: false, generationPrompts: false } } };
  const recovery = useBrowserDraft(`review-bundle-input:${props.project.projectId}`, baseline, stableJsonStringify([props.project.revision, props.outputOptions]), DeliveryDraftSchema);
  const draft: DeliveryDraft = recovery.value; const setDraft = recovery.setValue;
  const receipt = useBrowserDraft(`review-bundle-result:${props.project.projectId}`, null, 'generation-receipt-v1', ReviewBundleResultSchema.nullable());
  const attempts = useBrowserDraft<ReviewDeliveryAttempt[]>(`review-bundle-attempts:${props.project.projectId}`, [], 'generation-attempt-v1', z.array(ReviewDeliveryAttemptSchema));
  const [checked, setChecked] = useState<CheckedDelivery | null>(null);
  const result: ReviewBundleResult | null = receipt.value?.projectId === props.project.projectId ? receipt.value : null;
  const [working, setWorking] = useState<'preview' | 'create' | 'verify' | null>(null);
  const [verifiedNotice, setVerifiedNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copyNotice, setCopyNotice] = useState<string>('');
  const { termsText, ...fields } = draft;
  const input: ReviewBundleInput = { ...fields, version: '1.0.0', expectedRevision: props.project.revision, outputOptions: props.outputOptions,
    redactTerms: draft.profile === 'external' ? termsText.split(/\r?\n/u).map((term: string): string => term.trim()).filter((term: string): boolean => term.length > 0) : [] };
  const inputKey: string = JSON.stringify(input);
  const current: ReviewBundlePreview | null = checked?.key === inputKey ? checked.preview : null;
  const parsed = ReviewBundleInputSchema.safeParse(input);
  const preview = async (): Promise<void> => {
    if (recovery.blocked) return;
    setError(null); setWorking('preview'); setChecked(null);
    try { const value = ReviewBundleInputSchema.parse(input); setChecked({ key: inputKey, preview: await previewReviewBundle(props.project.projectId, value) }); }
    catch (failure: unknown) { setError(apiErrorMessage(failure)); }
    finally { setWorking(null); }
  };
  const create = async (): Promise<void> => {
    if (current === null || !current.canCreate || recovery.blocked || attempts.blocked || receipt.blocked) return;
    setError(null); setWorking('create');
    try {
      const attempt: ReviewDeliveryAttempt = { requestId: crypto.randomUUID(), recoveryKey: Array.from(crypto.getRandomValues(new Uint8Array(32)), (byte: number): string => byte.toString(16).padStart(2, '0')).join(''),
        projectId: props.project.projectId, input: ReviewBundleInputSchema.parse(input),
        basisSha256: current.basisSha256, output: current.output, attemptedAt: new Date().toISOString() };
      if (!attempts.setValue((previous: ReviewDeliveryAttempt[]): ReviewDeliveryAttempt[] => [...previous, attempt])) {
        throw new Error('생성 시도를 브라우저에 보관하지 못해 전송하지 않았습니다. 기록 충돌·저장 공간을 확인하세요.');
      }
      const created: ReviewBundleResult = await createReviewBundle(attempt.projectId, attempt.input, attempt.basisSha256, { requestId: attempt.requestId, recoveryKey: attempt.recoveryKey });
      if (!receipt.setValue(created)) throw new Error('패키지는 생성됐지만 완료 기록을 보관하지 못했습니다. 생성 시도에서 파일 확인·기록 복구를 실행하세요.');
      setCopyNotice(''); setVerifiedNotice(null); setChecked(null);
    }
    catch (failure: unknown) { setError(apiErrorMessage(failure)); setChecked(null); }
    finally { setWorking(null); }
  };
  const verify = async (attempt: ReviewDeliveryAttempt): Promise<void> => {
    if (attempts.blocked || receipt.blocked || attempt.projectId !== props.project.projectId) return;
    setError(null); setWorking('verify'); setVerifiedNotice(null);
    try {
      const verified: ReviewBundleResult = await verifyReviewBundle(attempt);
      if (!receipt.setValue(verified)) throw new Error('파일 검사는 끝났지만 복구 기록을 보관하지 못했습니다. 브라우저 기록 충돌·저장 공간을 확인하세요.');
      setCopyNotice(''); setVerifiedNotice(`${new Date().toLocaleString()}에 ${verified.files.length}개 파일의 크기·해시를 확인해 생성 기록을 복구했습니다. 현재 콘티를 수정하거나 승인하지 않았습니다.`);
    } catch (failure: unknown) { setError(apiErrorMessage(failure)); }
    finally { setWorking(null); }
  };
  const copyPath = async (): Promise<void> => {
    if (result === null) return;
    try { await navigator.clipboard.writeText(result.output); setCopyNotice('생성된 폴더 경로를 복사했습니다. Finder의 폴더로 이동에서 붙여 넣으세요.'); }
    catch (failure: unknown) { setCopyNotice(`경로 복사에 실패했습니다. 아래 경로를 직접 복사하세요. ${apiErrorMessage(failure)}`); }
  };
  return <section className="review-bundle-panel" aria-label="검토 패키지 만들기">
    <div className="section-title"><h3>검토 패키지 만들기</h3><span>JSON · PDF · CSV · 검증 기록</span></div>
    <p>위에서 선택한 PDF·CSV와 작품 전체의 참조·검증 자료를 한 폴더에 만듭니다. 수신자와 용도를 기록하며 실제 전송은 별도로 진행합니다.</p>
    <p>입력과 생성 기록은 이 브라우저에 보관합니다. 다시 열었을 때 새 패키지를 만들려면 생성 내용을 다시 확인하세요.</p>
    {recovery.notice !== null && <fieldset disabled={working !== null} aria-label="패키지 설정 복원">{recovery.notice}</fieldset>}
    <fieldset className="bundle-fields" disabled={working !== null}><legend>전달물 설정</legend><div className="output-setting-grid">
      <label className="field">사용 목적<select aria-label="패키지 사용 목적" value={draft.delivery.purpose} onChange={(event): void => { setDraft({ ...draft, delivery: { ...draft.delivery, purpose: event.target.value as ReviewBundleInput['delivery']['purpose'] } }); }}><option value="production-review">연출·콘티 검토</option><option value="production-handoff">제작 자료 전달</option><option value="archive">제작 기록 보관</option></select></label>
      <label className="field">수신자 · 선택<input aria-label="패키지 수신자" maxLength={120} value={draft.delivery.recipient} onChange={(event): void => { setDraft({ ...draft, delivery: { ...draft.delivery, recipient: event.target.value } }); }} /></label>
      <label className="field">공유 범위<select aria-label="패키지 공유 범위" value={draft.profile} onChange={(event): void => {
        const profile: 'internal' | 'external' = event.target.value as 'internal' | 'external';
        setDraft({ ...draft, profile, ...(profile === 'external' ? { includeMedia: false, delivery: { ...draft.delivery, contents: { sourceContent: false, generationPrompts: false } } } : {}) });
      }}><option value="internal">내부 제작용</option><option value="external">외부 공유용 · 비식별화</option></select></label>
      <label className="field">완성도<select aria-label="패키지 완성도" value={draft.maturity} onChange={(event): void => { setDraft({ ...draft, maturity: event.target.value as 'draft' | 'final' }); }}><option value="draft">초안 · 검토 상태 포함</option><option value="final" disabled={!props.finalReady}>최종 · 작품 전체 검사 필요</option></select></label>
      <label className="field">패키지 이름<input aria-label="검토 패키지 이름" value={draft.delivery.packageName} maxLength={100} onChange={(event): void => { setDraft({ ...draft, delivery: { ...draft.delivery, packageName: event.target.value } }); }} /></label>
      <label className="field">패키지 버전<input aria-label="검토 패키지 버전" value={draft.delivery.packageVersion} maxLength={100} onChange={(event): void => { setDraft({ ...draft, delivery: { ...draft.delivery, packageVersion: event.target.value } }); }} /></label>
    </div>
    <div className="bundle-inclusions"><label><input type="checkbox" disabled={draft.profile === 'external'} checked={draft.delivery.contents.sourceContent} onChange={(event): void => { setDraft({ ...draft, delivery: { ...draft.delivery, contents: { ...draft.delivery.contents, sourceContent: event.target.checked } } }); }} />입력 문서 전문 포함</label>
      <label><input type="checkbox" disabled={draft.profile === 'external'} checked={draft.delivery.contents.generationPrompts} onChange={(event): void => { setDraft({ ...draft, delivery: { ...draft.delivery, contents: { ...draft.delivery.contents, generationPrompts: event.target.checked } } }); }} />생성 프롬프트 포함</label>
      <label><input type="checkbox" disabled={draft.profile === 'external'} checked={draft.includeMedia} onChange={(event): void => { setDraft({ ...draft, includeMedia: event.target.checked }); }} />전체 미디어 파일 포함 · 기준 그림·콘티 그림·음성</label></div>
    <p>문서 전문을 제외해도 콘티의 대본 단위·연출·ID 연결·자산 목록·검증 기록은 포함됩니다. PDF·CSV의 구간 선택과 별개로 JSON·참조·선택한 미디어는 작품 전체입니다. 웹 미디어 한도는 256 MiB입니다.</p>
    {draft.profile === 'external' && <><p>외부용은 문서 전문·프롬프트를 제외하고 이메일·전화번호·주민번호·절대경로를 가립니다. 그림은 자리 표시자로 대체하며 미디어 파일을 포함하지 않습니다. 추가로 가릴 이름이나 문구를 아래에 지정하세요.</p><label className="field">추가로 가릴 문구 · 한 줄 하나<textarea aria-label="추가 비식별화 문구" rows={3} value={draft.termsText} onChange={(event): void => { setDraft({ ...draft, termsText: event.target.value }); }} /><small>문자 그대로 일치하는 부분을 가립니다. 정규식은 입력하지 않습니다.</small></label></>}
    <label className="field">저장할 상위 폴더<input aria-label="검토 패키지 상위 폴더" value={draft.directory} placeholder="기존 폴더의 절대경로" onChange={(event): void => { setDraft({ ...draft, directory: event.target.value }); }} /><small>이 폴더 안에 이름·버전·초안/최종·revision을 붙인 새 폴더를 만듭니다. 같은 이름의 기존 폴더는 덮어쓰지 않습니다.</small></label>
    <button type="button" disabled={!parsed.success || recovery.blocked} onClick={(): void => { void preview(); }}>생성 내용 확인</button></fieldset>
    {working !== null && <p role="status">{working === 'preview' ? '원본·출력 설정과 저장 위치를 확인하고 있습니다.' : working === 'verify' ? '생성 당시 기록과 실제 파일을 대조하고 있습니다.' : '패키지 파일을 생성하고 검증하고 있습니다. 화면을 닫아 응답을 놓쳤다면 생성 시도에서 결과를 다시 확인할 수 있습니다.'}</p>}
    {!parsed.success && draft.directory.length > 0 && <p role="alert">{parsed.error.issues.map((issue): string => `${issue.path.join(' · ')}: ${issue.message}`).join('\n')}</p>}
    {error !== null && <p role="alert">{error}</p>}
    {checked !== null && current === null && <p>설정이나 콘티 버전이 바뀌었습니다. 생성 내용 확인을 다시 실행하세요.</p>}
    {current !== null && <section className="bundle-preview" aria-label="패키지 생성 내용"><h4>생성할 파일과 위치</h4><p>{current.scopeLabel}</p><p>PDF·CSV {current.selectedShots}컷 / {current.selectedFrames}프레임 · 전체 기록 {current.archiveShots}컷 · 총 {current.fileCount}개 파일</p><p>미디어 {current.mediaFiles}개 · {(current.mediaBytes / 1024 / 1024).toFixed(1)} MiB</p><code>{current.output}</code>{current.issues.map((issue: string): ReactElement => <p role="alert" key={issue}>{issue}</p>)}<button className="studio-primary" disabled={!current.canCreate || working !== null || recovery.blocked || attempts.blocked || receipt.blocked} onClick={(): void => { void create(); }}>검토 패키지 생성</button></section>}
    {(attempts.notice !== null || attempts.value.length > 0) && <section aria-label="검토 패키지 생성 시도"><h4>생성 시도 · 결과 다시 확인</h4>
      <p>응답을 놓쳤다면 해당 폴더를 검사해 기록을 복구하세요. 자동 재생성·덮어쓰기는 하지 않습니다. 파일이 아직 없다면 생성 상태를 확인한 뒤 다시 검사하세요.</p>
      <fieldset disabled={working !== null}>{attempts.notice}</fieldset>
      {[...attempts.value].reverse().map((attempt: ReviewDeliveryAttempt): ReactElement => <details key={attempt.requestId}>
        <summary>{attempt.input.delivery.packageName} · {attempt.input.delivery.packageVersion} · REV {attempt.input.expectedRevision} · {attempt.attemptedAt}</summary>
        <code>{attempt.output}</code><p>요청 {attempt.requestId}</p>
        {attempt.projectId !== props.project.projectId && <p role="alert">다른 프로젝트의 시도는 여기서 복구할 수 없습니다.</p>}
        <button type="button" disabled={working !== null || attempts.blocked || receipt.blocked || attempt.projectId !== props.project.projectId} onClick={(): void => { void verify(attempt); }}>파일 확인·기록 복구</button>
      </details>)}
    </section>}
    {verifiedNotice !== null && <p role="status">{verifiedNotice}</p>}
    {(receipt.notice !== null || receipt.value !== null && result === null) && <section aria-label="패키지 생성 기록 복원">{receipt.notice}{receipt.value !== null && result === null && <p role="alert">보관된 생성 기록의 프로젝트가 일치하지 않습니다. 이 프로젝트의 결과로 사용할 수 없습니다.</p>}</section>}
    {result !== null && <section className="bundle-result" aria-label="생성된 검토 패키지"><h4>패키지 생성 기록</h4><p>{result.profile === 'external' ? '외부 공유용' : '내부 제작용'} · {result.maturity === 'draft' ? '초안' : '최종'} · REV {result.revision} · {result.files.length}개 파일</p><p>생성 시각 {result.createdAt}</p><p>생성 당시의 경로·파일 기록입니다. 현재 파일 존재·내용과 지금 콘티의 최종 완료 여부를 다시 검사한 결과는 아닙니다.</p><code>{result.output}</code><button onClick={(): void => { void copyPath(); }}>폴더 경로 복사</button>{copyNotice !== '' && <p role="status">{copyNotice}</p>}<p>Finder에서 폴더로 이동(⌘⇧G)을 열어 위 경로를 붙여 넣으세요. 생성된 검토 JSON은 편집기 재가져오기 파일과 다릅니다.</p><details><summary>파일 목록·생성 당시 해시</summary>{result.files.map((file): ReactElement => <p key={file.path}><b>{file.path}</b> · {file.bytes} bytes<br/><code>{file.sha256}</code></p>)}</details></section>}
  </section>;
}

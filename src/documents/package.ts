import { assertNoErrors, contractError } from '../domain/errors.js';
import { HandoffSchema } from '../domain/schema.js';
import type { Dataset, Handoff, Issue, PackagePayload, Snapshot } from '../domain/schema.js';
import { validateTimebase } from '../domain/time.js';
import { parseJson, sha256Text } from '../importers/integrity.js';
import { compileDocuments, documentFingerprint } from './compile.js';
import { DOCUMENT_FILES, DocumentSettingsSchema } from './schema.js';
import type { DocumentSettings, DocumentSources } from './schema.js';
import { validateReviewAudit } from './review-validation.js';

export function documentSources(snapshots: readonly Snapshot[]): DocumentSources {
  const entries = DOCUMENT_FILES.map((file) => {
    const matches: Snapshot[] = snapshots.filter((snapshot: Snapshot): boolean => snapshot.id === `document-${file.key}`);
    const snapshot: Snapshot | undefined = matches[0];
    if (matches.length !== 1 || snapshot === undefined || snapshot.role !== file.role || snapshot.path !== `09_PRODUCTION/${file.name}` || !snapshot.required || snapshot.hashMode !== 'bytes-sha256') {
      throw contractError('INVALID_DOCUMENT_CONTRACT', `${file.name}: 선언된 역할·경로·필수 여부·해시 형식을 확인하세요.`, []);
    }
    return [file.key, snapshot] as const;
  });
  return Object.fromEntries(entries) as DocumentSources;
}

export function buildDocumentPackage(sources: DocumentSources, input: unknown): PackagePayload {
  const settings: DocumentSettings = DocumentSettingsSchema.parse(input);
  assertNoErrors(validateTimebase(settings.timebase), 'INVALID_TIMEBASE');
  if (settings.sourceFingerprint !== documentFingerprint(sources)) throw contractError('INVALID_DOCUMENT_FINGERPRINT', '검토 이후 입력 문서가 변경되었습니다. 다시 미리보기를 실행하세요.', []);
  if (settings.formatVersion === '1.1.0' && settings.reviewAudit === undefined) throw contractError('INVALID_DOCUMENT_REVIEW_AUDIT', '설정 1.1.0에는 입력값의 출처·확인 기록이 필요합니다.', []);
  if (settings.reviewAudit !== undefined) validateReviewAudit(sources, settings, settings.reviewAudit);
  const normalized = compileDocuments(sources, settings.bindings);
  const settingsContent: string = `${JSON.stringify(settings, null, 2)}\n`;
  const files: Snapshot[] = [...DOCUMENT_FILES.map((file): Snapshot => sources[file.key]), {
    id: 'document-settings', role: 'reference', path: 'document-settings.json', required: true, hashMode: 'bytes-sha256', sha256: sha256Text(settingsContent), content: settingsContent,
  }];
  const authority: Handoff['authority'] = [
    { field: 'timeline', fileIds: ['document-edit'] }, { field: 'units', fileIds: ['document-broadcast'] },
    { field: 'people', fileIds: ['document-broadcast', 'document-manifest', 'document-settings'] },
    { field: 'scenes', fileIds: ['document-broadcast', 'document-manifest', 'document-settings'] },
    { field: 'screen-text', fileIds: ['document-broadcast'] }, { field: 'panel-turns', fileIds: ['document-panel', 'document-broadcast'] },
  ];
  const handoff: Handoff = HandoffSchema.parse({ contractVersion: '1.0.0', adapter: 'production-documents-v1', projectId: normalized.dataset.projectId,
    packageVersion: settings.packageVersion, upstreamRevision: null, timebase: settings.timebase, profile: settings.profile,
    files: files.map(({ content: _content, ...descriptor }) => descriptor), authority });
  return { handoff, files: files.map((file) => ({ path: file.path, content: file.content })) };
}

/** 가져오기와 재열기 모두 동일한 원본·결정으로 Dataset과 검토 상태를 재계산한다. */
export function importDocumentPackage(handoff: Handoff, snapshots: readonly Snapshot[]): { dataset: Dataset; issues: Issue[] } {
  if (snapshots.length !== DOCUMENT_FILES.length + 1) throw contractError('INVALID_DOCUMENT_CONTRACT', '문서 8개와 설정 파일 하나가 필요합니다.', []);
  const sources: DocumentSources = documentSources(snapshots);
  const settingsFile: Snapshot | undefined = snapshots.find((snapshot: Snapshot): boolean => snapshot.id === 'document-settings');
  if (settingsFile === undefined) throw contractError('MISSING_DOCUMENT_SETTINGS', 'document-settings.json이 필요합니다.', []);
  const settings: DocumentSettings = DocumentSettingsSchema.parse(parseJson(settingsFile.content, settingsFile.path));
  const expected: PackagePayload = buildDocumentPackage(sources, settings);
  if (JSON.stringify(handoff) !== JSON.stringify(expected.handoff)) throw contractError('INVALID_DOCUMENT_CONTRACT', '생성된 handoff와 설정·파일 역할·기준 원본이 다릅니다. 패키지를 다시 생성하세요.', []);
  return compileDocuments(sources, settings.bindings);
}

import { hostname } from 'node:os';
import { generatorBuildFingerprint } from '../build-fingerprint.js';
import { contractError } from '../domain/errors.js';
import type { ContractError } from '../domain/errors.js';
import { auditGenerationRecords } from '../domain/generation-records.js';
import type { GenerationRecordAuditEntry } from '../domain/generation-records.js';
import type { Asset, GenerationRecord, Project } from '../domain/schema.js';
import { sha256Text } from '../importers/integrity.js';
import { stableJsonStringify } from '../io/stable-json.js';
import type { ProjectStore } from '../server/store.js';
import type { ApplyIntent } from './apply-schema.js';
import type { CodexRequest } from './schema.js';
import { requestErrorCode } from './request-lock.js';
import { codexRequestBasis } from './work.js';

export type AppliedGenerationEvidence = {
  requestId: string; projectId: string; generationRecordId: string; committedRevision: number;
  resultAssetIds: string[]; generationRecordSha256: string; resultProjectSha256: string;
  resultSha256: string | null;
};
export type ApplyEvidenceSnapshot = { current: Project; receipt: AppliedGenerationEvidence | null };
export function applyHash(value: unknown): string { return sha256Text(stableJsonStringify(value)); }
export function applyBuildHash(request: CodexRequest): string { return applyHash(generatorBuildFingerprint(request.generatorBuild)); }
export function applyError(code: string, request: CodexRequest, detail: string): ContractError {
  return Object.assign(contractError(code, `${detail} requestId=${request.id}, projectId=${request.projectId}`, []),
    { requestId: request.id, resourceId: request.id, projectId: request.projectId });
}
export function assertIntentBinding(request: CodexRequest, logicalKey: string, intent: ApplyIntent): void {
  if (intent.requestId !== request.id || intent.logicalKey !== logicalKey || intent.projectId !== request.projectId
    || intent.kind !== request.kind || intent.targetId !== request.targetId || intent.basisHash !== request.basisHash
    || intent.generationBuildSha256 !== applyBuildHash(request)
    || request.status === 'applying' && intent.owner.host !== hostname()) {
    throw applyError('CODEX_APPLY_EVIDENCE_CONFLICT', request, '적용 의도와 Request의 불변 결속이 다릅니다.');
  }
}

function assertRecordBinding(request: CodexRequest, record: GenerationRecord, introduction: Project, before: Project): void {
  const expectedModel: string = request.kind === 'proposal' ? 'codex-app-current-model' : request.kind === 'image' ? 'codex-imagegen' : 'macos-say:';
  const assets: Asset[] = record.resultAssetIds.map((id: string): Asset => {
    const asset: Asset | undefined = introduction.assets.find((candidate: Asset): boolean => candidate.id === id);
    if (asset === undefined) throw applyError('CODEX_APPLY_EVIDENCE_CONFLICT', request, '도입 Version에 결과 Asset이 없습니다.');
    return asset;
  });
  const targetMatches: boolean = request.kind === 'proposal'
    ? assets.length === 0 && record.shotIds.length > 0 && record.shotIds.every((id: string): boolean => introduction.shots.some((shot): boolean => shot.id === id && shot.segmentId === request.targetId))
    : assets.length === 1 && assets[0]?.subjectId === request.targetId && assets[0]?.kind === (request.kind === 'image' ? 'image' : 'audio');
  if (record.id !== `codex:${request.id}` || record.requestId !== request.id || record.createdAt !== request.createdAt
    || record.provider !== 'codex-app' || !(request.kind === 'speech' ? record.model.startsWith(expectedModel) : record.model === expectedModel)
    || !targetMatches || applyHash(record.generatorBuild ?? null) !== applyHash(request.generatorBuild ?? null)
    || codexRequestBasis(before, request.kind, request.targetId) !== request.basisHash) {
    throw applyError('CODEX_APPLY_EVIDENCE_CONFLICT', request, 'Generation Record와 Request의 종류·대상·Basis·Build가 일치하지 않습니다.');
  }
}

/** 저장 전에 새 Record의 Request·대상 결속을 검사한다. 이 검사는 Commit 완료 증거를 대신하지 않는다. */
export function assertPreparedGeneration(request: CodexRequest, before: Project, next: Project): GenerationRecord {
  const records: GenerationRecord[] = next.generationRecords.filter((record: GenerationRecord): boolean => record.requestId === request.id || record.id === `codex:${request.id}`);
  const record: GenerationRecord | undefined = records[0];
  if (records.length !== 1 || record === undefined) throw applyError('CODEX_APPLY_EVIDENCE_CONFLICT', request, '새 결과의 Generation Record는 정확히 하나여야 합니다.');
  assertRecordBinding(request, record, next, before);
  return record;
}

/** 실제 Version의 최초 도입 Revision만 반환한다. 현재 Target 편집과 Asset 디코딩 상태는 과거 Commit의 증거를 바꾸지 않는다. */
export async function readApplyEvidence(request: CodexRequest, store: ProjectStore): Promise<ApplyEvidenceSnapshot> {
  const { current, versions } = await applyHistory(request, store);
  if (request.status === 'applying' && request.applyIntent === undefined || request.applyIntent !== undefined && current.revision < request.applyIntent.startRevision) {
    throw applyError('CODEX_APPLY_EVIDENCE_CONFLICT', request, '적용 의도 또는 시작 Revision을 증명할 수 없습니다.');
  }
  const records: GenerationRecord[] = current.generationRecords.filter((record: GenerationRecord): boolean => record.requestId === request.id || record.id === `codex:${request.id}`);
  const audits: GenerationRecordAuditEntry[] = auditGenerationRecords(current, versions);
  const historical: GenerationRecord[] = versions.flatMap((project: Project): GenerationRecord[] => project.generationRecords)
    .filter((record: GenerationRecord): boolean => record.requestId === request.id || record.id === `codex:${request.id}`);
  if (records.length === 0 && historical.length === 0) return { current, receipt: null };
  const record: GenerationRecord | undefined = records[0];
  const audit: GenerationRecordAuditEntry | undefined = audits.find((entry: GenerationRecordAuditEntry): boolean => entry.recordId === record?.id);
  if (records.length !== 1 || record === undefined || audit?.introducedRevision === null || audit?.introducedRevision === undefined
    || !audit.validAtIntroduction || audit.recordIntegrityState !== 'unchanged' || audit.removedAtRevision !== null
    || audit.reappearedAtRevisions.length > 0 || historical.some((entry: GenerationRecord): boolean => entry.id !== record.id)) {
    throw applyError('CODEX_APPLY_EVIDENCE_CONFLICT', request, '생성 기록의 유일한 최초 Commit을 증명할 수 없습니다.');
  }
  const introduction: Project | undefined = versions.find((version: Project): boolean => version.revision === audit.introducedRevision);
  const before: Project | undefined = versions.find((version: Project): boolean => version.revision === audit.introducedRevision! - 1);
  if (introduction === undefined || before === undefined) throw applyError('CODEX_APPLY_RECEIPT_UNRESOLVED', request, '생성 도입과 직전 Version이 필요합니다.');
  assertRecordBinding(request, record, introduction, before);
  const receipt: AppliedGenerationEvidence = { requestId: request.id, projectId: request.projectId, generationRecordId: record.id,
    committedRevision: introduction.revision, resultAssetIds: [...record.resultAssetIds], generationRecordSha256: applyHash(record), resultProjectSha256: applyHash(introduction),
    resultSha256: request.applyIntent?.resultSha256 ?? (request.kind === 'image' ? introduction.assets.find((asset: Asset): boolean => asset.id === record.resultAssetIds[0])?.sha256 ?? null : null) };
  const intent: ApplyIntent | undefined = request.applyIntent;
  if (intent !== undefined && (intent.startRevision + 1 !== receipt.committedRevision || intent.generationRecordSha256 !== receipt.generationRecordSha256
    || intent.resultProjectSha256 !== receipt.resultProjectSha256)) throw applyError('CODEX_APPLY_EVIDENCE_CONFLICT', request, '영속 적용 의도와 실제 Commit 바이트가 다릅니다.');
  if (request.status === 'failed' || request.status === 'superseded' || request.status === 'completed' && request.resultRevision !== receipt.committedRevision) {
    throw Object.assign(applyError('CODEX_APPLY_EVIDENCE_CONFLICT', request, '기존 Terminal 기록과 실제 적용 Commit이 모순됩니다. 자동 수정하지 않습니다.'), { committedRevision: receipt.committedRevision });
  }
  return { current, receipt };
}

async function applyHistory(request: CodexRequest, store: ProjectStore): Promise<{ current: Project; versions: Project[] }> {
  try {
    await store.assertMutable(request.projectId);
    return await store.generationHistorySnapshot(request.projectId);
  } catch (error: unknown) {
    const code: string = requestErrorCode(error);
    throw Object.assign(applyError(code === 'PROJECT_BUSY' || code === 'AUDIT_SNAPSHOT_CHANGED' ? 'CODEX_REQUEST_APPLY_IN_PROGRESS'
      : code === 'AUDIT_CURRENT_VERSION_MISMATCH' ? 'CODEX_APPLY_EVIDENCE_CONFLICT' : 'CODEX_APPLY_RECOVERY_REQUIRED', request,
    `Project의 적용 이력 검증이 필요합니다. causeCode=${code}, cause=${error instanceof Error ? error.message : String(error)}`), { cause: error });
  }
}

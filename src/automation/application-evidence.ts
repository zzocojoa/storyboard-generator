import { contractError } from '../domain/errors.js';
import { auditGenerationRecords } from '../domain/generation-records.js';
import type { Project } from '../domain/schema.js';
import { sha256Text } from '../importers/integrity.js';
import { stableJsonStringify } from '../io/stable-json.js';
import type { ProjectSnapshotEvidence } from '../io/project.js';
import type { AutomaticApplication, AutomaticApplyReceipt } from './application-schema.js';

export function automaticHash(value: unknown): string { return sha256Text(stableJsonStringify(value)); }

export function assertAutomaticBasis(project: Project, application: AutomaticApplication): void {
  if (project.projectId !== application.projectId || project.revision !== application.basisRevision || automaticHash(project) !== application.basisProjectHash) {
    throw contractError('AUTOMATION_STALE_RESULT', `자동 제작 중 입력이 변경되었습니다. projectId=${application.projectId}, expectedRevision=${application.basisRevision}, currentRevision=${project.revision}`, []);
  }
}

/** 현재 편집 상태 대신 실제 최초 도입 Version을 적용 증거로 사용한다. */
export function automaticApplyEvidence(application: AutomaticApplication, current: Project, snapshots: readonly ProjectSnapshotEvidence[]): AutomaticApplyReceipt | null {
  const versions: readonly Project[] = snapshots.map((snapshot): Project => snapshot.project);
  const matching = (project: Project): boolean => project.generationRecords.some((record): boolean => application.records.some((value): boolean => value.id === record.id) || record.requestId === application.id);
  if (!matching(current) && !versions.some(matching)) return null;
  const revision: number = application.basisRevision + 1;
  const before = snapshots.find((value): boolean => value.project.revision === application.basisRevision);
  const introduction = snapshots.find((value): boolean => value.project.revision === revision);
  const conflict = (): never => { throw contractError('AUTOMATION_APPLY_EVIDENCE_CONFLICT', `자동 제작의 최초 적용 Version·원문·생성 기록을 증명할 수 없습니다. applicationId=${application.id}, projectId=${application.projectId}`, []); };
  if (before === undefined || introduction === undefined || current.projectId !== application.projectId
    || before.project.projectId !== application.projectId || introduction.project.projectId !== application.projectId
    || !before.projectionHashes.includes(application.basisProjectHash) || !introduction.projectionHashes.includes(application.candidateProjectHash)) conflict();
  const audits = auditGenerationRecords(current, versions);
  for (const expected of application.records) {
    const record = current.generationRecords.find((value): boolean => value.id === expected.id);
    const audit = audits.find((value): boolean => value.recordId === expected.id);
    if (record === undefined || automaticHash(record) !== expected.hash || audit?.introducedRevision !== revision
      || !audit.validAtIntroduction || audit.recordIntegrityState !== 'unchanged' || audit.removedAtRevision !== null || audit.reappearedAtRevisions.length > 0) conflict();
  }
  const primary = current.generationRecords.filter((record): boolean => record.requestId === application.id);
  if (primary.length !== 1 || primary[0]?.id !== application.id) conflict();
  for (const expected of application.assets) {
    const asset = introduction!.project.assets.find((value): boolean => value.id === expected.id);
    if (asset?.path !== expected.relativePath || asset.sha256 !== expected.hash) conflict();
  }
  return { version: 1, applicationId: application.id, applicationHash: automaticHash(application), projectId: application.projectId,
    committedRevision: revision, resultProjectHash: application.candidateProjectHash };
}

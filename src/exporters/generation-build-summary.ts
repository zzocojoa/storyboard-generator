import { generatorBuildFingerprint } from '../build-fingerprint.js';
import type { GeneratorBuildFingerprint } from '../build-fingerprint.js';
import type { GenerationRecord, Project } from '../domain/schema.js';
import { stableJsonStringify } from '../io/stable-json.js';

export type GenerationIntroduction = { record: GenerationRecord; introducedRevision: number | null };
export type KnownGenerationBuild = { fingerprint: GeneratorBuildFingerprint; recordCount: number; resultAssetCount: number };
export type GenerationBuildSummary = { knownBuilds: KnownGenerationBuild[]; legacyNullRecordCount: number; unknownFingerprintRecordCount: number; unlinkedAssetCount: number };

/** 최초 Version revision과 그 안의 append 순서를 보존하며 현재본만의 기록은 도입 미상으로 남긴다. */
export function generationIntroductions(project: Project, versions: readonly Project[]): GenerationIntroduction[] {
  const seen: Set<string> = new Set<string>(); const entries: GenerationIntroduction[] = [];
  for (const version of [...versions].filter((value: Project): boolean => value.revision <= project.revision).sort((a: Project, b: Project): number => a.revision - b.revision)) {
    for (const record of version.generationRecords) if (!seen.has(record.id)) { seen.add(record.id); entries.push({ record, introducedRevision: version.revision }); }
  }
  for (const record of project.generationRecords) if (!seen.has(record.id)) { seen.add(record.id); entries.push({ record, introducedRevision: null }); }
  return entries;
}

/** Bundle 제작 Build를 생성 Build로 대입하지 않고 실제 최초 기록의 fingerprint만 집계한다. */
export function summarizeGenerationBuilds(project: Project, introductions: readonly GenerationIntroduction[]): GenerationBuildSummary {
  const known: Map<string, { fingerprint: GeneratorBuildFingerprint; recordIds: Set<string>; assetIds: Set<string> }> = new Map();
  const linked: Set<string> = new Set<string>(); let legacyNullRecordCount: number = 0; let unknownFingerprintRecordCount: number = 0;
  for (const { record } of introductions) {
    for (const id of record.resultAssetIds) linked.add(id);
    if (record.generatorBuild === null) legacyNullRecordCount += 1;
    const fingerprint: GeneratorBuildFingerprint | null = generatorBuildFingerprint(record.generatorBuild);
    if (fingerprint === null) { unknownFingerprintRecordCount += 1; continue; }
    const key: string = stableJsonStringify(fingerprint);
    const entry = known.get(key) ?? { fingerprint, recordIds: new Set<string>(), assetIds: new Set<string>() };
    entry.recordIds.add(record.id); for (const id of record.resultAssetIds) entry.assetIds.add(id); known.set(key, entry);
  }
  return { knownBuilds: [...known.entries()].sort(([a], [b]): number => a < b ? -1 : a > b ? 1 : 0).map(([, entry]): KnownGenerationBuild => ({
    fingerprint: entry.fingerprint, recordCount: entry.recordIds.size, resultAssetCount: entry.assetIds.size })), legacyNullRecordCount, unknownFingerprintRecordCount,
    unlinkedAssetCount: project.assets.filter((asset): boolean => !linked.has(asset.id)).length };
}

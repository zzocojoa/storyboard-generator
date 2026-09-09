import { mkdir, realpath } from 'node:fs/promises';
import { basename, dirname, join, resolve, sep } from 'node:path';
import type { BuildManifest } from '../build.js';
import { collectProjectAssetReferences, currentVisualReferenceAssets } from '../domain/asset-references.js';
import { contractError } from '../domain/errors.js';
import { assertFinalReadiness, reviewFinalReadiness } from '../domain/final-readiness.js';
import type { FinalReadinessReport } from '../domain/final-readiness.js';
import { auditGenerationRecords } from '../domain/generation-records.js';
import type { GenerationRecordAuditEntry } from '../domain/generation-records.js';
import { verifyStoredAsset } from '../domain/media-inspection.js';
import type { OutputMaturity } from '../domain/output-policy.js';
import type { Asset, Issue, Project } from '../domain/schema.js';
import { isSafePackagePath, sha256Bytes, sha256Text } from '../importers/integrity.js';
import { parseProject } from '../io/project.js';
import { stableJsonStringify } from '../io/stable-json.js';
import { SafeStoreFilesystem } from '../server/safe-filesystem.js';
import { assetFailureCode, mapStoredAssetIntegrityError } from '../server/store.js';
import { createCsvProjection, renderCsvProjection } from './csv.js';
import { createPdfProjection, createPdfTextProjection, renderPdfProjection } from './pdf.js';
import type { PdfProjection } from './pdf.js';
import { redactReviewBuild, redactCsvProjection, redactPdfProjection, redactReviewJson, redactReviewText, redactionManifest, reviewProfile, reviewRedactionPatterns } from './review-redaction.js';
import type { RedactionEntry, RedactionPattern, ReviewProfile } from './review-redaction.js';
import { assertReviewStorageQuiescent, assertReviewStorageUnchanged, inspectReviewStorageHealth } from './review-storage-health.js';
import type { ReviewStorageHealth, ReviewStorageSnapshot } from './review-storage-health.js';
import { ReviewBundlePublisher } from './review-output.js';
import { generationIntroductions, summarizeGenerationBuilds } from './generation-build-summary.js';
import type { GenerationBuildSummary } from './generation-build-summary.js';

export type ReviewArchive = {
  sourceRoot: string;
  project: Project; versions: readonly Project[]; integrity: Record<string, string>;
  readiness: FinalReadinessReport; audit: GenerationRecordAuditEntry[]; auditIssues: readonly Issue[];
  storageHealth: ReviewStorageHealth; assertStorageUnchanged: () => Promise<void>;
  sourceHashes: Readonly<Record<string, string>>;
  loadAsset: (assetId: string) => Promise<Buffer>;
  assertUnchanged: () => Promise<void>;
};
export type ReviewBundleOptions = {
  output: string; maturity: OutputMaturity; fontPath: string; createdAt: string; build: BuildManifest;
  profile?: ReviewProfile; piiPatterns?: readonly string[]; includeMedia?: boolean;
};
export type ReviewFile = { path: string; content: Buffer };
export type ReviewBundleManifest = {
  profile: ReviewProfile; bundleName: string; externalImagePolicy: 'placeholder' | 'not-applicable'; embeddedImageRedaction: 'not-performed';
  projectId: string; revision: number; createdAt: string; maturity: OutputMaturity; label: string; finalReady: boolean;
  bundleBuilderBuild: BuildManifest; generationBuildSummary: GenerationBuildSummary;
  build: BuildManifest; sourceHashes: Readonly<Record<string, string>>;
  files: { path: string; sha256: string; size: number; maturity: OutputMaturity }[];
};

async function readArchiveSnapshot(fs: SafeStoreFilesystem, projectId: string): Promise<ReviewArchive> {
  const directory: string = fs.path(sha256Text(projectId));
  const currentPath: string = join(directory, 'project.json');
  const currentBytes: Buffer = await fs.read(currentPath);
  const project: Project = parseProject(JSON.parse(currentBytes.toString('utf8')) as unknown);
  if (project.projectId !== projectId) throw contractError('REVIEW_PROJECT_ID_MISMATCH', `${projectId}: 저장 디렉터리와 Project ID가 다릅니다.`, []);
  const storage: ReviewStorageSnapshot = await inspectReviewStorageHealth(fs, project);
  const assertStorageUnchanged = async (): Promise<void> => { assertReviewStorageUnchanged(storage, await inspectReviewStorageHealth(fs, project)); };
  const sourceHashes: Record<string, string> = { 'project.json': sha256Bytes(currentBytes) };
  const versions: Project[] = [];
  const versionDirectoryInvalid: boolean = storage.health.invalidEvidenceEntries.includes(`${sha256Text(projectId)}/versions`)
    || !Object.keys(storage.evidence).some((path: string): boolean => path === `${sha256Text(projectId)}/versions`);
  const versionEntries = (versionDirectoryInvalid ? [] : await fs.entries(join(directory, 'versions'))).sort((a, b): number => Number(a.name.slice(0, 6)) - Number(b.name.slice(0, 6)));
  for (const entry of versionEntries) {
    if (storage.health.invalidEvidenceEntries.includes(`${sha256Text(projectId)}/versions/${entry.name}`)) continue;
    const path: string = `versions/${entry.name}`;
    const bytes: Buffer = await fs.read(join(directory, path));
    const version: Project = parseProject(JSON.parse(bytes.toString('utf8')) as unknown);
    if (version.projectId !== projectId || version.revision !== Number(entry.name.slice(0, 6))) throw contractError('REVIEW_VERSION_INVALID', `${projectId}: ${path}의 ID·revision이 다릅니다.`, []);
    sourceHashes[path] = sha256Bytes(bytes);
    if (version.revision <= project.revision) versions.push(version);
  }
  const assertSnapshotUnchanged = async (): Promise<void> => {
    for (const [path, hash] of Object.entries(sourceHashes)) {
      if (sha256Bytes(await fs.read(join(directory, path))) !== hash) throw contractError('AUDIT_SNAPSHOT_CHANGED', `${projectId}: 읽기 전용 검토 중 ${path}가 변경됐습니다. 다시 실행하세요.`, []);
    }
    const names: string[] = (versionDirectoryInvalid ? [] : await fs.entries(join(directory, 'versions'))).map((entry): string => entry.name).sort();
    if (JSON.stringify(names) !== JSON.stringify(versionEntries.map((entry): string => entry.name).sort())) throw contractError('AUDIT_SNAPSHOT_CHANGED', `${projectId}: 검토 중 Version 목록이 변경됐습니다.`, []);
  };
  await assertSnapshotUnchanged();
  const auditIssues: readonly Issue[] = storage.health.issues.filter((value: Issue): boolean => value.code === 'AUDIT_CURRENT_VERSION_MISMATCH' || value.code === 'REVIEW_VERSION_MISSING');
  const loadAsset = async (assetId: string): Promise<Buffer> => {
    const asset: Asset | undefined = project.assets.find((candidate: Asset): boolean => candidate.id === assetId);
    if (asset === undefined) throw contractError('ASSET_NOT_FOUND', `${projectId}: ${assetId} 자산이 없습니다.`, []);
    try {
      if (!isSafePackagePath(asset.path) || !asset.path.startsWith('assets/')) throw contractError('ASSET_PATH_UNSAFE', `${asset.id}: assets 내부 경로를 확인하세요. path=${asset.path}`, []);
      const path: string = join(directory, asset.path);
      if (await fs.kind(path) === 'missing') throw contractError('ASSET_FILE_MISSING', `${asset.id}: ${asset.path} 파일이 없습니다.`, []);
      const bytes: Buffer = await fs.read(path);
      if (sha256Bytes(bytes) !== asset.sha256) throw contractError('ASSET_HASH_MISMATCH', `${asset.id}: 파일 해시가 metadata와 다릅니다.`, []);
      await verifyStoredAsset(project, asset, bytes);
      return bytes;
    } catch (error: unknown) { throw mapStoredAssetIntegrityError(error, projectId, assetId); }
  };
  const integrity: Record<string, string> = {};
  for (const asset of project.assets) {
    try {
      if (isSafePackagePath(asset.path) && asset.path.startsWith('assets/') && await fs.kind(join(directory, asset.path)) === 'file') {
        sourceHashes[asset.path] = sha256Bytes(await fs.read(join(directory, asset.path)));
      }
    } catch (error: unknown) { if (assetFailureCode(error) === null) throw error; }
    try { await loadAsset(asset.id); integrity[asset.id] = 'verified'; }
    catch (error: unknown) { const code: string | null = assetFailureCode(error); if (code === null) throw error; integrity[asset.id] = code; }
  }
  const assertUnchanged = async (): Promise<void> => {
    await assertStorageUnchanged();
    await assertSnapshotUnchanged();
    for (const asset of project.assets) {
      let actual: string = 'verified';
      try { await loadAsset(asset.id); }
      catch (error: unknown) { const code: string | null = assetFailureCode(error); if (code === null) throw error; actual = code; }
      if (actual !== integrity[asset.id]) throw contractError('AUDIT_SNAPSHOT_CHANGED', `${projectId}: ${asset.id} 무결성 상태가 검토 도중 변경됐습니다.`, []);
    }
  };
  await assertUnchanged();
  return { sourceRoot: fs.root(), project, versions, integrity, sourceHashes: canonicalSourceHashes(sourceHashes), readiness: reviewFinalReadiness(project, integrity),
    audit: auditIssues.length === 0 ? auditGenerationRecords(project, versions) : [], auditIssues, storageHealth: storage.health, assertStorageUnchanged, loadAsset, assertUnchanged };
}

/** 원본에서 mkdir·lock·heartbeat·복구를 실행하지 않고 검토 중 변경만 탐지한다. */
export async function readReviewArchive(dataRoot: string, projectId: string): Promise<ReviewArchive> {
  const fs: SafeStoreFilesystem = new SafeStoreFilesystem(dataRoot); await fs.openExisting();
  try { return await readArchiveSnapshot(fs, projectId); }
  catch (error: unknown) {
    if (!(error instanceof Error && 'code' in error && error.code === 'AUDIT_SNAPSHOT_CHANGED')) throw error;
    return readArchiveSnapshot(fs, projectId);
  }
}

export async function listReviewProjects(dataRoot: string): Promise<{ projectId: string; revision: number }[]> {
  const fs: SafeStoreFilesystem = new SafeStoreFilesystem(dataRoot); await fs.openExisting();
  const result: { projectId: string; revision: number }[] = [];
  for (const entry of await fs.entries(fs.root())) {
    if (!/^[a-f0-9]{64}$/.test(entry.name)) continue;
    const path: string = fs.path(entry.name, 'project.json');
    if (await fs.kind(path) === 'missing') continue;
    const project: Project = parseProject(JSON.parse(await fs.readText(path)) as unknown);
    if (sha256Text(project.projectId) !== entry.name) throw contractError('REVIEW_PROJECT_ID_MISMATCH', `${entry.name}: 저장된 Project ID가 다릅니다.`, []);
    result.push({ projectId: project.projectId, revision: project.revision });
  }
  return result.sort((left, right): number => left.projectId < right.projectId ? -1 : left.projectId > right.projectId ? 1 : 0);
}

export async function reviewMediaFiles(archive: ReviewArchive): Promise<ReviewFile[]> {
  const files: ReviewFile[] = [];
  for (const asset of archive.project.assets) files.push({ path: `media/${asset.path}`, content: await archive.loadAsset(asset.id) });
  return files;
}

function jsonFile(path: string, value: unknown): ReviewFile {
  return { path, content: Buffer.from(stableJsonStringify(value)) };
}

function canonicalSourceHashes(input: Readonly<Record<string, string>>): Readonly<Record<string, string>> {
  const entries: [string, string][] = Object.entries(input).map(([path, hash]): [string, string] => [path.replaceAll('\\', '/'), hash])
    .sort(([a], [b]): number => a < b ? -1 : a > b ? 1 : 0);
  if (new Set(entries.map(([path]): string => path)).size !== entries.length || entries.some(([path]): boolean => !isSafePackagePath(path))) {
    throw contractError('REVIEW_BUNDLE_PATH_INVALID', 'Source Hash 경로는 중복 없는 정규 상대경로여야 합니다.', []);
  }
  return Object.fromEntries(entries);
}

async function canonicalReviewOutput(output: string): Promise<string> {
  try { return await realpath(output); }
  catch (error: unknown) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
    return join(await canonicalReviewOutput(dirname(output)), basename(output));
  }
}

/** 검사한 Snapshot과 감사 근거를 별도 신규 디렉터리에 작성하고 원본은 변경하지 않는다. */
export async function writeReviewBundle(archive: ReviewArchive, options: ReviewBundleOptions, media: readonly ReviewFile[]): Promise<ReviewBundleManifest> {
  const profile: ReviewProfile = reviewProfile(options.profile);
  if (profile === 'external' && (options.includeMedia === true || media.length > 0)) throw contractError('REVIEW_EXTERNAL_MEDIA_FORBIDDEN', 'External Profile은 원본 Media를 포함할 수 없습니다. 이미지 검사는 수행하지 않으며 PDF는 Placeholder를 사용합니다.', []);
  await archive.assertStorageUnchanged();
  if (options.maturity === 'final') { assertReviewStorageQuiescent(archive.storageHealth); assertFinalReadiness(archive.readiness); }
  const configuredOutput: string = await canonicalReviewOutput(resolve(options.output));
  if (configuredOutput === archive.sourceRoot || configuredOutput.startsWith(`${archive.sourceRoot}${sep}`)) throw contractError('REVIEW_OUTPUT_INSIDE_SOURCE',
    '읽기 전용 검토 Bundle은 원본 Data Root 밖의 경로에 출력하세요.', []);
  const project: Project = archive.project;
  const baseLabel: string = archive.storageHealth.quiescent ? options.maturity.toUpperCase() : 'DRAFT · SOURCE NOT QUIESCENT';
  const label: string = profile === 'external' ? `${baseLabel} · EXTERNAL REDACTED` : baseLabel;
  const patterns: RedactionPattern[] = profile === 'external' ? reviewRedactionPatterns(options.piiPatterns ?? []) : [];
  const redactions: RedactionEntry[] = [];
  const displayedProjectId = redactReviewText(project.projectId, '/bundle-manifest.json/projectId', patterns); redactions.push(...displayedProjectId.entries);
  const metadata = { maturity: options.maturity, profile, label, projectId: displayedProjectId.value, revision: project.revision };
  const sourceHashes: Readonly<Record<string, string>> = Object.fromEntries(Object.entries(canonicalSourceHashes(archive.sourceHashes)).map(([path, hash]): [string, string] => {
    const redacted = redactReviewText(path, `/bundle-manifest.json/sourceHashes/key:${sha256Text(path)}`, patterns); redactions.push(...redacted.entries); return [redacted.value, hash];
  }));
  const jsonArtifact = (path: string, value: unknown): ReviewFile => {
    if (profile === 'internal') return jsonFile(path, value);
    const result = redactReviewJson(value, `/${path}`, patterns); redactions.push(...result.entries); return jsonFile(path, result.value);
  };
  const csvRows: string[][] = createCsvProjection(project, archive.integrity, { maturity: options.maturity, channel: 'csv-export', exportLabel: label });
  const csv = profile === 'external' ? redactCsvProjection(csvRows, patterns) : { rows: csvRows, entries: [] }; redactions.push(...csv.entries);
  const pdfInput: PdfProjection = profile === 'external'
    ? await createPdfTextProjection(project, { maturity: options.maturity, channel: 'pdf-export', exportLabel: label }, archive.integrity)
    : await createPdfProjection(project, archive.loadAsset, { maturity: options.maturity, channel: 'pdf-export', exportLabel: label }, archive.integrity);
  const pdf = profile === 'external' ? redactPdfProjection(pdfInput, patterns) : { projection: pdfInput, entries: [] }; redactions.push(...pdf.entries);
  const references = collectProjectAssetReferences(project);
  const introductions = generationIntroductions(project, archive.versions);
  const builder = redactReviewBuild(options.build, '/bundle-manifest.json/bundleBuilderBuild', patterns);
  const buildAlias = redactReviewBuild(options.build, '/bundle-manifest.json/build', patterns); redactions.push(...builder.entries, ...buildAlias.entries);
  const rawSummary: GenerationBuildSummary = summarizeGenerationBuilds(project, introductions);
  const generationBuildSummary: GenerationBuildSummary = { ...rawSummary, knownBuilds: rawSummary.knownBuilds.map((entry, index) => {
    const result = redactReviewText(entry.fingerprint.projectSchemaVersion, `/bundle-manifest.json/generationBuildSummary/knownBuilds/${index}/fingerprint/projectSchemaVersion`, patterns);
    redactions.push(...result.entries); return { ...entry, fingerprint: { ...entry.fingerprint, projectSchemaVersion: result.value } };
  }) };
  const files: ReviewFile[] = [
    jsonArtifact('project.json', { artifactType: profile === 'external' ? 'storyboard-redacted-review-project' : 'storyboard-review-project', artifactVersion: '1.0.0', maturity: options.maturity, profile, label, project }),
    { path: 'shots.csv', content: Buffer.from(renderCsvProjection(csv.rows)) },
    { path: 'storyboard.pdf', content: await renderPdfProjection(pdf.projection, options.fontPath, options.createdAt) },
    jsonArtifact('final-readiness.json', { ...metadata, ...archive.readiness }),
    jsonArtifact('generation-audit.json', { ...metadata, records: archive.audit, issues: archive.auditIssues, auditAvailable: archive.auditIssues.length === 0 }),
    jsonArtifact('storage-health.json', { ...metadata, ...archive.storageHealth }),
    jsonArtifact('asset-integrity.json', { ...metadata, assets: archive.integrity }),
    jsonArtifact('asset-manifest.json', { ...metadata, assets: [...project.assets].sort((a: Asset, b: Asset): number => a.id < b.id ? -1 : a.id > b.id ? 1 : 0).map((asset: Asset) => ({ ...asset,
      integrity: archive.integrity[asset.id], currentOutputUsage: [
        ...references.filter((reference): boolean => reference.assetId === asset.id && reference.relation !== 'generation-result'),
        ...project.shots.filter((shot): boolean => currentVisualReferenceAssets(project, shot).some((reference: Asset): boolean => reference.id === asset.id))
          .map((shot) => ({ relation: 'visual-reference', entityId: shot.id, assetId: asset.id })),
      ],
      generation: introductions.filter(({ record }): boolean => record.resultAssetIds.includes(asset.id))
        .map(({ record, introducedRevision }) => ({ recordId: record.id, introducedRevision, generatorBuild: record.generatorBuild, auditArtifact: `generation-audit.json#${encodeURIComponent(record.id)}` })),
    })) }),
    jsonArtifact('build-manifest.json', { ...metadata, artifactType: 'storyboard-bundle-builder-build', artifactVersion: '1.0.0', bundleBuilderBuild: options.build }),
    ...media.map((file: ReviewFile): ReviewFile => ({ ...file, path: file.path.replaceAll('\\', '/') })).sort((a: ReviewFile, b: ReviewFile): number => a.path < b.path ? -1 : a.path > b.path ? 1 : 0),
  ];
  files.push(jsonFile('redaction-manifest.json', redactionManifest(profile, label, profile === 'external' ? options.piiPatterns ?? [] : [], redactions)));
  if (new Set(files.map((file: ReviewFile): string => file.path)).size !== files.length
    || files.some((file: ReviewFile): boolean => !isSafePackagePath(file.path))) throw contractError('REVIEW_BUNDLE_PATH_INVALID', 'Bundle 경로는 중복 없는 상대경로여야 합니다.', []);
  const manifest: ReviewBundleManifest = { ...metadata, bundleName: `${displayedProjectId.value} · ${label}`, externalImagePolicy: profile === 'external' ? 'placeholder' : 'not-applicable', embeddedImageRedaction: 'not-performed', createdAt: options.createdAt, finalReady: archive.readiness.finalReady && archive.storageHealth.quiescent,
    build: buildAlias.build, bundleBuilderBuild: builder.build, generationBuildSummary, sourceHashes,
    files: files.map((file: ReviewFile) => ({ path: file.path, sha256: sha256Bytes(file.content), size: file.content.length, maturity: options.maturity })) };
  await archive.assertUnchanged();
  const parent: string = dirname(configuredOutput);
  await mkdir(parent, { recursive: true });
  const outputFs: SafeStoreFilesystem = new SafeStoreFilesystem(parent); await outputFs.openExisting();
  const output: string = outputFs.path(basename(configuredOutput));
  if (output === archive.sourceRoot || output.startsWith(`${archive.sourceRoot}${sep}`)) throw contractError('REVIEW_OUTPUT_INSIDE_SOURCE',
    '읽기 전용 검토 Bundle은 원본 Data Root 밖의 경로에 출력하세요.', []);
  const publisher: ReviewBundlePublisher = new ReviewBundlePublisher(outputFs, output);
  await publisher.publish([...files, jsonFile('bundle-manifest.json', manifest)], archive.assertUnchanged);
  return manifest;
}

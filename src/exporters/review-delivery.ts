import { readTextFont } from '../rendering/text-font.js';
import type { TextFontSource } from '../rendering/text-font-source.js';
import { lstat, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, join, sep } from 'node:path';
import type { BuildManifest } from '../build.js';
import { contractError } from '../domain/errors.js';
import { sha256Bytes, sha256Text } from '../importers/integrity.js';
import { stableJsonStringify } from '../io/stable-json.js';
import { readSelectedTextFont, textFontEnvironment } from '../rendering/text-font-source.js';
import { withTextLayoutReadiness } from '../rendering/project-text.js';
import { SafeStoreFilesystem } from '../server/safe-filesystem.js';
import { outputSelectionLabel, selectedOutputFrames, selectedOutputShots } from './output-options.js';
import { readReviewArchive, reviewMediaFiles, writeReviewBundle } from './review-bundle.js';
import type { ReviewArchive } from './review-bundle.js';
import { literalRedactionPatterns, ReviewBundleInputSchema } from './review-delivery-schema.js';
import type { ReviewBundleInput, ReviewBundlePreview, ReviewBundleResult, ReviewDeliveryCredential } from './review-delivery-schema.js';
import { reviewDeliveryReceipt } from './review-delivery-receipt.js';

export const REVIEW_WEB_MEDIA_MAX_BYTES: number = 256 * 1024 * 1024;
type DeliveryContext = { archive: ReviewArchive; input: ReviewBundleInput; preview: ReviewBundlePreview };

async function existingDirectory(path: string): Promise<string> {
  if (!isAbsolute(path)) throw contractError('INVALID_REVIEW_DIRECTORY', '저장할 상위 폴더의 절대경로를 입력하세요.', []);
  try {
    const directory: string = await realpath(path);
    if (!(await lstat(directory)).isDirectory()) throw contractError('INVALID_REVIEW_DIRECTORY', `${path}: 상위 폴더가 디렉터리가 아닙니다.`, []);
    return directory;
  } catch (error: unknown) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') throw contractError('INVALID_REVIEW_DIRECTORY', `${path}: 상위 폴더가 없습니다. 기존 폴더를 지정하면 그 안에 새 패키지 폴더를 만듭니다.`, []);
    throw error;
  }
}

export async function reviewDeliveryOutput(input: ReviewBundleInput): Promise<string> {
  const directory: string = await existingDirectory(input.directory);
  const leaf: string = `${input.delivery.packageName}-${input.delivery.packageVersion}-${input.maturity}-r${input.expectedRevision}`;
  if (Buffer.byteLength(leaf, 'utf8') > 240) throw contractError('INVALID_REVIEW_NAME', '패키지 이름·버전이 너무 깁니다. 합계 UTF-8 240바이트 이내로 줄이세요.', []);
  return join(directory, leaf);
}

/** 같은 설정·실제 저장 근거·글꼴로 미리보기와 게시를 검증하며 원본 저장소를 변경하지 않는다. */
async function deliveryContext(dataRoot: string, projectId: string, source: ReviewBundleInput, fontPath: TextFontSource, build: BuildManifest): Promise<DeliveryContext> {
  const input: ReviewBundleInput = ReviewBundleInputSchema.parse(source);
  const output: string = await reviewDeliveryOutput(input);
  const directory: string = dirname(output);
  const archive: ReviewArchive = await readReviewArchive(dataRoot, projectId);
  if (archive.project.revision !== input.expectedRevision) throw contractError('REVISION_CONFLICT', `패키지 기준 revision ${input.expectedRevision}과 현재 ${archive.project.revision}이 다릅니다. 새로고침 후 다시 확인하세요.`, []);
  if (output === archive.sourceRoot || output.startsWith(`${archive.sourceRoot}${sep}`)) throw contractError('INVALID_REVIEW_DIRECTORY', '패키지는 콘티 저장소 밖의 상위 폴더에 만드세요.', []);
  const font = await readSelectedTextFont(archive.project.textTypography, fontPath);
  const bodyFont = await readTextFont(textFontEnvironment(fontPath).defaultPath);
  const readiness = withTextLayoutReadiness(archive.project, archive.readiness, font);
  const issues: string[] = [];
  try { await lstat(output); issues.push('같은 이름의 패키지 폴더가 이미 있습니다. 이름이나 버전을 바꾸세요. 기존 폴더는 덮어쓰지 않습니다.'); }
  catch (error: unknown) { if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error; }
  let mediaBytes: number = 0;
  if (input.includeMedia) for (const asset of archive.project.assets) {
    if (archive.integrity[asset.id] !== 'verified') { issues.push(`${asset.id}: ${archive.integrity[asset.id]} — 미디어 파일을 확인하세요.`); continue; }
    mediaBytes += (await archive.loadAsset(asset.id)).length;
  }
  if (!Number.isSafeInteger(mediaBytes) || mediaBytes > REVIEW_WEB_MEDIA_MAX_BYTES) issues.push('웹 패키지의 미디어 합계는 256 MiB 이내여야 합니다. 미디어 포함 범위를 확인하세요.');
  if (input.maturity === 'final') {
    if (!readiness.finalReady) issues.push(`작품 전체의 최종 출력 검토가 ${readiness.issues.length}개 남았습니다. 검토·출력에서 해결하세요.`);
    if (!archive.storageHealth.quiescent) issues.push('저장 작업과 복구 상태를 확인한 뒤 최종 패키지를 생성하세요.');
  }
  const parent = await lstat(directory);
  const assertDestinationUnchanged = async (): Promise<void> => {
    const actual = await lstat(directory);
    if (!actual.isDirectory() || actual.dev !== parent.dev || actual.ino !== parent.ino || await realpath(directory) !== directory) {
      throw contractError('REVIEW_DELIVERY_STALE', '저장할 상위 폴더가 변경됐습니다. 생성 내용 확인을 다시 실행하세요.', []);
    }
    if ((await readSelectedTextFont(archive.project.textTypography, fontPath)).sha256 !== font.sha256 || (await readTextFont(textFontEnvironment(fontPath).defaultPath)).sha256 !== bodyFont.sha256) throw contractError('REVIEW_DELIVERY_STALE', '출력 중 글꼴이 변경됐습니다. 생성 내용 확인을 다시 실행하세요.', []);
  };
  const guardedArchive: ReviewArchive = { ...archive, assertUnchanged: async (): Promise<void> => {
    await archive.assertUnchanged(); await assertDestinationUnchanged();
  } };
  const basisSha256: string = sha256Text(stableJsonStringify({ projectId, input, sourceHashes: archive.sourceHashes, output,
    parent: { dev: parent.dev, ino: parent.ino }, fontSha256: font.sha256, bodyFontSha256: bodyFont.sha256, build }));
  const mediaFiles: number = input.includeMedia ? archive.project.assets.length : 0;
  return { archive: guardedArchive, input, preview: { basisSha256, projectId, revision: archive.project.revision, output,
    scopeLabel: outputSelectionLabel(archive.project, input.outputOptions), selectedShots: selectedOutputShots(archive.project, input.outputOptions).length,
    selectedFrames: selectedOutputFrames(archive.project, input.outputOptions).length, archiveShots: archive.project.shots.length, mediaFiles, mediaBytes,
    fileCount: 11 + mediaFiles, finalReady: readiness.finalReady && archive.storageHealth.quiescent, canCreate: issues.length === 0, issues } };
}

export async function previewReviewDelivery(dataRoot: string, projectId: string, input: ReviewBundleInput, fontPath: TextFontSource, build: BuildManifest): Promise<ReviewBundlePreview> {
  const context: DeliveryContext = await deliveryContext(dataRoot, projectId, input, fontPath, build);
  await context.archive.assertUnchanged(); return context.preview;
}

export async function createReviewDelivery(dataRoot: string, projectId: string, source: ReviewBundleInput, basisSha256: string, fontPath: TextFontSource, build: BuildManifest, credential: ReviewDeliveryCredential | null): Promise<ReviewBundleResult> {
  const context: DeliveryContext = await deliveryContext(dataRoot, projectId, source, fontPath, build);
  const input: ReviewBundleInput = context.input;
  if (context.preview.basisSha256 !== basisSha256) throw contractError('REVIEW_DELIVERY_STALE', '패키지 설정·원본·글꼴 또는 실행 버전이 변경됐습니다. 생성 내용 확인을 다시 실행하세요.', []);
  if (!context.preview.canCreate) throw contractError('REVIEW_DELIVERY_BLOCKED', context.preview.issues.join('\n'), []);
  const media = input.includeMedia ? await reviewMediaFiles(context.archive) : [];
  const createdAt: string = new Date().toISOString();
  const manifest = await writeReviewBundle(context.archive, { output: context.preview.output, maturity: input.maturity, profile: input.profile,
    ...(credential === null ? {} : { deliveryRecovery: { receipt: reviewDeliveryReceipt(projectId, input, basisSha256, credential.requestId), recoveryKey: credential.recoveryKey } }),
    includeMedia: input.includeMedia, piiPatterns: literalRedactionPatterns(input.redactTerms), delivery: input.delivery, outputOptions: input.outputOptions,
    fontPath, createdAt, build }, media);
  const published = new SafeStoreFilesystem(context.preview.output); await published.openExisting();
  const manifestBytes: Buffer = await published.read(published.path('bundle-manifest.json'));
  return { output: context.preview.output, projectId, revision: manifest.revision, createdAt, maturity: input.maturity, profile: input.profile,
    files: [...manifest.files.map((file) => ({ path: file.path, bytes: file.size, sha256: file.sha256 })),
      { path: 'bundle-manifest.json', bytes: manifestBytes.length, sha256: sha256Bytes(manifestBytes) }] };
}

import { timingSafeEqual } from 'node:crypto';
import { lstat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { contractError } from '../domain/errors.js';
import { isSafePackagePath, sha256Bytes } from '../importers/integrity.js';
import { stableJsonStringify } from '../io/stable-json.js';
import { SafeStoreFilesystem, sameFileIdentity } from '../server/safe-filesystem.js';
import { reviewDeliveryOutput } from './review-delivery.js';
import { literalRedactionPatterns, ReviewDeliveryAttemptSchema, ReviewDeliveryReceiptSchema } from './review-delivery-schema.js';
import type { ReviewBundleResult, ReviewDeliveryAttempt } from './review-delivery-schema.js';
import { REVIEW_DELIVERY_MANIFEST_MAX_BYTES, REVIEW_DELIVERY_MAX_BYTES, REVIEW_DELIVERY_MAX_FILES, reviewDeliveryProof, reviewDeliveryReceipt } from './review-delivery-receipt.js';
import { redactReviewText, reviewRedactionPatterns } from './review-redaction.js';

const basePaths: readonly string[] = ['project.json', 'shots.csv', 'storyboard.pdf', 'final-readiness.json', 'generation-audit.json',
  'storage-health.json', 'asset-integrity.json', 'asset-manifest.json', 'build-manifest.json', 'redaction-manifest.json'];
const ManifestSchema = z.object({
  deliveryReceipt: ReviewDeliveryReceiptSchema, projectId: z.string(), revision: z.number().int().nonnegative(), createdAt: z.iso.datetime(),
  maturity: z.enum(['draft', 'final']), profile: z.enum(['internal', 'external']),
  files: z.array(z.strictObject({ path: z.string().max(4096).refine(isSafePackagePath), size: z.number().int().positive().safe(),
    sha256: z.string().regex(/^[a-f0-9]{64}$/u), maturity: z.enum(['draft', 'final']) })).max(REVIEW_DELIVERY_MAX_FILES - 1),
});
type Manifest = z.infer<typeof ManifestSchema>;
const AuthenticatedManifestSchema = z.object({ deliveryProofSha256: z.string().regex(/^[a-f0-9]{64}$/u) }).catchall(z.unknown());

function changed(output: string, detail: string): never {
  throw contractError('REVIEW_DELIVERY_VERIFICATION_FAILED', `${output}: ${detail} 파일을 보존했습니다. 생성 기록과 실제 출력 폴더를 확인하세요.`, []);
}

async function verifyEntries(fs: SafeStoreFilesystem, output: string, paths: readonly string[]): Promise<void> {
  const filePaths: ReadonlySet<string> = new Set(paths);
  const expected: Set<string> = new Set(paths);
  for (const path of paths) {
    const components: string[] = path.split('/'); components.pop();
    while (components.length > 0) { expected.add(components.join('/')); components.pop(); }
  }
  const pending: string[] = ['']; const found: Set<string> = new Set();
  while (pending.length > 0) {
    const directory: string = pending.pop()!;
    for (const entry of await fs.entries(join(output, directory))) {
      const relative: string = directory === '' ? entry.name : `${directory}/${entry.name}`;
      if (!expected.has(relative)) changed(output, `생성 기록에 없는 항목 ${relative}가 있습니다.`);
      found.add(relative);
      const kind = await fs.kind(join(output, relative));
      if (kind === 'directory') pending.push(relative);
      else if (kind !== 'file' || !filePaths.has(relative)) changed(output, `${relative}의 파일 종류가 다릅니다.`);
    }
  }
  if (found.size !== expected.size) changed(output, `필수 파일 또는 폴더가 누락됐습니다: ${[...expected].filter((path): boolean => !found.has(path)).join(', ')}`);
}

/** 원본·현재 revision·실행 Build를 변경하거나 재생성하지 않고 과거 게시 파일의 완전성만 다시 증명한다. */
export async function verifyReviewDelivery(projectId: string, source: ReviewDeliveryAttempt): Promise<ReviewBundleResult> {
  const attempt: ReviewDeliveryAttempt = ReviewDeliveryAttemptSchema.parse(source);
  if (attempt.projectId !== projectId) changed(attempt.output, '요청의 프로젝트가 다릅니다.');
  const output: string = await reviewDeliveryOutput(attempt.input);
  if (output !== attempt.output) changed(output, '생성 당시 경로와 현재 입력의 경로가 다릅니다.');
  const fs: SafeStoreFilesystem = new SafeStoreFilesystem(dirname(output)); await fs.openExisting();
  const kind = await fs.kind(output);
  if (kind === 'missing') throw contractError('REVIEW_DELIVERY_NOT_FOUND', `${output}: 게시된 패키지를 찾지 못했습니다. 생성 중이면 완료 후 다시 확인하세요. 자동 재생성은 하지 않습니다.`, []);
  await fs.requireDirectory(output);
  const identity = await lstat(output);
  const manifestPath: string = join(output, 'bundle-manifest.json');
  const manifestBytes: Buffer = await fs.readBounded(manifestPath, REVIEW_DELIVERY_MANIFEST_MAX_BYTES);
  let document: unknown;
  try { document = JSON.parse(manifestBytes.toString('utf8')) as unknown; }
  catch (error: unknown) {
    if (!(error instanceof SyntaxError)) throw error;
    changed(output, `생성 기록 JSON을 읽을 수 없습니다. ${error.message}`);
  }
  const authenticated = AuthenticatedManifestSchema.safeParse(document);
  if (!authenticated.success) changed(output, '인증 가능한 생성 기록이 없습니다. 이전 버전의 패키지는 자동 복구할 수 없습니다.');
  const { deliveryProofSha256, ...unsigned } = authenticated.data;
  if (!timingSafeEqual(Buffer.from(deliveryProofSha256, 'hex'), Buffer.from(reviewDeliveryProof(unsigned, attempt.recoveryKey), 'hex'))) changed(output, '생성 기록의 인증 코드가 일치하지 않습니다.');
  const parsed = ManifestSchema.safeParse(unsigned);
  if (!parsed.success) changed(output, `검증 가능한 생성 영수증·파일 목록이 없습니다. ${parsed.error.message}`);
  const manifest: Manifest = parsed.data;
  const expected = reviewDeliveryReceipt(projectId, attempt.input, attempt.basisSha256, attempt.requestId);
  const displayedId: string = attempt.input.profile === 'external'
    ? redactReviewText(projectId, '/bundle-manifest.json/projectId', reviewRedactionPatterns(literalRedactionPatterns(attempt.input.redactTerms))).value : projectId;
  if (stableJsonStringify(manifest.deliveryReceipt) !== stableJsonStringify(expected) || manifest.projectId !== displayedId
    || manifest.revision !== attempt.input.expectedRevision || manifest.profile !== attempt.input.profile || manifest.maturity !== attempt.input.maturity) {
    changed(output, '다른 입력·요청·프로젝트의 생성 기록입니다.');
  }
  const paths: string[] = manifest.files.map((file): string => file.path);
  const totalBytes: number = manifest.files.reduce((sum: number, file): number => sum + file.size, manifestBytes.length);
  if (!Number.isSafeInteger(totalBytes) || totalBytes > REVIEW_DELIVERY_MAX_BYTES || new Set(paths).size !== paths.length
    || basePaths.some((path): boolean => !paths.includes(path))
    || paths.some((path): boolean => !basePaths.includes(path) && (!attempt.input.includeMedia || !path.startsWith('media/assets/') || path.split('/').length > 8))
    || manifest.files.some((file): boolean => file.maturity !== manifest.maturity)) changed(output, '파일 목록·크기·포함 범위가 생성 계약과 다릅니다.');
  const allPaths: string[] = [...paths, 'bundle-manifest.json'];
  await verifyEntries(fs, output, allPaths);
  // 전체 검사가 진행되는 동안 먼저 읽은 파일이 바뀌어도 성공으로 반환하지 않는다.
  for (let pass: number = 0; pass < 2; pass += 1) {
    for (const file of manifest.files) {
      const bytes: Buffer = await fs.readBounded(join(output, file.path), file.size);
      if (bytes.length !== file.size || sha256Bytes(bytes) !== file.sha256) changed(output, `${file.path}의 크기 또는 SHA-256이 생성 기록과 다릅니다.`);
    }
  }
  await verifyEntries(fs, output, allPaths);
  if (!sameFileIdentity(identity, await lstat(output)) || !manifestBytes.equals(await fs.readBounded(manifestPath, REVIEW_DELIVERY_MANIFEST_MAX_BYTES))) {
    changed(output, '검증 도중 출력 폴더 또는 생성 기록이 바뀌었습니다.');
  }
  return { output, projectId, revision: manifest.revision, createdAt: manifest.createdAt, maturity: manifest.maturity, profile: manifest.profile,
    files: [...manifest.files.map((file) => ({ path: file.path, bytes: file.size, sha256: file.sha256 })),
      { path: 'bundle-manifest.json', bytes: manifestBytes.length, sha256: sha256Bytes(manifestBytes) }] };
}

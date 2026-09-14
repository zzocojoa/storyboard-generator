import { createHmac } from 'node:crypto';
import { contractError } from '../domain/errors.js';
import { sha256Text } from '../importers/integrity.js';
import { stableJsonStringify } from '../io/stable-json.js';
import type { ReviewFile } from './review-bundle.js';
import type { ReviewBundleInput, ReviewDeliveryReceipt } from './review-delivery-schema.js';

export const REVIEW_DELIVERY_MAX_BYTES: number = 512 * 1024 * 1024;
export const REVIEW_DELIVERY_MAX_FILES: number = 20000;
export const REVIEW_DELIVERY_MANIFEST_MAX_BYTES: number = 4 * 1024 * 1024;

/** 외부 공유 패키지에도 원문 ID·수신자·경로를 노출하지 않는 생성 입력 결속을 남긴다. */
export function reviewDeliveryReceipt(projectId: string, input: ReviewBundleInput, basisSha256: string, requestId: string): ReviewDeliveryReceipt {
  return { version: '1.0.0', requestId, basisSha256, inputSha256: sha256Text(stableJsonStringify(input)), projectIdSha256: sha256Text(projectId) };
}

/** 복구 키는 브라우저에만 보관하고 패키지에는 전체 manifest의 인증 코드만 게시한다. */
export function reviewDeliveryProof(manifest: unknown, recoveryKey: string): string {
  return createHmac('sha256', Buffer.from(recoveryKey, 'hex')).update(stableJsonStringify(manifest)).digest('hex');
}

/** 웹으로 생성한 전달물은 동일한 제한 안에서 다시 검사할 수 있어야 한다. */
export function assertRecoverableReviewFiles(files: readonly ReviewFile[], manifestBytes: number): void {
  const totalBytes: number = files.reduce((sum: number, file: ReviewFile): number => sum + file.content.length, manifestBytes);
  if (files.length + 1 > REVIEW_DELIVERY_MAX_FILES || totalBytes > REVIEW_DELIVERY_MAX_BYTES || manifestBytes > REVIEW_DELIVERY_MANIFEST_MAX_BYTES) {
    throw contractError('REVIEW_DELIVERY_SIZE_LIMIT', `검토 패키지가 웹 검증 한도를 넘습니다. files=${files.length + 1}/${REVIEW_DELIVERY_MAX_FILES}, bytes=${totalBytes}/${REVIEW_DELIVERY_MAX_BYTES}, manifestBytes=${manifestBytes}/${REVIEW_DELIVERY_MANIFEST_MAX_BYTES}. 포함 범위를 줄이세요.`, []);
  }
}

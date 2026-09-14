import { z } from 'zod';
import { StoryboardOutputOptionsSchema } from './output-options.js';

export const ReviewContentPolicySchema = z.strictObject({ sourceContent: z.boolean(), generationPrompts: z.boolean() });
export type ReviewContentPolicy = z.infer<typeof ReviewContentPolicySchema>;
export const ReviewDeliverySchema = z.strictObject({
  packageName: StoryboardOutputOptionsSchema.shape.filename, packageVersion: StoryboardOutputOptionsSchema.shape.filename,
  purpose: z.enum(['production-review', 'production-handoff', 'archive']), recipient: z.string().max(120), contents: ReviewContentPolicySchema,
});
export type ReviewDelivery = z.infer<typeof ReviewDeliverySchema>;
export const ReviewBundleInputSchema = z.strictObject({
  version: z.literal('1.0.0'), expectedRevision: z.number().int().nonnegative().safe(), directory: z.string().min(1).max(4096),
  maturity: z.enum(['draft', 'final']), profile: z.enum(['internal', 'external']), includeMedia: z.boolean(), delivery: ReviewDeliverySchema,
  redactTerms: z.array(z.string().trim().min(1).max(200)).max(64).refine((terms): boolean => new Set(terms).size === terms.length, '비식별화할 문구가 중복됩니다.'),
  outputOptions: StoryboardOutputOptionsSchema,
}).superRefine((value, context): void => {
  if (value.profile === 'external' && (value.includeMedia || value.delivery.contents.sourceContent || value.delivery.contents.generationPrompts)) {
    context.addIssue({ code: 'custom', path: ['profile'], message: '외부 공유용에는 원문 전문·생성 프롬프트·미디어 파일을 포함할 수 없습니다.' });
  }
  if (value.profile === 'internal' && value.redactTerms.length > 0) context.addIssue({ code: 'custom', path: ['redactTerms'], message: '추가 비식별화 문구는 외부 공유용에서 지정하세요.' });
});
export type ReviewBundleInput = z.infer<typeof ReviewBundleInputSchema>;
export const ReviewDeliveryReceiptSchema = z.strictObject({
  version: z.literal('1.0.0'), requestId: z.uuid(), basisSha256: z.string().regex(/^[a-f0-9]{64}$/u),
  inputSha256: z.string().regex(/^[a-f0-9]{64}$/u), projectIdSha256: z.string().regex(/^[a-f0-9]{64}$/u),
});
export type ReviewDeliveryReceipt = z.infer<typeof ReviewDeliveryReceiptSchema>;
export const ReviewDeliveryCredentialSchema = z.strictObject({ requestId: z.uuid(), recoveryKey: z.string().regex(/^[a-f0-9]{64}$/u) });
export type ReviewDeliveryCredential = z.infer<typeof ReviewDeliveryCredentialSchema>;
/** 응답을 받기 전에도 생성 당시 입력과 경로를 잃지 않도록 브라우저에 먼저 보관한다. */
export const ReviewDeliveryAttemptSchema = z.strictObject({
  ...ReviewDeliveryCredentialSchema.shape, projectId: z.string().min(1), input: ReviewBundleInputSchema,
  basisSha256: z.string().regex(/^[a-f0-9]{64}$/u), output: z.string().min(1).max(4096), attemptedAt: z.iso.datetime(),
});
export type ReviewDeliveryAttempt = z.infer<typeof ReviewDeliveryAttemptSchema>;
export const ReviewBundlePreviewSchema = z.strictObject({
  basisSha256: z.string().regex(/^[a-f0-9]{64}$/u), projectId: z.string(), revision: z.number().int().nonnegative(), output: z.string(),
  scopeLabel: z.string(), selectedShots: z.number().int().nonnegative(), selectedFrames: z.number().int().nonnegative(), archiveShots: z.number().int().nonnegative(),
  mediaFiles: z.number().int().nonnegative(), mediaBytes: z.number().int().nonnegative(), fileCount: z.number().int().positive(),
  finalReady: z.boolean(), canCreate: z.boolean(), issues: z.array(z.string()),
});
export type ReviewBundlePreview = z.infer<typeof ReviewBundlePreviewSchema>;
export const ReviewBundleResultSchema = z.strictObject({
  output: z.string(), projectId: z.string(), revision: z.number().int().nonnegative(), createdAt: z.iso.datetime(),
  maturity: z.enum(['draft', 'final']), profile: z.enum(['internal', 'external']),
  files: z.array(z.strictObject({ path: z.string(), bytes: z.number().int().nonnegative(), sha256: z.string().regex(/^[a-f0-9]{64}$/u) })),
});
export type ReviewBundleResult = z.infer<typeof ReviewBundleResultSchema>;

/** 웹 입력은 정규식이 아닌 문자 그대로 비교해 임의 표현식 실행을 피한다. */
export function literalRedactionPatterns(terms: readonly string[]): string[] {
  return terms.map((term: string): string => term.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'));
}

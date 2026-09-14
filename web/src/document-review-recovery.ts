import { z } from 'zod';
import { DocumentReviewInputSchema } from '../../src/documents/review-input.js';

/** 전송 전에 요청 ID·입력을 보관한다. 사용자 수정은 유지하고 접수·완료 상태는 서버에서 다시 읽는다. */
export const DocumentReviewRecoverySchema = z.strictObject({
  requestId: z.uuid(), input: DocumentReviewInputSchema, editedKeys: z.array(z.string()), applied: z.boolean(),
});
export type DocumentReviewRecovery = z.infer<typeof DocumentReviewRecoverySchema>;

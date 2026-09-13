import { z } from 'zod';
import { IndependentStoryboardInputSchema } from '../../src/domain/storyboard-creation.js';
import type { IndependentStoryboardInput } from '../../src/domain/storyboard-creation.js';

const AttemptsSchema = z.strictObject({ version: z.literal(1), flowId: z.uuid(), inputs: z.array(IndependentStoryboardInputSchema) });
type Attempts = z.infer<typeof AttemptsSchema>;
type CreationFields = Omit<IndependentStoryboardInput, 'storyboardId'>;

/** 동일 폼의 동일 입력에는 응답 성공 여부와 관계없이 같은 생성 ID를 사용한다. 호출자는 브라우저 Lock을 보유해야 한다. */
export function prepareStoryboardAttempt(storage: Pick<Storage, 'getItem' | 'setItem'>, flowId: string, fields: CreationFields): IndependentStoryboardInput {
  z.uuid().parse(flowId);
  const key: string = `cutroom:storyboard-create:1:${flowId}`;
  const text: string | null = storage.getItem(key);
  const saved: Attempts = text === null ? { version: 1, flowId, inputs: [] } : AttemptsSchema.parse(JSON.parse(text) as unknown);
  if (saved.flowId !== flowId) throw new Error('보관한 콘티 생성 요청의 폼 ID가 다릅니다. 기존 기록을 확인하세요.');
  const matches: IndependentStoryboardInput[] = saved.inputs.filter((input): boolean => input.handoffPath === fields.handoffPath
    && input.name === fields.name && input.proposedTextHoldMs === fields.proposedTextHoldMs);
  if (matches.length > 1) throw new Error('동일 입력의 생성 ID가 중복 보관되어 있습니다. 기존 기록을 확인하세요.');
  if (matches[0] !== undefined) return matches[0];
  const input: IndependentStoryboardInput = IndependentStoryboardInputSchema.parse({ ...fields, storyboardId: crypto.randomUUID() });
  storage.setItem(key, JSON.stringify({ ...saved, inputs: [...saved.inputs, input] } satisfies Attempts));
  return input;
}

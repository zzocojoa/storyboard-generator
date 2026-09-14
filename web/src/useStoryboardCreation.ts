import type { IndependentStoryboardInput } from '../../src/domain/storyboard-creation.js';
import { prepareStoryboardAttempt } from './storyboard-creation-attempts.js';

/** 같은 입력의 재시도에는 같은 ID를 보내 중복 생성과 기존 작업 교체를 방지한다. */
export function useStoryboardCreation(onCreate: (input: IndependentStoryboardInput) => Promise<void>): (flowId: string, path: string, name: string, hold: string) => Promise<void> {
  return async (flowId: string, path: string, name: string, hold: string): Promise<void> => {
    if (!path.trim() || !name.trim() || name.trim().length > 120) throw new Error('handoff 파일 경로와 120자 이내의 새 콘티 이름을 입력하세요.');
    const duration: number = Number(hold);
    if (!Number.isSafeInteger(duration) || duration <= 0) throw new Error('초안 글자 유지 시간은 1 이상의 정수 밀리초로 입력하세요.');
    if (navigator.locks === undefined) throw new Error('콘티 중복 생성을 방지하려면 localhost 또는 HTTPS에서 브라우저 Lock 기능을 사용할 수 있어야 합니다.');
    await navigator.locks.request(`cutroom:storyboard-create:1:${flowId}`, async (): Promise<void> => {
      const input: IndependentStoryboardInput = prepareStoryboardAttempt(window.localStorage, flowId,
        { handoffPath: path.trim(), name: name.trim(), proposedTextHoldMs: duration });
      await onCreate(input);
    });
  };
}

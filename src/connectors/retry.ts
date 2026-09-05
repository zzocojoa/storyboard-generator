export type WarningLogger = (fields: Readonly<Record<string, string | number>>) => void;

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve): void => { setTimeout(resolve, milliseconds); });
}

export async function withRetry<T>(operation: string, attempts: number, backoffMs: number, logger: WarningLogger, task: (attempt: number) => Promise<T>): Promise<T> {
  if (!Number.isSafeInteger(attempts) || attempts < 1) throw new RangeError('시도 횟수는 1 이상이어야 합니다.');
  let lastError: unknown;
  for (let attempt: number = 1; attempt <= attempts; attempt += 1) {
    try {
      return await task(attempt);
    } catch (error: unknown) {
      lastError = error;
      logger({ level: 'warning', operation, attempt, attempts, errorName: error instanceof Error ? error.name : 'UnknownError', errorMessage: error instanceof Error ? error.message : String(error) });
      if (attempt < attempts) await wait(backoffMs * attempt);
    }
  }
  throw lastError;
}

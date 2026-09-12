import { execFile } from 'node:child_process';
import type { ExecFileException } from 'node:child_process';
import { contractError } from '../domain/errors.js';
import { appServerDiagnostic } from './app-server-transport.js';

export function runSpeechCommand(executable: string, args: readonly string[], cwd: string, signal: AbortSignal): Promise<string> {
  return new Promise<string>((resolve, reject): void => {
    let outcome: { error: ExecFileException | null; stdout: string; stderr: string } | null = null;
    const child = execFile(executable, [...args], { cwd, shell: false, encoding: 'utf8', maxBuffer: 64 * 1024, signal, killSignal: 'SIGKILL' },
      (error: ExecFileException | null, stdout: string, stderr: string): void => {
        outcome = { error, stdout, stderr };
      });
    child.once('close', (): void => {
        if (outcome === null) { reject(contractError('SPEECH_COMMAND_RESULT_MISSING', `음성 실행 종료 결과가 없습니다: executable=${executable}`, [])); return; }
        const { error, stdout, stderr } = outcome;
        if (error === null) { resolve(stdout); return; }
        if (signal.aborted) {
          reject(contractError(signal.reason instanceof Error && signal.reason.name === 'TimeoutError' ? 'SPEECH_GENERATION_TIMEOUT' : 'SPEECH_GENERATION_CANCELLED', '가이드 음성 생성이 제한 시간 또는 취소 요청으로 중단됐습니다.', [])); return;
        }
        reject(contractError('SPEECH_COMMAND_FAILED', `가이드 음성 실행 실패: executable=${executable}, args=${JSON.stringify(args)}, code=${String(error.code)}, signal=${String(error.signal)}, detail=${appServerDiagnostic(stderr || error.message)}`, []));
    });
  });
}

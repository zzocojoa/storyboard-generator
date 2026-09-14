import { InstalledSpeechVoiceSchema } from '../domain/speech-voice.js';
import type { InstalledSpeechVoice } from '../domain/speech-voice.js';
import { contractError } from '../domain/errors.js';
import { runSpeechCommand } from './speech-command.js';

/** 시스템이 보고한 이름과 언어만 후보로 사용한다. 행 해석 실패를 음성 부재로 숨기지 않는다. */
export function parseInstalledSpeechVoices(listing: string): InstalledSpeechVoice[] {
  const lines: string[] = listing.split(/\r?\n/u).filter((line): boolean => line.trim() !== '');
  if (lines.length === 0 || lines.length > 1024) throw contractError('SPEECH_VOICE_LIST_INVALID', `설치 음성 목록의 크기를 확인하세요: lines=${lines.length}`, []);
  const voices: InstalledSpeechVoice[] = lines.map((line, index): InstalledSpeechVoice => {
    const match = line.match(/^(.*?)\s+([a-z]{2,3}(?:[_-][A-Za-z0-9]{2,8})+)\s+#\s?(.*)$/u);
    if (match === null) throw contractError('SPEECH_VOICE_LIST_INVALID', `설치 음성 목록을 해석하지 못했습니다: line=${index + 1}. 로컬 음성 명령의 출력 형식을 확인하세요.`, []);
    return InstalledSpeechVoiceSchema.parse({ name: match[1]?.trim(), locale: match[2], sample: match[3] });
  });
  if (new Set(voices.map((voice): string => voice.name)).size !== voices.length) throw contractError('SPEECH_VOICE_LIST_AMBIGUOUS', '같은 이름의 음성이 여러 개 있어 정확한 음성을 선택할 수 없습니다. 시스템 음성 목록을 확인하세요.', []);
  return voices;
}

export async function readInstalledSpeechVoices(executable: string, cwd: string, signal: AbortSignal): Promise<InstalledSpeechVoice[]> {
  return parseInstalledSpeechVoices(await runSpeechCommand(executable, ['-v', '?'], cwd, signal));
}

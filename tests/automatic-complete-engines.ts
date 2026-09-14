import { randomUUID } from 'node:crypto';
import type { AutomationEngines } from '../src/automation/task-executor.js';

/** 화분 안내의 전체 UI 흐름은 새 자동 음성 배정 단계도 실제 실행기에 전달한다. */
export function withTestVoiceCasting(engines: AutomationEngines): AutomationEngines {
  return { ...engines, voiceCatalog: async () => [{ name: 'Yuna', locale: 'ko_KR', sample: '안녕하세요.' }],
    model: { run: async (input, signal) => {
      if (!JSON.stringify(input.outputSchema).includes('"assignments"')) return engines.model.run(input, signal);
      return { model: 'test-voice-casting', turnId: randomUUID(), result: { version: '1.0.0', status: 'ready', summary: '한국어 안내 발화의 설치 음성 배정',
        assignments: [{ speakerId: 'CHAR-01', language: 'ko', voice: { name: 'Yuna', rateWordsPerMinute: 180 }, reason: '한국어 안내 발화에 설치된 한국어 음성을 선택했습니다.' }] } };
    } } };
}

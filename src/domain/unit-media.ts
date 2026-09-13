import type { AudioCue, SourceUnit } from './schema.js';

/** 메시지·메모는 낭독하지 않으며 극중 독백은 별도 내레이션 구간과 구별한다. */
export function unitAudioKind(unit: SourceUnit): AudioCue['kind'] | null {
  switch (unit.kind) {
    case 'DIALOGUE': return unit.delivery === 'inner-monologue' ? 'voiceover' : 'dialogue';
    case 'NARRATION': return 'voiceover';
    case 'PANEL': return 'panel';
    case 'SOUND': return 'sfx';
    case 'MUSIC': return 'music';
    default: return null;
  }
}

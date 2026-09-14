import type { Project } from '../src/domain/schema.js';
import { inspectAudioFileBytes } from '../src/domain/media-inspection.js';
import { automaticPlanProject } from './automatic-plan-helpers.js';
import { pcmWav } from './helpers.js';

/** 진폭과 부호가 알려진 PCM으로 실제 표본 검사를 검증한다. */
export function levelWav(amplitude: number, bits: 16 | 24, channels: 1 | 2): Buffer {
  const bytes = pcmWav(1000, 48000, channels, bits); const width: number = bits / 8;
  for (let offset: number = 44; offset < bytes.length; offset += width) {
    const sign: number = ((offset - 44) / width) % 2 === 0 ? 1 : -1;
    bytes.writeIntLE(Math.round(amplitude * 2 ** (bits - 1)) * sign, offset, width);
  }
  return bytes;
}

export async function audioMixFixture(): Promise<{ project: Project; files: Map<string, Buffer>; speechId: string; soundId: string }> {
  const base = await automaticPlanProject(); const files: Map<string, Buffer> = new Map();
  const selected = base.audioCues.filter((cue): boolean => cue.unitId !== null && ['안내-1', '효과음'].includes(cue.unitId));
  const assets = selected.map((cue) => {
    const bytes = levelWav(0.75, 16, 1); const actual = inspectAudioFileBytes(bytes, 'audio/wav'); const id: string = `mix-${cue.id}`; files.set(id, bytes);
    return { id, kind: 'audio' as const, subjectId: cue.id, path: `assets/${id}.wav`, mimeType: 'audio/wav', sha256: actual.sha256,
      version: 1, description: '음량 검증용 PCM', durationMs: actual.durationMs, audioMetadata: { sampleRate: actual.sampleRate, channels: actual.channels, codec: actual.codec } };
  });
  const project: Project = { ...base, assets, audioCues: base.audioCues.map((cue) => selected.some((target): boolean => target.id === cue.id)
    ? { ...cue, startMs: 5000, endMs: 6000, timingStatus: 'measured', assetId: `mix-${cue.id}` } : cue) };
  return { project, files, speechId: selected.find((cue): boolean => cue.unitId === '안내-1')!.id, soundId: selected.find((cue): boolean => cue.unitId === '효과음')!.id };
}

import { audioCuesInSegment } from '../domain/audio-source.js';
import { contractError } from '../domain/errors.js';
import type { Project } from '../domain/schema.js';
import { existingAudioEvidence } from './plan-audio.js';
import type { ExistingAudioFile } from './plan-audio.js';

export type ExistingAudioLoader = (assetId: string, signal: AbortSignal) => Promise<Buffer>;
export type ExistingAudioProgress = (cueId: string, completed: number, total: number) => Promise<void>;

function assertActive(signal: AbortSignal): void {
  if (signal.aborted) throw contractError('AUTOMATION_CANCELLED', '기존 음원 검증이 중단되었습니다.', []);
}

/** 선택 구간의 모든 기존 음원을 실제 바이트와 같은 배치로 검사한다. */
export async function loadExistingAudioFiles(project: Project, segmentId: string, maxBytes: number, load: ExistingAudioLoader, progress: ExistingAudioProgress, signal: AbortSignal): Promise<ExistingAudioFile[]> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0 || maxBytes > 512 * 1024 * 1024) throw contractError('AUTOMATION_AUDIO_BUDGET', '기존 음원 검증의 바이트 한도가 유효하지 않습니다.', []);
  assertActive(signal);
  const selected = audioCuesInSegment(project, segmentId);
  const unbound = selected.find((cue): boolean => cue.timingStatus === 'measured' && cue.assetId === null);
  if (unbound !== undefined) throw contractError('AUTOMATION_EXISTING_AUDIO_REVIEW', `측정 상태에 실제 음원이 없습니다: ${unbound.id}. 음성 탭에서 파일 연결을 확인하세요.`, []);
  const cues = selected.filter((cue): boolean => cue.assetId !== null);
  const files: ExistingAudioFile[] = [];
  let totalBytes: number = 0;
  for (const cue of cues) {
    assertActive(signal);
    await progress(cue.id, files.length, cues.length);
    assertActive(signal);
    const bytes: Buffer = await load(cue.assetId!, signal);
    assertActive(signal);
    if (totalBytes + bytes.length > maxBytes) throw contractError('AUTOMATION_AUDIO_BUDGET', `기존 음원 검증 메모리 한도를 초과했습니다: maxBytes=${maxBytes}`, []);
    const file: ExistingAudioFile = { cueId: cue.id, assetId: cue.assetId!, bytes: Buffer.from(bytes) };
    existingAudioEvidence(project, file); files.push(file); totalBytes += bytes.length;
  }
  return files;
}

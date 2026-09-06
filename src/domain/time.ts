import { assertNoErrors, contractError, issue } from './errors.js';
import type { Issue, Shot, StoryboardFrame, Timebase } from './schema.js';

export function frameDisplayAbsoluteMs(shot: Shot, frame: StoryboardFrame): number {
  return shot.startMs + frame.offsetMs;
}

/** End Frame은 저장 위치를 유지하면서 컷 내부의 마지막 유효 밀리초에서 의미를 평가한다. */
export function frameEvaluationAbsoluteMs(shot: Shot, frame: StoryboardFrame): number {
  if (frame.role === 'end') return Math.max(shot.startMs, shot.endMs - 1);
  return frameDisplayAbsoluteMs(shot, frame);
}

export function secondsToMilliseconds(seconds: number): number {
  const milliseconds: number = seconds * 1000;
  const rounded: number = Math.round(milliseconds);
  const tolerance: number = Math.min(1e-7, Number.EPSILON * Math.max(1, Math.abs(milliseconds)) * 2);
  if (!Number.isSafeInteger(rounded) || seconds < 0 || Math.abs(milliseconds - rounded) > tolerance) {
    throw contractError('INVALID_TIME_PRECISION', `정수 밀리초로 표현할 수 없는 시간입니다: ${seconds}`, []);
  }
  return rounded;
}

export function parseMinuteTime(value: string): number {
  if (!/^\d{2,}:\d{2}$/u.test(value)) throw contractError('INVALID_TIMECODE', `MM:SS 형식이 필요합니다: ${value}`, []);
  const [minutes, seconds] = value.split(':').map(Number);
  if (minutes === undefined || seconds === undefined || seconds >= 60) throw contractError('INVALID_TIMECODE', `초 범위가 올바르지 않습니다: ${value}`, []);
  return secondsToMilliseconds(minutes * 60 + seconds);
}

export function formatMilliseconds(value: number): string {
  if (!Number.isSafeInteger(value) || value < 0) throw contractError('INVALID_TIME', '음수가 아닌 정수 밀리초가 필요합니다.', []);
  const hours: number = Math.floor(value / 3600000);
  const minutes: number = Math.floor(value / 60000) % 60;
  const seconds: number = Math.floor(value / 1000) % 60;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}.${String(value % 1000).padStart(3, '0')}`;
}

export function millisecondsToNearestFrame(value: number, timebase: Timebase): number {
  return Math.round(value * timebase.fpsNumerator / (1000 * timebase.fpsDenominator));
}

function elapsedFrames(value: number, timebase: Timebase): bigint {
  if (!Number.isSafeInteger(value) || value < 0) throw contractError('INVALID_TIME', '음수가 아닌 정수 밀리초가 필요합니다.', []);
  return BigInt(value) * BigInt(timebase.fpsNumerator) / (1000n * BigInt(timebase.fpsDenominator));
}

function timecodeFields(value: string): readonly [number, number, number, number] {
  const fields: number[] = value.split(/[:;]/u).map(Number);
  const [hours, minutes, seconds, frames] = fields;
  if (hours === undefined || minutes === undefined || seconds === undefined || frames === undefined) {
    throw contractError('INVALID_TIMECODE', `시작 타임코드를 해석할 수 없습니다: ${value}`, []);
  }
  return [hours, minutes, seconds, frames];
}

function startFrameNumber(timebase: Timebase, nominalFps: number): bigint {
  const [hours, minutes, seconds, frames] = timecodeFields(timebase.startTimecode);
  const nominal: bigint = BigInt(nominalFps);
  const totalMinutes: number = hours * 60 + minutes;
  const nominalFrames: bigint = BigInt(hours * 3600 + minutes * 60 + seconds) * nominal + BigInt(frames);
  if (!timebase.dropFrame) return nominalFrames;
  const droppedPerMinute: number = Math.round(nominalFps * 2 / 30);
  const dropped: number = droppedPerMinute * (totalMinutes - Math.floor(totalMinutes / 10));
  return nominalFrames - BigInt(dropped);
}

function dropFrameLabel(frameNumber: bigint, nominalFps: number): bigint {
  const droppedPerMinute: bigint = BigInt(Math.round(nominalFps * 2 / 30));
  const nominal: bigint = BigInt(nominalFps);
  const framesPer10Minutes: bigint = nominal * 600n - droppedPerMinute * 9n;
  const framesPer24Hours: bigint = (nominal * 3600n - droppedPerMinute * 54n) * 24n;
  const normalized: bigint = frameNumber % framesPer24Hours;
  const tenMinuteBlocks: bigint = normalized / framesPer10Minutes;
  const remainder: bigint = normalized % framesPer10Minutes;
  const additionalMinutes: bigint = remainder < droppedPerMinute ? 0n
    : (remainder - droppedPerMinute) / (nominal * 60n - droppedPerMinute);
  return normalized + droppedPerMinute * 9n * tenMinuteBlocks + droppedPerMinute * additionalMinutes;
}

/** Project Timebase와 시작 Timecode를 사용해 정수 프레임 산술로 표시한다. */
export function formatProjectTimecode(milliseconds: number, timebase: Timebase): string {
  assertNoErrors(validateTimebase(timebase), 'INVALID_TIMEBASE');
  const nominalFps: number = Math.round(timebase.fpsNumerator / timebase.fpsDenominator);
  const absoluteFrame: bigint = startFrameNumber(timebase, nominalFps) + elapsedFrames(milliseconds, timebase);
  const displayFrame: bigint = timebase.dropFrame ? dropFrameLabel(absoluteFrame, nominalFps) : absoluteFrame;
  const nominal: bigint = BigInt(nominalFps);
  const frames: bigint = displayFrame % nominal;
  const totalSeconds: bigint = displayFrame / nominal;
  const seconds: bigint = totalSeconds % 60n;
  const totalMinutes: bigint = totalSeconds / 60n;
  const minutes: bigint = totalMinutes % 60n;
  const hours: bigint = totalMinutes / 60n;
  const separator: string = timebase.dropFrame ? ';' : ':';
  const base: string = `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}${separator}${String(frames).padStart(2, '0')}`;
  return hours === 0n ? base : `${String(hours).padStart(2, '0')}:${base}`;
}

export function validateTimebase(timebase: Timebase): Issue[] {
  const nominalFps: number = Math.round(timebase.fpsNumerator / timebase.fpsDenominator);
  const fields: number[] = timebase.startTimecode.split(/[:;]/u).map(Number);
  const [hours, minutes, seconds, frames] = fields;
  const supportsDrop: boolean = timebase.fpsDenominator === 1001 && [30000, 60000].includes(timebase.fpsNumerator);
  const separator: string = timebase.startTimecode.charAt(8);
  const invalid: boolean = hours === undefined || minutes === undefined || seconds === undefined || frames === undefined
    || hours >= 24 || minutes >= 60 || seconds >= 60 || frames >= nominalFps || nominalFps < 1 || nominalFps > 120
    || (timebase.dropFrame && (!supportsDrop || separator !== ';')) || (!timebase.dropFrame && separator !== ':')
    || (timebase.dropFrame && minutes % 10 !== 0 && seconds === 0 && frames < nominalFps / 15);
  return invalid ? [issue('INVALID_TIMEBASE', 'error', 'handoff', 'timebase', 'FPS와 시작 타임코드의 조합을 확인하세요.', null, JSON.stringify(timebase), [])] : [];
}

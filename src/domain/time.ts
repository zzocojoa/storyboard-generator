import { contractError, issue } from './errors.js';
import type { Issue, Timebase } from './schema.js';

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

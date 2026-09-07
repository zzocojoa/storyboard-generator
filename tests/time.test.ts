import { describe, expect, it } from 'vitest';
import { formatMilliseconds, parseMinuteTime, secondsToMilliseconds, validateTimebase } from '../src/domain/time.js';

describe('정수 시간과 타임코드', (): void => {
  it('실수 표현 오차는 보존하되 밀리초보다 작은 시간을 거부한다', (): void => {
    expect(secondsToMilliseconds(1.001)).toBe(1001);
    expect(secondsToMilliseconds(0.1 + 0.2)).toBe(300);
    expect(() => secondsToMilliseconds(1.0001)).toThrowError(expect.objectContaining({ code: 'INVALID_TIME_PRECISION' }));
    expect(() => secondsToMilliseconds(Number.NaN)).toThrow();
    expect(() => secondsToMilliseconds(-0.1)).toThrow();
    expect(parseMinuteTime('25:00')).toBe(1500000);
    expect(formatMilliseconds(17500)).toBe('00:00:17.500');
    expect(() => parseMinuteTime('00:61')).toThrow();
  });

  it('드롭 프레임에서 존재하지 않는 라벨을 거부한다', (): void => {
    const base = { fpsNumerator: 30000, fpsDenominator: 1001, dropFrame: true, sampleRate: 48000 as const, startTimecode: '00:01:00;00' };
    expect(validateTimebase(base)).toHaveLength(1);
    expect(validateTimebase({ ...base, startTimecode: '00:01:00;02' })).toEqual([]);
    expect(validateTimebase({ ...base, startTimecode: '00:10:00;00' })).toEqual([]);
    expect(validateTimebase({ ...base, fpsNumerator: 24, fpsDenominator: 1 })).toHaveLength(1);
  });
});

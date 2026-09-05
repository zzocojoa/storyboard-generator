import { describe, expect, it } from 'vitest';
import { imageSize } from '../src/connectors/openai.js';

describe('OpenAI 이미지 요청 크기', (): void => {
  it('프로젝트 화면비를 Image API가 지원하는 가로·세로·정사각형 규격으로 매핑한다', (): void => {
    expect(imageSize(16, 9)).toBe('1536x1024');
    expect(imageSize(9, 16)).toBe('1024x1536');
    expect(imageSize(1, 1)).toBe('1024x1024');
  });
});

import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Project } from '../src/domain/schema.js';
import { exportProjectPdf } from '../src/exporters/pdf.js';
import { importPackage } from '../src/importers/import-package.js';
import { createSourceOutline } from '../src/proposal/outline.js';
import { nativePackage } from './helpers.js';

describe('PDF 콘티', (): void => {
  it('그림이 없는 초안도 모든 프레임을 포함한 PDF로 만든다', async (): Promise<void> => {
    const project: Project = createSourceOutline(importPackage(await nativePackage()), { proposedTextHoldMs: 2000 });
    const fontPath: string = resolve('assets/fonts/NanumGothic-Regular.ttf');
    const pdf: Buffer = await exportProjectPdf(project, fontPath, async (): Promise<Buffer> => { throw new Error('이미지 로더가 호출되면 안 됩니다.'); });
    expect(pdf.subarray(0, 5).toString('ascii')).toBe('%PDF-');
    expect(pdf.length).toBeGreaterThan(5000);
  });
});

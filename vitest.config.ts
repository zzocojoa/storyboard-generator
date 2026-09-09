import { join } from 'node:path';
import { defineConfig } from 'vitest/config';

const diagnostics: string | undefined = process.env['STORYBOARD_TEST_DIAGNOSTICS_DIR'];
// 실제 fsync·복구·디코딩 시험의 디스크 경합을 제한하고 개별 5초 한도는 유지한다.
export default defineConfig({ test: { root: '.', maxWorkers: 2, include: ['tests/**/*.test.ts'],
  ...(diagnostics === undefined ? {} : { reporters: ['default', 'json'], outputFile: { json: join(diagnostics, 'vitest-results.json') } }),
} });

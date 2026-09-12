import { join } from 'node:path';
import { defineConfig } from 'vitest/config';

const diagnostics: string | undefined = process.env['STORYBOARD_TEST_DIAGNOSTICS_DIR'];
// 실제 저장·재개 시험은 동시 fsync 경합을 피하도록 순차 실행하며 개별 5초 한도는 유지한다.
export default defineConfig({ test: { root: '.', maxWorkers: 1, include: ['tests/**/*.test.ts'],
  ...(diagnostics === undefined ? {} : { reporters: ['default', 'json'], outputFile: { json: join(diagnostics, 'vitest-results.json') } }),
} });

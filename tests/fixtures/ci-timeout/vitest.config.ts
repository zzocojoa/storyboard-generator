import { defineConfig } from 'vitest/config';

// 의도적 실패는 일반 *.test.ts 수집에서 제외하고 별도 Process에서만 실행한다.
export default defineConfig({ test: { root: '.', include: ['tests/fixtures/ci-timeout/writer.fixture.ts'], pool: 'threads', maxWorkers: 1, testTimeout: 250, hookTimeout: 2000, retry: 0 } });

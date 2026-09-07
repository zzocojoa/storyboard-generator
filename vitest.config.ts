import { defineConfig } from 'vitest/config';

export default defineConfig({ test: { root: '.', maxWorkers: 4, include: ['tests/**/*.test.ts'] } });

import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()], root: 'web', publicDir: false,
  build: { outDir: '../dist/web', emptyOutDir: true },
  server: { host: '127.0.0.1', port: 4318, proxy: { '/api': 'http://127.0.0.1:4317' } },
});

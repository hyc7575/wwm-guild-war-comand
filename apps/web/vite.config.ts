/// <reference types="vitest/config" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // e2e runs (apps/e2e) set this so source edits during a test run do not HMR-reload the pages under test
    ...(process.env.WINDS_NO_WATCH ? { watch: null, hmr: false } : {}),
    proxy: {
      '/api': { target: process.env.WINDS_API_TARGET ?? 'http://localhost:8787', changeOrigin: true, ws: true },
    },
  },
  build: { target: 'es2022' },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test/setup.ts'],
    css: false,
  },
});

import { defineConfig, devices } from '@playwright/test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const API_PORT = 8798;
const WEB_PORT = 5180;
const persist = mkdtempSync(join(tmpdir(), 'winds-e2e-'));

export default defineConfig({
  testDir: './tests',
  timeout: 60_000,
  expect: { timeout: 5_000 },
  fullyParallel: false,
  workers: 1,
  globalSetup: './global-setup.ts',
  retries: 0,
  reporter: [['list']],
  use: {
    baseURL: `http://localhost:${WEB_PORT}`,
    trace: 'retain-on-failure',
    ...devices['Desktop Chrome'],
    // the HUD hides the history list below 900px; use a wide viewport
    viewport: { width: 1280, height: 900 },
  },
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],
  webServer: [
    {
      command: `pnpm --filter @winds/server exec wrangler dev --port ${API_PORT} --inspector-port 9341 --local --persist-to ${persist}`,
      url: `http://localhost:${API_PORT}/api/health`,
      env: { WRANGLER_SEND_METRICS: 'false', CI: '1' },
      reuseExistingServer: false,
      timeout: 90_000,
    },
    {
      command: `pnpm --filter @winds/web exec vite --port ${WEB_PORT} --strictPort`,
      url: `http://localhost:${WEB_PORT}/`,
      env: { WINDS_API_TARGET: `http://localhost:${API_PORT}`, WINDS_NO_WATCH: '1' },
      reuseExistingServer: false,
      timeout: 60_000,
    },
  ],
});

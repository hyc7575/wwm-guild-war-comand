import { chromium } from '@playwright/test';

/** Visit every lazy route once so vite finishes dependency optimization before tests start (a mid-test re-optimize reloads pages). */
export default async function globalSetup() {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  const base = 'http://localhost:5180';
  for (const path of ['/', '/create', '/c/AAAAAA', '/o/AAAAAA', '/r/AAAAAA']) {
    await page.goto(base + path);
    await page.waitForLoadState('networkidle');
  }
  await browser.close();
}

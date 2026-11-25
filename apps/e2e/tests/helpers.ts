import { expect, type Browser, type BrowserContext, type Page } from '@playwright/test';

export interface Person {
  ctx: BrowserContext;
  page: Page;
}

export async function newPerson(browser: Browser, path?: string): Promise<Person> {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  if (path) await page.goto(path);
  return { ctx, page };
}

/** Commander creates a room through /create. names: one entry per party ('' = unnamed). */
export async function createRoom(browser: Browser, names: string[] = ['돌격', '수비', '']): Promise<Person & { code: string }> {
  const p = await newPerson(browser, '/create');
  const count = p.page.getByRole('textbox', { name: '파티 수' });
  await count.fill(String(names.length));
  for (let i = 0; i < names.length; i++) {
    if (names[i]) await p.page.getByLabel(`${i + 1}파티 이름 (선택)`).fill(names[i]!);
  }
  await p.page.getByRole('button', { name: '만들기' }).click();
  await expect(p.page).toHaveURL(/\/c\/[A-Z0-9]+$/);
  const code = new URL(p.page.url()).pathname.split('/').pop()!;
  await expect(p.page.getByTestId('room-code')).toHaveText(code);
  // a freshly created room opens the invite modal automatically; close it so it does not cover the console
  await expect(p.page.getByTestId('invite-code')).toHaveText(code);
  await p.page.keyboard.press('Escape');
  await expect(p.page.getByTestId('invite-code')).toHaveCount(0);
  await expect(p.page.getByTestId('party-row-1')).toBeVisible();
  return { ...p, code };
}

/** Member joins /r/CODE and picks a party number (null = 아직 모름). */
export async function joinMember(browser: Browser, code: string, party: number | null, urlCode = code): Promise<Person> {
  const p = await newPerson(browser, `/r/${urlCode}`);
  await p.page.getByTestId(party === null ? 'party-option-unknown' : `party-option-${party}`).click();
  await expect(p.page.getByTestId('status-connection')).toHaveText('연결됨');
  return p;
}

export async function memberCount(cmd: Page, n: number) {
  await expect(cmd.getByTestId('member-count')).toHaveText(`${n}명`);
}

/** Button-panel command. targets: 'all' or party numbers. */
export async function issueManual(cmd: Page, targets: 'all' | number[], action: string, location?: string) {
  if (targets === 'all') await cmd.getByTestId('console-target-all').click();
  else for (const n of targets) await cmd.getByTestId(`console-target-${n}`).click();
  await cmd.getByTestId(`console-action-${action}`).click();
  if (location) await cmd.getByTestId(`console-location-${location}`).click();
  await cmd.getByTestId('console-publish').click();
}

export async function say(cmd: Page, text: string) {
  const input = cmd.getByTestId('voice-test-input').locator('input').or(cmd.locator('input[data-testid="voice-test-input"]'));
  await input.first().fill(text);
  await input.first().press('Enter');
}

/** Assert the member's own card (action label, optional location). */
export async function expectCard(p: Page, action: string, location?: string, timeout = 5000) {
  await expect(p.getByTestId('my-card-action')).toHaveText(action, { timeout });
  if (location) await expect(p.getByTestId('my-card-location')).toHaveText(location, { timeout });
}

export const historyRows = (p: Page) => p.getByTestId('history-row');

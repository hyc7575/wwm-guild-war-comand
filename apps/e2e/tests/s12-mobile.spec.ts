import { test, expect, type Browser } from '@playwright/test';
import { issueManual, newPerson } from './helpers';

/** helpers.createRoom matches labels non-exactly ("1파티" also hits "11파티"), so 12 parties need exact matching. */
async function createTwelvePartyRoom(browser: Browser, names: string[]) {
  const p = await newPerson(browser, '/create');
  await p.page.getByRole('textbox', { name: '파티 수' }).fill(String(names.length));
  for (let i = 0; i < names.length; i++) await p.page.getByLabel(`${i + 1}파티 이름 (선택)`, { exact: true }).fill(names[i]!);
  await p.page.getByRole('button', { name: '만들기' }).click();
  await expect(p.page).toHaveURL(/\/c\/[A-Z0-9]+$/);
  const code = new URL(p.page.url()).pathname.split('/').pop()!;
  await expect(p.page.getByTestId('invite-code')).toHaveText(code);
  await p.page.keyboard.press('Escape');
  await expect(p.page.getByTestId('party-row-12')).toBeVisible();
  return { ...p, code };
}

test('12. 모바일(390x844) 12개 파티: 내 파티 명령이 첫 화면에 보이고 가로 스크롤이 없다', async ({ browser }) => {
  const names = Array.from({ length: 12 }, (_, i) => `${i + 1}가나다라마바사아자`.slice(0, 10));
  const cmd = await createTwelvePartyRoom(browser, names);

  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  const page = await ctx.newPage();
  await page.goto(`/r/${cmd.code}`);
  await page.getByTestId('party-option-9').tap();
  await expect(page.getByTestId('status-connection')).toHaveText('연결됨');

  await issueManual(cmd.page, [9], 'ATTACK', 'RIGHT');
  await expect(page.getByTestId('my-card-action')).toHaveText('공격');

  // my card is inside the first screen
  const box = await page.getByTestId('my-party-card').boundingBox();
  expect(box).not.toBeNull();
  expect(box!.y).toBeGreaterThanOrEqual(0);
  expect(box!.y + Math.min(box!.height, 200)).toBeLessThanOrEqual(844);
  await expect(page.getByTestId('my-card-action')).toBeInViewport();

  // all other 11 parties are in the grid (2 columns), none horizontally scrolls the page
  await expect(page.getByTestId('party-cell-12')).toHaveCount(1);
  await expect(page.getByTestId('party-cell-9')).toHaveCount(0);
  const noHScroll = () => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);
  expect(await noHScroll()).toBe(true);

  // largest font + "active first" option still fit
  await page.getByTestId('open-settings').tap();
  await page.getByRole('button', { name: '아주 크게' }).tap();
  await page.getByTestId('opt-active-first').tap();
  await page.keyboard.press('Escape');
  expect(await noHScroll()).toBe(true);

  await ctx.close();
  await cmd.ctx.close();
});

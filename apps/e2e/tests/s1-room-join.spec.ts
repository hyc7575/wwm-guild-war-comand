import { test, expect } from '@playwright/test';
import { createRoom, joinMember, memberCount } from './helpers';

test('1. 방 생성과 입장', async ({ browser }) => {
  const cmd = await createRoom(browser, ['돌격', '수비', '']);
  await expect(cmd.page.getByTestId('party-row-1')).toContainText('1파티 돌격');
  await expect(cmd.page.getByTestId('party-row-2')).toContainText('2파티 수비');
  await expect(cmd.page.getByTestId('party-row-3')).toContainText('3파티');
  await expect(cmd.page.getByTestId('party-row-4')).toHaveCount(0);

  // (the invite modal already auto-opened once at creation; reopen it from the button)
  await cmd.page.getByTestId('invite-open').click();
  await expect(cmd.page.getByTestId('invite-code')).toHaveText(cmd.code);
  await expect(cmd.page.getByTestId('invite-link')).toHaveValue(new RegExp(`/r/${cmd.code}$`));
  await cmd.page.getByTestId('remote-reveal').click();
  await expect(cmd.page.getByTestId('operator-link')).toHaveValue(new RegExp(`/o/${cmd.code}#`));
  await cmd.page.keyboard.press('Escape');

  // member 1 uses a lowercase code
  const m1 = await joinMember(browser, cmd.code, 1, cmd.code.toLowerCase());
  const m2 = await joinMember(browser, cmd.code, 2);
  const m3 = await joinMember(browser, cmd.code, 3);
  const m4 = await joinMember(browser, cmd.code, null);

  // presence.total = non-commander connections
  await memberCount(cmd.page, 4);
  await expect(cmd.page.getByTestId('party-row-1')).toContainText('1명');
  await expect(cmd.page.getByTestId('party-row-2')).toContainText('1명');
  await expect(cmd.page.getByTestId('party-row-3')).toContainText('1명');

  await expect(m1.page.getByTestId('my-party-selector')).toContainText('1파티 돌격');
  await expect(m3.page.getByTestId('my-party-selector')).toContainText('3파티');
  await expect(m4.page.getByTestId('my-party-selector')).toContainText('아직 모름');
  await expect(m4.page.getByTestId('unselected-hint')).toBeVisible();
  await expect(m1.page.getByTestId('status-commander')).toBeVisible();
  await expect(m1.page.getByText('4명', { exact: true })).toBeVisible();

  // picker shows live party counts
  await m4.page.getByTestId('my-party-selector').click();
  await expect(m4.page.getByTestId('party-option-1')).toContainText('1명');
  await expect(m4.page.getByTestId('party-option-3')).toContainText('1명');

  for (const p of [cmd, m1, m2, m3, m4]) await p.ctx.close();
});

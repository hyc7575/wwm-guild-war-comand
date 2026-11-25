import { test, expect } from '@playwright/test';
import { createRoom, expectCard, historyRows, issueManual, joinMember, say } from './helpers';

test('2. 수동 명령 발행/반복/정정/취소', async ({ browser }) => {
  const cmd = await createRoom(browser);
  const m1 = await joinMember(browser, cmd.code, 1);
  const m2 = await joinMember(browser, cmd.code, 2);
  const m3 = await joinMember(browser, cmd.code, 3);

  await issueManual(cmd.page, 'all', 'GATHER', 'CENTER');
  for (const m of [m1, m2, m3]) {
    await expectCard(m.page, '집결', '중앙');
    await expect(m.page.getByTestId('my-card-badge-all')).toBeVisible();
  }

  await issueManual(cmd.page, [3], 'DEFEND', 'RIGHT');
  await expectCard(m3.page, '방어', '우측');
  await expect(m3.page.getByTestId('my-card-badge-all')).toHaveCount(0);
  for (const m of [m1, m2]) {
    await expectCard(m.page, '집결', '중앙');
    await expect(m.page.getByTestId('my-card-badge-all')).toBeVisible();
  }

  // same command again within 10s -> repeat, no new history row
  const rows = await historyRows(m3.page).count();
  await issueManual(cmd.page, [3], 'DEFEND', 'RIGHT');
  await expect(m3.page.getByTestId('my-card-repeat')).toHaveText('반복 1회');
  expect(await historyRows(m3.page).count()).toBe(rows);

  // corrections only apply to the last VOICE command: issue one by voice, then correct it
  await say(cmd.page, '3파티 공격 우측');
  await expectCard(m3.page, '공격', '우측');
  await say(cmd.page, '우측 말고 좌측으로');
  await expectCard(m3.page, '공격', '좌측');
  await expect(m3.page.getByTestId('my-card-badge-corrected')).toBeVisible();
  await expect(m3.page.locator('[data-testid="history-row"][data-status="CORRECTED"]')).toHaveCount(1);
  await expectCard(m1.page, '집결', '중앙');

  // cancel last (the correction) -> the slot falls back to the previous live command
  await cmd.page.getByTestId('console-cancel-last').click();
  await expectCard(m3.page, '방어', '우측');
  await expect(m3.page.getByTestId('restore-notice')).toHaveText('이전 명령으로 복귀');
  await expect(m3.page.locator('[data-testid="history-row"][data-status="CANCELLED"]').first()).toBeVisible();

  // cancel that one from the party row -> falls back to the all-command
  await cmd.page.getByTestId('party-row-cancel-3').click();
  await expectCard(m3.page, '집결', '중앙');
  await expect(m3.page.getByTestId('my-card-badge-all')).toBeVisible();
  await expect(m3.page.getByTestId('restore-notice')).toHaveText('이전 명령으로 복귀');

  // Esc also cancels the last command (all-command is now the last one)
  await cmd.page.locator('body').click({ position: { x: 1, y: 1 } });
  await cmd.page.keyboard.press('Escape');
  await expect(m1.page.getByTestId('my-card-action')).toHaveCount(0);
  await expect(m1.page.locator('[data-testid="my-party-card"][data-empty="true"]')).toBeVisible();

  for (const p of [cmd, m1, m2, m3]) await p.ctx.close();
});

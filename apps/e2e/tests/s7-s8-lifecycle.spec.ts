import { test, expect } from '@playwright/test';
import { createRoom, joinMember, newPerson } from './helpers';

test('7. 메인오더 연결 끊김 표시', async ({ browser }) => {
  const cmd = await createRoom(browser);
  const m1 = await joinMember(browser, cmd.code, 1);
  const m2 = await joinMember(browser, cmd.code, 2);
  await expect(m1.page.getByTestId('status-commander')).not.toHaveText('메인오더 연결 끊김');

  await cmd.page.close();
  for (const m of [m1, m2]) {
    await expect(m.page.getByTestId('status-commander')).toHaveText('메인오더 연결 끊김', { timeout: 10_000 });
  }
  for (const p of [cmd, m1, m2]) await p.ctx.close();
});

test('8. 방 종료', async ({ browser }) => {
  const cmd = await createRoom(browser);
  const m1 = await joinMember(browser, cmd.code, 1);
  const m2 = await joinMember(browser, cmd.code, 2);

  await cmd.page.getByTestId('room-close').click();
  await cmd.page.getByTestId('room-close-confirm').click();
  for (const m of [m1, m2]) {
    await expect(m.page.getByTestId('room-closed')).toContainText('오더방이 종료되었습니다');
  }

  await m1.page.reload();
  await expect(m1.page.getByText('방을 찾을 수 없습니다')).toBeVisible();
  const late = await newPerson(browser, `/r/${cmd.code}`);
  await expect(late.page.getByText('방을 찾을 수 없습니다')).toBeVisible();
  await expect(late.page.getByTestId('party-picker')).toHaveCount(0);
  for (const p of [cmd, m1, m2, late]) await p.ctx.close();
});

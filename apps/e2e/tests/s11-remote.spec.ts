import { test, expect } from '@playwright/test';
import { createRoom, expectCard, joinMember } from './helpers';

test('11. 휴대폰 리모컨: /r/ 링크로 모바일 viewport가 접속해 명령을 내면 동맹원 HUD에 서브오더 라벨', async ({ browser }) => {
  const cmd = await createRoom(browser);
  const m1 = await joinMember(browser, cmd.code, 1);

  await cmd.page.getByTestId('invite-open').click();
  const remoteUrl = await cmd.page.getByTestId('remote-link').inputValue();
  expect(remoteUrl).toMatch(new RegExp(`/r/${cmd.code}#.+`));
  await expect(cmd.page.getByTestId('remote-qr')).toBeVisible();
  await cmd.page.keyboard.press('Escape');

  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  const phone = await ctx.newPage();
  await phone.goto(remoteUrl);
  await expect(phone.getByTestId('remote-status')).toContainText('연결됨');
  await expect(phone.getByTestId('room-code')).toHaveText(cmd.code);
  await expect(phone).not.toHaveURL(/#/);

  await phone.getByTestId('remote-target-1').tap();
  await phone.getByTestId('remote-action-ATTACK').tap();
  await phone.getByTestId('remote-location-RIGHT').tap();
  await phone.getByTestId('remote-publish').tap();

  await expectCard(m1.page, '공격', '우측');
  await expect(m1.page.getByTestId('my-card-issuer')).toHaveText('서브오더');
  await expect(phone.getByTestId('remote-row-1')).toContainText('공격');

  // big cancel button
  await phone.getByTestId('remote-cancel-last').tap();
  await expect(phone.getByTestId('remote-row-1')).not.toContainText('공격');

  await ctx.close();
  for (const p of [cmd, m1]) await p.ctx.close();
});

import { test, expect } from '@playwright/test';
import { createRoom, expectCard, issueManual, joinMember, newPerson, say } from './helpers';

test('6. 운영자: 인식 피드, 취소, 관리 기능 없음', async ({ browser }) => {
  const cmd = await createRoom(browser);
  const m1 = await joinMember(browser, cmd.code, 1);

  await cmd.page.getByTestId('invite-open').click();
  const opUrl = await cmd.page.getByTestId('operator-link').inputValue();
  expect(opUrl).toMatch(new RegExp(`/o/${cmd.code}#.+`));
  await cmd.page.keyboard.press('Escape');

  const op = await newPerson(browser, opUrl);
  await expect(op.page.getByTestId('room-code')).toHaveText(cmd.code);
  await expect(op.page.getByText('운영자', { exact: true })).toBeVisible();
  await expect(op.page.getByTestId('party-editor-open')).toHaveCount(0);
  await expect(op.page.getByTestId('room-close')).toHaveCount(0);
  await expect(op.page.getByTestId('invite-open')).toHaveCount(0);
  await expect(op.page.getByTestId('voice-test-input')).toHaveCount(0);
  // the token is stripped from the address bar
  await expect(op.page).not.toHaveURL(/#/);
  // operator counts as a connection
  await expect(cmd.page.getByTestId('member-count')).toHaveText('2명');

  await say(cmd.page, '1파티 중앙으로 모여');
  await expectCard(m1.page, '집결', '중앙');
  const line = op.page.getByTestId('stt-feed-line').filter({ hasText: '1파티 중앙으로 모여' });
  await expect(line).toHaveCount(1);
  await expect(line).toHaveAttribute('data-outcome', 'ISSUED');

  // operator can issue and cancel
  await issueManual(op.page, [1], 'DEFEND', 'LEFT');
  await expectCard(m1.page, '방어', '좌측');
  await op.page.getByTestId('party-row-cancel-1').click();
  await expectCard(m1.page, '집결', '중앙');
  await expect(m1.page.getByTestId('restore-notice')).toBeVisible();

  for (const p of [cmd, m1, op]) await p.ctx.close();
});

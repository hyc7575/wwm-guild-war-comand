import { test, expect } from '@playwright/test';
import { createRoom, expectCard, issueManual, joinMember, newPerson } from './helpers';

// NOTE: written before the web wiring (/s/:code) landed; not run yet.
test('9. 서브오더: 링크로 접속해 명령을 내면 동맹원 HUD에 서브오더 라벨', async ({ browser }) => {
  const cmd = await createRoom(browser);
  const m1 = await joinMember(browser, cmd.code, 1);

  await cmd.page.getByTestId('invite-open').click();
  const subUrl = await cmd.page.getByTestId('sub-link').inputValue();
  expect(subUrl).toMatch(new RegExp(`/s/${cmd.code}#.+`));
  await cmd.page.keyboard.press('Escape');

  const sub = await newPerson(browser, subUrl);
  await expect(sub.page.getByTestId('room-code')).toHaveText(cmd.code);
  // no admin controls for a sub-commander
  await expect(sub.page.getByTestId('party-editor-open')).toHaveCount(0);
  await expect(sub.page.getByTestId('room-close')).toHaveCount(0);
  await expect(sub.page.getByTestId('invite-open')).toHaveCount(0);
  await expect(sub.page).not.toHaveURL(/#/);

  // main commander issues first: labelled 메인오더
  await issueManual(cmd.page, [1], 'GATHER', 'CENTER');
  await expectCard(m1.page, '집결', '중앙');
  await expect(m1.page.getByTestId('my-card-issuer')).toHaveText('메인오더');

  // sub-commander issues to the same party: latest wins, labelled 서브오더
  await issueManual(sub.page, [1], 'DEFEND', 'LEFT');
  await expectCard(m1.page, '방어', '좌측');
  await expect(m1.page.getByTestId('my-card-issuer')).toHaveText('서브오더');

  for (const p of [cmd, m1, sub]) await p.ctx.close();
});

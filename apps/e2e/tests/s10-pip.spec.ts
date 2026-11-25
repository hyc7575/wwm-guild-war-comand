import { test, expect } from '@playwright/test';
import { createRoom, issueManual, joinMember } from './helpers';

test('10. 작은 창(Document PiP): 열기 -> 명령 표시 -> 닫으면 본 창 복귀', async ({ browser }) => {
  const cmd = await createRoom(browser);
  const m3 = await joinMember(browser, cmd.code, 3);
  const supported = await m3.page.evaluate(() => 'documentPictureInPicture' in window);
  test.skip(!supported, 'Document Picture-in-Picture API 없음 (이 브라우저/헤드리스에서는 지원 안 됨)');

  await issueManual(cmd.page, [3], 'DEFEND', 'RIGHT');
  await expect(m3.page.getByTestId('my-card-action')).toHaveText('방어');

  await m3.page.getByTestId('open-pip').click();
  await expect(m3.page.getByTestId('pip-active')).toBeVisible();
  const pipPage = m3.ctx.pages().find((p) => p !== m3.page);
  test.skip(!pipPage, 'PiP 창이 Playwright 페이지로 노출되지 않음');
  await expect(pipPage!.getByTestId('pip-card-action')).toHaveText('방어');

  await issueManual(cmd.page, [3], 'ATTACK', 'LEFT');
  await expect(pipPage!.getByTestId('pip-card-action')).toHaveText('공격');

  await pipPage!.getByTestId('pip-return').click();
  await expect(m3.page.getByTestId('my-card-action')).toHaveText('공격');
});

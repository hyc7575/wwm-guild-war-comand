import { test, expect } from '@playwright/test';
import { createRoom, expectCard, joinMember, say } from './helpers';

test('3. 음성 파이프라인 (가짜 음성 입력)', async ({ browser }) => {
  const cmd = await createRoom(browser);
  const m1 = await joinMember(browser, cmd.code, 1);
  const m2 = await joinMember(browser, cmd.code, 2);
  const m3 = await joinMember(browser, cmd.code, 3);

  // high confidence -> auto issue, fast
  const t0 = Date.now();
  await say(cmd.page, '1파티 2파티 중앙으로 모여');
  await expectCard(m1.page, '집결', '중앙', 2000);
  await expectCard(m2.page, '집결', '중앙', 2000);
  expect(Date.now() - t0).toBeLessThan(2500);
  await expect(m3.page.locator('[data-testid="my-party-card"][data-empty="true"]')).toBeVisible();

  // chatter -> nothing
  await say(cmd.page, '상대 인원이 생각보다 많네요');
  await expect(cmd.page.getByTestId('subtitle-line').filter({ hasText: '상대 인원이' })).toHaveCount(1);
  await expect(cmd.page.getByTestId('candidate-card')).toHaveCount(0);
  await expect(m3.page.locator('[data-testid="my-party-card"][data-empty="true"]')).toBeVisible();

  // ambiguous -> candidate on the commander only
  await say(cmd.page, '중앙으로 모여');
  await expect(cmd.page.getByTestId('candidate-card')).toBeVisible();
  await expect(m3.page.locator('[data-testid="my-party-card"][data-empty="true"]')).toBeVisible();
  await expectCard(m1.page, '집결', '중앙');
  await cmd.page.getByTestId('candidate-publish').click();
  await expectCard(m3.page, '집결', '중앙');
  await expect(m3.page.getByTestId('my-card-badge-all')).toBeVisible();
  await expect(cmd.page.getByTestId('candidate-card')).toHaveCount(0);

  // cancel by voice
  await say(cmd.page, '방금 거 취소');
  await expect(m3.page.locator('[data-testid="my-party-card"][data-empty="true"]')).toBeVisible();
  await expect(m3.page.locator('[data-testid="history-row"][data-status="CANCELLED"]').first()).toBeVisible();

  for (const p of [cmd, m1, m2, m3]) await p.ctx.close();
});

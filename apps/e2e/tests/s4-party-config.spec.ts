import { test, expect } from '@playwright/test';
import { createRoom, expectCard, issueManual, joinMember } from './helpers';

test('4. 파티 구성 실시간 변경', async ({ browser }) => {
  const cmd = await createRoom(browser);
  const m1 = await joinMember(browser, cmd.code, 1);
  const m2 = await joinMember(browser, cmd.code, 2);
  const m3 = await joinMember(browser, cmd.code, 3);

  await issueManual(cmd.page, [3], 'ATTACK', 'LEFT');
  await expectCard(m3.page, '공격', '좌측');
  await expect(m1.page.getByTestId('party-cell-3')).toContainText('공격');

  await cmd.page.getByTestId('party-editor-open').click();
  await cmd.page.getByTestId('party-editor-name-1').fill('본대');
  await cmd.page.getByTestId('party-editor-add').click();
  await cmd.page.getByTestId('party-editor-name-3').fill('예비');
  await cmd.page.getByTestId('party-editor-delete-2').click();
  await cmd.page.getByTestId('party-editor-apply').click();
  // party 3 had a member and a live command: confirmation first
  await expect(cmd.page.getByTestId('party-editor-confirm')).toBeVisible();
  await cmd.page.getByTestId('party-editor-confirm-apply').click();
  await expect(cmd.page.getByTestId('party-editor-apply')).toHaveCount(0);

  // the added party takes the freed slot: 돌격 / 본대 / 예비
  await expect(cmd.page.getByTestId('party-row-2')).toContainText('2파티 본대');
  await expect(cmd.page.getByTestId('party-row-3')).toContainText('3파티 예비');
  await expect(cmd.page.getByTestId('party-row-4')).toHaveCount(0);

  // members see the new grid within 5s
  // (the grid omits the member's own party)
  await expect(m1.page.getByTestId('party-cell-2')).toContainText('본대');
  await expect(m1.page.getByTestId('party-cell-3')).toContainText('예비');
  await expect(m1.page.getByTestId('party-cell-4')).toHaveCount(0);
  await expect(m2.page.getByTestId('party-cell-1')).toContainText('돌격');
  await expect(m2.page.getByTestId('party-cell-3')).toContainText('예비');
  await expect(m2.page.getByTestId('party-cell-4')).toHaveCount(0);
  // member 2 keeps the selection (renamed), member 3 must pick again
  await expect(m2.page.getByTestId('my-party-selector')).toContainText('2파티 본대');
  await expect(m3.page.getByTestId('party-picker')).toBeVisible();
  await expect(m3.page.getByTestId('party-option-3')).toContainText('예비');

  // the party-3-only command was cancelled because the party was removed
  await m1.page.getByTestId('history-filter-all').click();
  const cancelled = m1.page.locator('[data-testid="history-row"][data-status="CANCELLED"]');
  await expect(cancelled).toHaveCount(1);
  await expect(cancelled).toContainText('취소: 파티 삭제');

  // member 3 picks the new party 3
  await m3.page.getByTestId('party-option-3').click();
  await expect(m3.page.getByTestId('my-party-selector')).toContainText('3파티 예비');
  await expect(m3.page.getByTestId('my-party-card')).toHaveAttribute('data-empty', 'true');

  for (const p of [cmd, m1, m2, m3]) await p.ctx.close();
});

import { test, expect } from '@playwright/test';
import { createRoom, expectCard, issueManual, joinMember } from './helpers';

test('5a. 멤버 오프라인 복구와 새로고침', async ({ browser }) => {
  const cmd = await createRoom(browser);
  const m3 = await joinMember(browser, cmd.code, 3);
  await issueManual(cmd.page, [3], 'DEFEND', 'RIGHT');
  await expectCard(m3.page, '방어', '우측');

  await m3.ctx.setOffline(true);
  await expect(m3.page.getByTestId('banner-offline')).toBeVisible();
  await expect(m3.page.getByTestId('my-party-card')).toHaveAttribute('data-dimmed', 'true');
  await expect(m3.page.getByTestId('status-connection')).toHaveText(/인터넷 연결 없음|다시 연결/);

  await issueManual(cmd.page, [3], 'ATTACK', 'LEFT');
  await expect(cmd.page.getByTestId('party-row-3')).toContainText('공격');

  await m3.ctx.setOffline(false);
  await expectCard(m3.page, '공격', '좌측', 10_000);
  await expect(m3.page.getByTestId('banner-offline')).toHaveCount(0);
  await expect(m3.page.getByTestId('my-party-card')).not.toHaveAttribute('data-dimmed', 'true');
  await expect(m3.page.getByTestId('my-party-selector')).toContainText('3파티');
  await expect(m3.page.getByTestId('status-connection')).toHaveText('연결됨');

  // reload keeps party selection and current command
  await m3.page.reload();
  await expect(m3.page.getByTestId('party-picker')).toHaveCount(0);
  await expect(m3.page.getByTestId('my-party-selector')).toContainText('3파티');
  await expectCard(m3.page, '공격', '좌측');

  for (const p of [cmd, m3]) await p.ctx.close();
});

test('5b. 메인오더 새로고침은 역할과 콘솔 상태를 유지', async ({ browser }) => {
  const cmd = await createRoom(browser);
  const m1 = await joinMember(browser, cmd.code, 1);
  await issueManual(cmd.page, [1], 'GATHER', 'CENTER');
  await expectCard(m1.page, '집결', '중앙');

  await cmd.page.reload();
  await expect(cmd.page.getByTestId('room-code')).toHaveText(cmd.code);
  await expect(cmd.page.getByTestId('party-row-1')).toContainText('집결');
  await expect(cmd.page.getByTestId('party-editor-open')).toBeVisible();
  await expect(cmd.page.getByTestId('member-count')).toHaveText('1명');
  // STT is not running after a reload: the slot shows the placeholder or the start prompt (no auto-listen)
  const slot = cmd.page.getByTestId('stt-slot');
  await expect(slot).toBeVisible();
  await expect(slot).toContainText(/미연결|준비 중|음성인식 시작|다시 시작/);
  await expect(slot).not.toContainText('듣는 중');
  // still able to command after the reload
  await issueManual(cmd.page, [1], 'DEFEND', 'LEFT');
  await expectCard(m1.page, '방어', '좌측');

  for (const p of [cmd, m1]) await p.ctx.close();
});

import { useState, type ReactNode } from 'react';
import { Badge, Button, Group, Modal, Paper, Stack, Text } from '@mantine/core';
import { useRoomStore } from '../../state/roomStore';
import { useConsole } from './ConsoleProvider';
import { InviteModal } from './InviteModal';

interface Props {
  mode: 'commander' | 'operator';
  code: string;
  operatorToken?: string;
  subCommanderToken?: string;
  roleLabel?: string;
  sttSlot?: ReactNode;
  openInvite?: boolean;
}

export function TopBar({ mode, code, operatorToken, subCommanderToken, roleLabel, sttSlot, openInvite }: Props) {
  const c = useConsole();
  const total = useRoomStore((s) => s.presence.total);
  const [invite, setInvite] = useState(!!openInvite);
  const [closing, setClosing] = useState(false);

  return (
    <Paper withBorder p="xs">
      <Group justify="space-between" wrap="wrap" gap="sm">
        <Group gap="md">
          {mode === 'commander' ? sttSlot : <Badge color="grape">{roleLabel ?? '운영자'}</Badge>}
          <Text>
            방 <Text span fw={700} data-testid="room-code">{code}</Text> · <span data-testid="member-count">{total}명</span>
          </Text>
        </Group>
        {mode === 'commander' && (
          <Group gap="xs">
            <Button variant="default" onClick={() => setInvite(true)} data-testid="invite-open">
              초대 링크
            </Button>
            <Button color="red" variant="light" onClick={() => setClosing(true)} data-testid="room-close">
              방 종료
            </Button>
          </Group>
        )}
      </Group>
      {mode === 'commander' && (
        <>
          <InviteModal opened={invite} onClose={() => setInvite(false)} code={code} operatorToken={operatorToken} subCommanderToken={subCommanderToken} />
          <Modal opened={closing} onClose={() => setClosing(false)} title="방을 종료할까요?" centered transitionProps={{ duration: 0 }}>
            <Stack>
              <Text>종료하면 모든 동맹원의 연결이 끊기고 되돌릴 수 없습니다.</Text>
              <Group justify="flex-end">
                <Button variant="default" onClick={() => setClosing(false)}>
                  취소
                </Button>
                <Button
                  color="red"
                  onClick={() => {
                    c.closeRoom();
                    setClosing(false);
                  }}
                  data-testid="room-close-confirm"
                >
                  방 종료
                </Button>
              </Group>
            </Stack>
          </Modal>
        </>
      )}
    </Paper>
  );
}

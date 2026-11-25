import { useEffect, useRef } from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router';
import { Anchor, Stack, Text } from '@mantine/core';
import { normalizeRoomCode } from '@winds/protocol';
import { RoomSession } from '../net/RoomSession';
import { loadRoomTokens } from '../net/session';
import { NoticeToast } from '../shared/NoticeToast';
import { StatusBar } from '../shared/StatusBar';
import { useRoomStore } from '../state/roomStore';
import { Console } from './console/Console';
import { ConsoleProvider } from './console/ConsoleProvider';
import { ClosedSummary } from './summary/ClosedSummary';

/** /c/:code: the F08 commander console. */
export default function CommanderRoomPage() {
  const code = normalizeRoomCode(useParams().code ?? '');
  const tokens = loadRoomTokens(code);
  const location = useLocation();
  const navigate = useNavigate();
  // FR-F01-2: arriving from /create opens the invite modal once (state is cleared so a reload does not reopen it).
  const justCreated = useRef((location.state as { justCreated?: boolean } | null)?.justCreated === true).current;
  useEffect(() => {
    if (justCreated) navigate(location.pathname, { replace: true, state: null });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  if (!tokens.commanderToken) {
    return (
      <Stack p="md" maw={560} mx="auto" mt="xl">
        <Text role="alert" fw={700}>
          이 브라우저에는 이 방의 메인오더 권한이 없습니다
        </Text>
        <Anchor component={Link} to="/">
          처음으로
        </Anchor>
      </Stack>
    );
  }
  return (
    <RoomSession code={code} role="COMMANDER" token={tokens.commanderToken}>
      <CommanderBody code={code} operatorToken={tokens.operatorToken} subCommanderToken={tokens.subCommanderToken} openInvite={justCreated} />
    </RoomSession>
  );
}

function CommanderBody({ code, operatorToken, subCommanderToken, openInvite }: { code: string; operatorToken?: string; subCommanderToken?: string; openInvite?: boolean }) {
  const connection = useRoomStore((s) => s.connection);
  return (
    <>
      <StatusBar />
      {connection === 'REPLACED' && (
        <Text p="md" fw={700}>
          다른 탭에서 열렸습니다. 이 탭은 더 이상 명령을 보낼 수 없습니다.
        </Text>
      )}
      <ConsoleProvider mode="commander">
        <ClosedSummary />
        <Console mode="commander" code={code} operatorToken={operatorToken} subCommanderToken={subCommanderToken} openInvite={openInvite} />
      </ConsoleProvider>
      <NoticeToast />
    </>
  );
}

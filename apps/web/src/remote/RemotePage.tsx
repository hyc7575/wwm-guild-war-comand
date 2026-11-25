import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router';
import { Anchor, Stack, Text } from '@mantine/core';
import { normalizeRoomCode } from '@winds/protocol';
import { RoomSession } from '../net/RoomSession';
import { loadRoomTokens, saveRoomTokens } from '../net/session';
import { NoticeToast } from '../shared/NoticeToast';
import { ConsoleProvider } from '../commander/console/ConsoleProvider';
import { RemoteConsole } from './RemoteConsole';

/**
 * /r/:code#token. The token is the sub-commander token the main commander handed to the phone.
 * It lives only in the URL fragment (never sent to the server); stored locally, then removed from the address bar.
 */
export default function RemotePage() {
  const code = normalizeRoomCode(useParams().code ?? '');
  const [token, setToken] = useState<string | undefined>(() => {
    const fromHash = location.hash.replace(/^#/, '');
    if (fromHash) saveRoomTokens(code, { subCommanderToken: fromHash });
    return fromHash || loadRoomTokens(code).subCommanderToken;
  });

  useEffect(() => {
    if (location.hash) history.replaceState(null, '', location.pathname + location.search);
    setToken((t) => t ?? loadRoomTokens(code).subCommanderToken);
  }, [code]);

  if (!token) {
    return (
      <Stack p="md" maw={560} mx="auto" mt="xl">
        <Text role="alert" fw={700}>
          리모컨 링크가 올바르지 않습니다
        </Text>
        <Anchor component={Link} to="/">
          처음으로
        </Anchor>
      </Stack>
    );
  }
  return (
    <RoomSession code={code} role="SUB_COMMANDER" token={token}>
      <ConsoleProvider mode="operator">
        <RemoteConsole code={code} />
      </ConsoleProvider>
      <NoticeToast />
    </RoomSession>
  );
}

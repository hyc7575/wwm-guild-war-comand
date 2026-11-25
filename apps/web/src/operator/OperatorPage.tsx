import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router';
import { Anchor, Stack, Text } from '@mantine/core';
import { normalizeRoomCode } from '@winds/protocol';
import { RoomSession } from '../net/RoomSession';
import { loadRoomTokens, saveRoomTokens } from '../net/session';
import { NoticeToast } from '../shared/NoticeToast';
import { StatusBar } from '../shared/StatusBar';
import { Console } from '../commander/console/Console';
import { ConsoleProvider } from '../commander/console/ConsoleProvider';

/** /o/:code#token (operator). Stores the token from the URL fragment, then connects as OPERATOR. */
export default function OperatorPage() {
  const code = normalizeRoomCode(useParams().code ?? '');
  const [token, setToken] = useState<string | undefined>(() => {
    const fromHash = location.hash.replace(/^#/, '');
    if (fromHash) saveRoomTokens(code, { operatorToken: fromHash });
    return fromHash || loadRoomTokens(code).operatorToken;
  });

  useEffect(() => {
    // Keep the token out of the address bar / history once stored.
    if (location.hash) history.replaceState(null, '', location.pathname + location.search);
    setToken((t) => t ?? loadRoomTokens(code).operatorToken);
  }, [code]);

  if (!token) {
    return (
      <Stack p="md" maw={560} mx="auto" mt="xl">
        <Text role="alert" fw={700}>
          운영자 링크가 올바르지 않습니다
        </Text>
        <Anchor component={Link} to="/">
          처음으로
        </Anchor>
      </Stack>
    );
  }
  return (
    <RoomSession code={code} role="OPERATOR" token={token}>
      <OperatorBody code={code} />
    </RoomSession>
  );
}

function OperatorBody({ code }: { code: string }) {
  return (
    <>
      <StatusBar />
      <ConsoleProvider>
        <Console mode="operator" code={code} />
      </ConsoleProvider>
      <NoticeToast />
    </>
  );
}

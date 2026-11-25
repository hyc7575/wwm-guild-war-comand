import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router';
import { Anchor, Stack, Text } from '@mantine/core';
import { normalizeRoomCode } from '@winds/protocol';
import type { Role } from '@winds/protocol';
import { RoomSession } from '../net/RoomSession';
import { loadRoomTokens, saveRoomTokens } from '../net/session';
import { NoticeToast } from '../shared/NoticeToast';
import { StatusBar } from '../shared/StatusBar';
import { Console } from '../commander/console/Console';
import { ConsoleProvider } from '../commander/console/ConsoleProvider';

export type OperatorRole = Extract<Role, 'OPERATOR' | 'SUB_COMMANDER'>;

const ROLE_INFO = {
  OPERATOR: { label: '운영자', tokenKey: 'operatorToken' },
  SUB_COMMANDER: { label: '서브오더', tokenKey: 'subCommanderToken' },
} as const;

/** /o/:code#token (operator) and /s/:code#token (sub-commander). Stores the token from the URL fragment, then connects with that role. */
export default function OperatorPage({ role = 'OPERATOR' }: { role?: OperatorRole }) {
  const { label, tokenKey } = ROLE_INFO[role];
  const code = normalizeRoomCode(useParams().code ?? '');
  const [token, setToken] = useState<string | undefined>(() => {
    const fromHash = location.hash.replace(/^#/, '');
    if (fromHash) saveRoomTokens(code, { [tokenKey]: fromHash });
    return fromHash || loadRoomTokens(code)[tokenKey];
  });

  useEffect(() => {
    // Keep the token out of the address bar / history once stored.
    if (location.hash) history.replaceState(null, '', location.pathname + location.search);
    setToken((t) => t ?? loadRoomTokens(code)[tokenKey]);
  }, [code, tokenKey]);

  if (!token) {
    return (
      <Stack p="md" maw={560} mx="auto" mt="xl">
        <Text role="alert" fw={700}>
          {label} 링크가 올바르지 않습니다
        </Text>
        <Anchor component={Link} to="/">
          처음으로
        </Anchor>
      </Stack>
    );
  }
  return (
    <RoomSession code={code} role={role} token={token}>
      <OperatorBody code={code} label={label} />
    </RoomSession>
  );
}

function OperatorBody({ code, label }: { code: string; label: string }) {
  return (
    <>
      <StatusBar />
      <ConsoleProvider mode="operator">
        <Console mode="operator" roleLabel={label} code={code} />
      </ConsoleProvider>
      <NoticeToast />
    </>
  );
}

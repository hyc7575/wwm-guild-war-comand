import { useEffect, useState } from 'react';
import { Alert, Button, Group, Loader, Paper, Stack, Text } from '@mantine/core';
import { useRoomStore } from '../../state/roomStore';
import { NOTE_TEXT, errorText } from '../labels';
import { describeRequest } from './ConsoleController';
import { useConsole, useTrackedRequests } from './ConsoleProvider';
import { ackStatus, type AckStatus } from './IssueTracker';
import styles from './console.module.css';

const TOAST_MS = 4000;

function StatusMark({ status, error }: { status: AckStatus; error?: string }) {
  switch (status) {
    case 'PENDING':
      return <Loader size={12} aria-label="전송 중" />;
    case 'DELAYED':
      return <Text span c="yellow" size="sm">전송 지연</Text>;
    case 'ACKED':
      return <Text span c="green" size="sm">✓</Text>;
    case 'ERROR':
      return <Text span c="red" size="sm">✕ {errorText(error ?? '')}</Text>;
  }
}

/** US-F04-2: ack state of the most recent requests. */
export function AckStatusList() {
  const { entries, now } = useTrackedRequests();
  const recent = entries.slice(-3).reverse();
  if (recent.length === 0) return null;
  return (
    <Stack gap={2} data-testid="ack-status" aria-live="polite">
      {recent.map((e) => {
        const status = ackStatus(e, now);
        return (
          <Group gap={6} key={e.clientCmdId} data-status={status} data-testid="ack-status-item">
            <Text size="sm">{e.label}</Text>
            <StatusMark status={status} error={e.ack?.error} />
          </Group>
        );
      })}
    </Stack>
  );
}

/** Notes worth a toast: correction fell back to a new command, repeat, already cancelled. */
export function AckToasts() {
  const { entries, now } = useTrackedRequests();
  const fresh = entries.filter((e) => e.ack?.note && now - e.ack.at < TOAST_MS);
  if (fresh.length === 0) return null;
  return (
    <div className={styles.toasts} role="status">
      {fresh.map((e) => (
        <Alert key={e.clientCmdId} color="blue" data-testid="ack-toast">
          {NOTE_TEXT[e.ack!.note as keyof typeof NOTE_TEXT] ?? e.ack!.note}
        </Alert>
      ))}
    </div>
  );
}

/** F10: commands that never reached the server (queued > 10s offline / no ack). */
export function UnsentList() {
  const c = useConsole();
  const unsent = useRoomStore((s) => s.unsent);
  const parties = useRoomStore((s) => s.parties);
  if (unsent.length === 0) return null;
  return (
    <Paper withBorder p="sm" role="alert" data-testid="unsent-list" style={{ borderColor: 'var(--mantine-color-red-6)' }}>
      <Text fw={700} mb={4}>
        전송되지 않은 명령
      </Text>
      <Stack gap={4}>
        {unsent.map((u) => (
          <Group key={u.clientCmdId} gap="xs">
            <Text>{describeRequest(u.msg, parties)}</Text>
            <Button size="xs" onClick={() => c.resend(u)} data-testid="unsent-resend">
              다시 보내기
            </Button>
            <Button size="xs" variant="default" onClick={() => c.discard(u)} data-testid="unsent-discard">
              버리기
            </Button>
          </Group>
        ))}
      </Stack>
    </Paper>
  );
}

/** Server `error` messages that carry no clientCmdId (store.lastError) as a short toast. */
export function ErrorToast() {
  const lastError = useRoomStore((s) => s.lastError);
  const [shown, setShown] = useState<typeof lastError>(null);
  useEffect(() => {
    if (!lastError) return;
    setShown(lastError);
    const t = setTimeout(() => setShown(null), TOAST_MS);
    return () => clearTimeout(t);
  }, [lastError]);
  if (!shown) return null;
  return (
    <div className={styles.toasts} role="alert">
      <Alert color="red" data-testid="error-toast">
        {errorText(shown.code)}
      </Alert>
    </div>
  );
}

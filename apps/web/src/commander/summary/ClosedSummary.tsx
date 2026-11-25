import { useSyncExternalStore } from 'react';
import { Anchor, Paper, Stack } from '@mantine/core';
import { Link } from 'react-router';
import { useConsole } from '../console/ConsoleProvider';
import { SummaryView } from './SummaryView';

/** Shown on the commander page after the room is closed (by me, or expired). */
export function ClosedSummary() {
  const c = useConsole();
  const s = useSyncExternalStore(
    (fn) => c.summary?.subscribe(fn) ?? (() => {}),
    () => c.summary?.getFinal(),
  );
  if (!s) return null;
  return (
    <Paper withBorder p="md" m="sm" data-testid="summary-closed">
      <Stack>
        <SummaryView summary={s} />
        <Anchor component={Link} to="/create">
          새 방 만들기
        </Anchor>
      </Stack>
    </Paper>
  );
}

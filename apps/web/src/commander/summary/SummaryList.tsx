import { useEffect, useState } from 'react';
import { Alert, Button, Group, Modal, Stack, Text, UnstyledButton } from '@mantine/core';
import { loadRoomTokens } from '../../net/session';
import { fmtDateTime, fmtDuration } from './format';
import { defaultSummaryStore, type SummaryStore } from './store';
import { SummaryView } from './SummaryView';
import type { StoredSummary } from './types';

/** Temp saves of rooms that were never closed properly and whose tokens are gone/expired (the room is gone). */
export function orphanTemps(temps: StoredSummary[], finals: StoredSummary[], now = Date.now()): StoredSummary[] {
  const closed = new Set(finals.map((f) => f.summary.roomCode));
  return temps
    .filter((t) => {
      if (closed.has(t.summary.roomCode)) return false;
      const tok = loadRoomTokens(t.summary.roomCode);
      return !tok.commanderToken || (tok.expiresAt !== undefined && tok.expiresAt < now);
    })
    .sort((a, b) => b.savedAt - a.savedAt);
}

function useSummaries(store: SummaryStore, refreshKey: unknown) {
  const [data, setData] = useState<{ finals: StoredSummary[]; temps: StoredSummary[] }>({ finals: [], temps: [] });
  useEffect(() => {
    let live = true;
    void Promise.all([store.listFinals(), store.listTemps()]).then(([finals, temps]) => {
      if (live) setData({ finals, temps: orphanTemps(temps, finals) });
    });
    return () => {
      live = false;
    };
  }, [store, refreshKey]);
  return data;
}

/** "지난 세션 요약" button + modal with the last 20 summaries. */
export function SummaryListButton({ store = defaultSummaryStore() }: { store?: SummaryStore }) {
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<StoredSummary | null>(null);
  const { finals, temps } = useSummaries(store, open);
  const items = [...finals, ...temps];
  return (
    <>
      <Button variant="default" onClick={() => setOpen(true)} data-testid="summary-open">
        지난 세션 요약
      </Button>
      <Modal opened={open} onClose={() => { setOpen(false); setView(null); }} title="지난 세션 요약" size="lg" centered transitionProps={{ duration: 0 }}>
        {view ? (
          <Stack>
            <Button variant="subtle" size="xs" w="fit-content" onClick={() => setView(null)}>
              ← 목록
            </Button>
            <SummaryView summary={view.summary} temp={view.temp} />
          </Stack>
        ) : (
          <Stack gap="xs" data-testid="summary-list">
            {items.length === 0 && <Text c="dimmed">아직 저장된 세션 요약이 없습니다.</Text>}
            {items.map((it) => (
              <UnstyledButton key={`${it.summary.roomCode}-${it.temp}`} onClick={() => setView(it)} data-testid="summary-item" p="xs" style={{ border: '1px solid var(--mantine-color-default-border)', borderRadius: 6 }}>
                <Group justify="space-between">
                  <Text fw={700}>
                    {it.summary.roomCode}
                    {it.temp ? ' (임시 저장본)' : ''}
                  </Text>
                  <Text size="sm" c="dimmed">
                    {fmtDateTime(it.summary.endedAt)} · 음성인식 {fmtDuration(it.summary.sttActiveMs)} · 최대 {it.summary.peakMembers}명
                  </Text>
                </Group>
              </UnstyledButton>
            ))}
          </Stack>
        )}
      </Modal>
    </>
  );
}

/** Create page: an unfinished session whose room is gone is offered as "마지막 임시 저장본". */
export function TempSummaryNotice({ store = defaultSummaryStore() }: { store?: SummaryStore }) {
  const { temps } = useSummaries(store, null);
  const [view, setView] = useState<StoredSummary | null>(null);
  const last = temps[0];
  if (!last) return null;
  return (
    <>
      <Alert color="yellow" title="마지막 임시 저장본" data-testid="summary-temp-notice">
        <Group justify="space-between">
          <Text size="sm">
            방 {last.summary.roomCode}이(가) 정상 종료되지 않았습니다. {fmtDateTime(last.savedAt)}까지의 요약이 남아 있습니다.
          </Text>
          <Button size="xs" variant="default" onClick={() => setView(last)}>
            보기
          </Button>
        </Group>
      </Alert>
      <Modal opened={!!view} onClose={() => setView(null)} title="마지막 임시 저장본" size="lg" centered transitionProps={{ duration: 0 }}>
        {view && <SummaryView summary={view.summary} temp />}
      </Modal>
    </>
  );
}

import { Badge, Button, Group, Stack, Text } from '@mantine/core';
import { useShallow } from 'zustand/react/shallow';
import { selectCurrentCommand, useRoomStore } from '../../state/roomStore';
import { ACTION_LABEL, partyLabel, targetLabel } from '../../shared/labels';
import { partyColorStyle } from '../../shared/partyColor';
import { useConsole } from './ConsoleProvider';
import { findCurrentAllCommand } from './selectors';
import { elapsedText, useNow } from './useNow';
import styles from './console.module.css';

/** FR-F07-7: per-party current command with a cancel button each. Everything comes from server events. */
export function PartyCommands() {
  const c = useConsole();
  const { parties, connection, hasSnapshot } = useRoomStore(
    useShallow((s) => ({ parties: s.parties, connection: s.connection, hasSnapshot: s.hasSnapshot })),
  );
  const slots = useRoomStore((s) => s.slots);
  const commands = useRoomStore((s) => s.commands);
  const byParty = useRoomStore((s) => s.presence.byParty);
  const now = useNow(1000);
  const stale = connection !== 'CONNECTED';
  const dead = connection === 'CLOSED' || connection === 'REPLACED';
  const all = findCurrentAllCommand({ slots, commands });

  if (!hasSnapshot) return <Text c="dimmed">방 정보를 불러오는 중…</Text>;

  return (
    <Stack gap={4} aria-label="파티별 현재 명령" className={stale ? styles.stale : undefined}>
      {all && (
        <div className={styles.row} data-testid="party-row-all" style={{ ['--party-color' as string]: '#c9ced6' }}>
          <div className={styles.rowBody}>
            <Text fw={700}>
              전체 {ACTION_LABEL[all.action]} {all.location?.label ?? ''}
            </Text>
            <Text size="xs" c="dimmed">
              {elapsedText(all.issuedAt, now)}
            </Text>
          </div>
          <Button size="xs" color="red" variant="light" disabled={dead} onClick={() => c.cancelCommand(all.id)} data-testid="party-row-cancel-all">
            취소
          </Button>
        </div>
      )}
      {parties.map((p) => {
        const cmd = selectCurrentCommand({ slots, commands }, p.id);
        return (
          <div key={p.id} className={styles.row} style={partyColorStyle(p)} data-testid={`party-row-${p.number}`}>
            <div className={styles.rowBody}>
              <Group gap={6}>
                <Text fw={700}>{partyLabel(p)}</Text>
                <Text size="xs" c="dimmed">
                  {byParty[p.id] ?? 0}명
                </Text>
              </Group>
              {cmd ? (
                <Group gap={6}>
                  <Text>
                    {ACTION_LABEL[cmd.action]} {cmd.location?.label ?? ''}
                  </Text>
                  {cmd.target.kind === 'PARTIES' && cmd.target.partyIds.length > 1 && (
                    <Badge variant="outline" size="xs">
                      {targetLabel(cmd.target, parties)}
                    </Badge>
                  )}
                  {cmd.repeatCount > 0 && (
                    <Badge size="xs" variant="light">
                      x{cmd.repeatCount + 1}
                    </Badge>
                  )}
                  <Text size="xs" c="dimmed">
                    {elapsedText(cmd.issuedAt, now)}
                  </Text>
                </Group>
              ) : (
                <Text c="dimmed">—</Text>
              )}
            </div>
            {cmd && (
              <Button
                size="xs"
                color="red"
                variant="light"
                disabled={dead}
                onClick={() => c.cancelCommand(cmd.id)}
                data-testid={`party-row-cancel-${p.number}`}
              >
                취소
              </Button>
            )}
          </div>
        );
      })}
    </Stack>
  );
}

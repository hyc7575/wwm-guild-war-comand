import { Button, Group, Paper, Text } from '@mantine/core';
import type { CommandDraft } from '@winds/parser';
import { useCommandPipeline } from './ConsoleProvider';
import { useNow } from './useNow';

/** F03 candidates (MEDIUM): one-click publish, edit into the panel, or let them expire after 10s. */
export function CandidatesBar({ onEdit }: { onEdit(draft: Partial<CommandDraft>): void }) {
  const { candidates, publishCandidate, editCandidate, dismissCandidate } = useCommandPipeline();
  const now = useNow(250);
  if (candidates.length === 0) return null;
  return (
    <Group gap="xs" aria-label="후보">
      {candidates.map((c) => {
        const left = Math.max(0, Math.ceil((c.expiresAt - now) / 1000));
        return (
          <Paper key={c.id} withBorder p="xs" data-testid="candidate-card" style={{ borderColor: 'var(--mantine-color-yellow-6)' }}>
            <Group gap="sm" wrap="nowrap">
              <div>
                <Text fw={700}>
                  후보: {c.label}
                </Text>
                <Text size="xs" c="dimmed">
                  &ldquo;{c.text}&rdquo; · {left}초
                </Text>
              </div>
              <Button size="sm" color="green" onClick={() => publishCandidate(c.id)} data-testid="candidate-publish">
                발행
              </Button>
              <Button
                size="sm"
                variant="default"
                onClick={() => {
                  const d = editCandidate(c.id);
                  if (d) onEdit(d);
                }}
                data-testid="candidate-edit"
              >
                수정
              </Button>
              <Button size="sm" variant="subtle" color="gray" onClick={() => dismissCandidate(c.id)} aria-label="후보 닫기">
                ✕
              </Button>
            </Group>
          </Paper>
        );
      })}
    </Group>
  );
}

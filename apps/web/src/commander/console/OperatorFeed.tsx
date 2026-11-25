import { Badge, Button, Group, Stack, Text } from '@mantine/core';
import type { CommandDraft } from '@winds/parser';
import type { SttFeedOutcome } from '@winds/protocol';
import { useRoomStore } from '../../state/roomStore';
import { useConsole } from './ConsoleProvider';

const OUTCOME: Record<SttFeedOutcome, { label: string; color: string }> = {
  ISSUED: { label: '발행', color: 'green' },
  CANDIDATE: { label: '후보', color: 'yellow' },
  CORRECTED: { label: '정정', color: 'blue' },
  CANCELLED: { label: '취소', color: 'gray' },
  DISCARDED: { label: '버림', color: 'gray' },
};

/**
 * Operator view of the commander's recognition (relayed stt.feed): spot misfires, and turn a
 * candidate/missed line into a command by parsing its text locally and prefilling the panel.
 */
export function OperatorFeed({ onPrefill }: { onPrefill(draft: Partial<CommandDraft>): void }) {
  const c = useConsole();
  const feed = useRoomStore((s) => s.sttFeed);
  const lines = [...feed].reverse();
  return (
    <Stack gap={6} aria-label="인식 원문">
      {lines.length === 0 && (
        <Text c="dimmed" size="sm">
          메인오더의 인식 결과가 여기에 표시됩니다
        </Text>
      )}
      {lines.map((e) => {
        const o = OUTCOME[e.outcome];
        const draft = e.outcome === 'ISSUED' || e.outcome === 'CANCELLED' ? undefined : c.previewText(e.text).drafts[0];
        return (
          <div key={e.id} data-testid="stt-feed-line" data-outcome={e.outcome}>
            <Group gap={6} wrap="nowrap">
              <Badge color={o.color} variant="light" size="lg">
                {o.label}
              </Badge>
              <Text style={{ flex: 1 }}>&ldquo;{e.text}&rdquo;</Text>
              {draft && (
                <Button size="xs" variant="default" onClick={() => onPrefill(draft)} data-testid="stt-feed-prefill">
                  채우기
                </Button>
              )}
            </Group>
            {e.summary && (
              <Text size="xs" c="dimmed" pl={4}>
                {e.summary}
              </Text>
            )}
          </div>
        );
      })}
    </Stack>
  );
}

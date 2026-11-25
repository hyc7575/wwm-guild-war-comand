import { useState } from 'react';
import { Loader, Paper, Stack, Text, TextInput, Group, Badge } from '@mantine/core';
import { useCommandPipeline, useConsole, useTrackedRequests } from './ConsoleProvider';
import { ackStatus } from './IssueTracker';
import { errorText } from '../labels';
import type { SubtitleChip } from '../pipeline/CommandPipeline';

const CHIP_COLOR: Record<SubtitleChip['kind'], string> = {
  ISSUED: 'green',
  CANDIDATE: 'yellow',
  CORRECTED: 'blue',
  CANCELLED: 'gray',
  DISCARDED: 'gray',
};

function ChipView({ chip }: { chip: SubtitleChip }) {
  const { entries, now } = useTrackedRequests();
  const entry = chip.clientCmdId ? entries.find((e) => e.clientCmdId === chip.clientCmdId) : undefined;
  const status = entry ? ackStatus(entry, now) : null;
  return (
    <Badge color={CHIP_COLOR[chip.kind]} variant="light" size="lg" tt="none" data-testid="subtitle-chip">
      → {chip.kind === 'CANDIDATE' ? `후보 ${chip.label}` : chip.label}{' '}
      {status === 'ACKED' && '✓'}
      {status === 'PENDING' && <Loader size={10} />}
      {status === 'DELAYED' && '전송 지연'}
      {status === 'ERROR' && `✕ ${errorText(entry?.ack?.error ?? '')}`}
    </Badge>
  );
}

/** Last 5 recognized lines with their result chips. */
export function Subtitles() {
  const { subtitles, partial } = useCommandPipeline();
  return (
    <Stack gap={6} aria-label="자막">
      {subtitles.length === 0 && !partial && (
        <Text c="dimmed" size="sm">
          아직 인식된 발화가 없습니다
        </Text>
      )}
      {subtitles.map((l) => (
        <div key={l.id} data-testid="subtitle-line">
          <Text size="md">&ldquo;{l.text}&rdquo;</Text>
          <Group gap={6}>
            {l.chips.map((c, i) => (
              <ChipView key={i} chip={c} />
            ))}
          </Group>
        </div>
      ))}
      {partial && (
        <Text c="dimmed" fs="italic" data-testid="subtitle-partial">
          {partial}
        </Text>
      )}
    </Stack>
  );
}

/** Dev / fake voice path: text typed here goes through the exact same pipeline as a recognized utterance. */
export function VoiceTestInput() {
  const { pipeline } = useConsole();
  const [text, setText] = useState('');
  const submit = () => {
    const t = text.trim();
    if (!t) return;
    pipeline.onFinalTranscript(t, { endedAt: Date.now() });
    setText('');
  };
  return (
    <Paper withBorder p="xs">
      <TextInput
        label="테스트 발화 입력 (음성 대신 글자로 파이프라인 시험)"
        description="음성인식과 똑같이 해석되어 자동 발행/후보로 처리됩니다"
        placeholder='예: 3파티 우측 방어'
        value={text}
        onChange={(e) => setText(e.currentTarget.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
            e.preventDefault();
            submit();
          }
        }}
        data-testid="voice-test-input"
      />
    </Paper>
  );
}

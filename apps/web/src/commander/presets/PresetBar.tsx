import { useState } from 'react';
import { Alert, Badge, Button, Group, Kbd, Paper, Stack, Text } from '@mantine/core';
import { errorText } from '../labels';
import { useConsole } from '../console/ConsoleProvider';
import { useLatestRun, usePresetList } from './hooks';
import { PresetEditor } from './PresetEditor';
import type { PresetRun, StepResult } from './runner';
import { getPresetStore, type PresetStore } from './store';

const STATUS_MARK: Record<StepResult['status'], { text: string; color: string }> = {
  WAITING: { text: '대기', color: 'gray' },
  SENT: { text: '전송 중', color: 'blue' },
  OK: { text: '✓', color: 'green' },
  FAILED: { text: '✕ 실패', color: 'red' },
  SKIPPED: { text: '건너뜀', color: 'yellow' },
  CANCELLING: { text: '취소 중', color: 'orange' },
  CANCEL_FAILED: { text: '✕ 취소 실패', color: 'red' },
  CANCELLED: { text: '취소됨', color: 'gray' },
};

/** F08 Phase 2: one button per tactical preset, the result of the latest run, and the editor. */
export function PresetBar({ disabled, store }: { disabled?: boolean; store?: PresetStore }) {
  const c = useConsole();
  const s = store ?? getPresetStore();
  const presets = usePresetList(s);
  const run = useLatestRun();
  const [editing, setEditing] = useState(false);

  return (
    <Paper withBorder p="sm" data-testid="preset-bar">
      <Stack gap="xs">
        <Group gap="xs" role="group" aria-label="전술 프리셋">
          <Text w={36} size="sm" c="dimmed">
            작전
          </Text>
          {presets.map((p) => (
            <Button key={p.id} size="md" variant="default" disabled={disabled} onClick={() => c.presets.start(p)} data-testid={`preset-run-${p.id}`}>
              {p.name || '이름 없음'} {p.shortcut && <Kbd ml={6}>{p.shortcut}</Kbd>}
            </Button>
          ))}
          {presets.length === 0 && (
            <Text size="sm" c="dimmed">
              프리셋이 없습니다. 여러 파티에 서로 다른 명령을 한 번에 보내려면 만드세요.
            </Text>
          )}
          <Button size="sm" variant="subtle" ml="auto" onClick={() => setEditing(true)} data-testid="preset-edit-open">
            프리셋 편집
          </Button>
        </Group>
        {run && <RunStatus run={run} disabled={disabled} />}
      </Stack>
      <PresetEditor opened={editing} onClose={() => setEditing(false)} store={s} />
    </Paper>
  );
}

function RunStatus({ run, disabled }: { run: PresetRun; disabled?: boolean }) {
  const c = useConsole();
  const failed = run.steps.filter((s) => s.status === 'FAILED');
  const skipped = run.steps.filter((s) => s.status === 'SKIPPED');
  const cancelFailed = run.steps.filter((s) => s.status === 'CANCEL_FAILED');
  const active = run.steps.some((s) => s.status === 'WAITING' || s.status === 'SENT');
  const hasIssued = run.steps.some((s) => s.status === 'OK' || s.status === 'SENT' || s.status === 'WAITING');
  return (
    <Stack gap={4} data-testid="preset-run" aria-live="polite">
      <Group gap="xs">
        <Text size="sm" fw={600}>
          {run.presetName}
          {run.cancelled ? ' (취소됨)' : active ? ' 발행 중' : ''}
        </Text>
        {!run.cancelled && hasIssued && (
          <Button size="xs" color="red" variant="light" disabled={disabled} onClick={() => c.presets.cancelRun(run.id)} data-testid="preset-cancel">
            프리셋 취소
          </Button>
        )}
        {cancelFailed.length > 0 && (
          <Button size="xs" variant="light" color="red" disabled={disabled} onClick={() => c.presets.retryCancel(run.id)} data-testid="preset-cancel-retry">
            취소 실패 {cancelFailed.length}건 재시도
          </Button>
        )}
        {failed.length > 0 && !run.cancelled && (
          <Button size="xs" variant="light" disabled={disabled} onClick={() => c.presets.retryFailed(run.id)} data-testid="preset-retry">
            실패 {failed.length}건 재시도
          </Button>
        )}
      </Group>
      {skipped.length > 0 && (
        <Alert color="yellow" p="xs" data-testid="preset-skipped">
          {skipped.map((s) => (
            <Text key={s.index} size="sm">
              {s.index + 1}단계 ({s.label}): {s.reason}
            </Text>
          ))}
        </Alert>
      )}
      <Group gap={6} wrap="wrap">
        {run.steps.map((s) => {
          const m = STATUS_MARK[s.status];
          return (
            <Badge key={s.index} color={m.color} variant="light" size="lg" style={{ textTransform: 'none' }} data-testid={`preset-step-${s.index}`} data-status={s.status}>
              {s.index + 1}. {s.label} {m.text}
              {(s.status === 'FAILED' || s.status === 'CANCEL_FAILED') && s.reason ? `: ${errorText(s.reason)}` : ''}
              {s.missing?.length ? ` (${s.missing.join('·')}파티 없음)` : ''}
            </Badge>
          );
        })}
      </Group>
    </Stack>
  );
}

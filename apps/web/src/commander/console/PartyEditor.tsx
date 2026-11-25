import { useState } from 'react';
import { ActionIcon, Alert, Button, Group, Modal, Paper, Stack, Text, TextInput } from '@mantine/core';
import { LIMITS } from '@winds/protocol';
import { useRoomStore } from '../../state/roomStore';
import { currentCommands } from './selectors';
import { errorText } from '../labels';
import { saveLastConfig } from '../lastConfig';
import { useConsole } from './ConsoleProvider';
import {
  addRow,
  buildPartiesPayload,
  moveRow,
  removalImpact,
  removeRow,
  rowsFromParties,
  rowsValid,
  toLastConfig,
  validateRows,
  type EditorRow,
} from './partyEditorLogic';

/** US-F01-4: add / delete / rename / aliases / reorder, applied atomically with baseVersion. */
export function PartyEditor({ opened, onClose }: { opened: boolean; onClose(): void }) {
  // Remount the body each time it opens so it always starts from the latest store state.
  return (
    <Modal opened={opened} onClose={onClose} title="파티 편집" size="lg" centered transitionProps={{ duration: 0 }}>
      {opened && <EditorBody onClose={onClose} />}
    </Modal>
  );
}

function EditorBody({ onClose }: { onClose(): void }) {
  const c = useConsole();
  const [rows, setRows] = useState<EditorRow[]>(() => rowsFromParties(useRoomStore.getState().parties));
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState<string | null>(null);
  const errors = validateRows(rows);
  const valid = rowsValid(rows);

  const apply = (confirmed: boolean) => {
    const s = useRoomStore.getState();
    if (!confirmed) {
      const impact = removalImpact(
        rows,
        s.parties,
        (id) => s.presence.byParty[id] ?? 0,
        (id) => currentCommands(s).filter((cmd) => cmd.target.kind === 'ALL' || cmd.target.partyIds.includes(id)).length,
      );
      if (impact.length > 0) {
        setConfirm(
          impact
            .map((x) => `${x.party.number}파티${x.party.name ? ` ${x.party.name}` : ''}: 접속 ${x.members}명, 유효 명령 ${x.commands}개`)
            .join(' / '),
        );
        return;
      }
    }
    setConfirm(null);
    setBusy(true);
    setMessage(null);
    const payload = buildPartiesPayload(rows, s.parties);
    c.updateParties(s.partyConfigVersion, payload, (ack) => {
      setBusy(false);
      if (!ack.error) {
        void saveLastConfig(toLastConfig(payload));
        onClose();
      } else if (ack.error === 'VERSION_CONFLICT') {
        setRows(rowsFromParties(useRoomStore.getState().parties));
        setMessage('다른 변경이 먼저 적용되어 최신 구성을 불러왔습니다');
      } else {
        setMessage(`적용하지 못했습니다: ${errorText(ack.error)}`);
      }
    });
  };

  return (
    <Stack gap="xs">
      {rows.map((r, i) => (
        <Paper key={r.key} withBorder p="xs">
          <Group gap="xs" wrap="nowrap" align="flex-start">
            <Text w={28} fw={700} pt={6}>
              {i + 1}
            </Text>
            <TextInput
              style={{ flex: 1 }}
              aria-label={`${i + 1}파티 이름`}
              placeholder="이름 (선택)"
              maxLength={LIMITS.partyNameMax}
              value={r.name}
              onChange={(e) => {
                const name = e.currentTarget.value;
                setRows((rs) => rs.map((x, j) => (j === i ? { ...x, name } : x)));
              }}
              data-testid={`party-editor-name-${i}`}
            />
            <TextInput
              style={{ flex: 1 }}
              aria-label={`${i + 1}파티 별칭`}
              placeholder="별칭 (쉼표로 구분)"
              value={r.aliasText}
              error={errors[i]}
              onChange={(e) => {
                const aliasText = e.currentTarget.value;
                setRows((rs) => rs.map((x, j) => (j === i ? { ...x, aliasText } : x)));
              }}
              data-testid={`party-editor-alias-${i}`}
            />
            <ActionIcon variant="default" size="lg" aria-label="위로" disabled={i === 0} onClick={() => setRows((rs) => moveRow(rs, i, -1))} data-testid={`party-editor-up-${i}`}>
              ↑
            </ActionIcon>
            <ActionIcon variant="default" size="lg" aria-label="아래로" disabled={i === rows.length - 1} onClick={() => setRows((rs) => moveRow(rs, i, 1))} data-testid={`party-editor-down-${i}`}>
              ↓
            </ActionIcon>
            <ActionIcon
              color="red"
              variant="light"
              size="lg"
              aria-label="삭제"
              disabled={rows.length <= LIMITS.minParties}
              onClick={() => setRows((rs) => removeRow(rs, i))}
              data-testid={`party-editor-delete-${i}`}
            >
              ✕
            </ActionIcon>
          </Group>
        </Paper>
      ))}
      <Group>
        <Button variant="default" disabled={rows.length >= LIMITS.maxParties} onClick={() => setRows((rs) => addRow(rs))} data-testid="party-editor-add">
          + 파티 추가
        </Button>
        <Text size="xs" c="dimmed">
          {rows.length}/{LIMITS.maxParties}개
        </Text>
      </Group>
      {message && (
        <Alert color="yellow" data-testid="party-editor-message">
          {message}
        </Alert>
      )}
      {confirm && (
        <Alert color="red" title="삭제할 파티에 사용 중인 정보가 있습니다" data-testid="party-editor-confirm">
          <Text size="sm">{confirm}</Text>
          <Text size="sm">삭제하면 그 파티의 동맹원은 파티를 다시 골라야 하고 유효한 명령은 취소됩니다.</Text>
          <Group mt="xs">
            <Button color="red" size="xs" onClick={() => apply(true)} data-testid="party-editor-confirm-apply">
              삭제하고 적용
            </Button>
            <Button variant="default" size="xs" onClick={() => setConfirm(null)}>
              돌아가기
            </Button>
          </Group>
        </Alert>
      )}
      <Group justify="flex-end">
        <Button variant="default" onClick={onClose}>
          닫기
        </Button>
        <Button onClick={() => apply(false)} disabled={!valid} loading={busy} data-testid="party-editor-apply">
          적용
        </Button>
      </Group>
    </Stack>
  );
}

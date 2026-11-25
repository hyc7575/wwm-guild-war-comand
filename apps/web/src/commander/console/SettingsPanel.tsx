import { Paper, Stack, Switch, Text } from '@mantine/core';
import { useRoomStore } from '../../state/roomStore';
import { useConsole } from './ConsoleProvider';

/** Room settings (commander only): Q2 shareTranscript, Q1 targetlessAsAll. */
export function SettingsPanel() {
  const c = useConsole();
  const settings = useRoomStore((s) => s.settings);
  return (
    <Paper withBorder p="sm">
      <Stack gap="xs">
        <Text fw={700}>방 설정</Text>
        <Switch
          label="인식 원문을 동맹원에게 공유"
          description="켜면 이후 발행하는 명령의 인식 원문이 동맹원의 명령 카드와 이력에 작게 보입니다. 이미 발행한 명령은 다음 명령부터 적용됩니다 (기본 꺼짐)"
          checked={settings.shareTranscript}
          onChange={(e) => {
            c.updateSettings({ shareTranscript: e.currentTarget.checked });
            e.currentTarget.blur();
          }}
          data-testid="settings-share-transcript"
        />
        <Switch
          label="대상 없는 명령을 전체로 보기"
          description='"중앙으로 모여"처럼 대상이 없는 발화를 후보 없이 전체 대상으로 바로 발행 (기본 꺼짐)'
          checked={settings.targetlessAsAll}
          onChange={(e) => {
            c.updateSettings({ targetlessAsAll: e.currentTarget.checked });
            e.currentTarget.blur();
          }}
          data-testid="settings-targetless-all"
        />
      </Stack>
    </Paper>
  );
}

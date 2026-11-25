import { Group, Kbd, Text } from '@mantine/core';
import { ACTION_LABEL, ACTION_ORDER } from '../../shared/labels';
import { ACTION_KEYS, ALL_KEY, LOCATION_KEYS } from './shortcuts';

/** FR-F08-3: always-visible shortcut list. Works only while this page has focus and no text box is active. */
export function ShortcutLegend({ locationLabels }: { locationLabels: string[] }) {
  return (
    <div data-testid="shortcut-legend" aria-label="단축키">
      <Text size="xs" c="dimmed" mb={4}>
        단축키 (입력창 밖에서, 이 탭에 초점이 있을 때)
      </Text>
      <Group gap="md" wrap="wrap">
        <Text size="xs">
          <Kbd>1</Kbd>~<Kbd>9</Kbd> 파티 선택 · <Kbd>{ALL_KEY}</Kbd> 전체
        </Text>
        <Text size="xs">
          {ACTION_ORDER.map((a, i) => (
            <span key={a}>
              <Kbd>{ACTION_KEYS[i]}</Kbd> {ACTION_LABEL[a]}{' '}
            </span>
          ))}
        </Text>
        <Text size="xs">
          {LOCATION_KEYS.map((k, i) =>
            locationLabels[i] ? (
              <span key={k}>
                <Kbd>{k}</Kbd> {locationLabels[i]}{' '}
              </span>
            ) : null,
          )}
        </Text>
        <Text size="xs">
          <Kbd>Enter</Kbd> 발행 · <Kbd>Esc</Kbd> 직전 취소
        </Text>
      </Group>
    </div>
  );
}

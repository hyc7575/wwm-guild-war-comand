import { useMemo, useState } from 'react';
import { Button, Group, Text, TextInput } from '@mantine/core';
import { useConsole } from './ConsoleProvider';

/** FR-F08-4: typed command, live parse preview, Enter issues with source MANUAL. */
export function TextCommand({ disabled }: { disabled?: boolean }) {
  const c = useConsole();
  const [text, setText] = useState('');
  const preview = useMemo(() => c.previewText(text), [c, text]);
  const hasText = text.trim().length > 0;
  const ok = preview.drafts.length > 0;

  const submit = () => {
    if (!ok || disabled) return;
    c.issueText(text);
    setText('');
  };

  return (
    <div>
      <Group gap="xs" align="flex-start" wrap="nowrap">
        <TextInput
          style={{ flex: 1 }}
          placeholder='입력: "3파티 우측 방어" 후 Enter'
          aria-label="글자로 명령 입력"
          value={text}
          onChange={(e) => setText(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
              e.preventDefault();
              submit();
            }
          }}
          data-testid="console-text-input"
        />
        <Button onClick={submit} disabled={!ok || disabled} data-testid="console-text-send">
          보내기
        </Button>
      </Group>
      {hasText && (
        <Text size="sm" mt={4} c={ok ? 'green' : 'red'} data-testid="console-text-preview">
          {ok ? `→ ${preview.labels.join(' / ')}` : '해석할 수 없습니다'}
        </Text>
      )}
    </div>
  );
}

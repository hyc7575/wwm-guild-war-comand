import type { ReactNode } from 'react';
import { Text } from '@mantine/core';

/**
 * Slot in the commander top bar for the speech-recognition panel (status, level meter, start/stop).
 *
 * The STT agent replaces the body of this component. Inside it, call `useCommandPipeline()` from
 * './ConsoleProvider' and feed it: `onPartial(text)` for interim text, `onFinal(text, { endedAt })`
 * for each final sentence.
 */
export function SttSlot({ children }: { children?: ReactNode }) {
  return (
    <div data-testid="stt-slot">
      {children ?? (
        <Text size="sm" c="dimmed">
          ● 음성인식 미연결
        </Text>
      )}
    </div>
  );
}

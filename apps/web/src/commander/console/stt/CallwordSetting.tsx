import { useState } from 'react';
import { Checkbox, Group, TextInput } from '@mantine/core';
import { sanitizeCallwords, type CallwordConfig } from '@winds/parser';
import { loadCallword, saveCallword } from '../../callwordSettings';

/** One line in the STT panel: call-word mode toggle, call words (max 3), optional misrecognition spellings. */
export function CallwordSetting() {
  const [cfg, setCfg] = useState<CallwordConfig>(() => loadCallword());
  const [words, setWords] = useState(cfg.words.join(', '));
  const [aliases, setAliases] = useState(cfg.aliases.join(', '));
  const split = (v: string) => v.split(/[,，\s]+/);
  const commit = (next: Partial<CallwordConfig>) => setCfg(saveCallword({ ...cfg, ...next }));
  return (
    <Group gap="xs" align="center" wrap="wrap" data-testid="callword-setting">
      <Checkbox
        size="xs"
        label="호출어 모드"
        checked={cfg.enabled}
        onChange={(e) => commit({ enabled: e.currentTarget.checked })}
        data-testid="callword-toggle"
      />
      <TextInput
        size="xs"
        w={120}
        aria-label="호출어 (최대 3개, 쉼표로 구분)"
        value={words}
        onChange={(e) => setWords(e.currentTarget.value)}
        onBlur={() => {
          const w = sanitizeCallwords(split(words));
          commit({ words: w });
          setWords(w.length ? w.join(', ') : '오더');
        }}
        data-testid="callword-words"
      />
      <TextInput
        size="xs"
        w={140}
        placeholder="비슷한 표기 (예: 어더)"
        aria-label="호출어 유사 표기"
        value={aliases}
        onChange={(e) => setAliases(e.currentTarget.value)}
        onBlur={() => {
          const a = sanitizeCallwords(split(aliases), 10);
          commit({ aliases: a });
          setAliases(a.join(', '));
        }}
        data-testid="callword-aliases"
      />
    </Group>
  );
}

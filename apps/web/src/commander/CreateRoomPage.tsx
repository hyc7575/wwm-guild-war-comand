import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router';
import { Alert, Button, Group, NumberInput, Paper, Stack, TextInput, Title } from '@mantine/core';
import { LIMITS, type CreateRoomRequest } from '@winds/protocol';
import { createRoom } from '../net/api';
import { saveRoomTokens } from '../net/session';
import { SummaryListButton, TempSummaryNotice } from './summary/SummaryList';
import { loadLastConfig, saveLastConfig, type PartyDraft } from './lastConfig';

const DEFAULT_COUNT = 5;

function resize(list: PartyDraft[], n: number): PartyDraft[] {
  return Array.from({ length: n }, (_, i) => list[i] ?? { name: '', aliases: [] });
}

export function parseAliases(text: string): string[] {
  return text
    .split(/[,，、]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

export function buildRequest(drafts: PartyDraft[]): CreateRoomRequest {
  return {
    parties: drafts.map((d) => ({
      ...(d.name.trim() ? { name: d.name.trim() } : {}),
      ...(d.aliases.length ? { aliases: d.aliases } : {}),
    })),
  };
}

/** /create (commander). */
export default function CreateRoomPage() {
  const navigate = useNavigate();
  const [count, setCount] = useState(DEFAULT_COUNT);
  const [drafts, setDrafts] = useState<PartyDraft[]>(() => resize([], DEFAULT_COUNT));
  const [aliasText, setAliasText] = useState<string[]>(() => resize([], DEFAULT_COUNT).map(() => ''));
  const [last, setLast] = useState<PartyDraft[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void loadLastConfig().then(setLast);
  }, []);

  const applyCount = (n: number) => {
    setCount(n);
    setDrafts((d) => resize(d, n));
    setAliasText((a) => Array.from({ length: n }, (_, i) => a[i] ?? ''));
  };

  const loadPrevious = () => {
    if (!last) return;
    const n = Math.min(LIMITS.maxParties, Math.max(LIMITS.minParties, last.length));
    setCount(n);
    setDrafts(resize(last, n));
    setAliasText(resize(last, n).map((d) => d.aliases.join(', ')));
  };

  const aliasErrors = aliasText.map((t) => {
    const list = parseAliases(t);
    if (list.length > LIMITS.maxAliasesPerParty) return `별칭은 ${LIMITS.maxAliasesPerParty}개까지`;
    if (list.some((a) => a.length > LIMITS.partyAliasMax)) return `별칭은 ${LIMITS.partyAliasMax}자까지`;
    return null;
  });
  const invalid = aliasErrors.some(Boolean);

  const submit = async () => {
    setBusy(true);
    setError(null);
    const finalDrafts = drafts.map((d, i) => ({ ...d, aliases: parseAliases(aliasText[i] ?? '') }));
    try {
      const res = await createRoom(buildRequest(finalDrafts));
      saveRoomTokens(res.code, {
        commanderToken: res.commanderToken,
        operatorToken: res.operatorToken,
        expiresAt: res.expiresAt,
      });
      await saveLastConfig(finalDrafts);
      navigate(`/c/${res.code}`, { state: { justCreated: true } });
    } catch (e) {
      setError(e instanceof Error ? e.message : '방을 만들지 못했습니다');
      setBusy(false);
    }
  };

  return (
    <Stack maw={560} mx="auto" p="md" gap="md">
      <Title order={1} size="h2">
        방 만들기
      </Title>
      <TempSummaryNotice />
      <NumberInput
        label="파티 수"
        min={LIMITS.minParties}
        max={LIMITS.maxParties}
        allowDecimal={false}
        clampBehavior="strict"
        value={count}
        onChange={(v) => {
          const n = typeof v === 'number' ? v : Number(v);
          if (Number.isFinite(n) && n >= LIMITS.minParties) applyCount(Math.min(LIMITS.maxParties, Math.floor(n)));
        }}
      />
      <Group>
        <Button variant="default" onClick={loadPrevious} disabled={!last}>
          지난 구성 불러오기
        </Button>
        <SummaryListButton />
      </Group>
      <Stack gap="xs">
        {drafts.map((d, i) => (
          <Paper key={i} withBorder p="sm">
            <Group align="flex-start" grow>
              <TextInput
                label={`${i + 1}파티 이름 (선택)`}
                maxLength={LIMITS.partyNameMax}
                value={d.name}
                onChange={(e) => {
                  const name = e.currentTarget.value;
                  setDrafts((ds) => ds.map((x, j) => (j === i ? { ...x, name } : x)));
                }}
              />
              <TextInput
                label="별칭 (쉼표로 구분)"
                value={aliasText[i] ?? ''}
                error={aliasErrors[i]}
                onChange={(e) => {
                  const v = e.currentTarget.value;
                  setAliasText((a) => a.map((x, j) => (j === i ? v : x)));
                }}
              />
            </Group>
          </Paper>
        ))}
      </Stack>
      {error && <Alert color="red">{error}</Alert>}
      <Button size="lg" onClick={() => void submit()} loading={busy} disabled={invalid}>
        만들기
      </Button>
    </Stack>
  );
}

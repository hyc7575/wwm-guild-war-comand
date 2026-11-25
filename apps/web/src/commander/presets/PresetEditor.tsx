import { useEffect, useMemo, useState } from 'react';
import { ActionIcon, Alert, Button, Group, Modal, Paper, Select, Stack, Switch, Text, Textarea, TextInput } from '@mantine/core';
import { LIMITS, type Action, type Location } from '@winds/protocol';
import { ACTION_LABEL, ACTION_ORDER } from '../../shared/labels';
import { useConsole } from '../console/ConsoleProvider';
import { usePresetList } from './hooks';
import {
  PRESET_LIMITS,
  SHORTCUT_OPTIONS,
  emptyStep,
  newPreset,
  newPresetId,
  serializePresets,
  shortcutConflicts,
  validatePresets,
  type Preset,
  type PresetStep,
} from './schema';
import { getPresetStore, type PresetStore } from './store';

interface Props {
  opened: boolean;
  onClose(): void;
  store?: PresetStore;
  /** Location choices (the button panel's list). Defaults to the console's. */
  locations?: Location[];
}

const NUMBERS = Array.from({ length: LIMITS.maxParties }, (_, i) => i + 1);

/** F08 Phase 2: preset list, steps, shortcut conflicts, JSON import/export. Edits are saved as you type. */
export function PresetEditor({ opened, onClose, store, locations }: Props) {
  return (
    <Modal opened={opened} onClose={onClose} title="전술 프리셋" size="xl" centered transitionProps={{ duration: 0 }}>
      {opened && <Body store={store ?? getPresetStore()} locations={locations} />}
    </Modal>
  );
}

function Body({ store, locations }: { store: PresetStore; locations?: Location[] }) {
  const c = useConsole();
  const presets = usePresetList(store);
  const locs = useMemo(() => locations ?? c.locations(), [c, locations]);
  const [selectedId, setSelectedId] = useState<string | null>(presets[0]?.id ?? null);
  const selected = presets.find((p) => p.id === selectedId) ?? null;
  const conflicts = shortcutConflicts(presets);

  useEffect(() => {
    if (!selected) setSelectedId(presets[0]?.id ?? null);
  }, [selected, presets]);

  const update = (id: string, patch: Partial<Preset>) =>
    store.set(
      presets.map((p) => {
        if (p.id !== id) return p;
        const next = { ...p, ...patch };
        if (next.shortcut === undefined) delete next.shortcut;
        return next;
      }),
    );
  const move = (i: number, d: -1 | 1) => {
    const j = i + d;
    if (j < 0 || j >= presets.length) return;
    const next = [...presets];
    [next[i], next[j]] = [next[j]!, next[i]!];
    store.set(next);
  };
  const add = () => {
    const p = newPreset(`작전 ${presets.length + 1}`);
    store.set([...presets, p]);
    setSelectedId(p.id);
  };
  const duplicate = (p: Preset) => {
    // The copy has no shortcut: it would collide with the original.
    const { shortcut: _s, ...rest } = p;
    const copy: Preset = { ...rest, id: newPresetId(), name: `${p.name} 복사`.slice(0, PRESET_LIMITS.nameMax), steps: p.steps.map((s) => ({ ...s, parties: [...s.parties] })) };
    store.set([...presets.slice(0, presets.indexOf(p) + 1), copy, ...presets.slice(presets.indexOf(p) + 1)]);
    setSelectedId(copy.id);
  };
  const remove = (id: string) => store.set(presets.filter((p) => p.id !== id));

  return (
    <Stack gap="sm">
      <Group align="flex-start" wrap="nowrap" gap="md">
        <Stack gap={4} w={240} data-testid="preset-list">
          {presets.map((p, i) => (
            <Group key={p.id} gap={4} wrap="nowrap">
              <Button
                size="xs"
                style={{ flex: 1, overflow: 'hidden' }}
                variant={p.id === selectedId ? 'filled' : 'default'}
                onClick={() => setSelectedId(p.id)}
                data-testid={`preset-item-${i}`}
              >
                {p.name || '이름 없음'} {p.shortcut ? `[${p.shortcut}]` : ''}
              </Button>
              <ActionIcon variant="subtle" aria-label="위로" disabled={i === 0} onClick={() => move(i, -1)} data-testid={`preset-up-${i}`}>
                ↑
              </ActionIcon>
              <ActionIcon variant="subtle" aria-label="아래로" disabled={i === presets.length - 1} onClick={() => move(i, 1)} data-testid={`preset-down-${i}`}>
                ↓
              </ActionIcon>
            </Group>
          ))}
          <Button size="xs" variant="light" disabled={presets.length >= PRESET_LIMITS.maxPresets} onClick={add} data-testid="preset-add">
            + 프리셋 추가
          </Button>
        </Stack>
        <div style={{ flex: 1, minWidth: 0 }}>
          {selected ? (
            <PresetForm
              preset={selected}
              locations={locs}
              conflict={conflicts.get(selected.id)}
              onChange={(patch) => update(selected.id, patch)}
              onDuplicate={() => duplicate(selected)}
              onDelete={() => remove(selected.id)}
            />
          ) : (
            <Text c="dimmed">프리셋을 추가하세요.</Text>
          )}
        </div>
      </Group>
      <ImportExport store={store} presets={presets} />
    </Stack>
  );
}

function PresetForm({
  preset,
  locations,
  conflict,
  onChange,
  onDuplicate,
  onDelete,
}: {
  preset: Preset;
  locations: Location[];
  conflict?: string[];
  onChange(patch: Partial<Preset>): void;
  onDuplicate(): void;
  onDelete(): void;
}) {
  const setStep = (i: number, patch: Partial<PresetStep>) =>
    onChange({ steps: preset.steps.map((s, j) => (j === i ? { ...s, ...patch } : s)) });
  const moveStep = (i: number, d: -1 | 1) => {
    const j = i + d;
    if (j < 0 || j >= preset.steps.length) return;
    const next = [...preset.steps];
    [next[i], next[j]] = [next[j]!, next[i]!];
    onChange({ steps: next });
  };
  return (
    <Stack gap="sm" data-testid="preset-form">
      <Group align="flex-end" gap="sm">
        <TextInput
          label="이름"
          value={preset.name}
          maxLength={PRESET_LIMITS.nameMax}
          onChange={(e) => onChange({ name: e.currentTarget.value })}
          data-testid="preset-name"
        />
        <Select
          label="단축키"
          w={130}
          clearable
          placeholder="없음"
          data={SHORTCUT_OPTIONS}
          value={preset.shortcut ?? null}
          onChange={(v) => {
            onChange({ shortcut: v ?? undefined });
          }}
          comboboxProps={{ transitionProps: { duration: 0 } }}
          data-testid="preset-shortcut"
        />
        <Button variant="default" onClick={onDuplicate} data-testid="preset-duplicate">
          복제
        </Button>
        <Button color="red" variant="light" onClick={onDelete} data-testid="preset-delete">
          삭제
        </Button>
      </Group>
      {conflict && (
        <Alert color="yellow" p="xs" data-testid="preset-shortcut-conflict">
          단축키 {preset.shortcut}이(가) {conflict.map((n) => `"${n}"`).join(', ')}와(과) 겹칩니다. 먼저 있는 프리셋만 실행됩니다.
        </Alert>
      )}
      <Text size="sm" c="dimmed">
        단계는 위에서부터 순서대로 발행됩니다. 파티는 번호로 저장되어, 그 번호의 파티가 없으면 그 단계는 건너뜁니다.
      </Text>
      {preset.steps.map((s, i) => (
        <Paper withBorder p="xs" key={i} data-testid={`preset-step-form-${i}`}>
          <Stack gap="xs">
            <Group gap={4} wrap="wrap">
              <Text size="sm" w={50}>
                {i + 1}단계
              </Text>
              <Switch
                size="sm"
                label="전체"
                checked={s.all}
                onChange={(e) => setStep(i, { all: e.currentTarget.checked })}
                data-testid={`preset-step-all-${i}`}
              />
              {!s.all &&
                NUMBERS.map((n) => (
                  <Button
                    key={n}
                    size="compact-xs"
                    variant={s.parties.includes(n) ? 'filled' : 'default'}
                    aria-pressed={s.parties.includes(n)}
                    onClick={() => setStep(i, { parties: toggle(s.parties, n) })}
                    data-testid={`preset-step-${i}-party-${n}`}
                  >
                    {n}
                  </Button>
                ))}
              <Group gap={2} ml="auto">
                <ActionIcon variant="subtle" aria-label="단계 위로" disabled={i === 0} onClick={() => moveStep(i, -1)}>
                  ↑
                </ActionIcon>
                <ActionIcon variant="subtle" aria-label="단계 아래로" disabled={i === preset.steps.length - 1} onClick={() => moveStep(i, 1)}>
                  ↓
                </ActionIcon>
                <ActionIcon
                  variant="subtle"
                  color="red"
                  aria-label="단계 삭제"
                  disabled={preset.steps.length <= 1}
                  onClick={() => onChange({ steps: preset.steps.filter((_, j) => j !== i) })}
                  data-testid={`preset-step-remove-${i}`}
                >
                  ✕
                </ActionIcon>
              </Group>
            </Group>
            <Group gap="sm" align="flex-end">
              <Select
                label="행동"
                w={120}
                allowDeselect={false}
                data={ACTION_ORDER.map((a) => ({ value: a, label: ACTION_LABEL[a] }))}
                value={s.action}
                onChange={(v) => v && setStep(i, { action: v as Action })}
                comboboxProps={{ transitionProps: { duration: 0 } }}
                data-testid={`preset-step-action-${i}`}
              />
              <Select
                label="위치"
                w={140}
                clearable
                placeholder="없음"
                data={locations.map((l) => ({ value: l.id, label: l.label }))}
                value={s.location?.id ?? null}
                onChange={(v) => {
                  const l = locations.find((x) => x.id === v);
                  const { location: _l, ...rest } = s;
                  onChange({ steps: preset.steps.map((x, j) => (j === i ? (l ? { ...rest, location: l } : rest) : x)) });
                }}
                comboboxProps={{ transitionProps: { duration: 0 } }}
                data-testid={`preset-step-location-${i}`}
              />
              {s.action === 'SUPPORT' && (
                <Group gap={4} wrap="wrap">
                  <Text size="sm">지원 대상</Text>
                  {NUMBERS.map((n) => (
                    <Button
                      key={n}
                      size="compact-xs"
                      variant={s.supportParties?.includes(n) ? 'filled' : 'default'}
                      aria-pressed={!!s.supportParties?.includes(n)}
                      onClick={() => setStep(i, { supportParties: toggle(s.supportParties ?? [], n) })}
                      data-testid={`preset-step-${i}-support-${n}`}
                    >
                      {n}
                    </Button>
                  ))}
                </Group>
              )}
            </Group>
            {!s.all && s.parties.length === 0 && (
              <Text size="xs" c="red">
                대상 파티를 고르세요. 비어 있으면 실행 때 건너뜁니다.
              </Text>
            )}
          </Stack>
        </Paper>
      ))}
      <Button
        size="xs"
        variant="light"
        disabled={preset.steps.length >= PRESET_LIMITS.maxSteps}
        onClick={() => onChange({ steps: [...preset.steps, emptyStep()] })}
        data-testid="preset-step-add"
      >
        + 단계 추가
      </Button>
    </Stack>
  );
}

function toggle(list: number[], n: number): number[] {
  return list.includes(n) ? list.filter((x) => x !== n) : [...list, n].sort((a, b) => a - b);
}

function ImportExport({ store, presets }: { store: PresetStore; presets: Preset[] }) {
  const [text, setText] = useState('');
  const [msg, setMsg] = useState<{ ok: boolean; lines: string[] } | null>(null);
  const doImport = () => {
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      setMsg({ ok: false, lines: ['JSON을 읽을 수 없습니다'] });
      return;
    }
    const r = validatePresets(json);
    if (!r.ok) {
      setMsg({ ok: false, lines: r.errors.slice(0, 6) });
      return;
    }
    const room = PRESET_LIMITS.maxPresets - presets.length;
    if (r.presets.length > room) {
      setMsg({ ok: false, lines: [`프리셋은 최대 ${PRESET_LIMITS.maxPresets}개입니다 (남은 자리 ${room}개)`] });
      return;
    }
    // A shortcut already used by an existing preset is dropped from the imported one.
    const used = new Set(presets.flatMap((p) => (p.shortcut ? [p.shortcut] : [])));
    const warnings = [...r.warnings];
    const added = r.presets.map((p) => {
      if (p.shortcut && used.has(p.shortcut)) {
        warnings.push(`"${p.name}"의 단축키 ${p.shortcut}은(는) 이미 쓰여 비웠습니다`);
        const { shortcut: _s, ...rest } = p;
        return rest;
      }
      if (p.shortcut) used.add(p.shortcut);
      return p;
    });
    store.set([...presets, ...added]);
    setText('');
    setMsg({ ok: true, lines: [`${added.length}개를 가져왔습니다`, ...warnings] });
  };
  return (
    <Stack gap={4}>
      <Group justify="space-between">
        <Text size="sm" fw={600}>
          JSON 내보내기·가져오기
        </Text>
        <Group gap="xs">
          <Button size="xs" variant="default" disabled={presets.length === 0} onClick={() => setText(serializePresets(presets))} data-testid="preset-export">
            내보내기 (아래에 표시)
          </Button>
          <Button size="xs" onClick={doImport} disabled={!text.trim()} data-testid="preset-import">
            가져오기 (추가)
          </Button>
        </Group>
      </Group>
      <Textarea
        rows={6}
        value={text}
        onChange={(e) => setText(e.currentTarget.value)}
        placeholder="내보낸 JSON을 붙여 넣고 [가져오기]를 누르세요"
        data-testid="preset-json"
      />
      {msg && (
        <Alert color={msg.ok ? 'green' : 'red'} p="xs" data-testid="preset-import-result">
          {msg.lines.map((l, i) => (
            <Text key={i} size="sm">
              {l}
            </Text>
          ))}
        </Alert>
      )}
    </Stack>
  );
}

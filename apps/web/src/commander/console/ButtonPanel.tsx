import { useState, type Dispatch } from 'react';
import { Button, Group, Kbd, Paper, Stack, Switch, Text, TextInput } from '@mantine/core';
import type { Action, Location } from '@winds/protocol';
import { ACTION_LABEL, ACTION_ORDER } from '../../shared/labels';
import { useRoomStore } from '../../state/roomStore';
import { partyColorStyle } from '../../shared/partyColor';
import { panelDraft, type PanelEvent, type PanelState } from './panelState';
import { ACTION_KEYS, ALL_KEY, LOCATION_KEYS } from './shortcuts';
import { LIMITS } from '@winds/protocol';

interface Props {
  state: PanelState;
  dispatch: Dispatch<PanelEvent>;
  locations: Location[];
  instant: boolean;
  onInstantChange(v: boolean): void;
  onPublish(): void;
  /** Console decides: select the action, or publish right away in instant mode. */
  onAction(action: Action): void;
  disabled?: boolean;
}

/** FR-F08-1/2: target chips -> action -> (location) -> publish. */
export function ButtonPanel({ state, dispatch, locations, instant, onInstantChange, onPublish, onAction, disabled }: Props) {
  const parties = useRoomStore((s) => s.parties);
  const [custom, setCustom] = useState<string | null>(null);
  const draft = panelDraft(state);
  const known = new Set(locations.map((l) => l.id));
  const customSelected = state.location && !known.has(state.location.id);

  return (
    <Paper withBorder p="sm">
      <Stack gap="sm">
        <Group gap="xs" role="group" aria-label="대상">
          <Text w={36} size="sm" c="dimmed">
            대상
          </Text>
          <Button
            size="md"
            variant={state.all ? 'filled' : 'default'}
            aria-pressed={state.all}
            onClick={() => dispatch({ type: 'toggleAll' })}
            data-testid="console-target-all"
          >
            전체 <Kbd ml={6}>{ALL_KEY}</Kbd>
          </Button>
          {parties.map((p) => {
            const on = state.partyIds.includes(p.id);
            return (
              <Button
                key={p.id}
                size="md"
                variant={on ? 'filled' : 'default'}
                aria-pressed={on}
                style={{ ...partyColorStyle(p), borderBottom: '3px solid var(--party-color)' }}
                onClick={() => dispatch({ type: 'toggleParty', id: p.id })}
                data-testid={`console-target-${p.number}`}
              >
                {p.number}
                {p.number <= 9 && <Kbd ml={6}>{p.number}</Kbd>}
              </Button>
            );
          })}
        </Group>

        <Group gap="xs" role="group" aria-label="행동">
          <Text w={36} size="sm" c="dimmed">
            행동
          </Text>
          {ACTION_ORDER.map((a, i) => (
            <Button
              key={a}
              size="md"
              variant={state.action === a ? 'filled' : 'default'}
              color={state.action === a ? 'blue' : undefined}
              aria-pressed={state.action === a}
              onClick={() => onAction(a)}
              data-testid={`console-action-${a}`}
            >
              {ACTION_LABEL[a]} <Kbd ml={6}>{ACTION_KEYS[i]}</Kbd>
            </Button>
          ))}
        </Group>

        <Group gap="xs" role="group" aria-label="위치">
          <Text w={36} size="sm" c="dimmed">
            위치
          </Text>
          {locations.map((l, i) => (
            <Button
              key={l.id}
              size="md"
              variant={state.location?.id === l.id ? 'filled' : 'default'}
              aria-pressed={state.location?.id === l.id}
              onClick={() => dispatch({ type: 'setLocation', location: l })}
              data-testid={`console-location-${l.id}`}
            >
              {l.label} {i < LOCATION_KEYS.length && <Kbd ml={6}>{LOCATION_KEYS[i]}</Kbd>}
            </Button>
          ))}
          <Button
            size="md"
            variant={customSelected ? 'filled' : 'default'}
            onClick={() => setCustom((c) => (c === null ? state.location && customSelected ? state.location.label : '' : null))}
            data-testid="console-location-custom"
          >
            {customSelected && state.location ? state.location.label : '거점…'}
          </Button>
          {custom !== null && (
            <TextInput
              size="sm"
              placeholder="거점 이름"
              maxLength={LIMITS.locationLabelMax}
              value={custom}
              autoFocus
              onChange={(e) => setCustom(e.currentTarget.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
                  const label = custom.trim();
                  if (label) dispatch({ type: 'prefill', location: { id: `CUSTOM:${label}`, label } });
                  setCustom(null);
                }
                if (e.key === 'Escape') {
                  e.stopPropagation();
                  setCustom(null);
                }
              }}
              data-testid="console-location-custom-input"
            />
          )}
          <Button
            size="lg"
            ml="auto"
            color="green"
            disabled={disabled || !draft}
            onClick={onPublish}
            data-testid="console-publish"
          >
            발행 <Kbd ml={6}>Enter</Kbd>
          </Button>
        </Group>

        <Switch
          size="sm"
          label="행동 누르면 바로 발행 (위치 없는 후퇴·대기용)"
          checked={instant}
          onChange={(e) => {
            onInstantChange(e.currentTarget.checked);
            e.currentTarget.blur();
          }}
          data-testid="console-instant-toggle"
        />
      </Stack>
    </Paper>
  );
}

import { useEffect, useMemo, useReducer, useRef, useState, type ReactNode } from 'react';
import { Button, Group, Paper, Stack, Text, Title } from '@mantine/core';
import type { Action } from '@winds/protocol';
import type { EditedDraft } from '../pipeline/CommandPipeline';
import { useRoomStore } from '../../state/roomStore';
import { AckStatusList, AckToasts, ErrorToast, UnsentList } from './AckPanel';
import { ButtonPanel } from './ButtonPanel';
import { CandidatesBar } from './CandidatesBar';
import { useConsole } from './ConsoleProvider';
import { OperatorFeed } from './OperatorFeed';
import { PartyCommands } from './PartyCommands';
import { PartyEditor } from './PartyEditor';
import { SettingsPanel } from './SettingsPanel';
import { SummaryListButton } from '../summary/SummaryList';
import { ShortcutLegend } from './ShortcutLegend';
import { SttSlot } from './SttSlot';
import { Subtitles, VoiceTestInput } from './Subtitles';
import { TextCommand } from './TextCommand';
import { TopBar } from './TopBar';
import { EMPTY_PANEL, panelDraft, panelReducer } from './panelState';
import { isTypingContext, mapShortcut } from './shortcuts';
import styles from './console.module.css';

interface Props {
  mode: 'commander' | 'operator';
  code: string;
  operatorToken?: string;
  subCommanderToken?: string;
  /** Badge text for non-commander modes (default "운영자"; "서브오더" for the sub-commander). */
  roleLabel?: string;
  /** Commander only: content of the top-bar STT slot. Defaults to the placeholder. */
  sttSlot?: ReactNode;
  /** Commander only: open the invite modal on mount (arrived from /create). */
  openInvite?: boolean;
}

/** F08 console. Commander and operator share everything except admin (parties, settings, close, STT). */
export function Console({ mode, code, operatorToken, subCommanderToken, roleLabel, sttSlot, openInvite }: Props) {
  const c = useConsole();
  const parties = useRoomStore((s) => s.parties);
  const connection = useRoomStore((s) => s.connection);
  const [panel, dispatch] = useReducer(panelReducer, EMPTY_PANEL);
  const [instant, setInstant] = useState(false);
  const [editor, setEditor] = useState(false);
  const locations = useMemo(() => c.locations(), [c]);
  const dead = connection === 'CLOSED' || connection === 'REPLACED';

  // Drop selected parties that were deleted while selected.
  useEffect(() => {
    dispatch({ type: 'prune', validPartyIds: parties.map((p) => p.id) });
  }, [parties]);

  // Latest values for the window key handler (registered once).
  const live = useRef({ panel, parties, instant, locations, dead });
  live.current = { panel, parties, instant, locations, dead };

  const publishWith = (p = live.current.panel) => {
    const d = panelDraft(p);
    if (!d || live.current.dead) return;
    c.issueManual(d);
    dispatch({ type: 'reset' });
  };

  const onAction = (action: Action) => {
    const p = { ...live.current.panel, action };
    dispatch({ type: 'setAction', action });
    if (live.current.instant && panelDraft(p)) publishWith(p);
  };

  const cancelLast = () => {
    if (!live.current.dead) c.cancelLast();
  };

  const prefill = (d: EditedDraft) =>
    dispatch({
      type: 'prefill',
      target: d.target,
      action: d.action,
      location: d.location ?? null,
      supportPartyIds: d.supportPartyIds,
      correctsId: d.correctsId,
    });

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.isComposing || isTypingContext(e.target)) return;
      const { parties: ps, locations: locs } = live.current;
      const a = mapShortcut(e, { partyCount: ps.length });
      if (!a) return;
      e.preventDefault();
      switch (a.type) {
        case 'toggleAll':
          dispatch({ type: 'toggleAll' });
          break;
        case 'toggleParty': {
          const p = ps.find((x) => x.number === a.number);
          if (p) dispatch({ type: 'toggleParty', id: p.id });
          break;
        }
        case 'action':
          onAction(a.action);
          break;
        case 'location': {
          const l = locs[a.index];
          if (l) dispatch({ type: 'setLocation', location: l });
          break;
        }
        case 'publish':
          publishWith();
          break;
        case 'cancelLast':
          cancelLast();
          break;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [c]);

  return (
    <div className={styles.root}>
      <TopBar mode={mode} code={code} operatorToken={operatorToken} subCommanderToken={subCommanderToken} roleLabel={roleLabel} openInvite={openInvite} sttSlot={mode === 'commander' ? (sttSlot ?? <SttSlot />) : undefined} />

      <div className={styles.cols}>
        <Paper withBorder p="sm">
          <Stack gap="sm">
            <Title order={3} size="h5">
              {mode === 'commander' ? '자막' : '인식 원문'}
            </Title>
            {mode === 'commander' ? (
              <>
                <Subtitles />
                <VoiceTestInput />
              </>
            ) : (
              <OperatorFeed onPrefill={prefill} />
            )}
          </Stack>
        </Paper>
        <Paper withBorder p="sm">
          <Stack gap="sm">
            <Title order={3} size="h5">
              파티별 현재 명령
            </Title>
            <PartyCommands />
          </Stack>
        </Paper>
      </div>

      {mode === 'commander' && <CandidatesBar onEdit={prefill} />}

      <ButtonPanel
        state={panel}
        dispatch={dispatch}
        locations={locations}
        instant={instant}
        onInstantChange={setInstant}
        onPublish={() => publishWith()}
        onAction={onAction}
        disabled={dead}
      />

      <Group align="flex-start" wrap="nowrap" gap="sm">
        <div style={{ flex: 1 }}>
          <TextCommand disabled={dead} />
        </div>
        <Button color="red" size="xl" className={styles.cancelLast} disabled={dead} onClick={cancelLast} data-testid="console-cancel-last">
          직전 취소 <Text span size="xs" ml={6}>Esc</Text>
        </Button>
      </Group>

      <AckStatusList />
      <UnsentList />
      <ShortcutLegend locationLabels={locations.map((l) => l.label)} />

      {mode === 'commander' && (
        <Group align="flex-start" gap="sm">
          <Button variant="default" onClick={() => setEditor(true)} data-testid="party-editor-open">
            파티 편집
          </Button>
          <SummaryListButton />
          <div style={{ flex: 1, minWidth: 260 }}>
            <SettingsPanel />
          </div>
          <PartyEditor opened={editor} onClose={() => setEditor(false)} />
        </Group>
      )}
      <AckToasts />
      <ErrorToast />
    </div>
  );
}

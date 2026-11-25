import { useEffect, useRef, useState } from 'react';
import type { Command } from '@winds/protocol';
import type { RestoreKind } from './CommandCard';
import { playBeep } from './beeper';
import { isForParty } from './model';
import type { MemberHudModel } from './useMemberHudModel';
import type { HudSettings } from './settings';

export const FLASH_MS = 1000;
export const PULSE_MS = 450;
export const STRIKE_MS = 500;
export const RESTORE_MS = 3000;

export interface CardEffects {
  flashing: boolean;
  pulsing: boolean;
  /** while set, show this (cancelled) command struck through instead of the restored one */
  struckCommand: Command | null;
  restore: RestoreKind | null;
}

/**
 * Turns store transitions (model.lastEvent) into one-shot visual/audio effects for MY card:
 * new -> flash + beep/vibrate, repeat -> pulse, cancel -> strike 0.5s then restore notice 3s.
 * Events that were already applied when the HUD mounted are ignored (no beep on reconnect snapshots).
 */
export function useCardEffects(
  m: Pick<MemberHudModel, 'lastEvent' | 'myPartyId' | 'myCommand' | 'commands'>,
  settings: HudSettings,
): CardEffects {
  const [flashing, setFlashing] = useState(false);
  const [pulsing, setPulsing] = useState(false);
  const [struckCommand, setStruck] = useState<Command | null>(null);
  const [restore, setRestore] = useState<RestoreKind | null>(null);
  const seen = useRef<number | null>(m.lastEvent?.seq ?? null);
  const prevCurrent = useRef<Command | null>(m.myCommand);
  const timers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});
  const settingsRef = useRef(settings);
  settingsRef.current = settings;

  const later = (key: string, ms: number, fn: () => void) => {
    clearTimeout(timers.current[key]);
    timers.current[key] = setTimeout(fn, ms);
  };

  useEffect(() => {
    const ev = m.lastEvent;
    if (ev && ev.seq !== seen.current) {
      seen.current = ev.seq;
      const st = settingsRef.current;
      if ((ev.kind === 'command.issued' || ev.kind === 'command.corrected') && ev.commandId) {
        const c = m.commands[ev.commandId];
        if (c) {
          if (m.myCommand?.id === c.id) {
            setFlashing(true);
            later('flash', FLASH_MS, () => setFlashing(false));
            setRestore(null);
          }
          if (isForParty(c, m.myPartyId)) {
            if (st.soundOn) playBeep(st.volume);
            if (st.vibrationOn && typeof navigator.vibrate === 'function') navigator.vibrate(200);
          }
        }
      } else if (ev.kind === 'command.repeated' && ev.commandId && m.myCommand?.id === ev.commandId) {
        setPulsing(true);
        later('pulse', PULSE_MS, () => setPulsing(false));
      } else if (ev.kind === 'command.cancelled' && ev.commandIds && prevCurrent.current && ev.commandIds.includes(prevCurrent.current.id)) {
        setStruck(prevCurrent.current);
        setRestore(null);
        const kind: RestoreKind = m.myCommand ? 'RESTORED' : 'EMPTY';
        later('strike', STRIKE_MS, () => {
          setStruck(null);
          setRestore(kind);
          later('restore', RESTORE_MS, () => setRestore(null));
        });
      }
    }
    prevCurrent.current = m.myCommand;
  });

  useEffect(
    () => () => {
      Object.values(timers.current).forEach(clearTimeout);
    },
    [],
  );

  return { flashing, pulsing, struckCommand, restore };
}

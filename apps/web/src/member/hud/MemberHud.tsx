import { useEffect, useState } from 'react';
import type { Party } from '@winds/protocol';
import { NoticeToast } from '../../shared/NoticeToast';
import { CommandCard } from './CommandCard';
import { AllLine } from './AllLine';
import { HistoryList } from './HistoryList';
import { HudStatusBar } from './HudStatusBar';
import { PartyGrid } from './PartyGrid';
import { SettingsDrawer } from './SettingsDrawer';
import { isAudioBlocked, onAudioStateChange, unlockAudio } from './beeper';
import { supportersOf } from './model';
import { FONT_SCALE, useHudSettings } from './settings';
import { useCardEffects } from './useCardEffects';
import { useMemberHudModel } from './useMemberHudModel';
import { useMediaQuery, useNow } from './useNow';
import { useWakeLock } from './useWakeLock';
import styles from './MemberHud.module.css';

/** Is audio waiting for a user gesture? Any first tap also unlocks it (US-F05-2). */
function useAudioBlocked(enabled: boolean): boolean {
  const [blocked, setBlocked] = useState(() => enabled && !!isAudioBlocked());
  useEffect(() => {
    if (!enabled) {
      setBlocked(false);
      return;
    }
    const sync = () => setBlocked(!!isAudioBlocked());
    sync();
    const off = onAudioStateChange(sync);
    const first = () => void unlockAudio();
    document.addEventListener('pointerdown', first, { once: true });
    return () => {
      off?.();
      document.removeEventListener('pointerdown', first);
    };
  }, [enabled]);
  return blocked;
}

export function MemberHud({ onChangeParty }: { onChangeParty(): void }) {
  const m = useMemberHudModel();
  const { settings, update } = useHudSettings();
  const now = useNow(1000);
  const wide = useMediaQuery('(min-width: 900px)');
  const osReduced = useMediaQuery('(prefers-reduced-motion: reduce)');
  const fx = useCardEffects(m, settings);
  const audioBlocked = useAudioBlocked(settings.soundOn);
  useWakeLock(settings.wakeLockOn && !m.closed);

  const [settingsOpen, setSettingsOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [focus, setFocus] = useState<Party | null>(null);

  if (m.closed) {
    return (
      <main className={styles.closed} data-testid="room-closed">
        <h1>오더방이 종료되었습니다</h1>
      </main>
    );
  }

  const reduced = settings.reduceMotion || osReduced;
  const shownCommand = fx.struckCommand ?? m.myCommand;
  const unselected = !m.myParty;
  const focusParty = focus ? m.parties.find((p) => p.id === focus.id) : undefined;

  return (
    <div
      className={styles.hud}
      data-wide={wide ? 'true' : undefined}
      data-reduced-motion={reduced ? 'true' : 'false'}
      style={{ ['--hud-fs' as string]: String(FONT_SCALE[settings.fontStep]) }}
    >
      <div className={styles.top}>
        <HudStatusBar
          connection={m.connection}
          hasSnapshot={m.hasSnapshot}
          presence={m.presence}
          myPartyText={m.myParty ? (m.myParty.name ? `${m.myParty.number}파티 ${m.myParty.name}` : `${m.myParty.number}파티`) : undefined}
          onChangeParty={onChangeParty}
          onOpenSettings={() => setSettingsOpen(true)}
        />
        {m.connection === 'RECONNECTING' && (
          <div className={styles.band} data-tone="warn" data-testid="banner-reconnecting" role="alert">
            다시 연결 중… 화면의 명령이 최신이 아닐 수 있습니다
          </div>
        )}
        {m.connection === 'OFFLINE' && (
          <div className={styles.band} data-tone="danger" data-testid="banner-offline" role="alert">
            인터넷 연결 없음
          </div>
        )}
        {m.connection === 'REPLACED' && (
          <div className={styles.band} data-tone="danger" data-testid="banner-replaced" role="alert">
            다른 탭에서 열렸습니다. 이 화면은 더 이상 갱신되지 않습니다
          </div>
        )}
        {audioBlocked && (
          <button type="button" className={styles.sound} data-testid="enable-sound" onClick={() => void unlockAudio()}>
            소리 켜기
          </button>
        )}
      </div>

      {!m.hasSnapshot ? (
        <p className={styles.loading}>방 정보를 불러오는 중…</p>
      ) : (
        <div className={styles.body} data-unselected={unselected ? 'true' : undefined}>
          {unselected && (
            <p className={styles.hint} data-testid="unselected-hint">
              내 파티를 고르면 내 명령을 크게 볼 수 있습니다
            </p>
          )}
          {unselected && m.allLine && (
            <div className={styles.all}>
              <AllLine command={m.allLine} now={now} dimmed={m.dimmed} />
            </div>
          )}
          {m.myParty && (
            <div className={styles.mine}>
              <CommandCard
                command={shownCommand}
                parties={m.parties}
                owner={m.myParty}
                original={fx.struckCommand ? null : m.original}
                supportFrom={fx.struckCommand ? [] : m.supportFrom}
                now={now}
                dimmed={m.dimmed}
                flashing={fx.flashing}
                pulsing={fx.pulsing}
                struck={!!fx.struckCommand}
                restore={fx.restore}
              />
            </div>
          )}
          {!unselected && m.allLine && (
            <div className={styles.all}>
              <AllLine command={m.allLine} now={now} dimmed={m.dimmed} />
            </div>
          )}
          <div className={styles.grid}>
            <PartyGrid
              parties={m.gridParties}
              commandOf={m.commandOf}
              now={now}
              large={unselected}
              dimmed={m.dimmed}
              onSelect={setFocus}
            />
          </div>
          <section className={styles.history}>
            {!wide && (
              <button type="button" className={styles.toggle} aria-expanded={historyOpen} data-testid="history-toggle" onClick={() => setHistoryOpen((v) => !v)}>
                최근 이력 {historyOpen ? '▾' : '▸'}
              </button>
            )}
            {wide && <h2 className={styles.h2}>최근 이력</h2>}
            {(wide || historyOpen) && (
              <HistoryList
                parties={m.parties}
                rows={m.history}
                commands={m.commands}
                filter={m.historyFilter}
                onFilter={m.setHistoryFilter}
                canFilterMine={!unselected}
              />
            )}
          </section>
        </div>
      )}

      {focusParty && (
        <div className={styles.focusBack} onClick={() => setFocus(null)}>
          <div className={styles.focus} role="dialog" aria-modal="true" aria-label={`${focusParty.number}파티 명령`} data-testid="focus-view" onClick={(e) => e.stopPropagation()}>
            <CommandCard
              command={m.commandOf(focusParty.id)}
              parties={m.parties}
              owner={focusParty}
              supportFrom={supportersOf(focusParty.id, m.parties, m.slots, m.commands)}
              now={now}
              dimmed={m.dimmed}
              testId="focus-card"
              idPrefix="focus-card"
            />
            <button type="button" className={styles.focusClose} data-testid="focus-close" onClick={() => setFocus(null)}>
              닫기
            </button>
          </div>
        </div>
      )}

      {settingsOpen && <SettingsDrawer settings={settings} onChange={update} onClose={() => setSettingsOpen(false)} />}
      <NoticeToast />
    </div>
  );
}

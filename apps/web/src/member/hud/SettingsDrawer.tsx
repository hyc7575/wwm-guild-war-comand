import { FONT_SCALE, type HudSettings } from './settings';
import styles from './SettingsDrawer.module.css';

export interface SettingsDrawerProps {
  settings: HudSettings;
  onChange(patch: Partial<HudSettings>): void;
  onClose(): void;
}

/** Member-local settings (F05). Presentational. */
export function SettingsDrawer({ settings, onChange, onClose }: SettingsDrawerProps) {
  return (
    <div className={styles.backdrop} onClick={onClose}>
      <aside className={styles.drawer} role="dialog" aria-modal="true" aria-label="설정" data-testid="settings-drawer" onClick={(e) => e.stopPropagation()}>
        <h2 className={styles.title}>설정</h2>

        <label className={styles.row}>
          <input type="checkbox" checked={settings.soundOn} onChange={(e) => onChange({ soundOn: e.target.checked })} />
          알림음
        </label>
        <label className={styles.row}>
          음량
          <input
            type="range"
            min={0}
            max={1}
            step={0.1}
            value={settings.volume}
            disabled={!settings.soundOn}
            aria-label="음량"
            onChange={(e) => onChange({ volume: Number(e.target.value) })}
          />
        </label>
        <label className={styles.row}>
          <input type="checkbox" checked={settings.vibrationOn} onChange={(e) => onChange({ vibrationOn: e.target.checked })} />
          진동 (지원하는 기기만)
        </label>
        <label className={styles.row}>
          <input type="checkbox" checked={settings.wakeLockOn} onChange={(e) => onChange({ wakeLockOn: e.target.checked })} />
          화면 꺼짐 방지
        </label>
        <label className={styles.row}>
          <input type="checkbox" checked={settings.reduceMotion} onChange={(e) => onChange({ reduceMotion: e.target.checked })} />
          동작 줄이기
        </label>

        <fieldset className={styles.fonts}>
          <legend>글자 크기</legend>
          {(['작게', '보통', '크게'] as const).map((label, i) => (
            <button
              key={label}
              type="button"
              aria-pressed={settings.fontStep === i}
              style={{ fontSize: `${FONT_SCALE[i]}rem` }}
              onClick={() => onChange({ fontStep: i as 0 | 1 | 2 })}
            >
              {label}
            </button>
          ))}
        </fieldset>

        <button type="button" className={styles.close} onClick={onClose}>
          닫기
        </button>
      </aside>
    </div>
  );
}

import type { Action } from '@winds/protocol';
import { ACTION_LABEL } from '../../shared/labels';

const ACTION_VAR: Record<Action, string> = {
  GATHER: 'var(--act-gather)',
  MOVE: 'var(--act-move)',
  ATTACK: 'var(--act-attack)',
  DEFEND: 'var(--act-defend)',
  RETREAT: 'var(--act-retreat)',
  SUPPORT: 'var(--act-support)',
  HOLD: 'var(--act-hold)',
};

export function actionColor(action: Action): string {
  return ACTION_VAR[action];
}

/** Hand-made inline SVG per action (F05 시각 언어). Decorative unless `title` is passed. */
const PATHS: Record<Action, React.ReactNode> = {
  // four arrows converging on the center
  GATHER: (
    <>
      <path d="M3 3l6 6M3 3v4M3 3h4" />
      <path d="M21 3l-6 6M21 3v4M21 3h-4" />
      <path d="M3 21l6-6M3 21v-4M3 21h4" />
      <path d="M21 21l-6-6M21 21v-4M21 21h-4" />
      <circle cx="12" cy="12" r="1.6" fill="currentColor" />
    </>
  ),
  // arrow pointing forward (up)
  MOVE: <path d="M12 21V4M5 11l7-7 7 7" />,
  // sword
  ATTACK: (
    <>
      <path d="M19 3l-2 6-8 8-3-3 8-8z" fill="currentColor" fillOpacity="0.25" />
      <path d="M6 18l-3 3M5 14l5 5" />
    </>
  ),
  // shield
  DEFEND: <path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z" fill="currentColor" fillOpacity="0.25" />,
  // arrow pointing back (down)
  RETREAT: <path d="M12 3v17M5 13l7 7 7-7" />,
  // plus
  SUPPORT: <path d="M12 4v16M4 12h16" />,
  // pause
  HOLD: (
    <>
      <rect x="6" y="4" width="4" height="16" rx="1" fill="currentColor" />
      <rect x="14" y="4" width="4" height="16" rx="1" fill="currentColor" />
    </>
  ),
};

export function ActionIcon({ action, size = 48, title }: { action: Action; size?: number; title?: boolean }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth={2.2}
      strokeLinecap="round"
      strokeLinejoin="round"
      style={{ color: ACTION_VAR[action], flex: 'none' }}
      data-action-icon={action}
      role={title ? 'img' : undefined}
      aria-label={title ? ACTION_LABEL[action] : undefined}
      aria-hidden={title ? undefined : true}
    >
      {PATHS[action]}
    </svg>
  );
}

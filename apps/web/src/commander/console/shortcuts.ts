import { ACTION_ORDER } from '../../shared/labels';
import type { Action } from '@winds/protocol';

export type ShortcutAction =
  | { type: 'toggleAll' }
  | { type: 'toggleParty'; number: number }
  | { type: 'action'; action: Action }
  | { type: 'location'; index: number }
  | { type: 'publish' }
  | { type: 'cancelLast' };

export const ACTION_KEYS = ['Q', 'W', 'E', 'R', 'T', 'Y', 'U'] as const;
export const LOCATION_KEYS = ['A', 'S', 'D', 'F', 'G'] as const;
/** 1-9 -> parties 1-9, 0 -> 전체. Parties 10+ are click-only. */
export const ALL_KEY = '0';

export interface KeyLike {
  key: string;
  code?: string;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
}

/**
 * Pure key -> action mapping. Prefers `code` (KeyQ, Digit3) so it works while the Korean IME is on,
 * where `key` would be "ㅂ".
 */
export function mapShortcut(e: KeyLike, ctx: { partyCount: number }): ShortcutAction | null {
  if (e.ctrlKey || e.metaKey || e.altKey) return null;
  const code = e.code ?? '';
  if (code === 'Enter' || code === 'NumpadEnter' || e.key === 'Enter') return { type: 'publish' };
  if (code === 'Escape' || e.key === 'Escape') return { type: 'cancelLast' };

  let ch = '';
  const dm = /^(?:Digit|Numpad)(\d)$/.exec(code);
  const km = /^Key([A-Z])$/.exec(code);
  if (dm) ch = dm[1]!;
  else if (km) ch = km[1]!;
  else if (e.key.length === 1) ch = e.key.toUpperCase();
  if (!ch) return null;

  if (ch === ALL_KEY) return { type: 'toggleAll' };
  if (/^[1-9]$/.test(ch)) {
    const n = Number(ch);
    return n <= ctx.partyCount ? { type: 'toggleParty', number: n } : null;
  }
  const ai = (ACTION_KEYS as readonly string[]).indexOf(ch);
  if (ai >= 0) return { type: 'action', action: ACTION_ORDER[ai]! };
  const li = (LOCATION_KEYS as readonly string[]).indexOf(ch);
  if (li >= 0) return { type: 'location', index: li };
  return null;
}

const NON_TEXT_INPUT = new Set(['checkbox', 'radio', 'button', 'submit', 'reset', 'range']);

/** True when the key event should be left to the focused element (typing) or an open dialog. */
export function isTypingContext(target: EventTarget | null, doc: Document = document): boolean {
  const el = target as HTMLElement | null;
  if (el && el.tagName) {
    const tag = el.tagName;
    if (tag === 'INPUT') {
      // Switches, checkboxes, radios and buttons do not take text: shortcuts keep working.
      const type = (el as HTMLInputElement).type;
      if (!NON_TEXT_INPUT.has(type)) return true;
    } else if (tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable) return true;
  }
  return doc.querySelector('[role="dialog"]') !== null;
}

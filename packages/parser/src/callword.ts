/**
 * F02 call-word mode (Phase 2, optional). Pure functions: no clock, no storage.
 * With the mode on, only sentences that start with a call word ("오더, ...") reach the parser,
 * and only what follows the call word is read as the command.
 */

export const CALLWORD_MAX = 3;
/** Fillers ("자", "에", "그") allowed before the call word. */
export const CALLWORD_FILLER_MAX = 2;
/** After a sentence that was only the call word, the next sentence within this window is the command. */
export const CALLWORD_FOLLOWUP_MS = 5000;

export interface CallwordConfig {
  enabled: boolean;
  /** Call words, at most CALLWORD_MAX. */
  words: string[];
  /** STT misrecognition spellings that also count as the call word (e.g. "어더", "오다"). Empty by default. */
  aliases: string[];
}

export const DEFAULT_CALLWORD_CONFIG: CallwordConfig = { enabled: false, words: ['오더'], aliases: [] };

export type CallwordResult =
  /** Call word found; `text` is what followed it. */
  | { kind: 'COMMAND'; text: string }
  /** The sentence was just the call word (maybe with fillers): take the next sentence as the command. */
  | { kind: 'CALL_ONLY' }
  /** No call word at the start. */
  | { kind: 'NONE' };

const PUNCT = /^[\s,.!?~…·、，。]+|[\s,.!?~…·、，。]+$/g;
const clean = (s: string) => s.replace(PUNCT, '');

/** Trims, dedupes, drops empties and spaces inside a word, caps at CALLWORD_MAX. */
export function sanitizeCallwords(list: readonly string[], max = CALLWORD_MAX): string[] {
  const out: string[] = [];
  for (const w of list) {
    const v = clean(w.normalize('NFC')).replace(/\s+/g, '');
    if (v && !out.includes(v)) out.push(v);
    if (out.length >= max) break;
  }
  return out;
}

export function sanitizeCallwordConfig(raw: unknown): CallwordConfig {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Partial<Record<keyof CallwordConfig, unknown>>;
  const strs = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
  const words = sanitizeCallwords(strs(o.words));
  return {
    enabled: o.enabled === true,
    words: words.length ? words : [...DEFAULT_CALLWORD_CONFIG.words],
    aliases: sanitizeCallwords(strs(o.aliases), 10),
  };
}

/**
 * Looks for a call word in the first CALLWORD_FILLER_MAX+1 words. Fillers containing a digit are not
 * fillers ("1파티 오더 ..." is a command about party 1, not a call). A glued form "오더1파티" is not matched.
 * Disabled config returns COMMAND with the whole text so callers can use one path.
 */
export function extractCallword(text: string, cfg: CallwordConfig): CallwordResult {
  const trimmed = text.trim();
  if (!cfg.enabled) return { kind: 'COMMAND', text: trimmed };
  const names = new Set(sanitizeCallwords([...cfg.words, ...cfg.aliases], CALLWORD_MAX + 10));
  if (names.size === 0) return { kind: 'NONE' };
  const tokens = trimmed.split(/\s+/).filter(Boolean);
  for (let i = 0; i <= CALLWORD_FILLER_MAX && i < tokens.length; i++) {
    if (i > 0 && /\d/.test(tokens[i - 1]!)) return { kind: 'NONE' };
    if (names.has(clean(tokens[i]!))) {
      const rest = tokens.slice(i + 1).join(' ').replace(PUNCT, '');
      return rest ? { kind: 'COMMAND', text: rest } : { kind: 'CALL_ONLY' };
    }
  }
  return { kind: 'NONE' };
}

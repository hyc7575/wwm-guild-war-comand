import { LIMITS, type Action, type Location } from '@winds/protocol';
import { ACTION_ORDER } from '../../shared/labels';

/** F08 Phase 2: tactical preset. Parties are stored by number so a preset is reusable across rooms. */
export interface PresetStep {
  /** true: target 전체 (parties ignored). */
  all: boolean;
  /** Party numbers (1-based). */
  parties: number[];
  action: Action;
  location?: Location;
  /** SUPPORT only: party numbers being supported. */
  supportParties?: number[];
}

export interface Preset {
  id: string;
  name: string;
  /** "F1".."F10" (not F5) or "Shift+1".."Shift+9". Digits alone are the party keys. */
  shortcut?: string;
  steps: PresetStep[];
}

export const PRESET_LIMITS = {
  maxPresets: 30,
  maxSteps: LIMITS.maxParties,
  nameMax: 20,
} as const;

export const STORAGE_KEY = 'winds.presets';
export const FILE_VERSION = 1;

/** F5 reload, F11 fullscreen and F12 devtools are left to the browser. */
export const SHORTCUT_OPTIONS: string[] = [
  ...['F1', 'F2', 'F3', 'F4', 'F6', 'F7', 'F8', 'F9', 'F10'],
  ...[1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => `Shift+${n}`),
];

let counter = 0;
export function newPresetId(): string {
  counter += 1;
  return `pre_${Date.now().toString(36)}${counter.toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

export function emptyStep(): PresetStep {
  return { all: false, parties: [], action: 'ATTACK' };
}

export function newPreset(name = '새 작전'): Preset {
  return { id: newPresetId(), name, steps: [emptyStep()] };
}

/** Presets whose shortcut is also used by an earlier-or-later preset: id -> other preset names. */
export function shortcutConflicts(presets: Preset[]): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const p of presets) {
    if (!p.shortcut) continue;
    const others = presets.filter((q) => q.id !== p.id && q.shortcut === p.shortcut).map((q) => q.name || '이름 없음');
    if (others.length) out.set(p.id, others);
  }
  return out;
}

export type ValidateResult = { ok: true; presets: Preset[]; warnings: string[] } | { ok: false; errors: string[] };

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const partyNo = (v: unknown): v is number => Number.isInteger(v) && (v as number) >= 1 && (v as number) <= LIMITS.maxParties;

function readNumbers(v: unknown, where: string, errors: string[]): number[] {
  if (v === undefined) return [];
  if (!Array.isArray(v) || v.length > LIMITS.maxParties || !v.every(partyNo)) {
    errors.push(`${where}: 파티 번호는 1~${LIMITS.maxParties} 정수 배열이어야 합니다`);
    return [];
  }
  return [...new Set(v as number[])].sort((a, b) => a - b);
}

function readStep(raw: unknown, where: string, errors: string[], lenient: boolean): PresetStep | null {
  if (!isObj(raw)) {
    errors.push(`${where}: 객체가 아닙니다`);
    return null;
  }
  const before = errors.length;
  const all = raw.all === undefined ? false : raw.all;
  if (typeof all !== 'boolean') errors.push(`${where}: all은 true/false여야 합니다`);
  const parties = readNumbers(raw.parties, `${where}.parties`, errors);
  if (!ACTION_ORDER.includes(raw.action as Action)) errors.push(`${where}: 알 수 없는 행동 "${String(raw.action)}"`);
  let location: Location | undefined;
  if (raw.location !== undefined && raw.location !== null) {
    const l = raw.location;
    if (!isObj(l) || typeof l.id !== 'string' || typeof l.label !== 'string' || !l.id || !l.label || l.label.length > LIMITS.locationLabelMax || l.id.length > 60) {
      errors.push(`${where}: 위치는 {id, label(${LIMITS.locationLabelMax}자 이하)}여야 합니다`);
    } else location = { id: l.id, label: l.label };
  }
  const supportParties = readNumbers(raw.supportParties, `${where}.supportParties`, errors);
  if (errors.length > before) return null;
  if (!lenient && !all && parties.length === 0) {
    errors.push(`${where}: 대상 파티가 없습니다`);
    return null;
  }
  const action = raw.action as Action;
  return {
    all: all as boolean,
    parties: all ? [] : parties,
    action,
    ...(location ? { location } : {}),
    ...(action === 'SUPPORT' && supportParties.length ? { supportParties } : {}),
  };
}

/** Validates unknown JSON (imported file or stored value). Ids are always regenerated on import to avoid collisions. */
export function validatePresets(input: unknown, opts: { keepIds?: boolean; /** Stored drafts may be half-edited (no target, empty name). */ lenient?: boolean } = {}): ValidateResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const list = isObj(input) && 'presets' in input ? input.presets : input;
  if (isObj(input) && input.version !== undefined && input.version !== FILE_VERSION) {
    return { ok: false, errors: [`지원하지 않는 버전입니다: ${String(input.version)}`] };
  }
  if (!Array.isArray(list)) return { ok: false, errors: ['프리셋 목록(배열)이 아닙니다'] };
  if (list.length > PRESET_LIMITS.maxPresets) return { ok: false, errors: [`프리셋은 최대 ${PRESET_LIMITS.maxPresets}개입니다`] };
  const presets: Preset[] = [];
  const usedIds = new Set<string>();
  list.forEach((raw, i) => {
    const where = `프리셋 ${i + 1}`;
    if (!isObj(raw)) {
      errors.push(`${where}: 객체가 아닙니다`);
      return;
    }
    const before = errors.length;
    if (typeof raw.name !== 'string' || (!opts.lenient && raw.name.trim() === '') || raw.name.length > PRESET_LIMITS.nameMax) {
      errors.push(`${where}: 이름은 1~${PRESET_LIMITS.nameMax}자여야 합니다`);
    }
    if (!Array.isArray(raw.steps) || (!opts.lenient && raw.steps.length === 0) || raw.steps.length > PRESET_LIMITS.maxSteps) {
      errors.push(`${where}: steps는 1~${PRESET_LIMITS.maxSteps}개여야 합니다`);
    }
    let shortcut: string | undefined;
    if (raw.shortcut !== undefined && raw.shortcut !== null && raw.shortcut !== '') {
      if (typeof raw.shortcut === 'string' && SHORTCUT_OPTIONS.includes(raw.shortcut)) shortcut = raw.shortcut;
      else errors.push(`${where}: 지원하지 않는 단축키 "${String(raw.shortcut)}"`);
    }
    const steps: PresetStep[] = [];
    if (Array.isArray(raw.steps) && raw.steps.length <= PRESET_LIMITS.maxSteps) {
      raw.steps.forEach((s, j) => {
        const st = readStep(s, `${where} 단계 ${j + 1}`, errors, !!opts.lenient);
        if (st) steps.push(st);
      });
    }
    if (errors.length > before) return;
    let id = opts.keepIds && typeof raw.id === 'string' && raw.id ? raw.id : newPresetId();
    if (usedIds.has(id)) id = newPresetId();
    usedIds.add(id);
    presets.push({ id, name: (raw.name as string).trim(), ...(shortcut ? { shortcut } : {}), steps });
  });
  if (errors.length) return { ok: false, errors };
  // A duplicated shortcut within the file: keep the first, drop later ones (and say so).
  const seen = new Set<string>();
  for (const p of presets) {
    if (!p.shortcut) continue;
    if (seen.has(p.shortcut)) {
      warnings.push(`"${p.name}"의 단축키 ${p.shortcut}은(는) 이미 쓰여 비웠습니다`);
      delete p.shortcut;
    } else seen.add(p.shortcut);
  }
  return { ok: true, presets, warnings };
}

export function serializePresets(presets: Preset[]): string {
  const out = presets.map(({ id: _id, ...rest }) => rest);
  return JSON.stringify({ version: FILE_VERSION, presets: out }, null, 2);
}

/** Pure key -> shortcut string ("F1", "Shift+3") or null. Uses `code` so it works under the Korean IME. */
export function presetShortcutOf(e: { code?: string; key?: string; ctrlKey?: boolean; metaKey?: boolean; altKey?: boolean; shiftKey?: boolean }): string | null {
  if (e.ctrlKey || e.metaKey || e.altKey) return null;
  const code = e.code ?? '';
  const f = /^F(\d{1,2})$/.exec(code || e.key || '');
  if (f && !e.shiftKey) {
    const s = `F${f[1]}`;
    return SHORTCUT_OPTIONS.includes(s) ? s : null;
  }
  const d = /^Digit([1-9])$/.exec(code);
  if (d && e.shiftKey) return `Shift+${d[1]}`;
  return null;
}

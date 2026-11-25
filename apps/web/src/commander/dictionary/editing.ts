import { Action } from '@winds/protocol';
import { compactExpression, mergeDictionaries, type Dictionary } from '@winds/parser';

export const ACTIONS = Action.options;

export function emptyAllianceDictionary(name = '우리 동맹'): Dictionary {
  return {
    version: 1,
    name,
    actions: { GATHER: [], MOVE: [], ATTACK: [], DEFEND: [], RETREAT: [], SUPPORT: [], HOLD: [] },
    targetAll: [],
    locations: [],
    numberWords: {},
    partySuffixes: [],
    correctionMarkers: [],
    cancelPhrases: [],
  };
}

const same = (a: string, b: string) => compactExpression(a) === compactExpression(b);
const has = (list: readonly string[], e: string) => list.some((x) => same(x, e));

/** The action that already owns `expr` in the merged dictionary (other than `action`), if any. */
export function findActionOwner(merged: Dictionary, expr: string, action: Action): Action | undefined {
  return ACTIONS.find((a) => a !== action && has(merged.actions[a], expr));
}

/** Adds the expression to `action`; the same expression is moved out of the alliance's other actions. */
export function addActionExpression(d: Dictionary, action: Action, expr: string): Dictionary {
  const e = expr.trim();
  if (!compactExpression(e)) return d;
  const actions = { ...d.actions };
  for (const a of ACTIONS) if (a !== action) actions[a] = d.actions[a].filter((x) => !same(x, e));
  actions[action] = has(d.actions[action], e) ? d.actions[action] : [...d.actions[action], e];
  // Adding an expression the alliance had switched off turns it back on.
  return { ...d, actions, disabled: d.disabled?.filter((x) => !same(x, e)) };
}

export function removeActionExpression(d: Dictionary, action: Action, expr: string): Dictionary {
  return { ...d, actions: { ...d.actions, [action]: d.actions[action].filter((x) => !same(x, expr)) } };
}

/** US-F09-1.3: switch a base-dictionary expression off (or back on). */
export function setBaseDisabled(d: Dictionary, expr: string, disabled: boolean): Dictionary {
  const rest = (d.disabled ?? []).filter((x) => !same(x, expr));
  return { ...d, disabled: disabled ? [...rest, expr] : rest };
}

export function isDisabled(d: Dictionary, expr: string): boolean {
  return has(d.disabled ?? [], expr);
}

/** New alliance location. Ids are generated (CUSTOM_n) so they never collide with the base ones. */
export function addLocation(d: Dictionary, label: string, aliases: string[] = []): Dictionary {
  const l = label.trim();
  if (!compactExpression(l)) return d;
  let n = 1;
  const taken = new Set(d.locations.map((x) => x.id));
  while (taken.has(`CUSTOM_${n}`)) n++;
  return { ...d, locations: [...d.locations, { id: `CUSTOM_${n}`, label: l, aliases: aliases.map((a) => a.trim()).filter(Boolean) }] };
}

export function removeLocation(d: Dictionary, id: string): Dictionary {
  return { ...d, locations: d.locations.filter((l) => l.id !== id) };
}

/** Adds an alias to a location. For a base location (`label` is its base label) an override entry with the same id is created. */
export function addLocationAlias(d: Dictionary, id: string, label: string, alias: string): Dictionary {
  const a = alias.trim();
  if (!compactExpression(a)) return d;
  const cur = d.locations.find((l) => l.id === id);
  if (!cur) return { ...d, locations: [...d.locations, { id, label, aliases: [a] }] };
  if (has(cur.aliases, a)) return d;
  return { ...d, locations: d.locations.map((l) => (l.id === id ? { ...l, aliases: [...l.aliases, a] } : l)) };
}

export function removeLocationAlias(d: Dictionary, id: string, alias: string, baseIds: ReadonlySet<string>): Dictionary {
  const locations = d.locations
    .map((l) => (l.id === id ? { ...l, aliases: l.aliases.filter((x) => !same(x, alias)) } : l))
    // An override entry that only existed to extend a base location disappears when empty.
    .filter((l) => !(l.id === id && baseIds.has(id) && l.aliases.length === 0));
  return { ...d, locations };
}

/** Import "합치기": everything of `incoming` is added on top of `current` (disabled lists are unioned). */
export function mergeAlliance(current: Dictionary, incoming: Dictionary): Dictionary {
  const merged = mergeDictionaries(current, { ...incoming, disabled: undefined });
  const disabled = [...(current.disabled ?? [])];
  for (const e of incoming.disabled ?? []) if (!has(disabled, e)) disabled.push(e);
  // `disabled` refers to the built-in dictionary, so it is unioned instead of being applied to our own entries.
  return { ...merged, disabled };
}

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

export interface MergeDiff {
  /** Incoming CUSTOM_n locations that got a new id because the id was taken by a different location. */
  renamedLocations: Array<{ from: string; to: string; label: string; clashedWith: string }>;
  /** Same id (a built-in location override), different label: the incoming label wins. */
  labelChanges: Array<{ id: string; from: string; to: string }>;
  /** Expressions whose effective action changes (current alliance + base -> after merge). */
  movedExpressions: Array<{ expression: string; from: Action; to: Action }>;
}

const CUSTOM_ID = /^CUSTOM_\d+$/;

/** Gives incoming CUSTOM_n ids that clash with `current` a fresh id. Aliases and labels are kept. */
function remapIncomingLocations(current: Dictionary, incoming: Dictionary): { dictionary: Dictionary; renamed: MergeDiff['renamedLocations'] } {
  const currentById = new Map(current.locations.map((l) => [l.id, l]));
  const taken = new Set([...currentById.keys(), ...incoming.locations.map((l) => l.id)]);
  const renamed: MergeDiff['renamedLocations'] = [];
  const locations = incoming.locations.map((l) => {
    const clash = currentById.get(l.id);
    if (!CUSTOM_ID.test(l.id) || !clash || same(clash.label, l.label)) return l; // same place (or a built-in id): merges as before
    let n = 1;
    while (taken.has(`CUSTOM_${n}`)) n++;
    const id = `CUSTOM_${n}`;
    taken.add(id);
    renamed.push({ from: l.id, to: id, label: l.label, clashedWith: clash.label });
    return { ...l, id };
  });
  return { dictionary: { ...incoming, locations }, renamed };
}

function effectiveActionOf(d: Dictionary): Map<string, { expression: string; action: Action }> {
  const m = new Map<string, { expression: string; action: Action }>();
  for (const a of ACTIONS) for (const e of d.actions[a]) m.set(compactExpression(e), { expression: e, action: a });
  return m;
}

/**
 * What "합치기" would do: the merged alliance dictionary (clashing CUSTOM ids renumbered) and the
 * differences the user should see before confirming. `base` is the built-in dictionary.
 */
export function planMerge(current: Dictionary, incoming: Dictionary, base: Dictionary): { result: Dictionary; diff: MergeDiff } {
  const { dictionary: remapped, renamed } = remapIncomingLocations(current, incoming);
  const result = mergeAlliance(current, remapped);
  const before = effectiveActionOf(mergeDictionaries(base, current));
  const after = effectiveActionOf(mergeDictionaries(base, result));
  const movedExpressions: MergeDiff['movedExpressions'] = [];
  for (const [k, b] of before) {
    const a = after.get(k);
    if (a && a.action !== b.action) movedExpressions.push({ expression: b.expression, from: b.action, to: a.action });
  }
  const effLocs = new Map([...base.locations, ...current.locations].map((l) => [l.id, l.label]));
  const labelChanges: MergeDiff['labelChanges'] = [];
  for (const l of remapped.locations) {
    const was = effLocs.get(l.id);
    if (was !== undefined && !same(was, l.label)) labelChanges.push({ id: l.id, from: was, to: l.label });
  }
  return { result, diff: { renamedLocations: renamed, labelChanges, movedExpressions } };
}

export const hasMergeDiff = (d: MergeDiff) => d.renamedLocations.length + d.labelChanges.length + d.movedExpressions.length > 0;
